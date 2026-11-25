import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {createFullJobQueue} from "../src/fullJobQueue.js";
import {createMemoryAdmission,evaluateMemoryAdmission,memoryGuardSettings} from "../src/memoryAdmission.js";

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const job=(id,region)=>({id,region,state:"waiting",progress:{},cancelled:false});
const settings={...memoryGuardSettings({RESEARCH_MEMORY_JOB_MIB:"768"}),stableMs:1000,startSpacingMs:1000};
const sample=availableMiB=>({valid:true,totalMiB:1967,availableMiB,heapLimitMiB:1080,heapAvailableMiB:831});

test("the last research keeps running at the observed Saby headroom but another is not admitted",()=>{
  for(const available of [492,506,512]){
    const alone=evaluateMemoryAdmission(sample(available),settings,1);
    assert.equal(alone.pressure,"normal");
    assert.equal(alone.canStart,false);
    assert.equal(evaluateMemoryAdmission(sample(available),settings,2).pressure,"high");
  }
  assert.equal(evaluateMemoryAdmission(sample(384),settings,1).pressure,"high");
  assert.equal(evaluateMemoryAdmission(sample(192),settings,1).pressure,"critical");
  assert.equal(evaluateMemoryAdmission({...sample(1200),heapAvailableMiB:128},settings,1).pressure,"critical");
});

test("idle queue reclaims unreachable heap, then uses measured headroom and stabilizes",async()=>{
  let now=0,available=1000,gcCalls=0;
  const starts=[];
  const memory=createMemoryAdmission({settings,now:()=>now,sample:()=>sample(available)});
  let finish;
  const hold=new Promise(resolve=>{finish=resolve;});
  const q=createFullJobQueue({limit:1,memory,autoPoll:false,log:()=>{},
    collectGarbage:()=>{gcCalls++;if(gcCalls>=2)available=1250;},
    execute:async j=>{j.state="active";starts.push(j.id);await hold;j.state="completed";}});
  try{
    q.enqueue(job("a","A"),"test");await tick();
    assert.equal(gcCalls,1);assert.equal(starts.length,0);
    now=14000;q.poll();await tick();assert.equal(gcCalls,1);
    now=15000;q.poll();await tick();assert.equal(gcCalls,2);
    assert.equal(starts.length,0);
    now=16000;q.poll();await tick();assert.deepEqual(starts,["a"]);
    available=492;now+=1000;q.poll();
    assert.equal(q.snapshot().memory.pause_requested,0);
    assert.equal(gcCalls,2);
    finish();await tick();
    assert.equal(q.snapshot().active,0);assert.equal(gcCalls,3);
  }finally{finish();q.close();}
});

test("idle GC cannot override genuine lack of memory",async()=>{
  let calls=0,now=0;
  const memory=createMemoryAdmission({settings,now:()=>now,sample:()=>sample(713)});
  const q=createFullJobQueue({memory,autoPoll:false,log:()=>{},collectGarbage:()=>{calls++;},
    execute:async()=>assert.fail("not enough RAM")});
  try{
    q.enqueue(job("a","A"),"test");now=30000;q.poll();await tick();
    assert.equal(calls,2);assert.equal(q.snapshot().active,0);
    assert.equal(q.snapshot().pending,1);
  }finally{q.close();}
});

test("SQLite preserves unstarted jobs and inline checkpoints, then atomically consumes or cancels intent",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"rr-durable-queue-"));
  try{
    const db=path.join(dir,"queue.sqlite"),url=new URL("../src/checkpointStore.js",import.meta.url).href;
    const common="import * as s from "+JSON.stringify(url)+";import assert from 'node:assert/strict';"+
      "const a='12345678-1234-1234-1234-123456789abc',b='22345678-1234-1234-1234-123456789abc',c='32345678-1234-1234-1234-123456789abc',d='42345678-1234-1234-1234-123456789abc';"+
      "const cp={version:1,pipeline_version:1,region:'B',source_mode:'full',phase:'discovery',completed_stage:2};";
    const run=code=>{
      const r=spawnSync(process.execPath,["--input-type=module","-e",common+code],{
        env:{...process.env,CHECKPOINT_DB_PATH:db,PIPELINE_VERSION:"1"},encoding:"utf8",timeout:20000,windowsHide:true});
      assert.equal(r.status,0,r.stderr||r.stdout);
    };
    run("await s.saveCheckpoint(d,cp);"+
      "s.saveQueuedResearchJob({id:a,region:'A',mode:'full',createdAt:10,data:{region:'A',apiKey:'must-not-store'}});"+
      "s.saveQueuedResearchJob({id:b,region:'B',mode:'resume',createdAt:20,data:{checkpointRef:d,sourceJobId:d},latestCheckpointSummary:s.checkpointSummary(cp)});"+
      "s.saveQueuedResearchJob({id:c,region:'B',mode:'resume',createdAt:30,data:{checkpoint:cp},latestCheckpointSummary:s.checkpointSummary(cp)});"+
      "assert.deepEqual(s.listQueuedResearchJobs().map(x=>x.id),[a,b,c]);");
    run("const jobs=s.listQueuedResearchJobs();assert.deepEqual(jobs.map(x=>x.id),[a,b,c]);"+
      "assert.equal(jobs[1].checkpointRef,d);assert.equal(jobs[2].summary.completed_stage,2);"+
      "assert.equal(Object.hasOwn(jobs[2],'checkpoint_payload'),false);"+
      "assert.deepEqual(s.loadQueuedResearchSource(c),cp);"+
      "assert.deepEqual(s.takeQueuedResearchJob(c),cp);"+
      "assert.throws(()=>s.takeQueuedResearchJob(c),/NOT_DURABLE/);"+
      "s.clearQueuedResearchJob(b);assert.equal(s.takeQueuedResearchJob(a),null);"+
      "assert.equal(s.listQueuedResearchJobs().length,0);"+
      "assert.equal((await s.loadCheckpoint(d)).completed_stage,2);");
    run("assert.equal(s.listQueuedResearchJobs().length,0);");
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
