import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {PIPELINE_VERSION} from "../src/checkpointStore.js";
import {
  validateSabyOnlySource,runSabyOnlyContinuation
} from "../src/sabyOnlyContinuation.js";
import {sabyBrowserSettings} from "../src/sabyBrowser.js";

const INNS=["7707083893","7702070139"];
const env={
  SABY_STAGE12_ENABLED:"true",SABY_FLEET_TREE_PRODUCTION_ENABLED:"true",
  SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED:"true",SABY_HEADLESS:"false",
  SABY_MAX_COMPANIES:"0",SABY_CHECKPOINT_EVERY:"1",
  SABY_DELAY_MS:"250"
};
function fixture(){
  return {
    version:1,pipeline_version:PIPELINE_VERSION,
    region:"Ленинградская область",source_mode:"full",phase:"priority",
    completed_stage:12,
    contact_stats:{version:2,ok:1,unsearched:1},
    saby_stats:{enabled:true,scheduled:2,verified:0,deferred:2,circuitOpen:true},
    priority_ai_stats:{version:1,calls:0,classified:0,cached:0,deferred:0,
      stopped_reason:""},
    final_result:{
      direct_buyers:INNS.map((inn,i)=>({
        "ИНН":inn,"Организация":"ООО Тест "+i,"Телефон":"",
        "Электронная почта":"","Наличие транспорта":"",
        "Основание":"C — регулярные грузовые перевозки",
        __final_grade:"C",__evidence:{source_urls:[],notes:[]}
      })),
      intermediaries:[],leasing:[],statistics:[],
      final_quality_gate:{version:"2",active_commercial_records:2,
        review_records:0,excluded_records:0}
    },
    saby_completed_inns:[],saby_deferred_inns:[...INNS],saby_attempted_inns:[]
  };
}

test("Stage13 crashed priority source becomes in-memory final snapshot for Saby-only",()=>{
  const cp=fixture(),frozen=JSON.stringify(cp);
  const v=validateSabyOnlySource(cp);
  assert.equal(v.ok,true,JSON.stringify(v));
  assert.equal(v.recovered_priority,true);
  assert.equal(v.bootstrap,false);
  assert.equal(v.pending,2);
  assert.equal(v.checkpoint.phase,"completed");
  assert.equal(v.checkpoint.source_mode,"full");
  assert.equal(v.checkpoint.offline_recovery.new_openai_calls,0);
  assert.equal(v.checkpoint.offline_recovery.sqlite_writes,0);
  assert.deepEqual(v.checkpoint.final_quality_gate,
    cp.final_result.final_quality_gate);
  assert.equal(JSON.stringify(cp),frozen,"source SQLite payload must not mutate");
});

test("reject incomplete or untrusted priority source without launching browser",()=>{
  const bad=fixture();
  bad.priority_ai_stats.deferred=2;
  assert.equal(validateSabyOnlySource(bad).code,
    "SABY_PRIORITY_SNAPSHOT_INCOMPLETE");
  const noQA=fixture();
  delete noQA.priority_ai_stats;
  assert.equal(validateSabyOnlySource(noQA).ok,false);
  const noSaby=fixture();
  delete noSaby.saby_stats;
  assert.equal(validateSabyOnlySource(noSaby).ok,false);
  const wrongMode=fixture();
  wrongMode.source_mode="saby";
  assert.equal(validateSabyOnlySource(wrongMode).ok,false);
  const wrongPhase=fixture();
  wrongPhase.phase="final_inn";
  assert.equal(validateSabyOnlySource(wrongPhase).ok,false);
  const wrongVersion=fixture();
  wrongVersion.pipeline_version=PIPELINE_VERSION+1;
  assert.equal(validateSabyOnlySource(wrongVersion).code,
    "CHECKPOINT_VERSION_MISMATCH");
});

test("Saby-only from recovered Stage13 creates only new child checkpoint",async()=>{
  const parent=fixture(),original=JSON.stringify(parent);
  const saved=[],visited=[];
  const output=await runSabyOnlyContinuation({
    checkpoint:parent,sourceJobId:"56b9d1ac-1122-4023-8a45-1193cfdf0888",
    env,
    sessionRunner:task=>task({page:{},settings:sabyBrowserSettings(env)}),
    collectCompany:async(_page,company)=>{
      visited.push(company["ИНН"]);
      return {
        source:"SABY",source_url:"https://profile.saby.ru/",
        collected_at:"2026-11-18T10:00:00Z",
        identity:{inn:company["ИНН"],name:company["Организация"],verified:true},
        contacts:{status:"collected",phones:["74951234567"],emails:["info@example.org"]},
        trucks:{status:"verified",count:1,vehicles:[{model:"KAMAZ 5490",year:2020}]},
        errors:[]
      };
    },
    persistCheckpoint:async x=>saved.push(structuredClone(x))
  });
  assert.equal(JSON.stringify(parent),original);
  assert.deepEqual(new Set(visited),new Set(INNS));
  assert.equal(output.mode,"saby_only");
  assert.equal(saved[0].source_mode,"saby");
  assert.equal(saved[0].phase,"saby");
  assert.equal(saved.at(-1).phase,"completed");
  assert.equal(saved.at(-1).source_mode,"saby");
  assert.equal(saved.at(-1).offline_recovery.new_openai_calls,0);
  assert.equal(saved.at(-1).saby_continuation_root_job_id,
    "56b9d1ac-1122-4023-8a45-1193cfdf0888");
});

test("API exposes safely recoverable priority source, not general unfinished phases",()=>{
  const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
  assert.match(server,/c\.status==="resumable"/);
  assert.match(server,/c\.phase==="priority"/);
  assert.match(server,/saby_recovered_priority:validated\.recovered_priority/);
  assert.match(server,/const newest=await latestSabyCheckpointForRegion\(region\)/);
});
