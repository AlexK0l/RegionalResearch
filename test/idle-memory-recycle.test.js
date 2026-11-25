import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {createIdleMemoryRecycleGuard,durableIdleJobsMatch,idleMemoryRecycleSettings} from "../src/idleMemoryRecycle.js";
import {createFullJobQueue} from "../src/fullJobQueue.js";
import {createMemoryAdmission,memoryGuardSettings,isMemoryPause} from "../src/memoryAdmission.js";

const tick=()=>new Promise(r=>setImmediate(r));
const settings={...memoryGuardSettings({RESEARCH_MEMORY_JOB_MIB:"640"}),stableMs:1000,startSpacingMs:1000};
const sample=availableMiB=>({valid:true,totalMiB:1967,availableMiB,heapLimitMiB:1080,heapAvailableMiB:900});
const job=(id,region=id)=>({id,region,mode:"resume",state:"waiting",progress:{},cancelled:false});

test("idle restart is opt-in, needs uninterrupted stall, no requests, durable markers and an atomic cooldown claim",()=>{
  let time=0,rss=642,items=[{id:"a",region:"A",mode:"resume",paused:true}];
  let durable=false,canExit=false,claimed=false,frozen=false,exits=[];
  const config={...idleMemoryRecycleSettings({RESEARCH_MEMORY_IDLE_RECYCLE_ENABLED:"true"}),stallMs:60000,cooldownMs:300000};
  assert.equal(idleMemoryRecycleSettings({}).enabled,false);
  const guard=createIdleMemoryRecycleGuard({
    settings:config,now:()=>time,candidates:()=>items,rssMiB:()=>rss,
    canExit:()=>canExit,isDurable:()=>durable,claim:()=>claimed,
    freeze:()=>frozen,exit:code=>exits.push(code),log:()=>{}
  });
  assert.equal(guard.poll(),false);
  time=60000;assert.equal(guard.poll(),false); // request in flight
  canExit=true;assert.equal(guard.poll(),false); // marker missing
  durable=true;assert.equal(guard.poll(),false); // cooldown denies
  claimed=true;frozen=true;time=119999;assert.equal(guard.poll(),false);
  items=null;time=120000;assert.equal(guard.poll(),false);
  items=[{id:"a",region:"A",mode:"resume",paused:true}];
  assert.equal(guard.poll(),false);
  time=179999;assert.equal(guard.poll(),false);
  time=180000;assert.equal(guard.poll(),true);
  assert.deepEqual(exits,[75]);
  time=999999;assert.equal(guard.poll(),false);
});

test("durability requires the right mode, region and pause/queue marker for every job",()=>{
  const a={id:"a",region:"A",mode:"resume",paused:true};
  const b={id:"b",region:"B",mode:"full",paused:false};
  assert.equal(durableIdleJobsMatch([a,b],{paused:[a],queued:[b]}),true);
  assert.equal(durableIdleJobsMatch([a,b],{paused:[],queued:[a,b]}),false);
  assert.equal(durableIdleJobsMatch([a,b],{paused:[a],queued:[{...b,region:"C"}]}),false);
  assert.equal(durableIdleJobsMatch([a,b],{paused:[a],queued:[b],canRestore:x=>x.id!=="a"}),false);
  assert.equal(durableIdleJobsMatch([],{}),false);
});

test("a paused Saby snapshot needs hydration margin; blocked idle queue freezes only exact durable candidates",async()=>{
  let now=0,available=1100,started=0;
  const q=createFullJobQueue({memory:createMemoryAdmission({settings,now:()=>now,sample:()=>sample(available)}),
    autoPoll:false,collectGarbage:null,log:()=>{},execute:async()=>{started++;}});
  const a=job("a");a.latestCheckpointSummary={phase:"saby",saby_browser_pending:true};
  try{
    q.enqueue(a,"key",{paused:true});
    await tick();
    assert.equal(started,0);
    assert.equal(q.snapshot().memory.reason,"saby_resume_headroom");
    assert.equal(q.snapshot().memory.saby_resume_required_mib,1216);
    const candidates=q.idleBlockedJobs();
    assert.deepEqual(candidates,[{id:"a",region:"a",mode:"resume",paused:true}]);
    assert.equal(q.freezeForRecycle([{...candidates[0],id:"other"}]),false);
    available=1300;assert.equal(q.freezeForRecycle(candidates),false);
    available=1100;assert.equal(q.freezeForRecycle(candidates),true);
    available=1500;now+=10000;q.poll();await tick();
    assert.equal(started,0);
    assert.throws(()=>q.enqueue(job("b"),"key"),/QUIESCED/);
  }finally{q.close();}
});

