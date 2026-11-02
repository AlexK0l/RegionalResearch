import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import XLSX from "xlsx";

const script=fileURLToPath(new URL("../scripts/compose-offline-crm.js",import.meta.url));
function fixture(differentGrade=false){
 const one={ "Организация":"АО «Спецавтохозяйство»","ИНН":"6731069440",
  "Основание":"B — архивная тяжёлая логистика","Следующее действие":"Связаться",
  "Почему им нужно звонить / потенциальный интерес к САТ":"Есть тяжёлая логистика",
  "__canonical_id":"k1","__merged_canonical_ids":["k1","k2"],"__final_grade":"B",
  "__comment":"Сайт/источник: https://sah67.ru/\nИНН: 6731069440",
  "__evidence":{"source_urls":["https://sah67.ru/","https://sah67.ru/vehicles/"],
    "notes":["Own equipment; legacy record"],"facts":[{"kind":"fleet","source_url":"https://sah67.ru/vehicles/"}]}};
 const two={ "Организация":"ООО «Нужна проверка»","ИНН":"",
  "Основание":"A — архивный вывод","__canonical_id":"k3","__final_grade":"A",
  "__comment":"Сайт/источник: https://example.org/\nИНН: не подтверждено",
  "__evidence":{"source_urls":["https://example.org/"],"notes":[]}};
 const identity={checkpoint_id:"test-checkpoint",region:"Смоленская область",
  final_result:{direct_buyers:[one,two],intermediaries:[],leasing:[],statistics:[],
    qualification_review:[{__canonical_id:"legacy", "Организация":"Старый кандидат",
      __decision_reason:"Недостаточно подтверждений"}]},
  audit:{restored_groups:[{winner_name:one["Организация"],inn:"6731069440",
    absorbed_names:["АО «СпецАТХ»"],original_canonical_ids:["k1","k2"],reason:"sourced_explicit_alias"}],
    unresolved:[],untrusted_or_unmatched:[]}};
 const replay={checkpoint:"test-checkpoint",rows:[
  {canonical_id:"k1",replay_grade:"B",qualification_status:"B",why:"тяжёлая логистика"},
  {canonical_id:"k2",replay_grade:differentGrade?"A":"B",qualification_status:differentGrade?"A":"B",why:"собственный парк"},
  {canonical_id:"k3",replay_grade:"",qualification_status:"REVIEW",why:"Недостаточно доказательств"}]};
 return {identity,replay};
}
function run(data,wrongCheckpoint=false){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"offline-composition-"));
 const a=path.join(dir,"recovery.json"),b=path.join(dir,"qual.json"),out=path.join(dir,"out");
 fs.writeFileSync(a,JSON.stringify(data.identity));
 fs.writeFileSync(b,JSON.stringify({...data.replay,checkpoint:wrongCheckpoint?"different":data.replay.checkpoint}));
 const before=[fs.readFileSync(a),fs.readFileSync(b)];
 const proc=spawnSync(process.execPath,[script,a,b,"--out="+out],{encoding:"utf8",timeout:30000});
 return {dir,a,b,out,proc,before};
}
test("combines completed offline recovery and v5 by canonical ID, preserves comments and source files",()=>{
 const state=run(fixture());
 try{
  assert.equal(state.proc.status,0,state.proc.stderr);
  assert.deepEqual([fs.readFileSync(state.a),fs.readFileSync(state.b)],state.before);
  const data=JSON.parse(state.proc.stdout);
  assert.deepEqual(data.summary.grades,{A:0,B:1,C:0,REVIEW:1});
  assert.equal(data.summary.total,2);
  assert.equal(data.summary.with_inn,1);
  assert.equal(data.summary.reclassified_rows,1);
  assert.equal(data.summary.historical_review_outside_active,1);
  assert.equal(data.summary.no_external_calls,true);
  assert.equal(data.summary.full_records_in_json,2);
  assert.equal(data.summary.stored_evidence_source_urls,3);
  const complete=JSON.parse(fs.readFileSync(data.output.json,"utf8"));
  assert.equal(complete.final_result.direct_buyers.length,2);
  assert.equal(complete.final_result.qualification_review.length,1);
  assert.equal(complete.final_result.direct_buyers[0].__merged_canonical_ids.length,2);
  assert.equal(complete.final_result.direct_buyers[0].__evidence.source_urls.length,2);
  assert.deepEqual(complete.final_result.direct_buyers[0].__evidence.facts,[{
    kind:"fleet",source_url:"https://sah67.ru/vehicles/"
  }]);
  assert.equal(complete.final_result.direct_buyers[0].__replay_v5.status,"B");
  assert.equal(complete.final_result.direct_buyers[1].__replay_v5.status,"REVIEW");
  assert.match(complete.final_result.direct_buyers[1].__archived_qualification.archived_basis,/архивный/);
  assert.ok(complete.final_result.direct_buyers[1].__comment.includes("example.org"));
  assert.equal(complete.rows[0].__evidence,undefined,"compact index remains compact");
  const book=XLSX.readFile(data.output.xlsx);
  const tab=book.Sheets["Прямые покупатели"];
  const rows=XLSX.utils.sheet_to_json(tab,{header:1,defval:""});
  assert.equal(rows[0].length,12);
  assert.ok(!rows[0].includes("__comment"));
  assert.equal(rows.length,3);
  assert.equal(rows[1][2],"6731069440");
  assert.match(rows[2][5],/^REVIEW —/);
  assert.match(JSON.stringify(tab.A2.c),/sah67.ru/);
  assert.match(JSON.stringify(tab.A3.c),/example.org/);
  assert.ok(book.Sheets["Прежняя проверка"]);
  assert.ok(book.Sheets["Проверка v5"]);
  const twice=spawnSync(process.execPath,[script,state.a,state.b,"--out="+state.out],{encoding:"utf8"});
  assert.notEqual(twice.status,0,"repeat must never overwrite output");
 }finally{fs.rmSync(state.dir,{recursive:true,force:true});}
});
test("a merged alias pair with incompatible replay grades is retained but requires review",()=>{
 const state=run(fixture(true));
 try{
  assert.equal(state.proc.status,0,state.proc.stderr);
  const data=JSON.parse(state.proc.stdout);
  assert.deepEqual(data.summary.grades,{A:0,B:0,C:0,REVIEW:2});
  assert.equal(data.summary.total,2);
  assert.equal(data.summary.manual_review_rows,2);
  assert.equal(data.summary.reclassified_rows,2);
  const complete=JSON.parse(fs.readFileSync(data.output.json,"utf8"));
  assert.ok(complete.final_result.direct_buyers.every((r)=>r.__replay_v5.status==="REVIEW"));
  assert.ok(complete.final_result.direct_buyers[0].__archived_qualification);
 }finally{fs.rmSync(state.dir,{recursive:true,force:true});}
});
test("refuses mismatched checkpoint IDs without exporting any combined files",()=>{
 const state=run(fixture(),true);
 try{
  assert.notEqual(state.proc.status,0);
  assert.match(state.proc.stderr,/Checkpoint mismatch/);
  assert.ok(!fs.existsSync(path.join(state.out,"combined_offline_test-che.xlsx")));
  assert.deepEqual([fs.readFileSync(state.a),fs.readFileSync(state.b)],state.before);
 }finally{fs.rmSync(state.dir,{recursive:true,force:true});}
});
