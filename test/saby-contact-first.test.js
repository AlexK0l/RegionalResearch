import test from "node:test";
import assert from "node:assert/strict";
import {runSabyContactFirst} from "../src/sabyContactFirst.js";
import {runSabyOnlyContinuation} from "../src/sabyOnlyContinuation.js";
import {runCheckpointedSabyStage12} from "../src/sabyCheckpointIntegration.js";
import {MemoryPauseError,isMemoryPause} from "../src/memoryAdmission.js";
import {lookupPublicCompanyContacts} from "../src/publicContactParser.js";
import {sabyStoredSectionCoverage} from "../src/sabyEnrichment.js";

const env={SABY_STAGE12_ENABLED:"true",SABY_MAX_COMPANIES:"0",SABY_FAST_PASS_ENABLED:"false",
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


test("planned Chromium rotation closes each context, saves its cursor, rechecks RAM and preserves total progress",async()=>{
  const db=result(),events=[],calls=[],saved=[],progress=[];
  let lastSaved=0,collects=0;
  const release=()=>events.push("released");
  release.beforeReopen=async()=>{
    assert.equal(events.at(-1),"closed");
    assert.equal(saved.at(-1).saby_pass_state.attempted.length,lastSaved);
    events.push("admission");
  };
  const out=await runSabyContactFirst({result:db,env:{...env,SABY_BROWSER_RECYCLE_EVERY:"1",SABY_GC_EVERY:"1"},
    acquireSabyBrowser:async()=>{events.push("acquired");return release;},
    collectGarbage:()=>collects++,
    sessionRunner:async task=>{
      events.push("open");try{return await task({page:{},settings:{}});}
      finally{events.push("closed");}
    },
    collectSections:async(_p,r,_s,sections)=>{
      calls.push([r["ИНН"],sections.contacts?"contacts":"details"]);
      lastSaved++;
      return record(r,sections);
    },
    persistCheckpoint:async(_phase,patch)=>saved.push(structuredClone(patch)),
    onProgress:async p=>progress.push(p)
  });
  assert.deepEqual(calls,[[innA,"contacts"],[innB,"contacts"],[innA,"details"],[innB,"details"]]);
  assert.equal(out.stats.browserRotations,3);
  assert.equal(out.stats.browserRestarts,0);
  assert.equal(out.stats.fullSweepCompleted,true);
  assert.equal(out.stats.deadlineReached,false);
  assert.ok(collects>=7);
  assert.equal(events.filter(x=>x==="open").length,4);
  assert.equal(events.filter(x=>x==="admission").length,3);
  assert.equal(events.at(-1),"released");
  const contacts=progress.filter(x=>x.phase==="contacts");
  assert.deepEqual(contacts.map(x=>x.passProcessed),[0,1,1,2]);
  assert.ok(contacts.every(x=>x.passTotal===2));
});

test("storage failure at a planned rotation is not misclassified as a browser failure",async()=>{
  let launches=0,closed=false;
  await assert.rejects(runSabyContactFirst({result:result(),
    env:{...env,SABY_BROWSER_RECYCLE_EVERY:"1"},
    sessionRunner:async task=>{
      launches++;
      try{return await task({page:{},settings:{}});}finally{closed=true;}
    },
    collectSections:async(_p,r,_s,sections)=>record(r,sections),
    persistCheckpoint:async(_phase,patch)=>{
      if(closed&&patch.saby_stats.browserRotations===1)throw Error("disk write failed");
    }}),/disk write failed/);
  assert.equal(launches,1);
});

test("optimized first visit completes mounted contacts, finance and small complete fleets without reopening",async()=>{
  const db=result(),calls=[],saved=[];
  const out=await runSabyContactFirst({result:db,env:{...env,SABY_FAST_PASS_ENABLED:"true"},sessionRunner,
    collectSections:async(_p,r,_s,sections)=>{
      calls.push({inn:r["ИНН"],...sections});
      return {...record(r,sections),timing:{full_search:true,search_ms:11,identity_ms:8,contacts_ms:5,financials_ms:4,fleet_ms:3}};
    },persistCheckpoint:async(_phase,patch)=>saved.push(structuredClone(patch))});
  assert.deepEqual(calls.map(c=>[c.inn,c.contacts,c.financials,c.trucks,c.quickDetails]),[
    [innA,true,true,true,true],[innB,true,true,true,true]]);
  assert.equal(out.stats.totalAttempts,2);
  assert.equal(out.stats.fullSweepCompleted,true);
  assert.deepEqual(out.deferredInns,[]);
  assert.equal(out.stats.timing.quick_fleet_completed,2);
  assert.equal(out.stats.timing.quick_finance_filled,2);
  assert.equal(out.stats.timing.full_searches,2);
  assert.equal(out.stats.timing.search_ms,22);
  assert.ok(db.direct_buyers.every(r=>r.__evidence.saby_navigation_hint));
  assert.equal(saved.at(-1).saby_pass_state.strategy,"combined_visible_v1");
});
test("incomplete quick details are never counted as a full fleet or finance attempt",async()=>{
  const db=result(),calls=[];
  const out=await runSabyContactFirst({result:db,env:{...env,SABY_FAST_PASS_ENABLED:"true"},sessionRunner,
    collectSections:async(_p,r,_s,sections)=>{
      calls.push({inn:r["ИНН"],...sections});
      const value=record(r,sections);
      if(sections.quickDetails){
        value.trucks={status:"missing"};
        value.financials={status:"collected",employees:12};
        if(r["ИНН"]===innA&&calls.length===1)value.contacts={status:"missing",phones:[],emails:[]};
      }
      return value;
    }});
  assert.deepEqual(calls.map(c=>[c.inn,c.contacts,c.quickDetails===true]),[
    [innA,true,true],[innB,true,true],[innA,true,true],[innA,false,false],[innB,false,false]]);
  assert.ok(calls.slice(3).every(c=>c.trucks&&c.financials));
  assert.equal(out.stats.fullSweepCompleted,true);
  assert.deepEqual(out.deferredInns,[]);
  assert.equal(out.stats.phonesAdded,2);
  assert.equal(out.stats.timing.quick_fleet_completed,0);
});
test("optimized sweep includes companies already having contacts and retains full details retries",async()=>{
  const a=row(innA,"Альфа"),b=row(innB,"Бета","B");
  a["Телефон"]="74951234567";a["Электронная почта"]="sales@alpha.ru";
  const calls=[];
  const out=await runSabyContactFirst({result:result([a,b]),env:{...env,SABY_FAST_PASS_ENABLED:"true"},sessionRunner,
    collectSections:async(_p,r,_s,sections)=>{
      calls.push({inn:r["ИНН"],...sections});
      const value=record(r,sections);
      if(r["ИНН"]===innA&&calls.filter(c=>c.inn===innA).length===1)value.trucks={status:"review"};
      return value;
    }});
  assert.deepEqual(calls.map(c=>[c.inn,c.contacts,c.trucks]),[[innB,true,true],[innA,false,true],[innA,false,true]]);
  assert.equal(out.stats.fullSweepCompleted,true);
  assert.equal(out.stats.totalAttempts,3);
  assert.deepEqual(out.deferredInns,[]);
});
test("legacy in-progress cursor keeps its scheduling semantics after the fast upgrade",async()=>{
  const db=result(),calls=[],first=record(db.direct_buyers[0],{contacts:true});
  const {applySabyEnrichment}=await import("../src/sabyEnrichment.js");
  applySabyEnrichment(db.direct_buyers[0],first);
  const out=await runSabyContactFirst({result:db,env:{...env,SABY_FAST_PASS_ENABLED:"true"},sessionRunner,
    passState:{version:1,planned_inns:[innA,innB],attempted:["contacts:"+innA],phase_index:0,
      verified_inns:[innA],stats:{phonesAdded:1}},
    collectSections:async(_p,r,_s,sections)=>{calls.push([r["ИНН"],sections.contacts,sections.financials,sections.trucks]);return record(r,sections);}});
  assert.deepEqual(calls,[[innB,true,false,false],[innA,false,true,true],[innB,false,true,true]]);
  assert.equal(out.passState.strategy,"section_passes_v1");
  assert.equal(out.stats.fullSweepCompleted,true);
});
test("a fast attempt with no usable facts saves its verified route and resumes the exact cursor",async()=>{
  const db=result([row(innA,"Альфа")]);let saved;
  await assert.rejects(runSabyContactFirst({result:db,env:{...env,SABY_FAST_PASS_ENABLED:"true"},sessionRunner,
    collectSections:async(_p,r)=>({...record(r,{}),timing:{full_search:true,search_ms:10}}),
    persistCheckpoint:async(_phase,p)=>{saved=structuredClone(p);if(p.saby_pass_state.attempted.length===1)throw new MemoryPauseError();}}),isMemoryPause);
  const r=saved.final_result.direct_buyers[0];
  assert.ok(r.__evidence.saby_navigation_hint);
  assert.equal(r.__evidence.saby,undefined);
  assert.equal(r["Телефон"],"");
  const calls=[];
  const out=await runSabyContactFirst({result:saved.final_result,passState:saved.saby_pass_state,
    env:{...env,SABY_FAST_PASS_ENABLED:"false"},sessionRunner,
    collectSections:async(_p,r,_s,sections)=>{calls.push(sections);return record(r,sections);}});
  assert.equal(calls.length,1);
  assert.equal(calls[0].quickDetails,true);
  assert.equal(out.stats.fullSweepCompleted,true);
  assert.equal(out.stats.timing.visits,2);
  assert.equal(out.stats.timing.search_ms,10);
});


test("fresh full sweep collects all three commercial groups even with existing contacts and finances",async()=>{
  const a=row(innA,"Альфа"),b=row(innB,"Бета"),c=row("7710140679","Гамма");
  const db={direct_buyers:[a],intermediaries:[b],leasing:[c],statistics:[]};
  for(const r of [a,b,c]){
    r["Телефон"]="74951234567";r["Электронная почта"]="sales@alpha.ru";
    r["Выручка последнего подтвержденного года"]=1000000;r["Численность"]=12;
  }
  const visits=[];
  const out=await runSabyContactFirst({result:db,env:{...env,SABY_FAST_PASS_ENABLED:"true"},sessionRunner,
    collectSections:async(_p,r,_s,sections)=>{
      visits.push([r["ИНН"],sections.contacts,sections.trucks]);
      const got=record(r,sections);
      if(r===c)got.trucks={status:"verified",count:0,vehicles:[]};
      return got;
    }});
  assert.equal(visits.length,3);
  assert.ok(visits.every(v=>!v[1]&&v[2]));
  assert.equal(out.passState.fleet_scope,"all_commercial_v1");
  assert.equal(out.stats.fleetCoverage.positive,2);
  assert.equal(out.stats.fleetCoverage.zero,1);
  assert.equal(out.stats.fleetCoverage.unknown,0);
  assert.equal(out.stats.fleetCoverage.by_sheet.intermediaries.positive,1);
  assert.equal(out.stats.fleetCoverage.by_sheet.leasing.zero,1);
  assert.equal(out.stats.fleetCoverage.vehicles,2);
  assert.deepEqual(out.deferredInns,[]);
  assert.match(b["Наличие транспорта"],/КАМАЗ 5490/);
  assert.equal(c.__evidence.saby.trucks.count,0);
});

test("old cursor retains direct-only scope and new all-group cursor pins scope across env changes",async()=>{
  const b=row(innB,"Бета");
  b["Телефон"]="74951234568";b["Электронная почта"]="sales@beta.ru";
  b["Выручка последнего подтвержденного года"]=1000000;b["Численность"]=12;
  const db={direct_buyers:[],intermediaries:[b],leasing:[],statistics:[]};
  const old=await runSabyContactFirst({result:db,env,sessionRunner,
    passState:{version:1,planned_inns:[innB],attempted:[],phase_index:2},
    collectSections:()=>assert.fail("legacy scope must not invent new work")});
  assert.equal(old.passState.fleet_scope,"direct_buyers_v1");
  assert.equal(old.stats.fleetCoverage.target,0);
  let saved;
  await assert.rejects(runSabyContactFirst({result:db,env,sessionRunner,
    acquireSabyBrowser:async()=>{throw new MemoryPauseError();},
    persistCheckpoint:async(_phase,p)=>{saved=structuredClone(p);}}),isMemoryPause);
  assert.equal(saved.saby_pass_state.fleet_scope,"all_commercial_v1");
  let visits=0;
  const resumed=await runSabyContactFirst({result:saved.final_result,
    passState:saved.saby_pass_state,env:{...env,SABY_ALL_COMPANY_FLEETS_ENABLED:"false"},sessionRunner,
    collectSections:async(_p,r,_s,sections)=>{
      visits++;assert.equal(sections.trucks,true);return record(r,sections);
    }});
  assert.equal(visits,1);
  assert.equal(resumed.passState.fleet_scope,"all_commercial_v1");
  assert.equal(resumed.stats.fleetCoverage.positive,1);
});

test("fresh scope opt-out does not add historical intermediary fleet work",async()=>{
  const b=row(innB,"Бета");
  Object.assign(b,{"Телефон":"74951234568","Электронная почта":"sales@beta.ru",
    "Выручка последнего подтвержденного года":1000000,"Численность":12});
  const out=await runSabyContactFirst({result:{direct_buyers:[],intermediaries:[b],leasing:[]},
    env:{...env,SABY_ALL_COMPANY_FLEETS_ENABLED:"false"},
    sessionRunner:()=>assert.fail("no unresolved sections")});
  assert.equal(out.passState.fleet_scope,"direct_buyers_v1");
  assert.equal(out.stats.fleetCoverage.target,0);
});


const combinedEnv={...env,SABY_FAST_PASS_ENABLED:"true",SABY_COMBINE_RETRY_DETAILS_ENABLED:"true"};
test("combine retry saves one visit without losing first full or second full fleet attempt",async()=>{
  const db=result([row(innA,"Альфа")]),calls=[];
  const out=await runSabyContactFirst({result:db,env:combinedEnv,sessionRunner,
    collectSections:async(_p,r,_s,sections)=>{
      calls.push({...sections});
      const v=record(r,sections,{emptyContacts:true});
      if(sections.quickDetails){v.trucks={status:"missing"};v.financials={status:"missing"};}
      if(sections.combinedDetails){
        v.trucks={status:"review"};v.financials={status:"missing"};
        v.full_detail_attempts={trucks:true,financials:true};
      }
      return v;
    }});
  assert.equal(out.passState.strategy,"combined_retry_full_v2");
  assert.equal(calls.length,3);
  assert.equal(calls[0].quickDetails,true);
  assert.equal(calls[1].contacts,true);assert.equal(calls[1].combinedDetails,true);
  assert.equal(calls[2].contacts,false);assert.equal(calls[2].trucks,true);
  assert.equal(calls[2].financials,true);
  assert.equal(out.stats.totalAttempts,3);
  assert.equal(out.stats.fleetCoverage.positive,1);
  assert.deepEqual(out.passState.combined_detail_attempts[innA],{trucks:true,financials:true});
  assert.ok(!out.passState.attempted.includes("details:"+innA));
});
test("an unentered fleet read does not consume its full details attempt",async()=>{
  const db=result([row(innA,"Альфа")]),calls=[];
  const out=await runSabyContactFirst({result:db,env:combinedEnv,sessionRunner,
    collectSections:async(_p,r,_s,sections)=>{
      calls.push({...sections});
      const v=record(r,sections,{emptyContacts:true});
      if(sections.quickDetails||sections.combinedDetails)v.trucks={status:"missing"};
      if(sections.quickDetails)v.financials={status:"missing"};
      if(sections.combinedDetails)v.full_detail_attempts={trucks:false,financials:true};
      return v;
    }});
  assert.equal(calls.length,3);
  assert.equal(calls[2].trucks,true);
  assert.equal(out.stats.fleetCoverage.positive,1);
  assert.ok(out.passState.attempted.includes("details:"+innA));
});
test("durable combined marker survives memory pause and does not invent unvisited section work",async()=>{
  const db=result([row(innA,"Альфа")]);let saved;
  const collect=async(_p,r,_s,sections)=>{
    const v=record(r,sections,{emptyContacts:true});
    if(sections.quickDetails||sections.combinedDetails){v.trucks={status:"review"};v.financials={status:"missing"};}
    if(sections.combinedDetails)v.full_detail_attempts={trucks:true,financials:true};
    return v;
  };
  await assert.rejects(runSabyContactFirst({result:db,env:combinedEnv,sessionRunner,
    collectSections:collect,persistCheckpoint:async(_phase,p)=>{
      saved=structuredClone(p);
      if(p.saby_pass_state.attempted.includes("contact_retry:"+innA))throw new MemoryPauseError();
    }}),isMemoryPause);
  const calls=[];
  const resumed=await runSabyContactFirst({result:saved.final_result,passState:saved.saby_pass_state,
    env:{...combinedEnv,SABY_COMBINE_RETRY_DETAILS_ENABLED:"false"},sessionRunner,
    collectSections:async(...args)=>{calls.push(args[3]);return collect(...args);}});
  assert.equal(calls.length,1);assert.equal(calls[0].trucks,true);
  assert.equal(resumed.passState.strategy,"combined_retry_full_v2");
  assert.ok(resumed.passState.attempted.includes("details_retry:"+innA));
  assert.equal(resumed.stats.totalAttempts,3);
  assert.equal(resumed.stats.fleetCoverage.positive,1);
});
test("existing optimized cursor is not reinterpreted after enabling combined retry",async()=>{
  const db=result([row(innA,"Альфа")]),calls=[];
  const out=await runSabyContactFirst({result:db,env:combinedEnv,sessionRunner,
    passState:{version:1,strategy:"combined_visible_v1",planned_inns:[innA],attempted:["contacts:"+innA],phase_index:1},
    collectSections:async(_p,r,_s,sections)=>{
      calls.push(sections);
      return record(r,sections);
    }});
  assert.equal(calls[0].quickDetails,true);
  assert.equal(out.passState.strategy,"combined_visible_v1");
  assert.deepEqual(out.passState.combined_detail_attempts,{});
});


test("all-category cursor stores nontruck fleet and needs no separate truck-only attempt",async()=>{
  const db=result([row(innA,"Альфа")]),calls=[];
  const outcome=await runSabyContactFirst({result:db,
    env:{...combinedEnv,SABY_ALL_VEHICLE_CATEGORIES_ENABLED:"true"},sessionRunner,
    collectSections:async(_p,r,_s,sections)=>{
      calls.push(sections);
      const v=record(r,sections);
      v.trucks={status:"missing"};
      if(sections.allVehicleCategories)v.vehicle_fleet={status:"verified",count:2,groups:[
        {category:"Легковые",count:1,vehicles:[{model:"PEUGEOT PARTNER VP",year:2023}]},
        {category:"Коммерческие",count:1,vehicles:[{model:"PEUGEOT BOXER",year:2024}]}
      ]};
      return v;
    }});
  assert.equal(outcome.passState.fleet_categories,"all_vehicle_categories_v1");
  assert.equal(calls.length,1);
  assert.equal(outcome.stats.fleetCoverage.positive,1);
  assert.equal(outcome.stats.fleetCoverage.vehicles,2);
  assert.equal(outcome.stats.vehiclesVerified,2);
  assert.deepEqual(outcome.deferredInns,[]);
  assert.equal(db.direct_buyers[0].__evidence.saby.trucks,undefined);
  assert.match(db.direct_buyers[0]["Наличие транспорта"],/PEUGEOT BOXER/);
});
test("truck-only cursor retains its old requirement when all categories enabled later",async()=>{
  const db=result([row(innA,"Альфа")]),calls=[];
  const outcome=await runSabyContactFirst({result:db,
    env:{...combinedEnv,SABY_ALL_VEHICLE_CATEGORIES_ENABLED:"true"},sessionRunner,
    passState:{version:1,strategy:"combined_visible_v1",planned_inns:[innA],attempted:[],phase_index:0},
    collectSections:async(_p,r,_s,sections)=>{calls.push(sections);return record(r,sections);}});
  assert.equal(outcome.passState.fleet_categories,"trucks_v1");
  assert.ok(calls.every(s=>s.allVehicleCategories!==true));
  assert.equal(outcome.stats.fleetCoverage.positive,1);
});


test("partial nontruck categories persist across full retries and never synthesize complete fleet",async()=>{
  const db=result([row(innA,"Альфа")]);let visit=0;
  const outcome=await runSabyContactFirst({result:db,
    env:{...combinedEnv,SABY_ALL_VEHICLE_CATEGORIES_ENABLED:"true"},sessionRunner,
    collectSections:async(_p,r,_s,sections)=>{
      const v=record(r,sections);
      v.trucks={status:"missing"};
      if(sections.allVehicleCategories){
        const groups=[{category:"Легковые",count:1,vehicles:[{model:"PEUGEOT PARTNER VP",year:2023}]},
          {category:"Коммерческие",count:1,vehicles:[{model:"PEUGEOT BOXER",year:2024}]}];
        v.vehicle_fleet_partial={status:"partial",announced_count:2,categories:groups.map(({category,count})=>({category,count})),
          groups:[groups[Math.min(visit++,1)]]};
      }
      return v;
    }});
  const saved=db.direct_buyers[0].__evidence.saby;
  assert.equal(saved.collection.vehicle_fleet,"partial");
  assert.equal(saved.vehicle_fleet,undefined);
  assert.equal(saved.vehicle_fleet_partial.groups.length,2);
  assert.equal(outcome.stats.fleetCoverage.unknown,1);
  assert.equal(outcome.stats.fleetCoverage.vehicles,0);
  assert.deepEqual(outcome.deferredInns,[innA]);
  assert.match(db.direct_buyers[0]["Наличие транспорта"],/неполный перечень/);
  assert.match(db.direct_buyers[0]["Наличие транспорта"],/PEUGEOT BOXER/);
});

const fullEnv={...env,SABY_FULL_CARD_PASS_ENABLED:"true"};
test("one verified full card visit per company collects all requested sections and skips resolved rows",async()=>{
  const db=result(),calls=[],saved=[];
  const out=await runSabyContactFirst({result:db,env:fullEnv,sessionRunner,
    collectSections:async(_p,r,_s,sections)=>{
      calls.push({inn:r["ИНН"],...sections});return record(r,sections);
    },persistCheckpoint:async(_phase,p)=>saved.push(structuredClone(p))});
  assert.equal(out.passState.strategy,"full_card_v3");
  assert.equal(out.stats.passCount,2);
  assert.equal(out.stats.fullSweepCompleted,true);
  assert.equal(out.stats.fullCardVisits,2);
  assert.equal(out.stats.totalAttempts,2);
  assert.deepEqual(calls.map(c=>c.inn),[innA,innB]);
  assert.ok(calls.every(c=>c.contacts&&c.financials&&c.trucks&&c.fullCard&&
    c.combinedDetails&&!c.quickDetails));
  assert.deepEqual(out.deferredInns,[]);
  assert.deepEqual(out.passState.attempted,["full:"+innA,"full:"+innB]);
  assert.deepEqual(out.passState.full_card_attempts["full:"+innA],
    {contacts:true,financials:true,trucks:true});
  assert.equal(saved.at(-1).saby_pass_state.phase_index,2);
});
test("full card retries only unresolved sections; no contacts never suppresses finances or fleet",async()=>{
  const db=result([row(innA,"Альфа")]),calls=[];
  const out=await runSabyContactFirst({result:db,env:fullEnv,sessionRunner,
    collectSections:async(_p,r,_s,sections)=>{
      calls.push({...sections});
      return record(r,sections,{emptyContacts:true});
    }});
  assert.deepEqual(calls.map(c=>[c.contacts,c.financials,c.trucks]),[[true,true,true],[true,false,false]]);
  assert.equal(out.stats.phonesAdded,0);
  assert.equal(out.stats.vehiclesVerified,1);
  assert.equal(out.stats.revenuesAdded,1);
  assert.equal(out.stats.employeesAdded,1);
  assert.deepEqual(out.deferredInns,[innA]);
  assert.equal(out.stats.fullSweepCompleted,true);
});
test("full card pass keeps finance-only and fleet-only work independent of contact gaps",async()=>{
  const a=row(innA,"Альфа"),b=row(innB,"Бета");
  for(const r of [a,b]){
    r["Телефон"]=r===a?"74951234567":"74951234568";
    r["Электронная почта"]=r===a?"sales@alpha.ru":"sales@beta.ru";
  }
  b["Выручка последнего подтвержденного года"]=1000000;b["Численность"]=12;
  const db={direct_buyers:[],intermediaries:[a],leasing:[b],statistics:[]};
  const calls=[];
  const out=await runSabyContactFirst({result:db,env:fullEnv,sessionRunner,
    collectSections:async(_p,r,_s,sections)=>{
      calls.push({inn:r["ИНН"],...sections});return record(r,sections);
    }});
  assert.equal(out.stats.fullSweepCompleted,true);
  assert.equal(calls.length,2);
  assert.deepEqual(calls.map(c=>[c.inn,c.contacts,c.financials,c.trucks]),
    [[innA,false,true,true],[innB,false,false,true]]);
});
test("migrate unfinished quick cursor without counting quick details as full or repeating completed contacts",async()=>{
  const a=row(innA,"Альфа"),b=row(innB,"Бета","B");
  a["Телефон"]="74951234567";a["Электронная почта"]="sales@alpha.ru";
  const db=result([a,b]),calls=[],saved=[];
  const old={version:1,strategy:"combined_visible_v1",fleet_scope:"all_commercial_v1",
    planned_inns:[innA,innB],attempted:["contacts:"+innA],verified_inns:[innA],
    phase_index:0,stats:{phonesAdded:1,emailsAdded:1,verified:1},timing:{visits:1}};
  const oldCopy=structuredClone(old);
  const out=await runSabyContactFirst({result:db,env:fullEnv,passState:old,sessionRunner,
    collectSections:async(_p,r,_s,sections)=>{
      calls.push({inn:r["ИНН"],...sections});return record(r,sections);
    },persistCheckpoint:async(_phase,p)=>saved.push(structuredClone(p))});
  assert.deepEqual(old,oldCopy);
  assert.equal(saved[0].saby_pass_state.strategy,"full_card_v3");
  assert.deepEqual(saved[0].saby_pass_state.attempted,old.attempted);
  assert.deepEqual(saved[0].saby_pass_state.full_card_attempts,{});
  assert.equal(saved[0].saby_pass_state.full_card_migration.legacy_attempts,1);
  assert.equal(out.stats.totalAttempts,3);
  assert.equal(out.stats.legacyAttempts,1);
  assert.equal(out.stats.phonesAdded,2);
  assert.deepEqual(calls.map(c=>[c.inn,c.contacts,c.financials,c.trucks]).sort(),
    [[innA,false,true,true],[innB,true,true,true]].sort());
  assert.deepEqual(out.deferredInns,[]);
});
test("migration honors old contact retry and attested combined detail budgets",async()=>{
  const db=result([row(innA,"Альфа")]),calls=[];
  const old={version:1,strategy:"combined_retry_full_v2",fleet_scope:"all_commercial_v1",
    planned_inns:[innA],attempted:["contacts:"+innA,"contact_retry:"+innA],
    combined_detail_attempts:{[innA]:{financials:true,trucks:false}},phase_index:2};
  const out=await runSabyContactFirst({result:db,env:fullEnv,passState:old,sessionRunner,
    collectSections:async(_p,r,_s,sections)=>{
      calls.push({...sections});
      const value=record(r,sections);value.trucks={status:"missing"};value.financials={status:"missing"};
      return value;
    }});
  assert.deepEqual(calls.map(c=>[c.contacts,c.financials,c.trucks]),[[false,true,true],[false,false,true]]);
  assert.equal(out.stats.legacyAttempts,2);
  assert.deepEqual(out.deferredInns,[innA]);
  assert.equal(out.stats.fullSweepCompleted,true);
});
test("new cursor is pinned and committed section masks survive memory pause without redoing completed visits",async()=>{
  let saved;
  const calls=[];
  const collectSections=async(_p,r,_s,sections)=>{
    calls.push(r["ИНН"]);return record(r,sections);
  };
  await assert.rejects(runSabyContactFirst({result:result(),env:fullEnv,sessionRunner,
    collectSections,persistCheckpoint:async(_phase,p)=>{
      saved=structuredClone(p);
      if(p.saby_pass_state.attempted.length===1)throw new MemoryPauseError();
    }}),isMemoryPause);
  assert.deepEqual(saved.saby_pass_state.attempted,["full:"+innA]);
  const out=await runSabyContactFirst({result:saved.final_result,env:{...fullEnv,SABY_FULL_CARD_PASS_ENABLED:"false"},
    passState:saved.saby_pass_state,sessionRunner,collectSections});
  assert.deepEqual(calls,[innA,innB]);
  assert.equal(out.passState.strategy,"full_card_v3");
  assert.equal(out.stats.fullSweepCompleted,true);
  const broken=structuredClone(saved.saby_pass_state);
  broken.full_card_attempts={};
  await assert.rejects(runSabyContactFirst({result:saved.final_result,env:fullEnv,
    passState:broken,sessionRunner:async()=>assert.fail("corrupt cursor must not open browser"),
    collectSections}),/SABY_FULL_CARD_CURSOR_INVALID/);
});
test("finished legacy cursor is never silently migrated or re-opened",async()=>{
  const old={version:1,strategy:"combined_visible_v1",planned_inns:[innA],
    attempted:["contacts:"+innA,"details:"+innA],phase_index:4};
  const out=await runSabyContactFirst({result:result([row(innA,"Альфа")]),env:fullEnv,passState:old,
    sessionRunner:async()=>assert.fail("finished legacy cursor must not reopen")});
  assert.equal(out.passState.strategy,"combined_visible_v1");
  assert.equal(out.passState.phase_index,4);
  assert.deepEqual(out.passState.attempted,old.attempted);
});
