import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";
import {
  processMemorySnapshot,currentCgroupMemoryBytes,createJobMemoryMonitor
} from "../src/runtimeMemory.js";

const M=1024*1024;

test("report process RSS, JS heap and cgroup separately, never as a single heap",()=>{
  const sample=processMemorySnapshot({
    usage:{rss:320*M,heapUsed:104*M,heapTotal:256*M,
      external:14*M,arrayBuffers:5*M},
    cgroupBytes:1536*M
  });
  assert.deepEqual(sample,{
    node_rss_mib:320,node_heap_used_mib:104,node_heap_total_mib:256,
    node_external_mib:14,node_array_buffers_mib:5,
    cgroup_total_mib:1536,cgroup_minus_node_rss_mib:1216
  });
  assert.equal(processMemorySnapshot({
    usage:{rss:16*M,heapUsed:8*M,heapTotal:12*M,external:0,
      arrayBuffers:0},cgroupBytes:null
  }).cgroup_total_mib,null);
});

test("read unified cgroup v2 accounting without probing other processes",()=>{
  if(process.platform!=="linux")return;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"rr-memory-cgroup-"));
  try{
    const proc=path.join(dir,"cgroup");
    const root=path.join(dir,"sys");
    const group=path.join(root,"system.slice","regionalresearch.service");
    fs.mkdirSync(group,{recursive:true});
    fs.writeFileSync(proc,"0::/system.slice/regionalresearch.service\n");
    fs.writeFileSync(path.join(group,"memory.current"),String(1536*M));
    assert.equal(currentCgroupMemoryBytes({procCgroup:proc,cgroupRoot:root}),1536*M);
    fs.writeFileSync(proc,"0::/missing\n");
    assert.equal(currentCgroupMemoryBytes({procCgroup:proc,cgroupRoot:root}),null);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test("monitor logs bounded structured snapshots and removes interval after job",()=>{
  const lines=[];
  const job={id:"test-id",mode:"full",progress:{phase:"discovery"}};
  const monitor=createJobMemoryMonitor(job,{
    intervalMs:60000,
    snapshot:()=>({node_rss_mib:120,node_heap_used_mib:40,
      cgroup_total_mib:240}),
    logger:line=>lines.push(line)
  });
  monitor.start();
  monitor.start();
  job.progress.phase="contacts";
  monitor.phase("contacts");
  monitor.stop();
  monitor.stop();
  assert.equal(lines.length,2);
  const [start,end]=lines.map(line=>JSON.parse(line.split("[JOB_MEMORY] ")[1]));
  assert.equal(start.reason,"start");
  assert.equal(start.phase,"discovery");
  assert.equal(end.reason,"finish");
  assert.equal(end.phase,"contacts");
  assert.equal(start.node_heap_used_mib,40);
  assert.equal("env" in start,false);
  assert.equal("region" in start,false);
});

test("server retains only checkpoint summaries and exposes memory in the normal browser",()=>{
  const source=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
  const ui=fs.readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
  const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
  const store=fs.readFileSync(new URL("../src/checkpointStore.js",import.meta.url),"utf8");
  execFileSync(process.execPath,["--check",
    fileURLToPath(new URL("../server.js",import.meta.url))]);
  execFileSync(process.execPath,["--check",
    fileURLToPath(new URL("../public/app.js",import.meta.url))]);
  assert.match(source,/createJobMemoryMonitor\(job\)/);
  assert.match(source,/memoryMonitor\.stop\(\)/);
  assert.match(source,/processMemorySnapshot\(\)/);
  assert.match(source,/app\.get\("\/api\/runtime\/memory"/);
  assert.match(source,/this\.latestCheckpointSummary=checkpointSummary\(checkpoint\)/);
  assert.match(source,/this\.latestCheckpoint=null/);
  assert.match(source,/function compactCompletedJobPayload\(job\)/);
  assert.match(source,/return preparePersistedCheckpointExport\(checkpoint\)/);
  assert.match(source,/job\.result\?\.resultStored/);
  assert.match(store,/const normalized = \{ \.\.\.checkpoint, pipeline_version: PIPELINE_VERSION \}/);
  assert.doesNotMatch(store,/const normalized = normalizeCheckpoint\(checkpoint\);\s*if \(!normalized\) throw new Error\("Некорректный checkpoint"\)/);
  assert.match(html,/id="runtimeMemory"/);
  assert.match(ui,/payload\?\.memory/);
});
