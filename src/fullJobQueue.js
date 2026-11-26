// Bounded queue with optional memory admission and cooperative preemption.
// A suspended study keeps its region reservation and resumes the SAME job.
import {MemoryPauseError,evaluateSabyBrowserAdmission} from "./memoryAdmission.js";
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
  autoPoll=true,log=console.info,canAdmitJob=()=>true,
  collectGarbage=typeof global.gc==="function"?()=>global.gc():null}={}){
  if(typeof execute!=="function")throw TypeError("Queue executor required");
  const capacity=Math.min(MAX_CONCURRENT_RESEARCH_JOBS,Math.max(1,Math.floor(Number(limit)||2)));
  const pending=[],regions=new Map(),running=new Map();
  let active=0,sequence=0,nextStartAt=0,nextPauseAt=0,blocked=false,healthySince=null,lastMemory=null;
  const enabled=!!memory?.settings?.enabled;
  let previousStatus="",lastIdleGcAt=-Infinity,lastSabyGcAt=-Infinity,sabyLease=null,quiesced=false;
  const sabyPolicy=()=>evaluateSabyBrowserAdmission(lastMemory,memory.settings,active);
  function sabyStatus(){
    if(!sabyLease)return null;
    const policy=sabyPolicy();
    return {job_id:sabyLease.item.job.id,region:sabyLease.item.job.region,
      state:sabyLease.state,exclusive:policy.exclusive,
      required_available_mib:policy.requiredAvailableMiB,
      browser_estimate_mib:policy.browserMiB};
  }
  function reclaimIdle(force=false){
    if(!enabled||active!==0||typeof collectGarbage!=="function")return false;
    const now=memory.now();
    if(!force&&now-lastIdleGcAt<Math.max(15000,memory.settings.stableMs))return false;
    lastIdleGcAt=now;
    try{collectGarbage();return true;}catch{return false;}
  }
  function status(){
    if(!enabled)return {};
    return {memory:{enabled:true,blocked,
      effectiveLimit:Math.min(capacity,lastMemory?.estimatedCapacity??capacity,
        sabyLease&&sabyPolicy().exclusive?1:capacity),
      limitedByMemory:blocked||lastMemory?.reason==="estimated_capacity"&&lastMemory.estimatedCapacity<capacity,
      paused:pending.filter(x=>x.paused).length,
      pause_requested:[...running.values()].filter(x=>x.job.memoryPauseRequested).length,
      job_estimate_mib:memory.settings.jobMiB,
      ...lastMemory,
      ...(sabyLease?{reason:"saby_browser_"+sabyLease.state,saby_browser:sabyStatus()}: {})}};
  }
  const snapshot=()=>({active,pending:pending.length,limit:capacity,...status()});
  const conflict=region=>regions.get(normalizedRegionKey(region))||null;
  const firstEligibleIndex=()=>pending.findIndex(item=>!item.job.cancelled&&canAdmitJob(item.job));
  function updatePositions(){
    let position=0;
    for(const item of pending){
      if(item.job.cancelled)continue;
      item.job.progress={...item.job.progress,
        phase:!canAdmitJob(item.job)?"billing_wait":item.paused?"memory_paused":(blocked||
          enabled&&lastMemory?.reason==="estimated_capacity"&&lastMemory.estimatedCapacity<capacity)?"memory_wait":"queued",
        queuePosition:++position,activeFullJobs:active,maxActiveFullJobs:capacity,
        memoryPauseCount:Number(item.job.memoryPauseCount||0)};
    }
  }
  function release(item){
    if(regions.get(item.key)===item.job)regions.delete(item.key);
  }
  function requestPause(item,reason="memory_pressure"){
    if(item.job.cancelled||item.job.memoryPauseRequested||!item.preemptible||
      item.job.state!=="active")return false;
    item.job.memoryPauseRequested=true;
    item.job.progress={...item.job.progress,memoryPauseRequested:true};
    log("[MEMORY_PAUSE_REQUEST] "+JSON.stringify({job_id:item.job.id,pressure:lastMemory.pressure,
      available_mib:lastMemory?.availableMiB,heap_available_mib:lastMemory?.heapAvailableMiB,reason}));
    return true;
  }
  // The reservation is made BEFORE browser launch and after a durable
  // checkpoint. A competing Saby job yields its stack instead of waiting
  // with another full result in memory and deadlocking the first owner.
  function acquireSabyBrowser(item){
    if(item.job.cancelled||item.job.abortController?.signal?.aborted)
      throw Error("JOB_CANCELLED");
    if(item.job.memoryPauseRequested)throw new MemoryPauseError();
    if(sabyLease){
      if(sabyLease.item===item)throw Error("SABY_BROWSER_LEASE_REENTRANT");
      if(requestPause(item,"saby_browser_priority")||item.job.memoryPauseRequested)
        throw new MemoryPauseError();
      throw Error("SABY_BROWSER_LEASE_UNAVAILABLE");
    }
    return new Promise((resolve,reject)=>{
      const lease={item,state:"waiting",resolve,reject,healthySince:null,
        lastGcAt:-Infinity,waitingSince:memory.now(),previousPhase:item.job.progress?.phase||"saby"};
      sabyLease=lease;
      blocked=true;healthySince=null;
      item.job.progress={...item.job.progress,phase:"saby_memory_wait"};
      log("[SABY_MEMORY_GATE] "+JSON.stringify({event:"requested",job_id:item.job.id}));
      pump();
    });
  }
  // Retain exclusive priority while the old Chromium context is already
  // closed and the next context waits for fresh measured headroom.
  function recheckSabyBrowser(lease){
    if(sabyLease!==lease||lease.state!=="active")throw Error("SABY_BROWSER_LEASE_INVALID");
    const {job}=lease.item;
    if(job.cancelled||job.abortController?.signal?.aborted)throw Error("JOB_CANCELLED");
    if(job.memoryPauseRequested)throw new MemoryPauseError();
    return new Promise((resolve,reject)=>{
      Object.assign(lease,{state:"waiting",resolve,reject,healthySince:null,
        waitingSince:memory.now(),lastGcAt:-Infinity});
      blocked=true;healthySince=null;
      job.progress={...job.progress,phase:"saby_memory_wait"};
      log("[SABY_MEMORY_GATE] "+JSON.stringify({event:"reopen_requested",job_id:job.id}));
      pump();
    });
  }
  function releaseSabyBrowser(lease,pumpNow=true){
    if(sabyLease!==lease)return;
    if(lease.state==="waiting"){
      lease.state="unwinding";
      lease.reject(Error("JOB_CANCELLED"));
    }
    sabyLease=null;
    blocked=true;healthySince=null;
    if(lease.item.job.progress?.phase==="saby_memory_wait")
      lease.item.job.progress={...lease.item.job.progress,phase:lease.previousPhase};
    log("[SABY_MEMORY_GATE] "+JSON.stringify({event:"released",job_id:lease.item.job.id}));
    if(pumpNow)pump();
  }
  function advanceSabyBrowser(now){
    const lease=sabyLease;
    if(!lease||lease.state!=="waiting")return;
    const owner=lease.item;
    if(owner.job.cancelled||owner.job.abortController?.signal?.aborted||
        owner.job.memoryPauseRequested){
      lease.state="unwinding";
      lease.reject(owner.job.cancelled||owner.job.abortController?.signal?.aborted
        ?Error("JOB_CANCELLED"):new MemoryPauseError());
      return;
    }
    let policy=sabyPolicy();
    const peers=[...running.values()].filter(item=>item!==owner)
      .sort((a,b)=>b.started-a.started);
    if(policy.exclusive){
      // 2 GiB hosts must drain every other research before Chromium opens.
      for(const peer of peers)requestPause(peer,"saby_browser_priority");
    }else if(!policy.canOpen&&!peers.some(peer=>peer.job.memoryPauseRequested)){
      const peer=peers.find(p=>p.preemptible&&!p.job.cancelled&&p.job.state==="active");
      if(peer)requestPause(peer,"saby_browser_headroom");
    }
    // The owner is quiescent at its checkpoint, not doing paid work.
    // Collect after peers unwind if unreachable objects still block launch.
    if(active===1&&!policy.canOpen&&typeof collectGarbage==="function"&&
        now-lease.lastGcAt>=Math.max(15000,memory.settings.stableMs)){
      lease.lastGcAt=now;
      try{collectGarbage();}catch{/* best effort */}
      lastMemory=memory.inspect(active);
      policy=sabyPolicy();
    }
    const draining=peers.some(peer=>peer.job.memoryPauseRequested);
    if(!policy.canOpen||draining){
      lease.healthySince=null;
      // Do not hold the owner's full JS graph forever if its browser
      // cannot be (re)opened after the peers have unwound.
      if(active===1&&!policy.canOpen&&now-lease.waitingSince>=
          Math.max(60000,2*memory.settings.stableMs)&&
          requestPause(owner,"saby_browser_headroom_stalled")){
        lease.state="unwinding";
        lease.reject(new MemoryPauseError());
      }
      return;
    }
    lease.healthySince??=now;
    if(now-lease.healthySince<memory.settings.stableMs)return;
    lease.state="active";
    owner.job.progress={...owner.job.progress,phase:lease.previousPhase};
    log("[SABY_MEMORY_GATE] "+JSON.stringify({event:"granted",...sabyStatus(),
      available_mib:lastMemory.availableMiB,active}));
    const release=()=>releaseSabyBrowser(lease);
    release.beforeReopen=()=>recheckSabyBrowser(lease);
    lease.resolve(release);
  }
  function admissionSample(){
    const sample=memory.inspect(active);
    const head=pending[firstEligibleIndex()],summary=head?.job.latestCheckpointSummary;
    if(active===0&&head?.paused&&summary?.phase==="saby"&&
       summary.saby_browser_pending!==false&&sample.valid&&sample.canStart){
      const required=sample.reserveMiB+(memory.settings.sabyBrowserMiB??640)+
        (memory.settings.sabyResumeMarginMiB??192);
      if(sample.availableMiB<required)
        return {...sample,canStart:false,reason:"saby_resume_headroom",saby_resume_required_mib:required};
    }
    return sample;
  }
  function inspect(){
    if(!enabled)return true;
    const now=memory.now();
    lastMemory=admissionSample();
    // A queue with no running jobs must not wait indefinitely merely because
    // unreachable V8 objects have not yet been collected. Best-effort GC
    // cannot override the actual host/cgroup/heap admission check.
    if(active===0&&pending.length&&!lastMemory.canStart&&reclaimIdle()){
      lastMemory=admissionSample();
    }
    // At a low-memory sample in a sole Saby job, try reclaiming dead
    // temporary checkpoint/DOM objects before setting an irreversible
    // cooperative pause flag. Critical pressure still pauses immediately.
    if(active===1&&sabyLease?.state==="active"&&lastMemory.pressure==="high"&&
        typeof collectGarbage==="function"&&now-lastSabyGcAt>=10000){
      lastSabyGcAt=now;
      try{collectGarbage();}catch{/* best effort */}
      lastMemory=memory.inspect(active);
    }
    if(lastMemory.pressure==="critical"||lastMemory.pressure==="high"){
      blocked=true;healthySince=null;
      const candidates=[...running.values()].sort((a,b)=>b.started-a.started);
      if(lastMemory.pressure==="critical"){
        for(const item of candidates)requestPause(item);
      }else if(now>=nextPauseAt&&!candidates.some(x=>x.job.memoryPauseRequested)){
        // Once Saby reserves Chromium, drain other regions first. The
        // owner still yields on critical pressure or if the full reserve
        // itself is threatened and no other preemptible region can yield.
        const peers=sabyLease?candidates.filter(x=>x!==sabyLease.item):candidates;
        let victim=peers.find(x=>x.preemptible&&!x.job.cancelled&&x.job.state==="active");
        if(!victim&&sabyLease&&(active===1||
            lastMemory.availableMiB<=lastMemory.reserveMiB||
            lastMemory.heapAvailableMiB<=lastMemory.heapReserveMiB))
          victim=candidates.find(x=>x===sabyLease.item&&x.preemptible&&
            !x.job.cancelled&&x.job.state==="active");
        if(victim)requestPause(victim);
      }
    }
    advanceSabyBrowser(now);
    const waitingForPause=[...running.values()].some(x=>x.job.memoryPauseRequested);
    if(sabyLease){
      blocked=true;healthySince=null;
    }else if(!lastMemory.canStart||waitingForPause){
      if(lastMemory.reason!=="estimated_capacity"||waitingForPause||
        lastMemory.pressure!=="normal")blocked=true;
      healthySince=null;
    }else if(blocked){
      healthySince??=now;
      if(now-healthySince>=memory.settings.stableMs){
        blocked=false;healthySince=null;
      }
    }
    const reason=sabyLease?"saby_browser_"+sabyLease.state:
      blocked?lastMemory.reason||"memory_stabilizing":lastMemory.reason;
    const key=[blocked,lastMemory.pressure,reason,lastMemory.estimatedCapacity].join("|");
    if(key!==previousStatus){
      previousStatus=key;
      log("[MEMORY_ADMISSION] "+JSON.stringify({...lastMemory,blocked,reason,active,
        ...(sabyLease?{saby_browser:sabyStatus()}: {})}));
    }
    return !sabyLease&&!blocked&&lastMemory.canStart&&!waitingForPause&&now>=nextStartAt;
  }
  function pump(){
    if(quiesced)return;
    for(let i=pending.length-1;i>=0;i--){
      if(pending[i].job.cancelled){const [item]=pending.splice(i,1);release(item);}
    }
    let allowed=inspect();
    while(active<capacity&&pending.length&&allowed){
      const index=firstEligibleIndex();
      if(index<0)break;
      const [item]=pending.splice(index,1);
      active++;item.started=++sequence;running.set(item.job.id,item);
      if(enabled){
        nextStartAt=memory.now()+memory.settings.startSpacingMs;
        item.job.memorySafePoint=()=>{
          if(item.job.cancelled)throw Error("JOB_CANCELLED");
          inspect();
          if(item.job.memoryPauseRequested)throw new MemoryPauseError();
        };
        if(item.preemptible)item.job.acquireSabyBrowser=()=>acquireSabyBrowser(item);
      }
      item.job.memoryPauseRequested=false;
      updatePositions();
      queueMicrotask(async()=>{
        let paused=false;
        try{
          const output=await execute(item.job,item.apiKey);
          paused=(output?.memoryPaused===true||output?.billingPaused===true)&&!item.job.cancelled;
        }catch(error){
          item.job.state=item.job.cancelled?"cancelled":"failed";
          item.job.error=error?.message||String(error);
          onError(error);
        }finally{
          active--;running.delete(item.job.id);
          item.job.memoryPauseRequested=false;
          delete item.job.memorySafePoint;
          delete item.job.acquireSabyBrowser;
          // Final safety net if a failure bypassed the stage's finally.
          if(sabyLease?.item===item)releaseSabyBrowser(sabyLease,false);
          if(paused){
            item.paused=true;item.job.state="waiting";
            item.job.progress={...item.job.progress,phase:canAdmitJob(item.job)?"memory_paused":"billing_wait",memoryPauseRequested:false};
            pending.unshift(item);
            blocked=true;healthySince=null;
            // Give the just-unwound job time to reclaim its heap before
            // asking another region to suspend. Critical pressure overrides.
            if(enabled)nextPauseAt=memory.now()+2*memory.settings.pollMs;
          }else{
            if(item.job.cancelled&&item.job.state==="waiting")item.job.state="cancelled";
            release(item);
          }
          // Also collect after NORMAL completion/failure, not only a pause.
          // Do not force GC in the middle of another active paid study.
          reclaimIdle(true);
          pump();
        }
      });
      // Do not admit a burst of jobs using the same pre-allocation sample.
      if(enabled)allowed=false;
    }
    updatePositions();
  }
  function enqueue(job,apiKey,{reserveRegion=true,paused=false}={}){
    if(quiesced)throw Error("RESEARCH_QUEUE_QUIESCED");
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
  // No executing job, no browser lease, and no diagnostic/non-durable
  // work: the server must independently verify each durable marker.
  function idleBlockedJobs(){
    if(!enabled||quiesced||active!==0||sabyLease||!pending.length||firstEligibleIndex()<0||
       pending.some(x=>!x.preemptible||x.job.cancelled||x.job.state!=="waiting"))return null;
    const sample=admissionSample();
    if(!sample.valid||sample.canStart||sample.reason==="estimated_capacity")return null;
    return pending.map(x=>({id:x.job.id,region:x.job.region,mode:x.job.mode,paused:x.paused}));
  }
  function freezeForRecycle(expected){
    const current=idleBlockedJobs();
    if(!current||current.length!==expected.length||
       current.some((x,i)=>x.id!==expected[i].id||x.paused!==expected[i].paused))return false;
    quiesced=true;
    if(timer)clearInterval(timer);
    return true;
  }
  const timer=enabled&&autoPoll?setInterval(pump,memory.settings.pollMs):null;
  timer?.unref?.();
  return {enqueue,cancelQueued,conflict,snapshot,poll:pump,idleBlockedJobs,freezeForRecycle,
    close:()=>{if(timer)clearInterval(timer);}};
}
