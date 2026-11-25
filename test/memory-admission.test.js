import test from "node:test";
import assert from "node:assert/strict";
import {createFullJobQueue} from "../src/fullJobQueue.js";
import {readMemoryHeadroom,memoryGuardSettings,evaluateMemoryAdmission,
  createMemoryAdmission,isMemoryPause} from "../src/memoryAdmission.js";
import {mapWithConcurrency,resolveFinalMissingInns} from "../src/pipeline.js";
const M=1024*1024;
const tick=()=>new Promise(r=>setImmediate(r));
const job=(id,region)=>({id,region,state:"waiting",progress:{},cancelled:false});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test("host available, tighter ancestor cgroup and V8 heap limit all constrain admission",()=>{
  const files={"/proc/meminfo":"MemTotal: 8388608 kB\nMemAvailable: 6291456 kB\n",
    "/proc/self/cgroup":"0::/system.slice/service\n",
    "/sys/fs/cgroup/system.slice/service/memory.max":"max",
    "/sys/fs/cgroup/system.slice/memory.max":String(3*1024*M),
    "/sys/fs/cgroup/system.slice/memory.current":String(2*1024*M)};
  const sample=readMemoryHeadroom({platform:"linux",total:8*1024*M,free:M,
    heap:{heap_size_limit:4*1024*M,used_heap_size:512*M},
    read:p=>{if(!(p in files))throw Error("missing");return files[p];}});
  assert.equal(sample.availableMiB,1024);assert.equal(sample.totalMiB,3072);
  assert.equal(sample.hostAvailableMiB,6144);
  const settings=memoryGuardSettings({});
  assert.equal(evaluateMemoryAdmission(sample,settings,0).canStart,false);
  assert.equal(evaluateMemoryAdmission({...sample,availableMiB:100},settings,1).pressure,"critical");
  assert.equal(evaluateMemoryAdmission({...sample,availableMiB:3000,heapAvailableMiB:80},settings,1).pressure,"critical");
});
test("admission waits, starts only one per sample, suspends latest, resumes same id after stable recovery",async()=>{
  let now=10000,available=7000;
  const settings={...memoryGuardSettings({}),stableMs:1000,startSpacingMs:1000};
  const memory=createMemoryAdmission({settings,now:()=>now,sample:()=>({
    valid:true,totalMiB:8192,availableMiB:available,heapLimitMiB:4096,heapAvailableMiB:3600})});
  const started=[],gates=new Map(),saved=new Map();
  const q=createFullJobQueue({limit:3,memory,autoPoll:false,log:()=>{},
    execute:async j=>{
      j.state="active";started.push(j.id);
      const d=deferred();gates.set(j.id,d);await d.promise;
      // Simulate a durable batch and prove the pause is not a cancellation.
      saved.set(j.id,(saved.get(j.id)||0)+1);
      try{j.memorySafePoint();}catch(e){
        assert.ok(isMemoryPause(e));assert.equal(j.cancelled,false);
        j.memoryPauseCount=(j.memoryPauseCount||0)+1;
        return {memoryPaused:true};
      }
      j.state="completed";
    }});
  const a=job("a","A"),b=job("b","B"),c=job("c","C");
  q.enqueue(a,"key");q.enqueue(b,"key");q.enqueue(c,"key");await tick();
  assert.deepEqual(started,["a"]);
  now+=1000;q.poll();await tick();assert.deepEqual(started,["a","b"]);
  available=850;now+=1000;q.poll();
  assert.equal(b.memoryPauseRequested,true);assert.equal(a.memoryPauseRequested,false);
  assert.equal(c.progress.phase,"memory_wait");
  gates.get("b").resolve();await tick();
  assert.equal(b.progress.phase,"memory_paused");assert.equal(q.conflict("B"),b);
  assert.equal(q.snapshot().active,1);assert.equal(saved.get("b"),1);
  assert.equal(q.enqueue(job("duplicate","B"),"key").accepted,false);
  available=6000;now+=1000;q.poll();await tick();assert.equal(started.length,2);
  now+=1000;q.poll();await tick();assert.deepEqual(started,["a","b","b"]);
  assert.equal(b.memoryPauseCount,1);
  gates.get("a").resolve();gates.get("b").resolve();await tick();
  now+=1000;q.poll();await tick();assert.deepEqual(started,["a","b","b","c"]);
  gates.get("c").resolve();await tick();assert.equal(q.snapshot().active,0);
  q.close();
});
test("no initial memory, automatic admission without a new submission; cancellation releases waiting region",async()=>{
  let now=0,available=100;
  const settings={...memoryGuardSettings({}),stableMs:1000,startSpacingMs:1000};
  const memory=createMemoryAdmission({settings,now:()=>now,sample:()=>({
    valid:true,totalMiB:4096,availableMiB:available,heapLimitMiB:4096,heapAvailableMiB:3000})});
  const calls=[];
  const q=createFullJobQueue({memory,autoPoll:false,log:()=>{},execute:async j=>{calls.push(j.id);j.state="completed";}});
  const a=job("a","A"),b=job("b","B");
  q.enqueue(a,"key");q.enqueue(b,"key");await tick();
  assert.equal(a.progress.phase,"memory_wait");assert.deepEqual(calls,[]);
  b.cancelled=true;b.state="cancelled";q.cancelQueued("b");assert.equal(q.conflict("B"),null);
  available=3900;now+=1000;q.poll();now+=1000;q.poll();await tick();
  assert.deepEqual(calls,["a"]);q.close();
});
test("drain stops scheduling new batches, waits for ALL in-flight work, propagates failures after drain",async()=>{
  const gates=[deferred(),deferred()],calls=[],settled=[];
  let stop=false,done=false;
  const p=mapWithConcurrency([0,1,2,3],2,async i=>{
    calls.push(i);await gates[i].promise;settled.push(i);
  },()=>stop).then(()=>done=true);
  await tick();stop=true;gates[0].resolve();await tick();
  assert.equal(done,false);assert.deepEqual(calls,[0,1]);
  gates[1].resolve();await p;assert.deepEqual(settled,[0,1]);
  const hold=deferred();let drained=false;
  const failing=mapWithConcurrency([0,1,2],2,async i=>{
    if(i===0)throw Error("worker failure");
    await hold.promise;drained=true;
  });
  const observed=assert.rejects(failing,/worker failure/);
  await tick();assert.equal(drained,false);hold.resolve();await observed;assert.equal(drained,true);
});
test("SQLite pause marker keeps only durable metadata, survives reopen and is removed before restart",async()=>{
  const fs=await import("node:fs"),os=await import("node:os"),path=await import("node:path");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"rr-memory-pause-"));
  const old=process.env.CHECKPOINT_DB_PATH;
  // pipeline imports the default store in this test process; use an isolated
  // child process for the actual durable pause marker integration test.
  const {spawnSync}=await import("node:child_process");
  try{
    const url=new URL("../src/checkpointStore.js",import.meta.url).href;
    const db=path.join(dir,"checkpoints.sqlite");
    const id="12345678-1234-1234-1234-123456789abc";
    const run=code=>{
      const r=spawnSync(process.execPath,["--input-type=module","-e",code],{
        encoding:"utf8",env:{...process.env,CHECKPOINT_DB_PATH:db},timeout:20000,windowsHide:true});
      assert.equal(r.status,0,r.stderr||r.stdout);
    };
    run("import * as s from "+JSON.stringify(url)+"; import assert from 'node:assert/strict';"+
      "const id="+JSON.stringify(id)+",cp={version:1,region:'Test',source_mode:'full',phase:'discovery',completed_stage:2};"+
      "await s.saveCheckpoint(id,cp);s.saveMemoryPausedJob({id,mode:'full',createdAt:10,memoryPauseCount:1,latestCheckpointSummary:s.checkpointSummary(cp),progress:{percent:18}});"+
      "assert.equal(s.listMemoryPausedJobs().length,1);");
    run("import * as s from "+JSON.stringify(url)+"; import assert from 'node:assert/strict';"+
      "const id="+JSON.stringify(id)+";const r=s.listMemoryPausedJobs()[0];assert.equal(r.id,id);assert.equal(r.percent,18);"+
      "s.clearMemoryPausedJob(id);assert.equal(s.listMemoryPausedJobs().length,0);assert.equal((await s.loadCheckpoint(id)).completed_stage,2);");
  }finally{
    if(old===undefined)delete process.env.CHECKPOINT_DB_PATH;else process.env.CHECKPOINT_DB_PATH=old;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test("final INN workers finish and commit all started batches before yielding",async()=>{
  const rows=Array.from({length:30},(_,i)=>({__canonical_id:"r"+i,"Организация":"ООО Тест "+i,"ИНН":""}));
  let stop=false,drained=null;
  const calls=[],holds=[];
  const run=resolveFinalMissingInns({
    client:{},finalResult:{direct_buyers:rows,intermediaries:[],leasing:[]},region:"Test",
    assertNotCancelled:async()=>{},shouldPause:()=>stop,
    lookupBatch:async({rows:batch})=>{
      calls.push(batch.map(r=>r.__canonical_id));
      const hold=deferred();holds.push(hold);await hold.promise;
      return {items:[]};
    },
    onPause:async state=>{drained=state;throw Error("test-pause-committed");}
  });
  const observed=assert.rejects(run,/test-pause-committed/);
  await tick();const started=calls.length;assert.ok(started>0);
  stop=true;
  for(const h of holds)h.resolve();
  await observed;
  assert.equal(calls.length,started);
  assert.equal(drained.completedIds.size,calls.flat().length);
  assert.equal(drained.attempted,calls.flat().length);
});
test("Saby checkpoint pause is propagated, closes its browser scope and is never a browser error",async()=>{
  const {runSabyStage12}=await import("../src/sabyStage12.js");
  const {MemoryPauseError}=await import("../src/memoryAdmission.js");
  const result={direct_buyers:[{"Организация":"ООО Альфа","ИНН":"7707083893","Телефон":"","Наличие транспорта":"",
    __canonical_id:"a",__evidence:{source_urls:["https://official.example/"]}}],
    intermediaries:[],leasing:[],statistics:[]};
  let closed=false,writes=0;
  await assert.rejects(runSabyStage12({result,
    env:{SABY_STAGE12_ENABLED:"true",SABY_CHECKPOINT_EVERY:"1"},
    sessionRunner:async task=>{try{return await task({page:{},settings:{}});}finally{closed=true;}},
    collectCompany:async(_page,row)=>({source:"SABY",source_url:"https://profile.saby.ru/page/contractor-info",
      collected_at:"2026-11-25T00:00:00Z",identity:{inn:row["ИНН"],name:row["Организация"],verified:true},
      contacts:{status:"collected",phones:["+74951234567"],emails:[]},
      trucks:{status:"verified",count:0,vehicles:[]},errors:[]}),
    onCheckpoint:async()=>{writes++;throw new MemoryPauseError();}
  }),isMemoryPause);
  assert.equal(closed,true);assert.equal(writes,1);
});

test("estimated RAM capacity below configured concurrency shows memory wait",async()=>{
  const settings={...memoryGuardSettings({}),stableMs:1000,startSpacingMs:1000};
  let now=0;
  const memory=createMemoryAdmission({settings,now:()=>now,sample:()=>({
    valid:true,totalMiB:3500,availableMiB:3000,heapLimitMiB:4096,heapAvailableMiB:3000})});
  const d=deferred(),a=job("a","A"),b=job("b","B");
  const q=createFullJobQueue({limit:10,memory,autoPoll:false,log:()=>{},
    execute:async j=>{j.state="active";if(j.id==="a")await d.promise;j.state="completed";}});
  q.enqueue(a,"key");await tick();q.enqueue(b,"key");
  assert.equal(q.snapshot().memory.effectiveLimit,2);
  // Tighten the effective cgroup limit while one region is active.
  memory.inspect=()=>({canStart:false,pressure:"normal",reason:"estimated_capacity",estimatedCapacity:1});
  now+=1000;q.poll();
  assert.equal(b.progress.phase,"memory_wait");assert.equal(q.snapshot().memory.effectiveLimit,1);
  b.cancelled=true;q.cancelQueued("b");d.resolve();await tick();q.close();
});
