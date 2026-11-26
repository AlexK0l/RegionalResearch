// Paid-free, optional FNS identity recovery before a fresh Stage12 plan.
// Use the same verified registry procedure as the existing offline child
// tool. It is not a new Saby query mode, nor a name-only INN assignment.
import {planIndependentInnBackfill,checkFnsRegistryCanary,recoverIndependentInns}
  from "./independentInnBackfill.js";
import {isMemoryPause} from "./memoryAdmission.js";
import {sabyEligibleRows,sabyInn,sabyWorkGaps,sabyHasWork} from "./sabyEnrichment.js";
import {sabyFleetScope,SABY_ALL_FLEETS_SCOPE} from "./sabyVisitPolicy.js";
export const sabyInnRecoveryEnabled=(env=process.env)=>
  String(env.SABY_INN_RECOVERY_ENABLED??"false").toLowerCase()==="true";

async function defaultLookupRunner(task,options){
  const {withPublicRegistryLookup}=await import("./independentInnRegistryBrowser.js");
  return withPublicRegistryLookup(task,options);
}

export async function runSabyInnRecoveryStage({
  result,region,env=process.env,signal=null,acquireSabyBrowser,
  priorOutcomes={},priorStats=null,persistCheckpoint=async()=>{},
  onProgress=async()=>{},lookupRunner=defaultLookupRunner,canary=checkFnsRegistryCanary
}={}){
  if(!sabyInnRecoveryEnabled(env)||!region)return null;
  // A resumed full study keeps already committed results and does not
  // immediately retry a terminal registry stop in the same preparation.
  if(priorStats?.finished===true)return priorStats;
  const abort=()=>{if(signal?.aborted)throw Error("JOB_CANCELLED");};
  abort();
  const counter=value=>Number.isSafeInteger(value)&&value>=0?value:0;
  const prior={processed:counter(priorStats?.processed),added:counter(priorStats?.added),
    review:counter(priorStats?.review)};
  let outcomes={...priorOutcomes},stats={scheduled:prior.processed,processed:prior.processed,
    added:prior.added,review:prior.review,pending:0,finished:false,stop_reason:""};
  const cumulative=run=>({...run,scheduled:prior.processed+run.scheduled,
    processed:prior.processed+run.processed,added:prior.added+run.added,
    review:prior.review+run.review,finished:false});
  let callbackError;
  const save=async()=>{
    // Persist the actual newly eligible INNs, not a stale Stage11 queue.
    // Keep no Saby cursor until the registry browser is closed.
    const all=sabyEligibleRows(result,{includeAll:true,includeFinanceGaps:true,
      allCompanyFleets:sabyFleetScope(env,null)===SABY_ALL_FLEETS_SCOPE});
    const completed=[],pending=[];
    for(const entry of all.eligible)
      (sabyHasWork(sabyWorkGaps(entry))?pending:completed).push(sabyInn(entry.row["ИНН"]));
    try{
      await persistCheckpoint("saby",{
        completed_stage:9,stage11_completed:true,final_result:result,
        saby_completed_inns:completed,saby_deferred_inns:pending,
        saby_pass_state:null,independent_inn_backfill_outcomes:outcomes,
        saby_inn_recovery_stats:{...stats}
      });
      await onProgress({...stats});
    }catch(error){callbackError=error;throw error;}
  };
  const snapshot={version:1,source_mode:"saby",phase:"saby",region,
    final_result:result,independent_inn_backfill_outcomes:outcomes};
  let plan;
  try{plan=planIndependentInnBackfill(snapshot,{provider:"fns"});}
  catch{
    stats.finished=true;stats.stop_reason="registry_source_not_ready";
    await save();return stats;
  }
  stats.scheduled=prior.processed+plan.scheduled;stats.pending=plan.pending;
  if(!plan.scheduled){stats.finished=true;await save();return stats;}
  // No standalone/unadmitted Chromium inside the running regional worker.
  if(typeof acquireSabyBrowser!=="function"){
    stats.finished=true;stats.stop_reason="registry_admission_unavailable";
    await save();return stats;
  }
  const raw=String(env.SABY_INN_RECOVERY_MAX_PAGES??"3000");
  const maxPages=/^[1-9]\d*$/.test(raw)&&Number(raw)<=3000?Number(raw):3000;
  await save();
  let release;
  try{
    release=await acquireSabyBrowser();
    abort();
    await lookupRunner(async lookup=>{
      const health=await canary(snapshot,lookup);
      abort();
      if(!health?.verified){
        stats.stop_reason="fns_preflight_failed";
        return;
      }
      const out=await recoverIndependentInns({
        checkpoint:snapshot,provider:"fns",lookup,signal,
        onCheckpoint:async cp=>{
          outcomes={...cp.independent_inn_backfill_outcomes};
          stats=cumulative(cp.independent_inn_backfill_stats);
          await save();
        }
      });
      stats=cumulative(out.stats);
    },{provider:"fns",confirmationMode:"extract",maxPages});
  }catch(error){
    if(callbackError||isMemoryPause(error)||signal?.aborted||error?.message==="JOB_CANCELLED")throw callbackError||error;
    // Existing Saby coverage remains available if the public registry has
    // a challenge, is down, or cannot launch. Never bypass it.
    stats.stop_reason="registry_unavailable";
  }finally{release?.();}
  abort();
  stats.finished=true;
  await save();
  console.info("[SABY_INN_RECOVERY_DONE] "+JSON.stringify(stats));
  return stats;
}
