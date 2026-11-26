import test from "node:test";
import assert from "node:assert/strict";
import {runSabyInnRecoveryStage} from "../src/sabyInnRecoveryStage.js";
import {runCheckpointedSabyStage12} from "../src/sabyCheckpointIntegration.js";
import {parseFnsSearchResult,fnsSourceUrl} from "../src/independentInnFns.js";
import {MemoryPauseError,isMemoryPause} from "../src/memoryAdmission.js";
const env={SABY_STAGE12_ENABLED:"true",SABY_INN_RECOVERY_ENABLED:"true",
  SABY_DELAY_MS:"250",SABY_MAX_COMPANIES:"0",SABY_FAST_PASS_ENABLED:"true",
  GIRBO_STAGE_ENABLED:"false"};
const makeResult=()=>({direct_buyers:[{
  __canonical_id:"k1","ИНН":"","Организация":"АО Пример","Город/район":"Кировск",
  "Телефон":"","Выручка последнего подтвержденного года":"","Численность":"",
  __evidence:{notes:[],source_urls:[]}
}],intermediaries:[],leasing:[],statistics:[]});
const region="Ленинградская область";
const never=()=>assert.fail("must not launch an unapproved browser");
test("identity recovery is opt-in, skipped for an existing completed preparation or without admission",async()=>{
  const result=makeResult();
  assert.equal(await runSabyInnRecoveryStage({result,region,env:{},lookupRunner:never}),null);
  const priorStats={finished:true,added:1};
  assert.equal(await runSabyInnRecoveryStage({result,region,env,priorStats,lookupRunner:never}),priorStats);
  const saved=[];
  const blocked=await runSabyInnRecoveryStage({result,region,env,lookupRunner:never,
    persistCheckpoint:async(phase,p)=>saved.push(structuredClone({phase,...p}))});
  assert.equal(blocked.stop_reason,"registry_admission_unavailable");
  assert.equal(blocked.pending,1);
  assert.equal(saved.at(-1).saby_pass_state,null);
  assert.equal(result.direct_buyers[0]["ИНН"],"");
});
test("registry preflight failure releases its admitted browser and retains all source rows",async()=>{
  const result=makeResult(),events=[],saved=[];
  const out=await runSabyInnRecoveryStage({result,region,env,
    acquireSabyBrowser:async()=>{events.push("acquire");return ()=>events.push("release");},
    lookupRunner:async(task,options)=>{
      assert.equal(options.provider,"fns");assert.equal(options.confirmationMode,"extract");
      events.push("open");try{await task({search:never,confirm:never});}finally{events.push("close");}
    },canary:async()=>({verified:false}),
    persistCheckpoint:async(phase,p)=>saved.push(structuredClone({phase,...p}))});
  assert.deepEqual(events,["acquire","open","close","release"]);
  assert.equal(out.stop_reason,"fns_preflight_failed");
  assert.equal(out.finished,true);
  assert.equal(saved.at(-1).final_result.direct_buyers[0]["ИНН"],"");
  assert.deepEqual(saved.at(-1).saby_deferred_inns,[]);
});
test("durable preparation does not swallow storage or cooperative memory failures",async()=>{
  const result=makeResult();
  await assert.rejects(runSabyInnRecoveryStage({result,region,env,lookupRunner:never,
    persistCheckpoint:async()=>{throw Error("disk write failed");}}),/disk write failed/);
  await assert.rejects(runSabyInnRecoveryStage({result,region,env,lookupRunner:never,
    acquireSabyBrowser:async()=>{throw new MemoryPauseError();}}),isMemoryPause);
});
test("old active Saby cursor is not expanded with registry recovery",async()=>{
  const result=makeResult();
  const out=await runCheckpointedSabyStage12({result,region,env,contactFirst:true,
    passState:{version:1,planned_inns:[],attempted:[],phase_index:2},
    innRecoveryLookupRunner:never,sessionRunner:never,acquireSabyBrowser:never});
  assert.equal(out.passState.fleet_scope,"direct_buyers_v1");
  assert.equal(out.stats.fleetCoverage.invalid,1);
});
test("a completed registry review is checkpointed once and resumes without duplicate lookup",async()=>{
  const result=makeResult(),events=[],saved=[];
  const options={result,region,env,
    acquireSabyBrowser:async()=>{events.push("acquire");return ()=>events.push("release");},
    lookupRunner:async(task)=>task({search:async()=>({state:"unconfirmed",records:[]}),confirm:never}),
    canary:async()=>({verified:true}),persistCheckpoint:async(phase,p)=>saved.push(structuredClone({phase,...p}))};
  const out=await runSabyInnRecoveryStage(options);
  assert.equal(out.processed,1);
  assert.equal(out.review,1);
  assert.equal(out.finished,true);
  assert.equal(result.direct_buyers[0]["ИНН"],"");
  assert.equal(saved.at(-1).independent_inn_backfill_outcomes.k1.status,"review");
  assert.equal((await runSabyInnRecoveryStage({...options,
    priorOutcomes:saved.at(-1).independent_inn_backfill_outcomes,
    priorStats:saved.at(-1).saby_inn_recovery_stats,lookupRunner:never})).processed,1);
  assert.deepEqual(events,["acquire","release"]);
});


