import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {DatabaseSync} from "node:sqlite";
import {auditContactCoverage,compareContactCoverage} from "../scripts/audit-contact-coverage.js";
const inn="4706000909",other="7810165652",phone="74951234567";
const row=(inn,name,extra={})=>({"ИНН":inn,"Организация":name,"Телефон":"","Основание":"A",...extra});
const cp=(rows,extra={})=>({version:1,phase:"completed",source_mode:"full",region:"Регион",
  final_result:{direct_buyers:rows,intermediaries:[],leasing:[],statistics:[]},...extra});
test("audit separates phone presence, structural evidence, shared numbers and missing identity",()=>{
  const data=cp([row(inn,"АО Альфа",{"Телефон":phone,__evidence:{contact_verification:{inn,phone,source_url:"https://alpha.example/contacts"}}}),
    row(other,"АО Бета",{"Телефон":phone}),row("","АО Гамма")],{
    contact_stats:{phone_coverage:{rows:3,with_phone:1}},saby_stats:{deferred:7}});
  const before=JSON.stringify(data),out=auditContactCoverage(data);
  assert.equal(out.actual.with_phone,2);assert.equal(out.shared_number_count,1);
  assert.equal(out.rows_with_shared_numbers,2);assert.equal(out.source_support_rows.model_source_hint,1);
  assert.equal(out.source_support_rows.no_recognized_saved_support,1);assert.equal(out.without_phone_invalid_or_missing_inn,1);
  assert.equal(out.stages.stage11.with_phone,1);assert.equal(out.stages.saby,null);
  assert.equal(out.pending.saby,7);assert.equal(JSON.stringify(data),before);
  assert.ok(!JSON.stringify(out).includes(phone));
});
test("same-region comparison separates matched phone gains from new rows and mismatched identities",()=>{
  const before=cp([row(inn,"АО Альфа"),row(other,"АО Бета",{"Телефон":phone})]);
  const after=cp([row(inn,"АО Альфа",{"Телефон":phone}),row(other,"АО Бета"),
    row("","АО Новый",{"Телефон":"79001234567"})]);
  const out=compareContactCoverage(before,after);
  assert.equal(out.matched_exact_unique_legal_inn_and_name,2);
  assert.equal(out.gained_phone_rows,1);assert.equal(out.lost_phone_rows,1);
  assert.equal(out.unmatched_after,1);assert.equal(out.net_change,0);
  after.final_result.direct_buyers[1]["Организация"]="АО Другое";
  assert.equal(compareContactCoverage(before,after).identity_conflicts,1);
  assert.throws(()=>compareContactCoverage(before,{...after,region:"Другой регион"}),/BASELINE_REGION_MISMATCH/);
});
test("SQLite CLI reads completed snapshots and never writes contacts or the parent",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"contact-coverage-audit-"));
  try{
    const file=path.join(dir,"cp.sqlite"),id="a0000000-0000-0000-0000-000000000001",payload=JSON.stringify(cp([row(inn,"АО Альфа",{"Телефон":phone})]));
    const db=new DatabaseSync(file);
    try{db.exec("CREATE TABLE research_checkpoints(id TEXT,phase TEXT,updated_at TEXT,payload TEXT)");
      db.prepare("INSERT INTO research_checkpoints VALUES (?,?,?,?)").run(id,"completed","2026-11-26",payload);}
    finally{db.close();}
    const script=fileURLToPath(new URL("../scripts/audit-contact-coverage.js",import.meta.url));
    const run=spawnSync(process.execPath,[script,"--db="+file,"--recent=1"],{encoding:"utf8",timeout:30000});
    assert.equal(run.status,0,run.stderr);
    assert.match(run.stdout,/CONTACT_COVERAGE_AUDIT/);
    assert.ok(!run.stdout.includes(phone));assert.ok(!run.stdout.includes("Альфа"));
    const check=new DatabaseSync(file,{readOnly:true});
    try{assert.equal(check.prepare("SELECT payload FROM research_checkpoints").get().payload,payload);}
    finally{check.close();}
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
