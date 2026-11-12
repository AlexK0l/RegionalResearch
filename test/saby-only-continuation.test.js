import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  runSabyOnlyContinuation,validateSabyOnlySource,sabyOnlyConfigReady
} from "../src/sabyOnlyContinuation.js";
import {PIPELINE_VERSION} from "../src/checkpointStore.js";
import {sabyBrowserSettings} from "../src/sabyBrowser.js";

const inns=["7707083893","7702070139","7736207543"];
const names=["ООО Альфа","ООО Бета","ООО Гамма"];
const env={
  SABY_STAGE12_ENABLED:"true",
  SABY_FLEET_TREE_PRODUCTION_ENABLED:"true",
  SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED:"true",
  SABY_HEADLESS:"false",
  SABY_MAX_COMPANIES:"0",
  SABY_CHECKPOINT_EVERY:"1",
  SABY_DELAY_MS:"250"
};
const originalId="56b9d1ac-1122-4023-8a45-1193cfdf0001";
const resumedId="56b9d1ac-1122-4023-8a45-1193cfdf0002";

const row=(inn,i)=>({
  "ИНН":inn,"Организация":names[i],"Телефон":"",
  "Основание":"C — предварительная квалификация",
  "Наличие транспорта":"",
  "__final_grade":"C"
});
function source(){
  return {
    version:1,pipeline_version:PIPELINE_VERSION,
    region:"Смоленская область",source_mode:"full",phase:"completed",
    created_at:"2026-11-11T07:00:00.000Z",
    final_quality_gate:{grades:{A:0,B:0,C:3}},
    contact_stats:{total:3,ok:1},
    final_result:{
      direct_buyers:inns.map((inn,i)=>row(inn,i)),
      intermediaries:[],leasing:[],statistics:[]
    },
    saby_completed_inns:[inns[0]],saby_deferred_inns:inns.slice(1)
  };
}
function verified(company){
  const index=inns.indexOf(company["ИНН"]);
  return {
    source:"SABY",
    source_url:"https://profile.saby.ru/page/contractor-info?id="+company["ИНН"],
    collected_at:"2026-11-12T14:00:00.000Z",
    identity:{inn:company["ИНН"],name:company["Организация"],verified:true},
    contacts:{status:"collected",phones:["79991112"+String(index).padStart(3,"0")],
      phone_details:[],emails:["info"+index+"@example.test"]},
    trucks:{status:"verified",count:2,vehicles:[
      {model:"KAMAZ 5490",year:2020},
      {model:"KAMAZ 5490",year:2020}
    ]},
    errors:[]
  };
}
const fakeSession=task=>task({page:{},settings:sabyBrowserSettings(env)});

test("Saby-only input must be a finalized, compatible, already partially enriched SQLite snapshot",()=>{
  const good=source();
  assert.equal(validateSabyOnlySource(good).ok,true);
  for(const patch of [
    {phase:"contacts"},
    {source_mode:"stage_test"},
    {pipeline_version:PIPELINE_VERSION+1},
    {saby_deferred_inns:[]},
    {saby_completed_inns:null},
    {final_result:{direct_buyers:[],intermediaries:[],leasing:[]}}
  ])assert.equal(validateSabyOnlySource({...good,...patch}).ok,false);
  assert.equal(sabyOnlyConfigReady(env),true);
  assert.equal(sabyOnlyConfigReady({...env,SABY_STAGE12_ENABLED:"false"}),false);
  assert.equal(sabyOnlyConfigReady({...env,SABY_MAX_COMPANIES:"oops"}),false);
  assert.equal(sabyOnlyConfigReady({...env,SABY_FLEET_TREE_PRODUCTION_ENABLED:"false"}),false);
});

