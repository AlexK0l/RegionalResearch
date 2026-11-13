import test from "node:test";
import assert from "node:assert/strict";
import {runSabyStage12} from "../src/sabyStage12.js";
import {runSabyOnlyContinuation} from "../src/sabyOnlyContinuation.js";
import {SabyReview,sabyBrowserSettings} from "../src/sabyBrowser.js";
import {PIPELINE_VERSION} from "../src/checkpointStore.js";

const env={
  SABY_STAGE12_ENABLED:"true",
  SABY_MAX_COMPANIES:"2",
  SABY_CHECKPOINT_EVERY:"1",
  SABY_CIRCUIT_AFTER:"3",
  SABY_DELAY_MS:"250",
  SABY_FLEET_TREE_PRODUCTION_ENABLED:"true",
  SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED:"true",
  SABY_HEADLESS:"false"
};
const ids=Array.from({length:6},(_,i)=>String(7707083800+i));
const makeResult=()=>({
  direct_buyers:ids.map((id,i)=>({
    "ИНН":id,"Организация":"ООО Организация "+i,
    "Телефон":"","Наличие транспорта":"",
    "Основание":"C — подтверждённый грузопоток","__final_grade":"C"
  })),
  intermediaries:[],leasing:[],statistics:[]
});
const sessionRunner=async task=>task({
  page:{},settings:sabyBrowserSettings(env)
});
const unavailable=async()=>{throw new SabyReview("No exact INN candidate",
  {scope:"company"});};

test("bulk Stage12 visits all untouched firms before retrying reviewed INNs",async()=>{
  const result=makeResult(),allVisits=[],checkpointSnapshots=[];
  let attempted=[];
  for(let pass=0;pass<4;pass++){
    const visits=[],snapshot=[];
    const out=await runSabyStage12({
      result,env,attemptedInns:attempted,sessionRunner,
      collectCompany:async(_page,row)=>{
        visits.push(row["ИНН"]);
        return unavailable();
      },
      onCheckpoint:x=>snapshot.push(structuredClone(x))
    });
    assert.equal(out.stats.scheduled,2);
    assert.equal(out.stats.processed,2);
    assert.equal(out.stats.companyReviews,2);
    assert.equal(out.stats.systemicErrors,0);
    assert.equal(out.stats.circuitOpen,false);
    assert.equal(out.stats.deferred,6);
    assert.equal(out.stats.freshScheduled,2);
    assert.equal(snapshot.length,3,"two per-company and final");
    assert.deepEqual(snapshot.at(-1).attemptedInns,out.attemptedInns);
    if(pass<3) {
      assert.equal(new Set([...allVisits,...visits]).size,
        (pass+1)*2,"do not repeat firms before all unvisited are reached");
    }else{
      assert.deepEqual(visits,allVisits.slice(0,2),
        "only after all companies were tried may first reviews be retried");
    }
    if(pass<3)allVisits.push(...visits);
    attempted=out.attemptedInns;
  }
  assert.equal(new Set(allVisits).size,6);
  assert.equal(attempted.length,6,"durable sweep state persists reviews");
});

test("old Stage12 checkpoints recover fair order from trusted partial Saby evidence alone",async()=>{
  const result=makeResult();
  const original=await runSabyStage12({
    result,env:{...env,SABY_MAX_COMPANIES:"1"},
    sessionRunner,
    collectCompany:async(_page,row)=>({
      source:"SABY",
      source_url:"https://profile.saby.ru/page/contractor-info?id="+row["ИНН"],
      identity:{inn:row["ИНН"],name:row["Организация"],verified:true},
      contacts:{status:"collected",phones:[],emails:[]},
      trucks:{status:"review"},errors:[]
    })
  });
  assert.equal(original.stats.processed,1);
  assert.equal(original.stats.partialResults,1);
  const visited=[];
  const second=await runSabyStage12({
    result,env:{...env,SABY_MAX_COMPANIES:"1"},
    // Historical checkpoints had no saby_attempted_inns field.
    sessionRunner,
    collectCompany:async(_page,row)=>{
      visited.push(row["ИНН"]);
      return unavailable();
    }
  });
  assert.deepEqual(visited,[ids[1]]);
  assert.equal(second.stats.retryScheduled,0);
  assert.equal(second.stats.freshScheduled,1);
});

test("Saby-only continuation stores a fair cursor in a NEW SQLite child checkpoint and carries it to the next attempt",async()=>{
  const original={
    version:1,pipeline_version:PIPELINE_VERSION,source_mode:"full",
    phase:"completed",region:"Смоленская область",
    final_result:makeResult(),
    saby_completed_inns:[],saby_deferred_inns:ids
  };
  const serialized=JSON.stringify(original),firstVisits=[],firstSaved=[];
  const first=await runSabyOnlyContinuation({
    checkpoint:original,
    sourceJobId:"fc23457a-1111-4444-8888-111111111111",
    env,sessionRunner,
    collectCompany:async(_page,row)=>{
      firstVisits.push(row["ИНН"]);return unavailable();
    },
    persistCheckpoint:x=>firstSaved.push(structuredClone(x))
  });
  assert.equal(first.saby.processed,2);
  assert.deepEqual(firstVisits,ids.slice(0,2));
  assert.deepEqual(firstSaved.at(-1).saby_attempted_inns,ids.slice(0,2));
  assert.deepEqual(firstSaved.at(-1).saby_deferred_inns,ids);
  assert.equal(JSON.stringify(original),serialized,"immutable parent");

  const secondVisits=[],secondSaved=[];
  await runSabyOnlyContinuation({
    checkpoint:firstSaved.at(-1),
    sourceJobId:"fc23457a-2222-4444-8888-222222222222",
    env,sessionRunner,
    collectCompany:async(_page,row)=>{
      secondVisits.push(row["ИНН"]);return unavailable();
    },
    persistCheckpoint:x=>secondSaved.push(structuredClone(x))
  });
  assert.deepEqual(secondVisits,ids.slice(2,4));
  assert.deepEqual(secondSaved.at(-1).saby_attempted_inns,ids.slice(0,4));
  assert.equal(secondSaved.at(-1).saby_continuation_root_job_id,
    "fc23457a-1111-4444-8888-111111111111");
});

test("unexpected, malformed and completed INNs cannot poison the fair cursor",async()=>{
  const result=makeResult(),visited=[];
  const out=await runSabyStage12({
    result,env,
    completedInns:[ids[0]],
    attemptedInns:[ids[0],ids[1],ids[1],"invalid","1234567890"],
    sessionRunner,
    collectCompany:async(_page,row)=>{
      visited.push(row["ИНН"]);return unavailable();
    }
  });
  assert.deepEqual(visited,ids.slice(2,4));
  assert.deepEqual(out.attemptedInns,ids.slice(1,4));
  assert.equal(out.stats.freshScheduled,2);
  assert.equal(out.stats.retryScheduled,0);
});
