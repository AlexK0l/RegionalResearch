import test from "node:test";
import assert from "node:assert/strict";
import {runSabyContactFirst} from "../src/sabyContactFirst.js";
import {runSabyOnlyContinuation} from "../src/sabyOnlyContinuation.js";
import {runCheckpointedSabyStage12} from "../src/sabyCheckpointIntegration.js";
import {MemoryPauseError,isMemoryPause} from "../src/memoryAdmission.js";
import {lookupPublicCompanyContacts} from "../src/publicContactParser.js";
import {sabyStoredSectionCoverage} from "../src/sabyEnrichment.js";

const env={SABY_STAGE12_ENABLED:"true",SABY_MAX_COMPANIES:"0",
  SABY_DELAY_MS:"250",STAGE12_MAX_MS:"60000",SABY_ONLY_MAX_MS:"60000",
  GIRBO_STAGE_ENABLED:"false",STAGE13_AI_ENABLED:"false",
  STAGE13_AI_SABY_ONLY_ENABLED:"false",SABY_FLEET_TREE_PRODUCTION_ENABLED:"true",
  SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED:"true",SABY_HEADLESS:"false"};
const innA="7707083893",innB="7702070139";
const row=(inn,name,grade="A")=>({__canonical_id:inn,__final_grade:grade,
  "ИНН":inn,"Организация":"ООО "+name,"Телефон":"","Электронная почта":"",
  "Выручка последнего подтвержденного года":"","Численность":"","Наличие транспорта":"",
  __evidence:{source_urls:["https://alpha.example.com/contacts"]}});
const result=(rows=[row(innA,"Альфа"),row(innB,"Бета","B")])=>({
  direct_buyers:rows,intermediaries:[],leasing:[],statistics:[]});
const sessionRunner=async task=>task({page:{},settings:{}});
const record=(r,sections,{emptyContacts=false}={})=>{
  const a=r["ИНН"]===innA;
  return {identity:{verified:true,inn:r["ИНН"],name:r["Организация"],kpp:a?"770101001":"770201001"},
    source:"SABY",source_url:"https://profile.saby.ru/page/contractor-info?id="+(a?
      "12345678-1234-1234-1234-123456789abc":"22345678-1234-1234-1234-123456789abc"),
    collected_at:"2026-11-25T00:00:00Z",
    contacts:sections.contacts?{status:"collected",phones:emptyContacts?[]:[a?"74951234567":"74951234568"],
      emails:emptyContacts?[]:[a?"sales@alpha.ru":"sales@beta.ru"]}:{status:"missing",phones:[],emails:[]},
    financials:sections.financials?{status:"collected",revenue_rub:1000000,revenue_year:2025,employees:12}:{status:"missing"},
    trucks:sections.trucks?{status:"verified",count:1,vehicles:[{model:"КАМАЗ 5490",year:2020}]}:{status:"missing"},
    errors:[]};
};

test("production contact sweep ignores legacy time limits, covers phones before any fleet and retains verified sections",async()=>{
  const db=result(),calls=[],saved=[];
  const realNow=Date.now;
  let now=realNow();
  Date.now=()=>now;
  try{
    const out=await runCheckpointedSabyStage12({result:db,env,contactFirst:true,sessionRunner,
      collectSections:async(_p,r,_s,sections)=>{
        calls.push({inn:r["ИНН"],...sections});
        now+=4*60*60*1000; // far beyond both legacy time caps
        return record(r,sections);
      },
      persistCheckpoint:async(phase,patch)=>saved.push(structuredClone({phase,...patch}))});
    assert.deepEqual(calls.map(x=>[x.inn,x.contacts,x.financials,x.trucks]),[
      [innA,true,false,false],[innB,true,false,false],
      [innA,false,true,true],[innB,false,true,true]]);
    assert.equal(out.stats.unlimited,true);
    assert.equal(out.stats.maxDurationMs,null);
    assert.equal(out.stats.deadlineReached,false);
    assert.equal(out.stats.fullSweepCompleted,true);
    assert.equal(out.stats.processed,2);
    assert.equal(out.stats.verified,2);
    assert.equal(out.stats.verifiedTasks,4);
    assert.equal(out.stats.phonesAdded,2);
    assert.equal(out.stats.emailsAdded,2);
    assert.deepEqual(out.deferredInns,[]);
    assert.ok(db.direct_buyers.every(r=>sabyStoredSectionCoverage(r,{transport:true}).complete));
    assert.ok(db.direct_buyers.every(r=>r["Выручка последнего подтвержденного года"]===1000000&&r["Численность"]===12));
    assert.equal(saved.at(-1).saby_pass_state.phase_index,4);
  }finally{Date.now=realNow;}
});

test("bounded gap retries do not make unlimited Saby an infinite loop",async()=>{
  const db=result([row(innA,"Альфа")]),calls=[];
  const out=await runSabyContactFirst({result:db,env,sessionRunner,
    collectSections:async(_p,r,_s,sections)=>{calls.push(sections);return record(r,sections,{emptyContacts:true});}});
  assert.equal(calls.filter(x=>x.contacts).length,2);
  assert.equal(calls.filter(x=>x.trucks).length,1);
  assert.equal(out.stats.fullSweepCompleted,true);
  assert.equal(out.stats.phonesAdded,0);
  assert.deepEqual(out.deferredInns,[innA]);
  assert.equal(out.passState.phase_index,4);
});

