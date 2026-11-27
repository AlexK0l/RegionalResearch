import test from "node:test";
import assert from "node:assert/strict";
import {createFullJobQueue} from "../src/fullJobQueue.js";
import {createMemoryAdmission,memoryGuardSettings,evaluateMemoryAdmission,
  evaluateSabyBrowserAdmission,isMemoryPause,MemoryPauseError} from "../src/memoryAdmission.js";
import {runCheckpointedSabyStage12} from "../src/sabyCheckpointIntegration.js";
import {runSabyOnlyContinuation} from "../src/sabyOnlyContinuation.js";

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const job=(id,region)=>({id,region,state:"waiting",progress:{},cancelled:false});
const settings={...memoryGuardSettings({RESEARCH_MEMORY_JOB_MIB:"768"}),stableMs:1000,startSpacingMs:1000};
const sample=(availableMiB,totalMiB=1967,heapAvailableMiB=900)=>({
  valid:true,totalMiB,availableMiB,heapLimitMiB:totalMiB===1967?1080:4096,heapAvailableMiB});

test("Saby admission counts additional browser RAM, not a second research allocation",()=>{
  const check=(available,active=1,total=1967,heap=900)=>evaluateSabyBrowserAdmission(
    evaluateMemoryAdmission(sample(available,total,heap),settings,active),settings,active);
  assert.deepEqual(check(1024),{canOpen:true,exclusive:true,browserMiB:640,
    requiredAvailableMiB:1024,requiredHeapMiB:320});
  assert.equal(check(1023).canOpen,false);
  assert.equal(check(1500,2).canOpen,false);
  assert.equal(check(2500,2,4096).canOpen,false);
  assert.equal(check(2500,1,4096).canOpen,true);
  assert.equal(check(2500,2,4096,300).canOpen,false);
});

test("two ordinary regions run; Saby drains peer, waits for real RAM, then resumes peer before owner finishes",async()=>{
  let now=0,available=1400;
  const memory=createMemoryAdmission({settings,now:()=>now,sample:()=>sample(available)});
  const a=job("a","A"),b=job("b","B"),c=job("c","C");
  const holdA=deferred(),holdB=deferred(),holdB2=deferred(),holdC=deferred();
  const started=[],errors=[];
  let bVisits=0,committed=false,granted=false,release;
  const q=createFullJobQueue({limit:10,memory,autoPoll:false,log:()=>{},
    onError:error=>errors.push(error),collectGarbage:null,
    execute:async j=>{
      j.state="active";started.push(j.id);
      if(j===a)await holdA.promise;
      if(j===b){
        bVisits++;
        if(bVisits===1){
          await holdB.promise;
          committed=true;
          try{j.memorySafePoint();}catch(error){
            if(!isMemoryPause(error))throw error;
            return {memoryPaused:true};
          }
        }else await holdB2.promise;
      }
      if(j===c)await holdC.promise;
      j.state="completed";
    }});
  try{
    q.enqueue(a,"key");q.enqueue(b,"key");await tick();
    now+=1000;q.poll();await tick();
    assert.deepEqual(started,["a","b"]);
    available=1000;
    a.progress.phase="saby";
    const lease=a.acquireSabyBrowser().then(value=>{release=value;granted=true;});
    assert.equal(a.progress.phase,"saby_memory_wait");
    assert.equal(b.memoryPauseRequested,true);
    assert.equal(a.memoryPauseRequested,false);
    q.enqueue(c,"key");
    holdB.resolve();await tick();
    assert.ok(committed);
    assert.equal(b.progress.phase,"memory_paused");
    assert.equal(q.snapshot().active,1);
    assert.equal(q.conflict("B"),b);
    now+=10000;q.poll();await tick();
    assert.equal(granted,false);
    available=1100;now+=1000;q.poll();await tick();
    assert.equal(granted,false);
    now+=1000;q.poll();await lease;
    assert.equal(q.snapshot().memory.saby_browser.state,"active");
    assert.equal(q.snapshot().memory.effectiveLimit,1);
    assert.equal(a.progress.phase,"saby");
    available=1400;now+=10000;q.poll();await tick();
    assert.deepEqual(started,["a","b"]);
    // Closing Chromium frees the reservation, not the entire research.
    release();release=null;
    now+=1000;q.poll();await tick();
    assert.deepEqual(started,["a","b","b"]);
    assert.equal(q.snapshot().active,2);
    assert.equal(a.state,"active");
    assert.equal(q.snapshot().memory.saby_browser,undefined);
    holdA.resolve();holdB2.resolve();await tick();
    now+=1000;q.poll();await tick();
    assert.deepEqual(started,["a","b","b","c"]);
    holdC.resolve();await tick();
    assert.deepEqual(errors,[]);
  }finally{release?.();holdA.resolve();holdB.resolve();holdB2.resolve();holdC.resolve();q.close();}
});

