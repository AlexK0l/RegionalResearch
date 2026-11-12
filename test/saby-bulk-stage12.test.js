import test from "node:test";
import assert from "node:assert/strict";
import {sabyBrowserSettings} from "../src/sabyBrowser.js";
import {runSabyStage12} from "../src/sabyStage12.js";

const inns=["7707083893","7702070139","7736207543"];
const phoneNumbers=["+7 (999) 111-11-11","+7 (999) 222-22-22",
  "+7 (999) 333-33-33"];
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

function fixture(){
  return {
    direct_buyers:inns.map((inn,index)=>({
      "ИНН":inn,"Организация":names[index],"Телефон":"",
      "Основание":"C — проверяемый грузопоток","__final_grade":"C"
    })),
    intermediaries:[],leasing:[],statistics:[]
  };
}

function verified(row){
  const index=inns.indexOf(row["ИНН"]);
  assert.ok(index>=0);
  return {
    source:"SABY",
    source_url:"https://profile.saby.ru/page/contractor-info?id="+row["ИНН"],
    collected_at:"2026-11-12T10:00:00Z",
    identity:{inn:row["ИНН"],name:row["Организация"],verified:true},
    contacts:{status:"collected",phones:[phoneNumbers[index]],
      phone_details:[],emails:["company"+index+"@example.test"]},
    trucks:{status:"verified",count:2,vehicles:[
      {model:"KAMAZ 5490",year:2020},
      {model:"KAMAZ 5490",year:2020}
    ]},
    errors:[]
  };
}

test("bulk Stage12 processes all eligible INNs once in a single browser session with per-company durable checkpoint",async()=>{
  const result=fixture(),sessions=[],visited=[],checkpoints=[];
  const originalGrade=result.direct_buyers.map(r=>r["Основание"]);
  const out=await runSabyStage12({
    result,env,
    sessionRunner:async task=>{
      sessions.push(1);
      const settings=sabyBrowserSettings(env);
      assert.equal(settings.fleetTreeProductionOptIn,true);
      assert.equal(settings.fleetTailClickOptIn,false);
      return task({page:{},settings});
    },
    collectCompany:async (_page,row)=>{
      visited.push(row["ИНН"]);
      return verified(row);
    },
    onCheckpoint:async snapshot=>checkpoints.push(structuredClone(snapshot))
  });
  assert.equal(sessions.length,1,"no parallel browser sessions");
  assert.deepEqual(new Set(visited),new Set(inns));
  assert.equal(visited.length,3,"no duplicate visits");
  assert.equal(out.stats.scheduled,3);
  assert.equal(out.stats.processed,3);
  assert.equal(out.stats.verified,3);
  assert.equal(out.stats.transportsAdded,3);
  assert.equal(out.stats.vehiclesVerified,6);
  assert.equal(out.stats.review,0);
  assert.equal(out.stats.deferred,0);
  assert.deepEqual(new Set(out.completedInns),new Set(inns));
  assert.deepEqual(out.deferredInns,[]);
  assert.equal(checkpoints.length,4,"checkpoint every firm plus final");
  assert.deepEqual(checkpoints.at(-1).deferredInns,[]);
  for(let i=0;i<3;i++){
    const row=result.direct_buyers[i];
    assert.equal(row["Основание"],originalGrade[i]);
    assert.equal(row.__final_grade,"C");
    assert.equal(row.__evidence.saby.trucks.vehicles.length,2);
    assert.equal(row.__evidence.saby.trucks.count,2);
    assert.match(row["Наличие транспорта"],/KAMAZ 5490 \(2020 г\.\) — 2 шт\./);
    assert.ok(/^7[0-9]{10}$/.test(row["Телефон"]));
  }
});

test("bulk Stage12 preserves partial contacts, defers only failed fleet and resumes without reprocessing completed INNs",async()=>{
  const result=fixture(),firstVisits=[],saved=[];
  const first=await runSabyStage12({
    result,env,
    sessionRunner:async task=>task({page:{},settings:sabyBrowserSettings(env)}),
    collectCompany:async (_page,row)=>{
      firstVisits.push(row["ИНН"]);
      const record=verified(row);
      if(row["ИНН"]===inns[1]) record.trucks={status:"review"};
      return record;
    },
    onCheckpoint:async x=>saved.push(structuredClone(x))
  });
  assert.equal(firstVisits.length,3);
  assert.equal(first.stats.review,0,"valid contacts are still useful");
  assert.equal(first.stats.partialResults,1);
  assert.equal(first.stats.transportsAdded,2);
  assert.equal(first.stats.deferred,1);
  assert.deepEqual(first.deferredInns,[inns[1]]);
  assert.equal(result.direct_buyers[1].__evidence.saby.trucks,undefined);
  assert.ok(/^7[0-9]{10}$/.test(result.direct_buyers[1]["Телефон"]));
  assert.deepEqual(saved.at(-1).deferredInns,[inns[1]]);

  const secondVisits=[];
  const second=await runSabyStage12({
    result,completedInns:first.completedInns,env,
    sessionRunner:async task=>task({page:{},settings:sabyBrowserSettings(env)}),
    collectCompany:async (_page,row)=>{
      secondVisits.push(row["ИНН"]);
      const record=verified(row);
      record.contacts={status:"missing",phones:[],emails:[]};
      return record;
    }
  });
  assert.deepEqual(secondVisits,[inns[1]]);
  assert.equal(second.stats.scheduled,1);
  assert.equal(second.stats.processed,1);
  assert.equal(second.stats.deferred,0);
  assert.equal(second.stats.transportsAdded,1);
  assert.deepEqual(new Set(second.completedInns),new Set(inns));
  assert.equal(result.direct_buyers[1].__evidence.saby.trucks.count,2);
  assert.ok(/^7[0-9]{10}$/.test(result.direct_buyers[1]["Телефон"]),
    "stored phone survives fleet-only retry");
});
