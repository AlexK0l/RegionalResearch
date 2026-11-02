import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import { integrateReviewedReplay, integratedReviewedWorkbook } from "../src/offlineReviewIntegration.js";

const checkpoint="fixture-integrated-f677c97e";
const create=()=>{
  const companies=[
    ["k1","ООО Основное","direct_buyers","","C"],
    ["k2","ООО Алиас","direct_buyers","","C"],
    ["k3","ООО Полуприцеп","direct_buyers","","A"],
    ["k4","ООО Проверить","intermediaries","","REVIEW"],
    ["k5","Журнал Отрасль","direct_buyers","","EXCLUDED"]
  ];
  const rec=(v)=>({
    __canonical_id:v[0],"Организация":v[1],"ИНН":v[0]==="k1"?"6732191851":v[3],
    "Основание":"Original historic class "+v[4], "Телефон":"79991112233",
    __comment:"Old CRM first-cell note "+v[0],
    __replay_v5:{status:v[4]},__a_evidence:"Historical evidence "+v[0],
    __evidence:{source_urls:["https://example.org/"+v[0]],notes:["Original note "+v[0]],facts:[]}
  });
  const records=companies.map(rec);
  const original=records.map((r,i)=>({canonical_id:r.__canonical_id,
    organization:r["Организация"],sheet:companies[i][2],inn:companies[i][3],
    archived_grade:companies[i][4],replay_grade:["REVIEW","EXCLUDED"].includes(companies[i][4])?"":companies[i][4],
    qualification_status:companies[i][4],
    a_rule:companies[i][4]==="A"?"direct_procurement":"",
    a_evidence:companies[i][4]==="A"?"Confirmed Kogel 10-year lease":"",
    why:"Fixture reason "+companies[i][4],source_urls:r.__evidence.source_urls,
    evidence_notes:r.__evidence.notes}));
  const reviewed={checkpoint_id:checkpoint,summary:{total:4,with_inn:1,without_inn:3},
    rows:[0,2,3,4].map(i=>({canonical_id:companies[i][0],
      organization:companies[i][1],inn:i===0?"6732191851":""})),
    final_result:{direct_buyers:[records[0],records[2],records[4]],
      intermediaries:[records[3]],leasing:[],statistics:[],qualification_review:[]},
    reviewed_alias_merges:{original_company_count:5,archived_original_records:[
      {canonical_id:"k2",original_sheet:"direct_buyers",retained_with:"k1",record:records[1]}
    ]}
  };
  const replay={checkpoint,source_sqlite_readonly:true,rows:original,review_queue:[]};
  return {reviewed,replay};
};

test("full reviewed JSON + v8 replay preserve legal identity, all original IDs, and CRM columns",()=>{
 const x=create(),old=structuredClone(x.reviewed);
 const {data,report}=integrateReviewedReplay(x.reviewed,x.replay,{qualificationSha:"abc123"});
 assert.deepEqual(x.reviewed,old,"No mutation of original reviewed data");
 assert.equal(report.active_full_records,4);
 assert.equal(report.absorbed_alias_records,1);
 assert.equal(report.replay_input_rows,5);
 assert.equal(report.crm_visible_rows,2);
 assert.deepEqual(report.counts,{A:1,B:0,C:1,REVIEW:1,EXCLUDED:1});
 assert.equal(report.reviewed_inn_present,1);
 assert.equal(report.openai_calls,0);
 assert.equal(data.final_result.direct_buyers[0]["ИНН"],"6732191851");
 assert.equal(data.final_result.direct_buyers[0]["Телефон"],"79991112233");
 assert.equal(data.final_result.direct_buyers[1].__replay_v8.a_evidence,"Confirmed Kogel 10-year lease");
 assert.equal(data.final_result.direct_buyers[1].__a_evidence,"Confirmed Kogel 10-year lease");
 assert.equal(data.final_result.direct_buyers[1].__a_evidence_before_v8,"Historical evidence k3");
 assert.equal(data.final_result.direct_buyers[1].__replay_v5.status,"A");
 assert.equal(data.final_result.qualification_review.length,1);
 assert.equal(data.final_result.qualification_excluded_v8.length,1);
 assert.equal(data.integration_replay_v8.lineage.length,5);
 assert.equal(data.integration_replay_v8.lineage.find(x=>x.canonical_id==="k2").survivor_canonical_id,"k1");
 assert.equal(data.final_result.direct_buyers[0].__evidence.facts.length,0);
 const wb=integratedReviewedWorkbook(data,report);
 assert.ok(wb.SheetNames.includes("Статистика"));
 assert.ok(wb.SheetNames.includes("Легенда"));
 assert.equal(XLSX.utils.sheet_to_json(wb.Sheets["Прямые покупатели"]).length,2);
 assert.equal(XLSX.utils.sheet_to_json(wb.Sheets["REVIEW v8"]).length,1);
 assert.equal(XLSX.utils.sheet_to_json(wb.Sheets["Исключено v8"]).length,1);
 assert.equal(XLSX.utils.sheet_to_json(wb.Sheets["История 492 ID"]).length,5);
 assert.ok(wb.Sheets["Прямые покупатели"].A2.c);
 assert.equal(XLSX.utils.sheet_to_json(wb.Sheets["Прямые покупатели"])[0]["Телефон"],"79991112233");
});

test("refuse mismatched checkpoint, identity, role and an unreviewed extra alias",()=>{
 for(const scenario of ["checkpoint","name","role","extra","INN"]){
  const x=create();
  if(scenario==="checkpoint")x.replay.checkpoint="wrong";
  if(scenario==="name")x.replay.rows[0].organization="Another company";
  if(scenario==="role")x.replay.rows[0].sheet="leasing";
  if(scenario==="extra")x.replay.rows.push({...x.replay.rows[1],canonical_id:"k6"});
  if(scenario==="INN")x.replay.rows[0].inn="1111111111";
  assert.throws(()=>integrateReviewedReplay(x.reviewed,x.replay),/Offline v8 integration/);
 }
});

test("CLI generates detached JSON/XLSX/audit, never overwrites outputs or source inputs",()=>{
 const x=create();
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"reviewed-v8-integrate-"));
 const entry=fileURLToPath(new URL("../scripts/integrate-reviewed-v8-offline.js",import.meta.url));
 const source=path.join(dir,"verified.json"),qual=path.join(dir,"replay.json"),out=path.join(dir,"result");
 try{
  fs.writeFileSync(source,JSON.stringify(x.reviewed));fs.writeFileSync(qual,JSON.stringify(x.replay));
  const old=[fs.readFileSync(source),fs.readFileSync(qual)];
  const run=()=>spawnSync(process.execPath,[entry,source,"--qualification="+qual,"--out="+out,
    "--qualifier-sha=abc123"],{encoding:"utf8",timeout:45000});
  const first=run();assert.equal(first.status,0,first.stderr);
  const result=JSON.parse(first.stdout);
  assert.equal(result.active_full_records,4);
  assert.equal(result.outputs.json.endsWith(".json"),true);
  assert.equal(JSON.parse(fs.readFileSync(result.outputs.json)).integration_replay_v8.report.counts.A,1);
  assert.ok(fs.statSync(result.outputs.xlsx).size>10000);
  assert.equal(run().status!==0,true,"Cannot overwrite result silently");
  assert.deepEqual([fs.readFileSync(source),fs.readFileSync(qual)],old);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