test("large host also drains existing peer; simultaneous Saby contender yields instead of deadlocking",async()=>{
  let now=0;
  const memory=createMemoryAdmission({settings,now:()=>now,sample:()=>sample(3500,8192,3500)});
  const a=job("a","A"),b=job("b","B"),goB=deferred(),doneA=deferred(),doneB=deferred();
  let bVisits=0,release,secondPaused=false;
  const errors=[];
  const q=createFullJobQueue({limit:3,memory,autoPoll:false,log:()=>{},onError:e=>errors.push(e),
    execute:async j=>{
      j.state="active";
      if(j===a)await doneA.promise;
      else if(++bVisits===1){
        await goB.promise;
        try{await j.acquireSabyBrowser();throw Error("unexpected second browser");}
        catch(e){if(!isMemoryPause(e))throw e;secondPaused=true;return {memoryPaused:true};}
      }else await doneB.promise;
      j.state="completed";
    }});
  try{
    q.enqueue(a,"key");q.enqueue(b,"key");await tick();
    now+=1000;q.poll();await tick();
    const lease=a.acquireSabyBrowser();
    assert.equal(b.memoryPauseRequested,true);
    now+=1000;q.poll();await tick();
    assert.equal(q.snapshot().memory.saby_browser.state,"waiting");
    assert.equal(q.snapshot().active,2);
    goB.resolve();await tick();
    assert.equal(secondPaused,true);
    assert.equal(q.snapshot().active,1);
    now+=1000;q.poll();release=await lease;
    assert.equal(q.snapshot().memory.saby_browser.state,"active");
    assert.equal(q.snapshot().memory.saby_browser.job_id,"a");
    assert.equal(b.progress.phase,"memory_paused");
    release();release=null;
    now+=1000;q.poll();await tick();
    assert.equal(bVisits,2);
    assert.deepEqual(errors,[]);
  }finally{release?.();goB.resolve();doneA.resolve();doneB.resolve();q.close();}
});

test("cancellation while waiting for Saby RAM releases the reservation; next job runs",async()=>{
  let now=0,available=1400;
  const memory=createMemoryAdmission({settings,now:()=>now,sample:()=>sample(available)});
  const a=job("a","A"),b=job("b","B"),go=deferred(),holdB=deferred();
  const errors=[],started=[];
  const q=createFullJobQueue({limit:2,memory,autoPoll:false,log:()=>{},
    onError:e=>errors.push(e),collectGarbage:null,execute:async j=>{
      j.state="active";started.push(j.id);
      if(j===a){await go.promise;const release=await j.acquireSabyBrowser();release();}
      else await holdB.promise;
      j.state="completed";
    }});
  try{
    q.enqueue(a,"key");await tick();
    available=1000;go.resolve();await tick();
    assert.equal(a.progress.phase,"saby_memory_wait");
    q.enqueue(b,"key");
    a.cancelled=true;
    now+=1000;q.poll();await tick();
    assert.equal(a.state,"cancelled");
    assert.equal(errors[0]?.message,"JOB_CANCELLED");
    assert.equal(q.snapshot().memory.saby_browser,undefined);
    available=1400;now+=1000;q.poll();now+=1000;q.poll();await tick();
    assert.deepEqual(started,["a","b"]);
  }finally{go.resolve();holdB.resolve();q.close();}
});