test("memory pause preserves exact section cursor, then resumes without repeating the committed contact visit",async()=>{
  const db=result(),calls=[],events=[];
  let saved;
  const collectSections=async(_p,r,_s,sections)=>{
    calls.push([r["ИНН"],sections.contacts?"contact":"details"]);
    return record(r,sections);
  };
  await assert.rejects(runSabyContactFirst({result:db,env,sessionRunner,collectSections,
    acquireSabyBrowser:async()=>()=>events.push("released"),
    persistCheckpoint:async(_phase,patch)=>{
      saved=structuredClone(patch);
      if(patch.saby_pass_state.attempted.length===1)throw new MemoryPauseError();
    }}),isMemoryPause);
  assert.deepEqual(saved.saby_pass_state.attempted,["contacts:"+innA]);
  assert.deepEqual(events,["released"]);
  const out=await runSabyContactFirst({result:saved.final_result,env,sessionRunner,collectSections,
    passState:saved.saby_pass_state});
  assert.deepEqual(calls,[[innA,"contact"],[innB,"contact"],[innA,"details"],[innB,"details"]]);
  assert.equal(out.stats.phonesAdded,2);
  assert.equal(out.stats.fullSweepCompleted,true);
});

test("Saby continues all eligible rows but honors explicit company cap and keeps failed launches deferred",async()=>{
  const limited=await runSabyContactFirst({result:result(),env:{...env,SABY_MAX_COMPANIES:"1"},sessionRunner,
    collectSections:async(_p,r,_s,sections)=>record(r,sections)});
  assert.equal(limited.stats.scheduled,1);
  assert.equal(limited.stats.fullSweepCompleted,false);
  assert.deepEqual(limited.deferredInns,[innB]);
  let launches=0,released=0;
  const failed=await runSabyContactFirst({result:result(),env,
    sessionRunner:async()=>{launches++;throw Error("launch failed");},
    recoveryWait:async()=>{},
    acquireSabyBrowser:async()=>()=>released++});
  assert.equal(launches,3);
  assert.equal(released,1);
  assert.equal(failed.stats.browserRestarts,2);
  assert.equal(failed.stats.fullSweepCompleted,false);
  assert.equal(failed.stats.processed,0);
  assert.deepEqual(failed.deferredInns,[innA,innB]);
});

test("production Saby-only path is unlimited too and releases Chromium before Stage13",async()=>{
  const events=[],source={version:1,pipeline_version:1,region:"Test",source_mode:"full",phase:"saby",
    completed_stage:9,final_result:result([row(innA,"Альфа")]),
    saby_completed_inns:[],saby_deferred_inns:[innA],contact_stats:{}};
  const saved=[];
  const out=await runSabyOnlyContinuation({checkpoint:source,sourceJobId:"12345678-1234-1234-1234-123456789abc",
    env,contactFirst:true,sessionRunner:async task=>{events.push("opened");try{return await task({page:{},settings:{}});}finally{events.push("closed");}},
    acquireSabyBrowser:async()=>{assert.ok(saved.length);events.push("acquired");return ()=>events.push("released");},
    collectSections:async(_p,r,_s,sections)=>record(r,sections),
    persistCheckpoint:async cp=>saved.push(structuredClone(cp)),
    onProgress:async p=>{if(p.phase==="priority")assert.ok(events.includes("released"))}});
  assert.equal(out.saby.unlimited,true);
  assert.equal(out.saby.phonesAdded,1);
  assert.equal(saved.at(-1).phase,"completed");
  assert.equal(saved.at(-1).contact_stats.final_phone_coverage.with_phone,1);
  assert.ok(events.indexOf("closed")<events.indexOf("released"));
});

test("public HTTP diagnostics distinguish TLS, DNS and robots without weakening identity checks",async()=>{
  const r=row(innA,"Альфа");
  r.__evidence={source_urls:["https://alpha.example.com/contacts","https://beta.example.com/contacts","https://gamma.example.com/contacts"]};
  const codes=["CONTACT_TLS_UNAVAILABLE","CONTACT_DNS_UNAVAILABLE","CONTACT_ROBOTS_DENIED"];
  let i=0;
  const out=await lookupPublicCompanyContacts(r,{exhausted:false,fetch:async()=>{
    throw Object.assign(Error("private network diagnostic"),{code:codes[i++]});
  }});
  assert.equal(out.reason,"source_unavailable");
  assert.deepEqual(out.facts,[]);
  assert.deepEqual(out.source_error_reasons,Object.fromEntries(codes.map(k=>[k,1])));
});

test("explicit continuation resets exhausted section cursor before a memory pause at startup",async()=>{
  const source={version:1,pipeline_version:1,region:"Test",source_mode:"full",phase:"completed",
    completed_stage:9,final_result:result([row(innA,"Альфа")]),
    saby_completed_inns:[],saby_deferred_inns:[innA],
    saby_pass_state:{version:1,planned_inns:[innA],attempted:["contacts:"+innA],
      phase_index:4,stats:{}}};
  await assert.rejects(runSabyOnlyContinuation({checkpoint:source,
    sourceJobId:"12345678-1234-1234-1234-123456789abc",env,contactFirst:true,
    sessionRunner:async()=>assert.fail("must not open before durable admission"),
    persistCheckpoint:async cp=>{
      assert.equal(cp.saby_pass_state,null);
      throw new MemoryPauseError();
    }}),isMemoryPause);
});