test("idle recycle never considers an active job or an unpersisted diagnostic",async()=>{
  let available=1400,finish;
  const gate=new Promise(r=>finish=r);
  const q=createFullJobQueue({memory:createMemoryAdmission({settings,sample:()=>sample(available)}),
    autoPoll:false,collectGarbage:null,log:()=>{},execute:async j=>{j.state="active";await gate;j.state="completed";}});
  try{
    q.enqueue(job("a"),"key");await tick();
    available=800;q.enqueue(job("b"),"key");
    assert.equal(q.idleBlockedJobs(),null);
    q.enqueue(job("diagnostic"),"key",{reserveRegion:false});
    finish();await tick();
    assert.equal(q.idleBlockedJobs(),null);
  }finally{finish();q.close();}
});

test("SQLite cooldown survives a completely new process and checkpoint cache shrink",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"rr-idle-recycle-"));
  const db=path.join(dir,"checkpoints.sqlite");
  const run=(now,expected)=>{
    const code=`import assert from "node:assert/strict";
      import {claimIdleMemoryRecycle,shrinkCheckpointMemory} from "./src/checkpointStore.js";
      assert.equal(claimIdleMemoryRecycle(${now},300000),${expected});
      shrinkCheckpointMemory();`;
    const r=spawnSync(process.execPath,["--input-type=module","-e",code],{
      cwd:process.cwd(),env:{...process.env,CHECKPOINT_DB_PATH:db},encoding:"utf8",timeout:20000,windowsHide:true});
    assert.equal(r.status,0,r.stderr||r.stdout);
  };
  try{run(1000000,true);run(1000001,false);run(1299999,false);run(1300000,true);}
  finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test("Chromium rotation keeps the same exclusive lease and waits for fresh headroom",async()=>{
  let now=0,available=1400,finish,release;
  const gate=new Promise(r=>finish=r);
  const q=createFullJobQueue({memory:createMemoryAdmission({settings,now:()=>now,sample:()=>sample(available)}),
    autoPoll:false,collectGarbage:null,log:()=>{},execute:async j=>{j.state="active";await gate;j.state="completed";}});
  const a=job("a");
  try{
    q.enqueue(a,"key");await tick();
    const acquire=a.acquireSabyBrowser();now+=1000;q.poll();release=await acquire;
    available=900;
    let reopened=false;
    const reopen=release.beforeReopen().then(()=>{reopened=true;});
    q.enqueue(job("b"),"key");
    assert.equal(q.snapshot().memory.saby_browser.state,"waiting");
    now+=10000;q.poll();await tick();assert.equal(reopened,false);
    available=1250;now+=1000;q.poll();await tick();assert.equal(reopened,false);
    now+=1000;q.poll();await reopen;
    assert.equal(q.snapshot().active,1);
    assert.equal(q.snapshot().memory.saby_browser.state,"active");
    assert.equal(q.snapshot().pending,1);
  }finally{release?.();finish();q.close();}
});

test("sole browser owner with stalled headroom is cooperatively paused, not left holding the live snapshot",async()=>{
  let now=0,available=1400,finish;
  const gate=new Promise(r=>finish=r);
  const a=job("a");
  const q=createFullJobQueue({memory:createMemoryAdmission({settings,now:()=>now,sample:()=>sample(available)}),
    autoPoll:false,collectGarbage:null,log:()=>{},execute:async j=>{j.state="active";await gate;j.state="completed";}});
  try{
    q.enqueue(a,"key");await tick();
    available=900;
    const acquire=a.acquireSabyBrowser();
    const paused=assert.rejects(acquire,isMemoryPause);
    now+=60000;q.poll();await paused;
    assert.equal(a.memoryPauseRequested,true);
    assert.equal(q.snapshot().memory.saby_browser.state,"unwinding");
  }finally{finish();q.close();}
});