test("emergency pressure still pauses a Saby owner and never starts another browser",async()=>{
  let now=0,available=1400;
  const memory=createMemoryAdmission({settings,now:()=>now,sample:()=>sample(available)});
  const a=job("a","A"),go=deferred(),finish=deferred();
  let opened=false,closed=false;
  const errors=[];
  const q=createFullJobQueue({memory,autoPoll:false,log:()=>{},onError:e=>errors.push(e),
    execute:async j=>{
      j.state="active";await go.promise;
      let release;
      try{
        release=await j.acquireSabyBrowser();opened=true;
        await finish.promise;j.memorySafePoint();
      }catch(e){if(!isMemoryPause(e))throw e;return {memoryPaused:true};}
      finally{closed=!!release;release?.();}
    }});
  try{
    q.enqueue(a,"key");await tick();
    go.resolve();await tick();now+=1000;q.poll();await tick();assert.ok(opened);
    available=192;now+=1000;q.poll();
    assert.equal(a.memoryPauseRequested,true);
    finish.resolve();await tick();
    assert.ok(closed);assert.equal(q.snapshot().active,0);
    assert.equal(a.progress.phase,"memory_paused");
    assert.equal(q.snapshot().memory.saby_browser,undefined);
    assert.deepEqual(errors,[]);
  }finally{go.resolve();finish.resolve();q.close();}
});

const inn="7707083893";
const result=()=>({direct_buyers:[{__canonical_id:"a","Организация":"ООО Альфа",
  "ИНН":inn,"Телефон":"","Наличие транспорта":"",
  __evidence:{source_urls:["https://official.example/"]}}],
  intermediaries:[],leasing:[],statistics:[]});
const env={SABY_STAGE12_ENABLED:"true",GIRBO_STAGE_ENABLED:"false",
  SABY_CHECKPOINT_EVERY:"1",STAGE13_AI_SABY_ONLY_ENABLED:"false",
  SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED:"true",SABY_FLEET_TREE_PRODUCTION_ENABLED:"true",SABY_MAX_COMPANIES:"0"};
const record=(_page,row)=>({source:"SABY",source_url:"https://profile.saby.ru/page/contractor-info",
  collected_at:"2026-11-25T00:00:00Z",identity:{inn:row["ИНН"],name:row["Организация"],verified:true},
  contacts:{status:"collected",phones:["+74951234567"],emails:[]},
  trucks:{status:"verified",count:0,vehicles:[]},errors:[]});

test("stage checkpoints BEFORE reserving RAM, waits without opening browser and releases after close",async()=>{
  const events=[],gate=deferred();
  const pending=runCheckpointedSabyStage12({result:result(),env,
    persistCheckpoint:async(phase,patch)=>{
      assert.equal(phase,"saby");
      if(!events.length)assert.deepEqual(patch.saby_deferred_inns,[inn]);
      events.push("checkpoint");
    },
    acquireSabyBrowser:async()=>{events.push("request");await gate.promise;return ()=>events.push("released");},
    sessionRunner:async task=>{
      events.push("opened");try{return await task({page:{},settings:{}});}
      finally{events.push("closed");}
    },collectCompany:async(...args)=>record(...args)});
  await tick();
  assert.deepEqual(events,["checkpoint","request"]);
  gate.resolve();await pending;
  assert.equal(events.at(-1),"released");
  assert.ok(events.indexOf("closed")<events.indexOf("released"));
});

test("stage reservation holds across bounded browser reconnects and releases on failure",async()=>{
  const events=[];let visits=0;
  await runCheckpointedSabyStage12({result:result(),env,recoverBrowserSession:true,recoveryWait:async()=>{},
    persistCheckpoint:async()=>events.push("checkpoint"),
    acquireSabyBrowser:async()=>{events.push("acquired");return ()=>events.push("released");},
    sessionRunner:async task=>{
      events.push("opened");
      try{if(++visits===1)throw Error("temporary browser launch failure");
        return await task({page:{},settings:{}});}
      finally{events.push("closed");}
    },collectCompany:async(...args)=>record(...args)});
  assert.equal(visits,2);
  assert.equal(events.filter(x=>x==="acquired").length,1);
  assert.equal(events.filter(x=>x==="released").length,1);
  assert.equal(events.at(-1),"released");
});

