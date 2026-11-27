// Exercise real Express startup/restore/shutdown, isolated from production.
// The seeded billing latch and fake key prevent every paid job from entering
// execution. No Chromium, OpenAI requests, real company data or live DB.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawn,spawnSync} from "node:child_process";

const store=new URL("../src/checkpointStore.js",import.meta.url).href;
const server=fileURLToPath(new URL("../server.js",import.meta.url));
const ids=["11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555"];
const delay=ms=>new Promise(r=>setTimeout(r,ms));

test("real HTTP server restores jobs and drains on SIGTERM without paid replay",{timeout:45000},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"rr-server-restart-"));
  const token="isolated-restart-test-token";
  const env={...process.env,RENDER:"",PORT:"0",BIND_HOST:"127.0.0.1",
    API_ACCESS_TOKEN:token,WEB_LOGIN_PASSWORD_HASH:"",
    OPENAI_API_KEY:"offline-fixture-never-send",OPENAI_BASE_URL:"http://127.0.0.1:1/v1",
    LOG_DIR:path.join(dir,"logs"),CHECKPOINT_DB_PATH:path.join(dir,"db.sqlite"),
    PIPELINE_VERSION:"1",SKIP_CHROMIUM_SELF_TEST:"true",SABY_STAGE12_ENABLED:"false",
    RESEARCH_MEMORY_GUARD_ENABLED:"false",RESEARCH_MEMORY_IDLE_RECYCLE_ENABLED:"false"};
  const seed=spawnSync(process.execPath,["--input-type=module","-e",
    "import * as s from "+JSON.stringify(store)+";const ids="+JSON.stringify(ids)+";"+`
    const j=i=>({id:ids[i],region:"Fixture "+i,mode:"full",createdAt:Date.now()+i,
      state:"waiting",data:{},progress:{percent:25}});
    const cp=i=>({version:1,region:"Fixture "+i,source_mode:"full",
      phase:"discovery",completed_stage:2,parts:[]});
    s.setOpenAIBillingHold();
    const interrupted=j(0);s.saveQueuedResearchJob(interrupted);
    interrupted.queuedPersisted=true;s.beginResearchExecution(interrupted);
    await s.saveCheckpoint(interrupted.id,cp(0),interrupted);
    const done=j(1);s.saveQueuedResearchJob(done);done.queuedPersisted=true;
    s.beginResearchExecution(done);
    await s.saveCheckpoint(done.id,{...cp(1),phase:"completed",
      final_result:{direct_buyers:[],intermediaries:[],leasing:[],statistics:[]}},done);
    s.saveQueuedResearchJob(j(2));
    const paused=j(3);const saved=cp(3);
    await s.saveCheckpoint(paused.id,saved);
    paused.latestCheckpointSummary=s.checkpointSummary(saved);
    paused.memoryPauseCount=1;s.saveMemoryPausedJob(paused);
    const cancelled=j(4);s.saveQueuedResearchJob(cancelled);s.cancelResearchIntent(cancelled);
    `],{env,encoding:"utf8",timeout:10000});
  assert.equal(seed.status,0,seed.stderr||String(seed.error));
  let child,output="",exited;
  async function start(){
    output="";
    child=spawn(process.execPath,[server],{env,stdio:["ignore","pipe","pipe"]});
    child.stdout.on("data",b=>{output+=b.toString();});
    child.stderr.on("data",b=>{output+=b.toString();});
    exited=new Promise(resolve=>child.once("exit",(code,signal)=>resolve({code,signal})));
    let port=0;
    for(let i=0;i<150;i++){
      const m=output.match(/service listening on 127\.0\.0\.1:(\d+)/);
      if(m){port=Number(m[1]);break;}
      if(child.exitCode!==null||child.signalCode!==null)throw Error(output);
      await delay(50);
    }
    assert.ok(port,output);
    const req=async(p,method="GET")=>{
      const res=await fetch("http://127.0.0.1:"+port+p,{method,
        headers:{Authorization:"Bearer "+token},signal:AbortSignal.timeout(5000)});
      assert.ok(res.ok,res.status+" "+p);
      return res.json();
    };
    const health=await req("/health");
    assert.equal(health.checkpoints.ready,true);
    return req;
  }
  async function stop(signal){
    child.kill(signal);
    const result=await Promise.race([exited,delay(9000).then(()=>null)]);
    assert.ok(result,output);
    if(signal==="SIGTERM"&&process.platform!=="win32"){
      assert.equal(result.code,0,output);
      assert.match(output,/SERVICE_SHUTDOWN_DRAINED/);
    }
    child=null;
  }
  try{
    let req=await start();
    let d=await req("/api/jobs");
    let by=Object.fromEntries(d.jobs.map(x=>[x.id,x]));
    assert.equal(d.queue.active,0);
    assert.equal(d.queue.pending,2);
    assert.equal(d.billing.blocked,true);
    assert.equal(by[ids[0]].state,"interrupted");
    assert.equal(by[ids[0]].checkpointStage,2);
    assert.equal(by[ids[1]].state,"completed");
    assert.equal(by[ids[1]].hasResult,true);
    assert.equal(by[ids[2]].state,"waiting");
    assert.equal(by[ids[3]].state,"waiting");
    assert.equal(by[ids[4]].state,"cancelled");
    const detail=await req("/api/jobs/"+ids[0]);
    assert.equal(detail.resume_available,true);
    assert.equal((await req("/api/jobs/"+ids[0]+"/checkpoint")).completed_stage,2);
    assert.equal((await req("/api/jobs/"+ids[1]+"/download-json")).region,"Fixture 1");
    assert.equal((await req("/api/jobs/"+ids[2]+"/cancel","POST")).state,"cancelled");
    await stop(process.platform==="win32"?"SIGKILL":"SIGTERM");
    req=await start();
    d=await req("/api/jobs");by=Object.fromEntries(d.jobs.map(x=>[x.id,x]));
    assert.equal(d.queue.active,0);
    assert.equal(d.queue.pending,1);
    assert.equal(by[ids[0]].state,"interrupted");
    assert.equal(by[ids[1]].state,"completed");
    assert.equal(by[ids[2]].state,"cancelled");
    assert.equal(by[ids[3]].state,"waiting");
    assert.doesNotMatch(output,/\[JOB_START\]/);
    await stop("SIGKILL");
    req=await start();
    d=await req("/api/jobs");
    assert.equal(d.queue.active,0);
    assert.equal(d.queue.pending,1);
    assert.equal(d.jobs.find(x=>x.id===ids[0]).state,"interrupted");
    await stop(process.platform==="win32"?"SIGKILL":"SIGTERM");
  }finally{
    if(child){child.kill("SIGKILL");await exited;}
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
