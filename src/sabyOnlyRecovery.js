// Resilient, bounded Stage12 Saby-only browser sessions. This orchestrator
// neither uses OpenAI nor touches SQLite: each pass owns its existing guarded
// browser and persists every company through runCheckpointedSabyStage12.
const COUNTERS=[
  "processed","verified","review","phonesAdded","emailsAdded",
  "transportsAdded","vehiclesVerified","partialResults",
  "companyReviews","systemicErrors"
];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const SABY_ONLY_MAX_SESSION_RESTARTS=2;

export async function runSabyOnlyWithRecovery({
  runPass,completedInns=[],attemptedInns=[],
  total,startedAt=Date.now(),maxDurationMs,
  maxRestarts=SABY_ONLY_MAX_SESSION_RESTARTS,
  signal,onProgress=async()=>{},
  onRecovery=async()=>{},wait=sleep
}={}){
  if(typeof runPass!=="function")throw TypeError("runPass is required");
  if(!Number.isSafeInteger(total)||total<0)throw TypeError("Invalid total");
  if(!Number.isFinite(maxDurationMs)||maxDurationMs<60000)
    throw TypeError("Invalid Saby-only deadline");
  const retries=Math.min(2,Math.max(0,Math.trunc(maxRestarts)));
  const sums=Object.fromEntries(COUNTERS.map(key=>[key,0]));
  let completed=[...completedInns],attempted=[...attemptedInns];
  let last=null,lastStats=null,sessionRestarts=0;
  const decorate=(stats,extra={})=>({
    ...stats,
    ...Object.fromEntries(COUNTERS.map(key=>[key,
      sums[key]+Number(stats?.[key]||0)])),
    scheduled:total,
    processed:Math.min(total,sums.processed+Number(stats?.processed||0)),
    totalAttempts:sums.processed+Number(stats?.processed||0),
    deferred:Number(stats?.deferred??total),
    browserRestarts:sessionRestarts,
    maxBrowserRestarts:retries,
    ...extra
  });
  for(let i=0;i<=retries;i++){
    if(signal?.aborted)throw Error("JOB_CANCELLED");
    const remaining=maxDurationMs-(Date.now()-startedAt);
    if(remaining<60000)break;
    last=await runPass({
      completedInns:completed,attemptedInns:attempted,
      maxDurationMs:remaining,
      onProgress:stats=>onProgress(decorate(stats))
    });
    lastStats=last?.stats||{};
    completed=[...(last.completedInns||completed)];
    attempted=[...(last.attemptedInns||attempted)];
    for(const key of COUNTERS)
      sums[key]+=Number(lastStats[key]||0);
    const failure=lastStats.circuitOpen===true||Boolean(lastStats.browserError);
    if(!failure||i===retries||lastStats.deadlineReached)break;
    if(maxDurationMs-(Date.now()-startedAt)<60000)break;
    // Restart only the Playwright browser *session*, not the paid pipeline.
    // Each company already visited was durably checkpointed by the pass.
    sessionRestarts++;
    await onRecovery({browserRestarts:sessionRestarts,
      maxBrowserRestarts:retries,processed:sums.processed,
      scheduled:total,deferred:last.deferredInns?.length??total,
      reason:lastStats.circuitOpen?"circuit_open":"browser_unavailable"});
    await wait(sessionRestarts===1?5000:15000);
  }
  if(!last)throw Error("SABY_ONLY_DEADLINE_REACHED_BEFORE_START");
  const stats={
    ...lastStats,...sums,
    scheduled:total,
    processed:Math.min(total,sums.processed),
    totalAttempts:sums.processed,
    deferred:last.deferredInns?.length??total,
    browserRestarts:sessionRestarts,
    maxBrowserRestarts:retries,
    // Do not describe a systemic stop as successful completion.
    fullSweepCompleted:(
      !lastStats.circuitOpen && !lastStats.browserError &&
      !lastStats.deadlineReached &&
      (lastStats.fullSweepCompleted===true || sums.processed>=total)
    )
  };
  return {...last,stats};
}