test("disabled or empty Saby never reserves memory; a pause at admission propagates",async()=>{
  const acquire=async()=>assert.fail("unneeded browser reservation");
  await runCheckpointedSabyStage12({result:result(),env:{...env,SABY_STAGE12_ENABLED:"false"},acquireSabyBrowser:acquire});
  await runCheckpointedSabyStage12({result:{direct_buyers:[],intermediaries:[],leasing:[],statistics:[]},env,acquireSabyBrowser:acquire});
  let written=false;
  await assert.rejects(runCheckpointedSabyStage12({result:result(),env,
    persistCheckpoint:async()=>{written=true;},
    acquireSabyBrowser:async()=>{assert.ok(written);throw new MemoryPauseError();},
    sessionRunner:async()=>assert.fail("browser started before admission")}),isMemoryPause);
});

test("Saby-only continuation uses the same durable pre-browser admission and releases before Stage13",async()=>{
  const events=[];
  const source={version:1,pipeline_version:1,region:"Test",source_mode:"full",phase:"saby",
    completed_stage:9,final_result:result(),saby_completed_inns:[],saby_deferred_inns:[inn]};
  await runSabyOnlyContinuation({
    checkpoint:source,sourceJobId:"12345678-1234-1234-1234-123456789abc",env,
    persistCheckpoint:async(cp)=>events.push("checkpoint:"+cp.phase),
    acquireSabyBrowser:async()=>{
      assert.ok(events.includes("checkpoint:saby"));
      events.push("acquired");return ()=>events.push("released");
    },
    sessionRunner:async task=>{
      events.push("opened");try{return await task({page:{},settings:{}});}
      finally{events.push("closed");}
    },
    collectCompany:async(...args)=>record(...args),
    onProgress:async p=>{if(p.phase==="priority"){assert.ok(events.includes("released"));events.push("priority");}}
  });
  assert.equal(events.filter(x=>x==="acquired").length,1);
  assert.equal(events.filter(x=>x==="released").length,1);
  assert.ok(events.indexOf("closed")<events.indexOf("released"));
  assert.ok(events.indexOf("released")<events.indexOf("priority"));
});

test("three concurrent research jobs drain every other region before Saby opens, then resume",async()=>{
  let now=0;
  const settings={...memoryGuardSettings({RESEARCH_MEMORY_JOB_MIB:"640"}),stableMs:1000,startSpacingMs:1000};
  const memory=createMemoryAdmission({settings,now:()=>now,sample:()=>sample(1500,1967,950)});
  const a=job("a","A"),b=job("b","B"),c=job("c","C"),d=job("d","D");
  const started=[],gates=new Map(),errors=[];
  let release=null,granted=false;
  const q=createFullJobQueue({limit:10,memory,autoPoll:false,collectGarbage:null,log:()=>{},
    onError:e=>errors.push(e),execute:async j=>{
      j.state="active";started.push(j.id);
      const g=deferred();gates.set(j.id,g);await g.promise;
      try{j.memorySafePoint();}catch(e){
        if(!isMemoryPause(e))throw e;
        return {memoryPaused:true};
      }
      j.state="completed";
    }});
  try{
    q.enqueue(a,"key");q.enqueue(b,"key");q.enqueue(c,"key");await tick();
    now+=1000;q.poll();await tick();now+=1000;q.poll();await tick();
    assert.deepEqual(started,["a","b","c"]);
    const lease=a.acquireSabyBrowser().then(v=>{release=v;granted=true;});
    assert.ok(b.memoryPauseRequested&&c.memoryPauseRequested);
    q.enqueue(d,"key");
    gates.get("b").resolve();await tick();
    now+=2000;q.poll();await tick();assert.equal(granted,false);
    assert.equal(q.snapshot().active,2);
    gates.get("c").resolve();await tick();
    assert.equal(q.snapshot().active,1);
    now+=1000;q.poll();await lease;
    assert.equal(q.snapshot().memory.effectiveLimit,1);
    now+=10000;q.poll();await tick();
    assert.deepEqual(started,["a","b","c"]);
    release();release=null;
    now+=1000;q.poll();await tick();
    now+=1000;q.poll();await tick();
    assert.equal(q.snapshot().active,3);
    assert.deepEqual(new Set(started.slice(3)),new Set(["b","c"]));
    assert.deepEqual(errors,[]);
  }finally{
    q.beginShutdown();release?.();for(const g of gates.values())g.resolve();
    await tick();q.close();
  }
});
