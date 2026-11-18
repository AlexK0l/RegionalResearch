// Lightweight, read-only memory accounting for one Node process and its
// systemd cgroup (Chromium/Playwright/Python children). Values are MiB.
// No heap snapshots, user records, environment variables or private paths
// are written to logs. The Linux cgroup metric may include file cache.
import fs from "node:fs";
import path from "node:path";

const MIB=1024*1024;
const mib=value=>Math.round(Number(value||0)/MIB);
const readBytes=file=>{
  try{
    const n=Number(fs.readFileSync(file,"utf8").trim());
    return Number.isFinite(n)&&n>=0?n:null;
  }catch{return null;}
};
export function currentCgroupMemoryBytes({
  procCgroup="/proc/self/cgroup",cgroupRoot="/sys/fs/cgroup"
}={}){
  if(process.platform!=="linux")return null;
  try{
    const records=fs.readFileSync(procCgroup,"utf8").split("\n");
    const unified=records.find(line=>line.startsWith("0::"));
    if(unified){
      const relative=unified.slice(3).trim().replace(/^\/+/, "");
      const current=readBytes(path.join(cgroupRoot,relative,"memory.current"));
      if(current!==null)return current;
    }
  }catch{/* Linux /proc may be unavailable in containers */}
  return readBytes(path.join(cgroupRoot,"memory.current"));
}

export function processMemorySnapshot({
  usage=process.memoryUsage(),cgroupBytes=currentCgroupMemoryBytes()
}={}){
  return {
    node_rss_mib:mib(usage.rss),
    node_heap_used_mib:mib(usage.heapUsed),
    node_heap_total_mib:mib(usage.heapTotal),
    node_external_mib:mib(usage.external),
    node_array_buffers_mib:mib(usage.arrayBuffers),
    cgroup_total_mib:cgroupBytes===null?null:mib(cgroupBytes),
    // Not a rigorous sum of browser RSS: cgroup includes page cache,
    // memory-shared pages and all descendants of this service.
    cgroup_minus_node_rss_mib:cgroupBytes===null?null:
      Math.max(0,mib(cgroupBytes-usage.rss))
  };
}

export function createJobMemoryMonitor(job,{
  intervalMs=60000,logger=console.log,snapshot=processMemorySnapshot
}={}){
  const safeInterval=Math.max(15000,Math.min(600000,Number(intervalMs)||60000));
  let started=false,timer=null,lastPhase="",lastAt=0;
  const emit=(reason,phase="")=>{
    const sample=snapshot();
    logger("[JOB_MEMORY] "+JSON.stringify({
      job_id:String(job?.id||""),
      mode:String(job?.mode||""),
      phase:String(phase||job?.progress?.phase||""),
      reason,...sample
    }));
    lastPhase=String(phase||job?.progress?.phase||"");
    lastAt=Date.now();
    return sample;
  };
  return {
    start(){
      if(started)return;
      started=true;
      emit("start");
      timer=setInterval(()=>emit("interval"),safeInterval);
      timer.unref?.();
    },
    phase(phase){
      if(!started)return;
      const next=String(phase||"");
      if(next!==lastPhase&&Date.now()-lastAt>=5000)
        emit("phase_changed",next);
    },
    stop(){
      if(!started)return;
      started=false;
      if(timer){clearInterval(timer);timer=null;}
      emit("finish");
    }
  };
}
