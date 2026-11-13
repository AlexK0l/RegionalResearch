import test from "node:test";
import assert from "node:assert/strict";
import {runSabyStage12} from "../src/sabyStage12.js";
import {SabyReview,sabyBrowserSettings} from "../src/sabyBrowser.js";

const env={
  SABY_STAGE12_ENABLED:"true",
  SABY_MAX_COMPANIES:"0",
  SABY_CHECKPOINT_EVERY:"1",
  SABY_CIRCUIT_AFTER:"3",
  SABY_DELAY_MS:"250",
  STAGE12_MAX_MS:"60000"
};
const sessionRunner=task=>task({page:{},settings:sabyBrowserSettings(env)});
const fixture=(n=6)=>({
  direct_buyers:Array.from({length:n},(_,index)=>({
    "ИНН":String(7707083800+index),
    "Организация":"ООО Автопарк "+index,
    "Телефон":"",
    "Наличие транспорта":"",
    "Основание":"C — подтверждённый грузопоток",
    __final_grade:"C"
  })),
  intermediaries:[],leasing:[],statistics:[]
});
function verified(row){
  return {
    source:"SABY",
    source_url:"https://profile.saby.ru/page/contractor-info?id="+row["ИНН"],
    collected_at:"2026-11-13T09:00:00Z",
    identity:{inn:row["ИНН"],name:row["Организация"],verified:true},
    contacts:{status:"collected",phones:["79991234567"],emails:[]},
    trucks:{status:"verified",count:1,vehicles:[{model:"КАМАЗ 5490",year:2020}]},
    errors:[]
  };
}

test("five consecutive missing/ambiguous companies do not stop the rest of the regional Saby batch",async()=>{
  const result=fixture(),visits=[],checkpoints=[];
  const out=await runSabyStage12({
    result,env,sessionRunner,
    collectCompany:async(_page,row)=>{
      visits.push(row["ИНН"]);
      if(visits.length<=5)
        throw new SabyReview(visits.length%2
          ?"Saby: однозначная организация по ИНН не найдена"
          :"Saby: неоднозначный результат по ИНН",{scope:"company"});
      return verified(row);
    },
    onCheckpoint:snapshot=>checkpoints.push(structuredClone(snapshot))
  });
  assert.equal(visits.length,6,"last company must still be visited");
  assert.equal(out.stats.scheduled,6);
  assert.equal(out.stats.processed,6);
  assert.equal(out.stats.review,5);
  assert.equal(out.stats.companyReviews,5);
  assert.equal(out.stats.systemicErrors,0);
  assert.equal(out.stats.circuitOpen,false);
  assert.equal(out.stats.verified,1);
  assert.equal(out.stats.deferred,5);
  assert.equal(out.completedInns.length,1);
  assert.equal(checkpoints.length,7,"per-company and terminal snapshots");
  assert.deepEqual(checkpoints.at(-1).deferredInns,out.deferredInns);
  assert.match(result.direct_buyers[5]["Телефон"],/^7[0-9]{10}$/);
  assert.equal(result.direct_buyers[0].__evidence,undefined);
});

test("systemic Playwright/browser errors still trip the circuit at configured threshold",async()=>{
  const result=fixture(),visits=[];
  const out=await runSabyStage12({
    result,env,sessionRunner,
    collectCompany:async(_page,row)=>{
      visits.push(row["ИНН"]);
      if(visits.length===1)
        throw new SabyReview("Saby: однозначная организация по ИНН не найдена",
          {scope:"company"});
      throw Error("Playwright browser became unavailable");
    }
  });
  assert.equal(out.stats.processed,4,"one company review plus three systemic errors");
  assert.equal(out.stats.companyReviews,1);
  assert.equal(out.stats.systemicErrors,3);
  assert.equal(out.stats.review,4);
  assert.equal(out.stats.circuitOpen,true);
  assert.equal(out.stats.deferred,6);
  assert.deepEqual(out.completedInns,[]);
});

test("missing shared search UI is systemic by default; contractor review is explicitly scoped",async()=>{
  assert.equal(new SabyReview("company missing",{scope:"company"}).scope,"company");
  assert.equal(new SabyReview("search field missing").scope,"systemic");
  assert.equal(new SabyReview("bad scope",{scope:"unknown"}).scope,"systemic");
  const result=fixture(5);
  const out=await runSabyStage12({
    result,env,sessionRunner,
    collectCompany:async()=>{throw new SabyReview("Search widget missing");}
  });
  assert.equal(out.stats.processed,3);
  assert.equal(out.stats.systemicErrors,3);
  assert.equal(out.stats.circuitOpen,true);
});

test("missing detail sections in one contractor do not become an outage across unrelated companies",async()=>{
  const result=fixture(5),visits=[];
  const out=await runSabyStage12({
    result,env,sessionRunner,
    collectCompany:async(_page,row)=>{
      visits.push(row["ИНН"]);
      if(visits.length===5)return verified(row);
      const record=verified(row);
      record.contacts={status:"missing",phones:[],emails:[]};
      record.trucks={status:"review"};
      return record;
    }
  });
  assert.equal(out.stats.processed,5);
  assert.equal(out.stats.companyReviews,4);
  assert.equal(out.stats.review,4);
  assert.equal(out.stats.systemicErrors,0);
  assert.equal(out.stats.circuitOpen,false);
  assert.equal(out.stats.verified,1);
  assert.equal(out.stats.deferred,4);
});
