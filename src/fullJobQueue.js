// Bounded in-process queue for full/resume research. Each region is reserved
// from acceptance until completion/cancellation, including while queued.
export function normalizedRegionKey(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е").replace(/\s*[-–—]\s*/g, "-")
    .replace(/\s+/g, " ").trim();
}
export function fullJobConcurrencyLimit(env=process.env) {
  const value=Number(env.MAX_ACTIVE_FULL_JOBS);
  return Number.isFinite(value)&&value>=1
    ? Math.min(3,Math.max(1,Math.floor(value))) : 2;
}
export function createFullJobQueue({limit=2,execute,onError=console.error}={}) {
  if(typeof execute!=="function")throw TypeError("Queue executor required");
  const capacity=Math.min(3,Math.max(1,Math.floor(Number(limit)||2)));
  const pending=[],regions=new Map();
  let active=0;
  const snapshot=()=>({active,pending:pending.length,limit:capacity});
  const conflict=region=>regions.get(normalizedRegionKey(region))||null;
  function updatePositions(){
    let position=0;
    for(const item of pending){
      if(item.job.cancelled)continue;
      item.job.progress={...item.job.progress,phase:"queued",
        queuePosition:++position,activeFullJobs:active,
        maxActiveFullJobs:capacity};
    }
  }
  function release(item){
    if(regions.get(item.key)===item.job)regions.delete(item.key);
  }
  function pump(){
    while(active<capacity&&pending.length){
      const item=pending.shift();
      if(item.job.cancelled){release(item);continue;}
      active++;
      updatePositions();
      queueMicrotask(async()=>{
        try{
          await execute(item.job,item.apiKey);
        }catch(error){
          item.job.state=item.job.cancelled?"cancelled":"failed";
          item.job.error=error?.message||String(error);
          onError(error);
        }finally{
          active--;
          release(item);
          pump();
        }
      });
    }
    updatePositions();
  }
  function enqueue(job,apiKey){
    const key=normalizedRegionKey(job?.region);
    if(!key)throw TypeError("Research region required");
    const existing=regions.get(key);
    if(existing)return {accepted:false,existing};
    regions.set(key,job);
    pending.push({job,apiKey,key});
    pump();
    return {accepted:true};
  }
  function cancelQueued(id){
    const index=pending.findIndex(item=>item.job.id===id);
    if(index<0)return false;
    const [item]=pending.splice(index,1);
    release(item);
    pump();
    return true;
  }
  return {enqueue,cancelQueued,conflict,snapshot};
}
