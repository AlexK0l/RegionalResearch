import test from "node:test";
import assert from "node:assert/strict";
import {runCheckpointedSabyStage12} from "../src/sabyCheckpointIntegration.js";

const env={
  SABY_STAGE12_ENABLED:"true",
  SABY_MAX_COMPANIES:"0",
  SABY_CHECKPOINT_EVERY:"1",
  SABY_DELAY_MS:"250",
  STAGE12_MAX_MS:"60000"
};
const fixture=()=>({
  direct_buyers:[],
  leasing:[],
  intermediaries:[{
    "Организация":"ООО Тестовый перевозчик",
    "ИНН":"7707083893",
    "Телефон":"",
    "Электронная почта":"",
    "Основание":"C — грузоперевозки",
    "__final_grade":"C",
    "__evidence":{source_urls:[],notes:[]}
  }],
  statistics:[]
});
const record=company=>({
  identity:{
    inn:company["ИНН"],
    name:company["Организация"],
    verified:true
  },
  source:"SABY",
  source_url:"https://profile.saby.ru/page/contractor-info?id=one",
  contacts:{
    status:"collected",
    phones:[],
    emails:["orders@example.org"]
  },
  trucks:{status:"missing"},
  financials:{status:"missing"},
  errors:[]
});

test("normal browser research recovers an unavailable Chromium on next session without replaying companies",async()=>{
  const result=fixture(),saved=[],progress=[];
  let sessionAttempts=0,visited=0;
  const outcome=await runCheckpointedSabyStage12({
    result,env,recoverBrowserSession:true,recoveryWait:async()=>{},
    sessionRunner:async task=>{
      sessionAttempts++;
      if(sessionAttempts===1)throw Error("Chromium launch lost display :99");
      return task({page:{},settings:{}});
    },
    collectCompany:async(_page,company)=>{
      visited++;
      return record(company);
    },
    persistCheckpoint:async(phase,patch)=>
      saved.push({phase,patch:structuredClone(patch)}),
    onProgress:async stats=>progress.push(structuredClone(stats))
  });
  assert.equal(sessionAttempts,2);
  assert.equal(visited,1,"no duplicate Saby company visits");
  assert.equal(outcome.stats.processed,1);
  assert.equal(outcome.stats.verified,1);
  assert.equal(outcome.stats.browserRestarts,1);
  assert.equal(outcome.stats.deferred,0);
  assert.equal(outcome.stats.browserError,"");
  assert.equal(outcome.stats.fullSweepCompleted,true);
  assert.equal(result.intermediaries[0]["Электронная почта"],
    "orders@example.org");
  assert.equal(saved.at(-1).phase,"saby");
  assert.equal(saved.at(-1).patch.saby_deferred_inns.length,0);
  assert.ok(progress.some(x=>x.restarting),"the user sees a reconnect status");
});

test("3 failed headed sessions keep every company deferred and preserve all input facts",async()=>{
  const result=fixture(),original=JSON.stringify(result),saved=[];
  let attempts=0;
  const outcome=await runCheckpointedSabyStage12({
    result,env,recoverBrowserSession:true,recoveryWait:async()=>{},
    sessionRunner:async()=>{
      attempts++;throw Error("Saby browser cannot attach to DISPLAY :99");
    },
    collectCompany:async()=>{throw Error("must not collect");},
    persistCheckpoint:async(phase,patch)=>
      saved.push({phase,patch:structuredClone(patch)})
  });
  assert.equal(attempts,3);
  assert.equal(outcome.stats.processed,0);
  assert.equal(outcome.stats.verified,0);
  assert.equal(outcome.stats.deferred,1);
  assert.equal(outcome.stats.browserRestarts,2);
  assert.match(outcome.stats.browserError,/DISPLAY :99/);
  assert.equal(outcome.stats.fullSweepCompleted,false);
  assert.equal(JSON.stringify(result),original,
    "browser startup cannot mutate paid research facts");
  assert.equal(saved.at(-1).phase,"saby");
  assert.deepEqual(saved.at(-1).patch.saby_attempted_inns,[]);
  assert.deepEqual(saved.at(-1).patch.saby_deferred_inns,["7707083893"]);
});

test("Saby work deadline starts only after shared Chromium queue acquired",async()=>{
  const originalDateNow=Date.now;
  let fakeNow=originalDateNow();
  Date.now=()=>fakeNow;
  const result=fixture();
  let visits=0;
  try{
    const out=await runCheckpointedSabyStage12({
      result,env,
      // Without queue-aware clock, the old version treated this legitimate
      // 10-minute mutex wait as using up its 1-minute Saby deadline.
      sessionRunner:async task=>{
        fakeNow+=10*60*1000;
        return task({page:{},settings:{}});
      },
      collectCompany:async(_page,company)=>{
        visits++;return record(company);
      }
    });
    assert.equal(visits,1);
    assert.equal(out.stats.processed,1);
    assert.equal(out.stats.deadlineReached,false);
  } finally {
    Date.now=originalDateNow;
  }
});

test("Saby disabled or no pending never starts auto-reconnect",async()=>{
  const result=fixture();
  let attempts=0;
  const out=await runCheckpointedSabyStage12({
    result,
    recoverBrowserSession:true,
    env:{...env,SABY_STAGE12_ENABLED:"false"},
    sessionRunner:async()=>{attempts++;throw Error("must not run");}
  });
  assert.equal(attempts,0);
  assert.equal(out.stats.enabled,false);
});