test("Saby-only uses one browser, no paid pipeline and a NEW checkpoint, preserving the original",async()=>{
  const original=source(),before=JSON.stringify(original),visited=[],saved=[],progress=[];
  const out=await runSabyOnlyContinuation({
    checkpoint:original,sourceJobId:originalId,env,
    sessionRunner:fakeSession,
    collectCompany:async(_page,company)=>{
      visited.push(company["ИНН"]);
      const record=verified(company);
      if(company["ИНН"]===inns[2])record.trucks={status:"review"};
      return record;
    },
    persistCheckpoint:async x=>saved.push(structuredClone(x)),
    onProgress:async x=>progress.push(structuredClone(x))
  });
  assert.deepEqual(new Set(visited),new Set(inns.slice(1)));
  assert.equal(JSON.stringify(original),before,"source checkpoint stays immutable");
  assert.equal(out.mode,"saby_only");
  assert.equal(out.region,"Смоленская область");
  assert.equal(out.counts.direct_buyers,3);
  assert.equal(out.quality.grades.C,3);
  assert.equal(out.stats,undefined);
  assert.equal(out.saby.processed,2);
  assert.equal(out.saby.deferred,1);
  assert.equal(out.saby.transportsAdded,1);
  assert.deepEqual(progress.at(-1).sabyStats,out.saby);
  assert.equal(progress.at(-1).percent,100);
  assert.equal(saved.length,4,"start, 2 per-company checkpoints and completion");
  assert.equal(saved[0].phase,"saby");
  assert.equal(saved.at(-1).phase,"completed");
  assert.equal(saved.at(-1).source_mode,"saby");
  assert.equal(saved.at(-1).saby_continuation_source_job_id,originalId);
  assert.equal(saved.at(-1).saby_continuation_root_job_id,originalId);
  assert.deepEqual(saved.at(-1).saby_deferred_inns,[inns[2]]);
  assert.deepEqual(saved.at(-1).saby_completed_inns,[inns[0],inns[1]]);
  assert.equal(saved.at(-1).final_result.direct_buyers[0]["Основание"],
    "C — предварительная квалификация");
  assert.equal(saved.at(-1).final_result.direct_buyers[2].__evidence.saby.trucks,undefined);
  assert.match(saved.at(-1).final_result.direct_buyers[2]["Телефон"],/^7[0-9]{10}$/);
});

test("next Saby-only continuation processes only deferred, preserving prior contact and qualification",async()=>{
  const firstSource=source(),firstSaved=[];
  await runSabyOnlyContinuation({
    checkpoint:firstSource,sourceJobId:originalId,env,
    sessionRunner:fakeSession,
    collectCompany:async(_page,company)=>{
      const data=verified(company);
      if(company["ИНН"]===inns[2])data.trucks={status:"review"};
      return data;
    },
    persistCheckpoint:x=>firstSaved.push(structuredClone(x))
  });
  const secondSource=firstSaved.at(-1);
  const firstPhone=secondSource.final_result.direct_buyers[2]["Телефон"];
  const before=JSON.stringify(secondSource),visited=[],secondSaved=[];
  const second=await runSabyOnlyContinuation({
    checkpoint:secondSource,sourceJobId:resumedId,env,
    sessionRunner:fakeSession,
    collectCompany:async(_page,company)=>{
      visited.push(company["ИНН"]);
      const data=verified(company);
      data.contacts={status:"missing",phones:[],emails:[]};
      return data;
    },
    persistCheckpoint:x=>secondSaved.push(structuredClone(x))
  });
  assert.deepEqual(visited,[inns[2]]);
  assert.equal(second.saby.processed,1);
  assert.equal(second.saby.transportsAdded,1);
  assert.equal(second.saby.deferred,0);
  assert.deepEqual(secondSaved.at(-1).saby_deferred_inns,[]);
  assert.equal(secondSaved.at(-1).final_result.direct_buyers[2]["Телефон"],firstPhone);
  assert.equal(secondSaved.at(-1).final_result.direct_buyers[2].__evidence.saby.trucks.count,2);
  assert.equal(secondSaved.at(-1).saby_continuation_root_job_id,originalId);
  assert.equal(secondSaved.at(-1).saby_continuation_source_job_id,resumedId);
  assert.equal(JSON.stringify(secondSource),before,"child source stays immutable");
  assert.equal(validateSabyOnlySource(secondSaved.at(-1)).code,"NO_SABY_PENDING");
});

test("no Saby-only invocation is allowed when Stage12 bulk gate is disabled",async()=>{
  await assert.rejects(
    runSabyOnlyContinuation({checkpoint:source(),sourceJobId:originalId,
      env:{...env,SABY_STAGE12_ENABLED:"false"},
      sessionRunner:()=>assert.fail("browser never launched")}),
    /SABY_BULK_NOT_ENABLED/
  );
});

test("server routes Saby-only away from paid OpenAI pipeline and only accepts stored SQLite checkpoints",()=>{
  const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
  const module=fs.readFileSync(new URL("../src/sabyOnlyContinuation.js",import.meta.url),"utf8");
  assert.match(server,/job\.mode === "saby_only"\s*\? await runSabyOnlyContinuation/);
  assert.match(server,/mode !== "saby_only"/);
  assert.match(server,/const persisted=await loadCheckpoint\(checkpointId\)/);
  assert.match(server,/SABY_CHECKPOINT_STALE/);
  assert.match(server,/latestSabyCheckpointForRegion/);
  assert.match(server,/saby_checkpoint:await latestSabyCheckpointForRegion/);
  assert.doesNotMatch(module,/from "\.\/pipeline\.js"|from "openai"/);
});
