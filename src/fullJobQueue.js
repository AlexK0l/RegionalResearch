// Bounded queue with optional memory admission and cooperative preemption.
// A suspended study keeps its region reservation and resumes the SAME job.
import {MemoryPauseError} from "./memoryAdmission.js";
export const MAX_CONCURRENT_RESEARCH_JOBS=10;
export function normalizedRegionKey(value){
  return String(value||"").normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replace(/ё/g,"е").replace(/\s*[-–—]\s*/g,"-")
    .replace(/\s+/g," ").trim();
}
export function fullJobConcurrencyLimit(env=process.env){
  const value=Number(env.MAX_ACTIVE_FULL_JOBS);
  return Number.isFinite(value)&&value>=1
    ?Math.min(MAX_CONCURRENT_RESEARCH_JOBS,Math.max(1,Math.floor(value))):2;
}
export function createFullJobQueue({limit=2,execute,onError=console.error,memory=null,
  autoPoll=true,log=console.info}={}){
  if(typeof execute!=="function")throw TypeError("Queue executor required");
  const capacity=Math.min(MAX_CONCURRENT_RESEARCH_JOBS,Math.max(1,Math.floor(Number(limit)||2)));
  const pending=[],regions=new Map(),running=new Map();
  let active=0,sequence=0,nextStartAt=0,blocked=false,healthySince=null,lastMemory=null;
  const enabled=!!memory?.settings?.enabled;
  let previousStatus="";
  function status(){
    if(!enabled)return {};
    return {memory:{enabled:true,blocked,paused:pending.filter(x=>x.paused).length,
      pause_requested:[...running.values()].filter(x=>x.job.memoryPauseRequested).length,
      job_estimate_mib:memory.settings.jobMiB,
      ...lastMemory}};
  }
  const snapshot=()=>({active,pending:pending.length,limit:capacity,...status()});
  const conflict=region=>regions.get(normalizedRegionKey(region))||null;
  function updatePositions(){
    let position=0;
    for(const item of pending){
      if(item.job.cancelled)continue;
      item.job.progress={...item.job.progress,
        phase:item.paused?"memory_paused":blocked?"memory_wait":"queued",
        queuePosition:++position,activeFullJobs:active,maxActiveFullJobs:capacity,
        memoryPauseCount:Number(item.job.memoryPauseCount||0)};
    }
  }
  function release(item){
    if(regions.get(item.key)===item.job)regions.delete(item.key);
  }
  function requestPause(item){
    if(item.job.cancelled||item.job.memoryPauseRequested||!item.preemptible||
      item.job.state!=="active")return;
    item.job.memoryPauseRequested=true;
    item.job.progress={...item.job.progress,memoryPauseRequested:true};
    log("[MEMORY_PAUSE_REQUEST] "+JSON.stringify({job_id:item.job.id,pressure:lastMemory.pressure,
      available_mib:lastMemory.availableMiB,heap_available_mib:lastMemory.heapAvailableMiB}));
  }
  function inspect(){
    if(!enabled)return true;
    const now=memory.now();
    lastMemory=memory.inspect(active);
    if(lastMemory.pressure==="critical"||lastMemory.pressure==="high"){
      blocked=true;healthySince=null;
      const candidates=[...running.values()].sort((a,b)=>b.started-a.started);
      if(lastMemory.pressure==="critical"){
        for(const item of candidates)requestPause(item);
      }else if(!candidates.some(x=>x.job.memoryPauseRequested)){
        const victim=candidates.find(x=>x.preemptible&&!x.job.cancelled&&x.job.state==="active");
        if(victim)requestPause(victim);
      }
    }
    const waitingForPause=[...running.values()].some(x=>x.job.memoryPauseRequested);
    if(!lastMemory.canStart||waitingForPause){
      if(lastMemory.reason!=="estimated_capacity"||waitingForPause||
        lastMemory.pressure!=="normal")blocked=true;
      healthySince=null;
    }else if(blocked){
      healthySince??=now;
      if(now-healthySince>=memory.settings.stableMs){
        blocked=false;healthySince=null;
      }
    }
    const reason=blocked?lastMemory.reason||"memory_stabilizing":lastMemory.reason;
    const key=[blocked,lastMemory.pressure,reason,lastMemory.estimatedCapacity].join("|");
    if(key!==previousStatus){
      previousStatus=key;
      log("[MEMORY_ADMISSION] "+JSON.stringify({blocked,reason,...lastMemory,active}));
    }
    return !blocked&&lastMemory.canStart&&!waitingForPause&&now>=nextStartAt;
  }
  function pump(){
    let allowed=inspect();
    while(active<capacity&&pending.length&&allowed){
      const item=pending.shift();
      if(item.job.cancelled){release(item);continue;}
      active++;item.started=++sequence;running.set(item.job.id,item);
      if(enabled){
        nextStartAt=memory.now()+memory.settings.startSpacingMs;
        item.job.memorySafePoint=()=>{
          if(item.job.cancelled)throw Error("JOB_CANCELLED");
          inspect();
          if(item.job.memoryPauseRequested)throw new MemoryPauseError();
        };
      }
      item.job.memoryPauseRequested=false;
      updatePositions();
      queueMicrotask(async()=>{
        let paused=false;
        try{
          const output=await execute(item.job,item.apiKey);
          paused=output?.memoryPaused===true&&!item.job.cancelled;
        }catch(error){
          item.job.state=item.job.cancelled?"cancelled":"failed";
          item.job.error=error?.message||String(error);
          onError(error);
        }finally{
          active--;running.delete(item.job.id);
          item.job.memoryPauseRequested=false;
          delete item.job.memorySafePoint;
          if(paused){
            item.paused=true;item.job.state="waiting";
            item.job.progress={...item.job.progress,phase:"memory_paused",memoryPauseRequested:false};
            pending.unshift(item);
            blocked=true;healthySince=null;
            // Dropping the unwound stack and checkpoint payload is essential.
            // V8 GC may reclaim these objects; it need not return RSS instantly.
            if(typeof global.gc==="function")global.gc();
          }else{
            if(item.job.cancelled&&item.job.state==="waiting")item.job.state="cancelled";
            release(item);
          }
          pump();
        }
      });
      // Do not admit a burst of jobs using the same pre-allocation sample.
      if(enabled)allowed=false;
    }
    updatePositions();
  }
  function enqueue(job,apiKey,{reserveRegion=true,paused=false}={}){
    const key=reserveRegion?normalizedRegionKey(job?.region):"diagnostic:"+job.id;
    if(!key)throw TypeError("Research region required");
    const existing=regions.get(key);
    if(existing)return {accepted:false,existing};
    regions.set(key,job);
    pending.push({job,apiKey,key,paused,preemptible:reserveRegion,started:0});
    if(paused&&enabled){blocked=true;healthySince=null;}
    pump();
    return {accepted:true};
  }
  function cancelQueued(id){
    const index=pending.findIndex(item=>item.job.id===id);
    if(index<0)return false;
    const [item]=pending.splice(index,1);
    release(item);pump();return true;
  }
  const timer=enabled&&autoPoll?setInterval(pump,memory.settings.pollMs):null;
  timer?.unref?.();
  return {enqueue,cancelQueued,conflict,snapshot,poll:pump,close:()=>{if(timer)clearInterval(timer);}};
}
