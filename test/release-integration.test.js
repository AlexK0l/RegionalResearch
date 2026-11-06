import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const root=fileURLToPath(new URL("../",import.meta.url));
const serverFile=fileURLToPath(new URL("../server.js",import.meta.url));
const source=fs.readFileSync(serverFile,"utf8");

function directory() {
  return fs.mkdtempSync(path.join(os.tmpdir(),"regionalresearch-release-"));
}

async function launchIsolatedServer(folder,{token=""}={}) {
  const env={...process.env,PORT:"0",RENDER:"",API_ACCESS_TOKEN:token,
    OPENAI_API_KEY:"",CHECKPOINT_DB_PATH:path.join(folder,"smoke.sqlite"),
    LOG_DIR:path.join(folder,"logs"),BIND_HOST:"127.0.0.1",
    SKIP_CHROMIUM_SELF_TEST:"true"};
  const child=spawn(process.execPath,[serverFile],{
    cwd:root,env,stdio:["ignore","pipe","pipe"],windowsHide:true
  });
  let logs="",settled=false;
  const ready=new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{
      child.kill();
      if(!settled){settled=true;reject(new Error("HTTP launch timeout: "+logs.slice(-2000)));}
    },20000);
    timeout.unref?.();
    const error=err=>{
      if(settled)return;
      settled=true;clearTimeout(timeout);reject(err);
    };
    child.on("error",error);
    child.on("exit",(code)=>error(new Error("Server exited "+code+": "+logs.slice(-2500))));
    child.stdout.on("data",chunk=>{
      logs+=chunk.toString();
      const match=logs.match(/SAT research web service listening on 127\.0\.0\.1:(\d+)/);
      if(match&&!settled){settled=true;clearTimeout(timeout);resolve(Number(match[1]));}
    });
    child.stderr.on("data",chunk=>{logs+=chunk.toString();});
  });
  try{return {child,port:await ready,logs:()=>logs};}
  catch(error){child.kill();throw error;}
}

test("local server HTTP smoke: ready SQLite, config, rejected paid job, safe missing downloads",async()=>{
  const tmp=directory();
  let child;
  try{
    const launched=await launchIsolatedServer(tmp);
    child=launched.child;
    const base="http://127.0.0.1:"+launched.port;
    const health=await fetch(base+"/health");
    assert.equal(health.status,200);
    const info=await health.json();
    assert.equal(info.checkpoints.backend,"sqlite");
    assert.equal(info.checkpoints.ready,true);
    assert.equal(info.runtime,"local");
    const config=await fetch(base+"/api/config");
    assert.equal(config.status,200);
    assert.ok((await config.json()).pipelineVersion>=1);
    const queue=await fetch(base+"/api/jobs");
    assert.equal(queue.status,200);
    const initial=await queue.json();
    assert.deepEqual(initial.jobs,[]);
    assert.equal(initial.queue.limit,2);
    assert.equal(initial.queue.active,0);
    assert.equal(initial.queue.pending,0);
    const list=await fetch(base+"/api/checkpoints?region="+encodeURIComponent("Смоленская область")+"&mode=full");
    assert.equal(list.status,200);
    assert.deepEqual((await list.json()).history,[]);
    for(const ending of ["download","download-json","download-audit","quality"]){
      const response=await fetch(base+"/api/jobs/no-such-job/"+ending);
      assert.equal(response.status,404,ending);
    }
    const paid=await fetch(base+"/api/jobs",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({region:"Смоленская область",mode:"full",startFresh:true})
    });
    assert.equal(paid.status,503);
    assert.match((await paid.json()).error,/OPENAI_API_KEY/);
    assert.ok(fs.existsSync(path.join(tmp,"smoke.sqlite")));
  }finally{
    child?.kill();
    // Do not race the child process closing its SQLite/WAL handles on Windows.
    // Files in an OS temp directory are harmless if Windows delays cleanup.
    try {fs.rmSync(tmp,{recursive:true,force:true});}catch{}
  }
});

