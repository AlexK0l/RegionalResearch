// Run ONLY Stage 12 from an already finalized SQLite research checkpoint.
// No OpenAI SDK/client or earlier paid research pipeline is imported here.
// The parent snapshot is immutable; a new job ID persists a Saby-only copy.
import {PIPELINE_VERSION, normalizeCheckpoint} from "./checkpointStore.js";
import {STEPS} from "./constants.js";
import {sabyStage12Settings} from "./sabyStage12.js";
import {sabyFleetTreeProductionEnabled} from "./sabyBrowser.js";
import {runCheckpointedSabyStage12} from "./sabyCheckpointIntegration.js";

export function validateSabyOnlySource(value, {pipelineVersion=PIPELINE_VERSION}={}) {
  const checkpoint=normalizeCheckpoint(value);
  if(!checkpoint) return {ok:false,code:"CHECKPOINT_INVALID"};
  if(Number(checkpoint.pipeline_version||pipelineVersion)!==pipelineVersion)
    return {ok:false,code:"CHECKPOINT_VERSION_MISMATCH"};
  if(!["full","saby"].includes(String(checkpoint.source_mode||"full")) ||
     !["saby","completed"].includes(checkpoint.phase))
    return {ok:false,code:"SABY_FINALIZED_SOURCE_REQUIRED"};
  const result=checkpoint.final_result;
  if(!result ||
     !["direct_buyers","intermediaries","leasing","statistics"]
       .every(key=>Array.isArray(result[key])) ||
     !Array.isArray(checkpoint.saby_completed_inns) ||
     !Array.isArray(checkpoint.saby_deferred_inns))
    return {ok:false,code:"SABY_SNAPSHOT_INCOMPLETE"};
  if(checkpoint.saby_deferred_inns.length===0)
    return {ok:false,code:"NO_SABY_PENDING"};
  return {ok:true,checkpoint,pending:checkpoint.saby_deferred_inns.length};
}

export function sabyOnlyConfigReady(env=process.env) {
  return sabyStage12Settings(env).enabled &&
    sabyFleetTreeProductionEnabled(env);
}

export async function runSabyOnlyContinuation({
  checkpoint:input,
  sourceJobId,
  env=process.env,
  signal=null,
  onProgress=async()=>{},
  persistCheckpoint=async()=>{},
  sessionRunner,
  collectCompany
}={}) {
  const checked=validateSabyOnlySource(input);
  if(!checked.ok)throw new Error(checked.code);
  if(!sabyOnlyConfigReady(env))throw new Error("SABY_BULK_NOT_ENABLED");
  if(!sourceJobId || typeof sourceJobId!=="string")
    throw new Error("SABY_SOURCE_JOB_REQUIRED");

  // Never change the source checkpoint. Distinct child job IDs are assigned
  // by the HTTP queue; our copied snapshot uses source_mode=saby.
  const source=checked.checkpoint;
  const result=structuredClone(source.final_result);
  const startedAt=Date.now();
  const rootJobId=String(source.saby_continuation_root_job_id||sourceJobId);
  let snapshot={
    ...source,
    source_mode:"saby",
    created_at:new Date(startedAt).toISOString(),
    saby_continuation_source_job_id:sourceJobId,
    saby_continuation_root_job_id:rootJobId
  };
  const persist=async (phase, patch={})=>{
    snapshot={
      ...snapshot,...structuredClone(patch),phase,
      version:1,pipeline_version:PIPELINE_VERSION,
      source_mode:"saby",
      updated_at:new Date().toISOString()
    };
    await persistCheckpoint(structuredClone(snapshot));
  };
  const stageStatuses=STEPS.map((name,i)=>({
    step:i+1,name,
    status:i===11?"running":"done",
    detail:i===11?"Saby из SQLite · без OpenAI":"из сохранённого исследования"
  }));
  const report=async (stats,finished=false)=>{
    await onProgress({
      phase:finished?"completed":"saby",step:12,
      percent:finished?100:96+Math.floor(3*Math.min(1,
        Number(stats?.processed||0)/Math.max(1,Number(stats?.scheduled||1)))),
      statuses:stageStatuses.map((s,i)=>i===11&&finished
        ?{...s,status:"done",detail:"Saby-only завершён"}:s),
      sabyCurrent:Number(stats?.processed||0),
      sabyTotal:Number(stats?.scheduled||0),
      sabyStats:stats
    });
  };

  // A new child checkpoint is durable even when the first browser launch
  // fails or the process is restarted before the first company finishes.
  await persist("saby",{
    final_result:result,
    saby_completed_inns:source.saby_completed_inns,
    saby_deferred_inns:source.saby_deferred_inns
  });
  await report({processed:0,scheduled:checked.pending});
  const options={
    result,
    completedInns:source.saby_completed_inns,
    env,signal,startedAt,
    onProgress:stats=>report(stats),
    persistCheckpoint:persist
  };
  // Deterministic offline tests inject a fake browser only. Production uses
  // the same real guarded Playwright collector as ordinary Stage12.
  if(sessionRunner)options.sessionRunner=sessionRunner;
  if(collectCompany)options.collectCompany=collectCompany;
  const outcome=await runCheckpointedSabyStage12(options);

  await persist("completed",{
    completed_stage:9,
    final_result:result,
    saby_completed_inns:outcome.completedInns,
    saby_deferred_inns:outcome.deferredInns,
    saby_stats:outcome.stats,
    stage12_duration_ms:Date.now()-startedAt
  });
  await report(outcome.stats,true);
  return {
    mode:"saby_only",region:String(source.region),result,
    quality:source.final_quality_gate||null,
    counts:{
      direct_buyers:result.direct_buyers.length,
      intermediaries:result.intermediaries.length,
      leasing:result.leasing.length,
      statistics:result.statistics.length
    },
    contacts:source.contact_stats||null,
    saby:outcome.stats
  };
}
