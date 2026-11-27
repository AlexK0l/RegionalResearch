import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {createFullJobQueue} from "../src/fullJobQueue.js";

const store=new URL("../src/checkpointStore.js",import.meta.url).href;
const ids=[
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444"
];
test("hard process death preserves active identity and checkpoint without replaying queue intent",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"rr-lifecycle-"));
  const env={...process.env,CHECKPOINT_DB_PATH:path.join(dir,"test.sqlite"),PIPELINE_VERSION:"1"};
  const run=source=>spawnSync(process.execPath,["--input-type=module","-e",
    "import * as s from "+JSON.stringify(store)+"; const ids="+JSON.stringify(ids)+";"+source],
    {env,encoding:"utf8",timeout:15000});
  try{
    const killed=run(`
      const job=(i)=>({id:ids[i],region:"Region "+i,mode:"full",state:"active",
        createdAt:Date.now()+i,data:{},progress:{percent:45}});
      for(let i=0;i<4;i++)s.saveQueuedResearchJob(job(i));
      const first=job(0);first.queuedPersisted=true;
      s.beginResearchExecution(first);
      await s.saveCheckpoint(ids[0],{version:1,region:"Region 0",phase:"discovery",completed_stage:4});
      s.saveResearchLifecycle(job(1),"active"); // died before consuming intent
      const done=job(2);done.queuedPersisted=true;s.beginResearchExecution(done);
      await s.saveCheckpoint(ids[2],{version:1,region:"Region 2",phase:"completed",
        final_result:{direct_buyers:[{}],intermediaries:[],leasing:[],statistics:[]}},done);
      // Hard kill after final checkpoint but before the executor returns.
      s.cancelResearchIntent(job(3));
      process.kill(process.pid,"SIGKILL");
    `);
    assert.equal(killed.error,undefined,String(killed.error));
    assert.ok(killed.signal==="SIGKILL"||process.platform==="win32"&&killed.status!==0,String(killed.stderr));
    const checked=run(`
      console.log(JSON.stringify({queued:s.listQueuedResearchJobs(),history:s.listResearchLifecycle()}));
    `);
    assert.equal(checked.status,0,checked.stderr);
    const d=JSON.parse(checked.stdout);
    assert.deepEqual(d.queued.map(x=>x.id),[ids[1]]);
    const by=Object.fromEntries(d.history.map(x=>[x.id,x]));
    assert.equal(by[ids[0]].state,"interrupted");
    assert.equal(by[ids[0]].summary.completed_stage,4);
    assert.equal(by[ids[0]].summary.phase,"discovery");
    assert.equal(by[ids[2]].state,"completed");
    assert.equal(by[ids[2]].result.resultStored,true);
    assert.equal(by[ids[2]].result.counts.direct_buyers,1);
    assert.equal(by[ids[2]].percent,100);
    assert.equal(by[ids[3]].state,"cancelled");
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test("shutdown prevents queued admission and requests existing safe-point pause",async()=>{
  let entered,unblock;
  const started=new Promise(r=>entered=r),wait=new Promise(r=>unblock=r);
  const seen=[];
  const queue=createFullJobQueue({limit:1,autoPoll:false,log:()=>{},
    execute:async(job)=>{
      seen.push(job.id);job.state="active";entered();await wait;
      assert.throws(()=>job.memorySafePoint(),/memory|pause/i);
      return {memoryPaused:true};
    }});
  const a={id:ids[0],region:"A",state:"waiting",progress:{}};
  const b={id:ids[1],region:"B",state:"waiting",progress:{}};
  queue.enqueue(a,"");queue.enqueue(b,"");
  await started;
  queue.beginShutdown();
  assert.equal(a.memoryPauseRequested,true);
  assert.throws(()=>queue.enqueue({id:ids[2],region:"C"},""),/QUIESCED/);
  unblock();await new Promise(r=>setImmediate(r));
  assert.deepEqual(seen,[ids[0]]);
  assert.equal(queue.snapshot().active,0);
  assert.equal(queue.snapshot().pending,2);
  queue.close();
});
test("shutdown before admitted microtask does not consume its job",async()=>{
  let calls=0;
  const queue=createFullJobQueue({limit:1,autoPoll:false,execute:async()=>{calls++;}});
  queue.enqueue({id:ids[0],region:"A",state:"waiting",progress:{}},"");
  queue.beginShutdown();
  await new Promise(r=>setImmediate(r));
  assert.equal(calls,0);
  assert.equal(queue.snapshot().pending,1);
  assert.equal(queue.snapshot().active,0);
  queue.close();
});

test("admission retains inline imported checkpoint, cancellation and superseded history are safe",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"rr-lifecycle-inline-"));
  try{
    const result=spawnSync(process.execPath,["--input-type=module","-e",
      "import * as s from "+JSON.stringify(store)+"; const ids="+JSON.stringify(ids)+";"+`
      const j={id:ids[0],mode:"resume",region:"R",createdAt:Date.now(),state:"waiting",
        progress:{},data:{checkpoint:{version:1,region:"R",phase:"discovery",completed_stage:3}}};
      s.saveQueuedResearchJob(j);j.queuedPersisted=true;
      s.beginResearchExecution(j);
      if((await s.loadCheckpoint(j.id)).completed_stage!==3)throw Error("lost inline");
      if(s.listQueuedResearchJobs().length)throw Error("stale intent");
      const bad={...j,id:ids[1]};
      try{s.beginResearchExecution(bad);throw Error("unexpected success");}
      catch(e){if(e.message!=="QUEUED_RESEARCH_JOB_NOT_DURABLE")throw e;}
      if(s.listResearchLifecycle().some(x=>x.id===bad.id))throw Error("failed transaction committed");
      await s.markCheckpointStatus(j.id,"superseded");
      if(s.listResearchLifecycle().some(x=>x.id===j.id))throw Error("superseded offered for replay");
      const waiting={id:ids[2],mode:"full",region:"W",createdAt:Date.now(),state:"waiting",data:{},progress:{}};
      s.saveQueuedResearchJob(waiting);s.cancelResearchIntent(waiting);
      if(s.listQueuedResearchJobs().length)throw Error("cancelled resurrected");
      if(s.listResearchLifecycle().find(x=>x.id===waiting.id)?.state!=="cancelled")throw Error("cancel lost");
      `],{env:{...process.env,CHECKPOINT_DB_PATH:path.join(dir,"db.sqlite"),PIPELINE_VERSION:"1"},
        encoding:"utf8",timeout:15000});
    assert.equal(result.status,0,result.stderr);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