test("official extract recovery adds the exact INN before the Saby plan and closes its browser first",async()=>{
  const result=makeResult(),events=[],saved=[];
  const inn="4706000909",ogrn="1024701329377",kpp="470601001";
  const raw={k:"ul",i:inn,o:ogrn,p:kpp,n:'АКЦИОНЕРНОЕ ОБЩЕСТВО "ПРИМЕР"',
    c:'АО "ПРИМЕР"',a:"187300, ОБЛАСТЬ ЛЕНИНГРАДСКАЯ, Г.КИРОВСК, УЛ. ЖЕЛЕЗНОДОРОЖНАЯ, Д.59",
    tot:"1",pg:"1"};
  // Fixture mirrors the real strict FNS PDF-backed recovery tests.
  // The preflight is injected so no real network or Chromium is used.
  const search=parseFnsSearchResult({rows:[raw]},
    {query:raw.c,completeNameSearch:true});
  const proof={kind:"fns_extract",url:fnsSourceUrl(inn),
    record:{...search.records[0].record,active:true},
    extract:{date:"24.11.2026",number:"ЮЭ9965-26-254581820",page_count:17,
      status_basis:"complete_extract_no_adverse_status",sha256:"b".repeat(64)}};
  const out=await runSabyInnRecoveryStage({result,region,env,
    acquireSabyBrowser:async()=>{events.push("acquire");return ()=>events.push("release");},
    lookupRunner:async task=>{
      events.push("open");
      try{await task({search:async()=>search,confirm:async id=>{
        assert.equal(id,ogrn);return proof;
      }});}finally{events.push("close");}
    },canary:async()=>({verified:true}),
    persistCheckpoint:async(phase,p)=>saved.push(structuredClone({phase,...p}))});
  assert.equal(out.added,1);
  assert.equal(result.direct_buyers[0]["ИНН"],inn);
  assert.equal(result.direct_buyers[0].__evidence.identity_verification.method,"fns_official_extract");
  assert.deepEqual(saved.at(-1).saby_deferred_inns,[inn]);
  assert.deepEqual(events,["acquire","open","close","release"]);
  let visited=0;
  const sweep=await runCheckpointedSabyStage12({result,region,env,contactFirst:true,
    innRecoveryPriorStats:saved.at(-1).saby_inn_recovery_stats,
    innRecoveryPriorOutcomes:saved.at(-1).independent_inn_backfill_outcomes,
    innRecoveryLookupRunner:never,
    sessionRunner:async task=>task({page:{},settings:{}}),
    acquireSabyBrowser:async()=>{events.push("saby_acquire");return ()=>events.push("saby_release");},
    collectSections:async(_p,row,_s,sections)=>{
      visited++;
      assert.equal(row["ИНН"],inn);assert.equal(sections.trucks,true);
      return {identity:{verified:true,inn,name:row["Организация"],kpp},
        source_url:"https://profile.saby.ru/page/contractor-info?id=12345678-1234-1234-1234-123456789abc",
        collected_at:"2026-11-26T12:00:00Z",
        contacts:{status:"collected",phones:["74951234567"],emails:["office@example.ru"]},
        trucks:{status:"verified",count:1,vehicles:[{model:"КАМАЗ 5490",year:2020}]},
        financials:{status:"collected",revenue_rub:1000000,revenue_year:2025,employees:12}};
    }
  });
  assert.equal(visited,1);
  assert.equal(sweep.stats.fleetCoverage.positive,1);
  assert.deepEqual(sweep.deferredInns,[]);
  assert.deepEqual(events,["acquire","open","close","release","saby_acquire","saby_release"]);
});
test("cancellation during registry lookup does not apply the subsequent proof",async()=>{
  const result=makeResult(),abort=new AbortController(),events=[];
  await assert.rejects(runSabyInnRecoveryStage({result,region,env,signal:abort.signal,
    acquireSabyBrowser:async()=>()=>events.push("release"),
    lookupRunner:async task=>task({search:async()=>{
      abort.abort();return {state:"unconfirmed",records:[]};
    },confirm:never}),
    canary:async()=>({verified:true})
  }),/JOB_CANCELLED/);
  assert.equal(result.direct_buyers[0]["ИНН"],"");
  assert.deepEqual(events,["release"]);
});
