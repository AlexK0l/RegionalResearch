// Read-only host/cgroup/V8 memory pressure policy. Swap is not available RAM.
// Admission estimates are intentionally conservative, not OOM guarantees.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";

const M=1024*1024;
const integer=(raw,fallback,min,max)=>{
  const s=String(raw??"").trim(),n=Number(s);
  return /^\d+$/.test(s)&&Number.isSafeInteger(n)?Math.max(min,Math.min(max,n)):fallback;
};
export function memoryGuardSettings(env=process.env){
  return {
    enabled:String(env.RESEARCH_MEMORY_GUARD_ENABLED??"true").toLowerCase()!=="false",
    reserveMiB:integer(env.RESEARCH_MEMORY_RESERVE_MIB,384,128,32768),
    jobMiB:integer(env.RESEARCH_MEMORY_JOB_MIB,1536,256,32768),
    heapReserveMiB:integer(env.RESEARCH_MEMORY_HEAP_RESERVE_MIB,256,64,8192),
    heapJobMiB:integer(env.RESEARCH_MEMORY_HEAP_JOB_MIB,256,64,8192),
    pollMs:integer(env.RESEARCH_MEMORY_POLL_MS,2000,500,30000),
    stableMs:integer(env.RESEARCH_MEMORY_RESUME_STABLE_MS,15000,1000,300000),
    startSpacingMs:integer(env.RESEARCH_MEMORY_START_SPACING_MS,5000,1000,60000)
  };
}
export class MemoryPauseError extends Error {
  constructor(){super("JOB_MEMORY_PAUSE");this.name="MemoryPauseError";}
}
export const isMemoryPause=error=>error instanceof MemoryPauseError;

function readNumber(file,read){
  try{
    const s=String(read(file)).trim();
    if(!/^\d+$/.test(s))return null;
    const n=Number(s);
    return Number.isSafeInteger(n)&&n>=0?n:null;
  }catch{return null;}
}
export function readMemoryHeadroom({
  platform=process.platform,read=file=>fs.readFileSync(file,"utf8"),
  total=os.totalmem(),free=os.freemem(),heap=v8.getHeapStatistics(),
  cgroupRoot="/sys/fs/cgroup"
}={}){
  let hostTotal=Number(total),hostAvailable=Number(free),hostSource="os_free";
  let groupLimit=null,groupHeadroom=null;
  if(platform==="linux"){
    try{
      const info=String(read("/proc/meminfo"));
      const t=/^MemTotal:\s+(\d+)\s+kB/m.exec(info);
      const a=/^MemAvailable:\s+(\d+)\s+kB/m.exec(info);
      if(t&&a){hostTotal=Number(t[1])*1024;hostAvailable=Number(a[1])*1024;hostSource="mem_available";}
    }catch{/* conservative free-memory fallback */}
    try{
      const cg=String(read("/proc/self/cgroup")).split("\n").find(x=>x.startsWith("0::"));
      if(cg){
        const rel=cg.slice(3).trim().replace(/^\/+/,"");
        const root=path.resolve(cgroupRoot),leaf=path.resolve(root,rel);
        if(leaf!==root&&!leaf.startsWith(root+path.sep))throw Error("invalid cgroup path");
        // A parent slice can be tighter than the service's own memory.max.
        for(let dir=leaf;;dir=path.dirname(dir)){
          const cur=readNumber(path.join(dir,"memory.current"),read);
          for(const name of ["memory.max","memory.high"]){
            const cap=readNumber(path.join(dir,name),read);
            if(cap===null)continue;
            groupLimit=groupLimit===null?cap:Math.min(groupLimit,cap);
            // An unreadable current counter for a finite limit is unsafe.
            const remaining=cur===null?0:Math.max(0,cap-cur);
            groupHeadroom=groupHeadroom===null?remaining:Math.min(groupHeadroom,remaining);
          }
          if(dir===root)break;
        }
      }
    }catch{/* host measurement is still available */}
  }
  const limit=groupLimit===null?hostTotal:Math.min(hostTotal,groupLimit);
  const available=Math.max(0,Math.min(hostAvailable,limit,groupHeadroom??Infinity));
  const heapLimit=Number(heap?.heap_size_limit),used=Number(heap?.used_heap_size);
  const valid=[hostTotal,hostAvailable,limit,available,heapLimit,used].every(Number.isFinite)&&
    hostTotal>0&&limit>=0&&hostAvailable>=0&&heapLimit>0&&used>=0;
  return {valid,hostSource,totalMiB:Math.floor(limit/M),availableMiB:Math.floor(available/M),
    hostAvailableMiB:Math.floor(hostAvailable/M),
    heapLimitMiB:Math.floor(heapLimit/M),heapAvailableMiB:Math.max(0,Math.floor((heapLimit-used)/M)),
    cgroupLimited:groupLimit!==null};
}
export function evaluateMemoryAdmission(sample,settings,active=0){
  if(!sample?.valid)return {canStart:false,pressure:"unknown",reason:"memory_measurement_unavailable"};
  const reserve=Math.max(settings.reserveMiB,Math.ceil(sample.totalMiB*0.12));
  const heapReserve=Math.max(settings.heapReserveMiB,Math.ceil(sample.heapLimitMiB*0.08));
  const capacity=Math.max(0,Math.min(10,Math.floor((sample.totalMiB-reserve)/settings.jobMiB),
    Math.floor((sample.heapLimitMiB-heapReserve)/settings.heapJobMiB)));
  const critical=sample.availableMiB<=reserve/2||sample.heapAvailableMiB<=heapReserve/2;
  const pressured=sample.availableMiB<=reserve||sample.heapAvailableMiB<=heapReserve;
  const enough=sample.availableMiB>=reserve+settings.jobMiB+active*128&&
    sample.heapAvailableMiB>=heapReserve+settings.heapJobMiB+active*64;
  return {canStart:!pressured&&enough&&active<capacity,
    pressure:critical?"critical":pressured?"high":"normal",
    reason:pressured?"memory_reserve_reached":active>=capacity?"estimated_capacity":
      !enough?"insufficient_headroom":"",
    reserveMiB:reserve,heapReserveMiB:heapReserve,estimatedCapacity:capacity,
    ...sample};
}
export function createMemoryAdmission({settings=memoryGuardSettings(),sample=readMemoryHeadroom,now=Date.now}={}){
  return {settings,now,inspect(active){
    try{return evaluateMemoryAdmission(sample(),settings,active);}
    catch{return {canStart:false,pressure:"unknown",reason:"memory_measurement_unavailable"};}
  }};
}
