import test from "node:test";
import assert from "node:assert/strict";
import {
  runSabyOnlyContinuation,SABY_ONLY_DEFAULT_MAX_MS,sabyOnlyMaxDurationMs
} from "../src/sabyOnlyContinuation.js";
import {sabyStage12Settings} from "../src/sabyStage12.js";
import {sabyBrowserSettings,SabyReview} from "../src/sabyBrowser.js";
import {PIPELINE_VERSION} from "../src/checkpointStore.js";

const ids=Array.from({length:6},(_,i)=>String(7707083800+i));
const env={
  SABY_STAGE12_ENABLED:"true",
  SABY_FLEET_TREE_PRODUCTION_ENABLED:"true",
  SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED:"true",
  SABY_HEADLESS:"false",
  SABY_MAX_COMPANIES:"0",
  SABY_CHECKPOINT_EVERY:"5",
  SABY_DELAY_MS:"250",
  SABY_CIRCUIT_AFTER:"3"
};
const source=()=>({
  version:1,pipeline_version:PIPELINE_VERSION,
  region:"Смоленская область",source_mode:"saby",phase:"completed",
  saby_completed_inns:[],
  saby_deferred_inns:[...ids],
  saby_attempted_inns:[],
  final_result:{
    direct_buyers:ids.map((inn,i)=>({
      "ИНН":inn,"Организация":"ООО Тест "+i,
      "Телефон":"","Наличие транспорта":"",
      "Основание":"C — подтверждённый грузопоток","__final_grade":"C"
    })),
    intermediaries:[],leasing:[],statistics:[]
  }
});
const reviewed=async()=>{
  throw new SabyReview("Saby: однозначная организация по ИНН не найдена",
    {scope:"company"});
};

test("Saby-only 12-hour budget is isolated from the 30-minute full research Stage12",()=>{
  assert.equal(SABY_ONLY_DEFAULT_MAX_MS,12*60*60*1000);
  assert.equal(sabyOnlyMaxDurationMs(env),SABY_ONLY_DEFAULT_MAX_MS);
  assert.equal(sabyStage12Settings(env).maxMs,30*60*1000,
    "ordinary full research keeps its old 30-minute deadline");
  assert.equal(sabyStage12Settings({...env,STAGE12_MAX_MS:"99999999"}).maxMs,
    120*60*1000,"ordinary Stage12 keeps its existing two-hour hard ceiling");
  assert.equal(sabyOnlyMaxDurationMs({...env,SABY_ONLY_MAX_MS:"7200000"}),7200000);
  assert.equal(sabyOnlyMaxDurationMs({...env,SABY_ONLY_MAX_MS:"999999999"}),24*60*60*1000);
  assert.equal(sabyOnlyMaxDurationMs({...env,SABY_ONLY_MAX_MS:"1"}),30*60*1000);
  assert.equal(sabyOnlyMaxDurationMs({...env,SABY_ONLY_MAX_MS:"not-number"}),
    SABY_ONLY_DEFAULT_MAX_MS);
});

test("one Saby-only job traverses the entire deferred queue past the old 30-minute and two-hour limits",async()=>{
  // Controlled wall clock: each company uses 31 simulated minutes. Six
  // companies exceed 3 hours, but no actual browser or paid API is called.
  const actualDateNow=Date.now;
  let simulatedNow=actualDateNow();
  Date.now=()=>simulatedNow;
  const cp=source(),before=JSON.stringify(cp),saved=[],visited=[],progress=[];
  let sessions=0;
  try{
    const out=await runSabyOnlyContinuation({
      checkpoint:cp,
      sourceJobId:"f0000000-1111-4222-8333-999999999999",
      env,sessionRunner:async(task,{env:effectiveEnv})=>{
        sessions++;
        assert.equal(effectiveEnv.SABY_CHECKPOINT_EVERY,"1",
          "an unattended long sweep saves after every company");
        return task({page:{},settings:sabyBrowserSettings(effectiveEnv)});
      },
      collectCompany:async(_page,row)=>{
        visited.push(row["ИНН"]);
        simulatedNow+=31*60*1000;
        return reviewed();
      },
      persistCheckpoint:snapshot=>saved.push(structuredClone(snapshot)),
      onProgress:snapshot=>progress.push(structuredClone(snapshot))
    });
    assert.equal(sessions,1,"one shared browser session for the entire region");
    assert.deepEqual(visited,ids,"all six companies visited once");
    assert.equal(out.saby.processed,6);
    assert.equal(out.saby.verified,0);
    assert.equal(out.saby.companyReviews,6);
    assert.equal(out.saby.systemicErrors,0);
    assert.equal(out.saby.circuitOpen,false);
    assert.equal(out.saby.maxDurationMs,12*60*60*1000);
    assert.equal(out.saby.deadlineReached,false);
    assert.equal(out.saby.fullSweepCompleted,true,
      "sweep may be complete while companies remain unverified");
    assert.equal(out.saby.deferred,6);
    assert.equal(saved.length,9,
      "initial snapshot, six per-company checkpoints, terminal flush, final snapshot");
    assert.equal(saved.at(-1).phase,"completed");
    assert.equal(saved.at(-1).saby_stats.fullSweepCompleted,true);
    assert.deepEqual(saved.at(-1).saby_attempted_inns,ids);
    assert.equal(progress.at(-1).percent,100);
    assert.equal(JSON.stringify(cp),before,"source snapshot is immutable");
  } finally {
    Date.now=actualDateNow;
  }
});

test("explicit per-batch company guard remains respected when configured",async()=>{
  const saved=[],visited=[];
  const out=await runSabyOnlyContinuation({
    checkpoint:source(),
    sourceJobId:"f0000000-2222-4333-8444-999999999999",
    env:{...env,SABY_MAX_COMPANIES:"2",SABY_ONLY_MAX_MS:"5400000"},
    sessionRunner:async(task,{env:effectiveEnv})=>task({
      page:{},settings:sabyBrowserSettings(effectiveEnv)
    }),
    collectCompany:async(_page,row)=>{
      visited.push(row["ИНН"]);
      return reviewed();
    },
    persistCheckpoint:cp=>saved.push(structuredClone(cp))
  });
  assert.deepEqual(visited,ids.slice(0,2));
  assert.equal(out.saby.maxDurationMs,5400000);
  assert.equal(out.saby.fullSweepCompleted,false);
  assert.equal(out.saby.deferred,6);
  assert.deepEqual(saved.at(-1).saby_attempted_inns,ids.slice(0,2));
});