test("API_ACCESS_TOKEN protects completed exports and checkpoint listings",async()=>{
  const tmp=directory();
  let child;
  try{
    const launched=await launchIsolatedServer(tmp,{token:"only-test-secret"});
    child=launched.child;
    const base="http://127.0.0.1:"+launched.port;
    const unauthorized=await fetch(base+"/api/checkpoints?region=Sample");
    assert.equal(unauthorized.status,401);
    const allowed=await fetch(base+"/api/checkpoints?region=Sample",{
      headers:{Authorization:"Bearer only-test-secret"}
    });
    assert.equal(allowed.status,200);
    const download=await fetch(base+"/api/jobs/unavailable/download-json");
    assert.equal(download.status,401);
    assert.equal((await fetch(base+"/api/config")).status,200);
  }finally{
    child?.kill();
    try {fs.rmSync(tmp,{recursive:true,force:true});}catch{}
  }
});

test("LAN without access token fails before server opens any HTTP port",()=>{
  const tmp=directory();
  try{
    const proc=spawnSync(process.execPath,[serverFile],{
      cwd:root,encoding:"utf8",timeout:10000,windowsHide:true,
      env:{...process.env,RENDER:"",PORT:"0",BIND_HOST:"0.0.0.0",
        API_ACCESS_TOKEN:"",OPENAI_API_KEY:"",
        CHECKPOINT_DB_PATH:path.join(tmp,"unused.sqlite"),LOG_DIR:path.join(tmp,"logs"),
        SKIP_CHROMIUM_SELF_TEST:"true"}
    });
    assert.notEqual(proc.status,0);
    assert.match((proc.stderr||"")+(proc.stdout||""),/BIND_HOST outside localhost requires API_ACCESS_TOKEN/);
  }finally{try{fs.rmSync(tmp,{recursive:true,force:true});}catch{}}
});

test("SQLite WAL checkpoint replacement preserves source payload and failed-run fallback",async()=>{
  const dir=directory();
  const previous=process.env.CHECKPOINT_DB_PATH;
  try {
    process.env.CHECKPOINT_DB_PATH=path.join(dir,"checkpoints.sqlite");
    const store=await import("../src/checkpointStore.js?release_integrity="+Date.now());
    const old={version:1,region:"Release Test Region",source_mode:"full",
      phase:"contacts",completed_stage:9,contact_completed_ids:["a"],
      contact_unsearched_ids:["b"],final_result:{direct_buyers:[{"Организация":"Old"}]}};
    await store.saveCheckpoint("old",old);
    const before=JSON.stringify(await store.loadCheckpoint("old"));
    assert.equal((await store.findLatestCheckpoint("Release Test Region"))?.id,"old");
    assert.match(source,/CHECKPOINT_REPLACEMENT_DEFERRED/);
    assert.doesNotMatch(source,/if \(req\.body\?\.startFresh\)\s*\{\s*await supersedeRegionCheckpoints/);
    assert.doesNotMatch(source,/await supersedeRegionCheckpoints\(checkpoint\.region, "full", req\.params\.id\)/);
    // Queuing a fresh/retry study does NOT mark the old checkpoint superseded.
    assert.equal((await store.findLatestCheckpoint("Release Test Region"))?.id,"old");
    const fresh={version:1,region:"Release Test Region",source_mode:"full",
      phase:"completed",completed_stage:9,
      final_result:{direct_buyers:[{"Организация":"New"}]}};
    await store.saveCheckpoint("new",fresh);
    const retired=await store.supersedeRegionCheckpoints("Release Test Region","full","new");
    assert.equal(retired,1);
    assert.equal(await store.findLatestCheckpoint("Release Test Region"),null);
    assert.equal(JSON.stringify(await store.loadCheckpoint("old")),before);
    assert.equal((await store.loadCheckpoint("new")).final_result.direct_buyers[0]["Организация"],"New");
    const history=await store.listRegionCheckpoints("Release Test Region");
    assert.equal(history.find(x=>x.id==="old").status,"superseded");
    assert.equal(history.find(x=>x.id==="new").status,"completed");
  } finally {
    if(previous===undefined)delete process.env.CHECKPOINT_DB_PATH;
    else process.env.CHECKPOINT_DB_PATH=previous;
    try {fs.rmSync(dir,{recursive:true,force:true});}catch{}
  }
});
