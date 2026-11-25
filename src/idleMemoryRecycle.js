// Opt-in systemd-only process recycling, never an active research kill.
// Persistent SQLite cooldown is claimed by the caller immediately before
// quiescing admission and closing the HTTP listener.
export const IDLE_MEMORY_RECYCLE_EXIT_CODE=75;
const int=(raw,fallback,min,max)=>{
  const n=Number(raw);
  return /^\d+$/.test(String(raw??"").trim())&&Number.isSafeInteger(n)?
    Math.max(min,Math.min(max,n)):fallback;
};
export function idleMemoryRecycleSettings(env=process.env){
  return {
    enabled:env.RESEARCH_MEMORY_IDLE_RECYCLE_ENABLED==="true",
    stallMs:int(env.RESEARCH_MEMORY_IDLE_RECYCLE_STALL_MS,120000,60000,3600000),
    cooldownMs:int(env.RESEARCH_MEMORY_IDLE_RECYCLE_COOLDOWN_MS,1800000,300000,86400000),
    minRssMiB:int(env.RESEARCH_MEMORY_IDLE_RECYCLE_MIN_RSS_MIB,384,256,32768)
  };
}

export function durableIdleJobsMatch(candidates,{queued=[],paused=[],canRestore=()=>true}={}){
  if(!Array.isArray(candidates)||!candidates.length)return false;
  const q=new Map(queued.map(x=>[x.id,x])),p=new Map(paused.map(x=>[x.id,x]));
  return candidates.every(x=>{
    const marker=(x.paused?p:q).get(x.id);
    return !!marker&&marker.region===x.region&&marker.mode===x.mode&&canRestore(marker);
  });
}

// The continuous stall is reset on admission, empty queue, external memory
// release, or a changed pending set. A slow HTTP export postpones the exit,
// but does not discard an otherwise continuous stall.
export function createIdleMemoryRecycleGuard({
  settings=idleMemoryRecycleSettings(),now=Date.now,
  candidates=()=>null,rssMiB=()=>process.memoryUsage.rss()/1048576,
  canExit=()=>false,isDurable=()=>false,claim=()=>false,freeze=()=>false,
  exit=()=>{},log=console.info
}={}){
  let key="",since=null,started=false,nextClaimAt=0;
  return {poll(){
    if(!settings.enabled||started)return false;
    const at=now(),items=candidates(),rss=rssMiB();
    if(!items?.length||!Number.isFinite(rss)||rss<settings.minRssMiB){
      key="";since=null;return false;
    }
    const signature=items.map(x=>x.id+":"+Number(x.paused)).sort().join("|");
    if(signature!==key){key=signature;since=at;return false;}
    if(since===null||at-since<settings.stallMs||at<nextClaimAt||!canExit())return false;
    // Verify fresh markers without loading a full checkpoint. I/O failure
    // or an unsupported job is a refusal to exit, not permission to restart.
    try{
      if(!isDurable(items))return false;
      if(!claim(at,settings.cooldownMs)){
        nextClaimAt=at+60000;
        return false;
      }
      if(!freeze(items))return false;
      started=true;
      log("[MEMORY_IDLE_RECYCLE] "+JSON.stringify({
        event:"requested",pending:items.length,stalled_ms:at-since,node_rss_mib:Math.round(rss),
        exit_code:IDLE_MEMORY_RECYCLE_EXIT_CODE
      }));
      exit(IDLE_MEMORY_RECYCLE_EXIT_CODE);
      return true;
    }catch(error){
      nextClaimAt=at+60000;
      log("[MEMORY_IDLE_RECYCLE] "+JSON.stringify({event:"refused",reason:"durability_or_shutdown_error"}));
      return false;
    }
  }};
}
