import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {DatabaseSync} from "node:sqlite";
import {recoverPriorityCheckpointOffline}
  from "../src/priorityCheckpointRecovery.js";

const base=fileURLToPath(new URL("../",import.meta.url));
const row=(name,overrides={})=>({
  "Организация":name,"ИНН":"", "Наличие транспорта":"",
  "Основание":"C — промышленное предприятие",
  "Телефон":"", "Электронная почта":"",
  __evidence:{notes:[],source_urls:[]},...overrides
});
const fixture=()=>({
  source_mode:"full",region:"Тестовый регион",phase:"priority",pipeline_version:1,
  contact_stats:{version:2,checked:2},saby_stats:{enabled:true,processed:1},
  priority_ai_stats:{calls:0,classified:0,cached:0,deferred:0,stopped_reason:""},
  final_result:{
    direct_buyers:[
      row("ООО Альфа"),
      row("ООО Лизинг",{
        __a_evidence:"ООО Лизинг указан лизингодателем по договору.",
        "Основание":"A — ООО Лизинг указан лизингодателем по договору."
      })
    ],
    intermediaries:[],leasing:[],statistics:[]
  }
});
test("recover frozen priority checkpoint without network, source mutation or missing rows",()=>{
  const cp=fixture(),snapshot=structuredClone(cp);
  const {recovered,audit,summary}=recoverPriorityCheckpointOffline(cp,{jobId:"test-job"});
  assert.deepEqual(cp,snapshot);
  assert.equal(recovered.phase,"completed");
  assert.equal(recovered.final_result.direct_buyers.length,1);
  assert.equal(recovered.final_result.leasing.length,1);
  assert.equal(summary.source_fields_unchanged,true);
  assert.equal(summary.ai_classification_complete,true);
  assert.equal(audit.complete,true);
  assert.equal(recovered.offline_recovery.sqlite_writes,0);
  assert.equal(recovered.offline_recovery.new_openai_calls,0);
  assert.equal(recovered.offline_recovery.source_phase,"priority");
  assert.equal(recovered.offline_recovery.final_quality_report_present,false);
  assert.equal(recovered.final_result.direct_buyers[0]["Электронная почта"],"");
});
test("refuse salvage when model classification may still be unfinished",()=>{
  const cp=fixture();
  cp.priority_ai_stats.deferred=2;
  assert.throws(()=>recoverPriorityCheckpointOffline(cp),/incomplete/);
  assert.equal(cp.phase,"priority");
});
test("refuse earlier phases or absent contact and Saby evidence",()=>{
  const cp=fixture();
  cp.phase="saby";
  assert.throws(()=>recoverPriorityCheckpointOffline(cp),/priority phase/);
  cp.phase="priority";
  delete cp.contact_stats;
  assert.throws(()=>recoverPriorityCheckpointOffline(cp),/Stage11 or Stage12/);
});
test("CLI --preview reads exact SQLite job and writes no export files",()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"stage13-recovery-"));
  try{
    const dbPath=path.join(folder,"checkpoint.sqlite");
    const db=new DatabaseSync(dbPath);
    db.exec("CREATE TABLE research_checkpoints("+
      "id TEXT PRIMARY KEY,region TEXT,mode TEXT,status TEXT,phase TEXT,"+
      "pipeline_version INTEGER,payload TEXT)");
    const cp=fixture();
    db.prepare("INSERT INTO research_checkpoints VALUES (?,?,?,?,?,?,?)")
      .run("test-job",cp.region,"full","resumable","priority",1,JSON.stringify(cp));
    db.close();
    const script=path.join(base,"scripts","recover-priority-checkpoint-offline.js");
    const result=spawnSync(process.execPath,[script,
      "--db="+dbPath,"--job-id=test-job","--preview"],
      {cwd:base,encoding:"utf8",timeout:12000});
    assert.equal(result.status,0,result.stderr);
    const info=JSON.parse(result.stdout);
    assert.equal(info.mode,"read_only_preflight");
    assert.equal(info.original_checkpoint_unchanged,true);
    assert.equal(info.new_paid_calls,0);
    assert.equal(info.recovered_sections.leasing,1);
    assert.deepEqual(fs.readdirSync(folder),["checkpoint.sqlite"]);
  }finally{fs.rmSync(folder,{recursive:true,force:true});}
});
