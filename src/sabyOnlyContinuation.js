// Run ONLY Stage 12 from an already finalized SQLite research checkpoint.
// Saby-only remains free of OpenAI by default. AI model checks are explicit opt-in.
// The parent snapshot is immutable; a new job ID persists a Saby-only copy.
import OpenAI from "openai";
import {PIPELINE_VERSION, normalizeCheckpoint} from "./checkpointStore.js";
import {costEnvLimitUsd} from "./researchCostPolicy.js";
import {STEPS} from "./constants.js";
import {applyPriorityStage13} from "./priorityStage13.js";
import {classifyStage13UnknownModels} from "./priorityStage13AI.js";
import {sabyStage12Settings} from "./sabyStage12.js";
import {sabyFleetTreeProductionEnabled} from "./sabyBrowser.js";
import {runCheckpointedSabyStage12} from "./sabyCheckpointIntegration.js";
import {sabyEligibleRows,sabyInn,sabyStoredSectionCoverage} from "./sabyEnrichment.js";

// Older completed regional studies may predate Stage12 entirely. Derive a
// bounded Saby work plan strictly from their existing, finalized commercial
// rows; this is never company discovery or an OpenAI operation.
function legacySabyPlan(checkpoint, plan) {
  const done=checkpoint.saby_completed_inns;
  const deferred=checkpoint.saby_deferred_inns;
  const emptyOrAbsent=value=>value===undefined ||
    (Array.isArray(value)&&value.length===0);
  const neverRan=checkpoint.saby_stats==null ||
    checkpoint.saby_stats?.enabled===false;
  if(String(checkpoint.source_mode||"full")!=="full" ||
     checkpoint.phase!=="completed" || !neverRan ||
     !emptyOrAbsent(done) || !emptyOrAbsent(deferred))return null;

  // A phone/INN is NOT proof of Saby completion. Count only trusted,
  // company-scoped, explicitly verified Saby section evidence.
  const completed=[],pending=[];
  for(const entry of plan.eligible){
    const inn=sabyInn(entry.row["ИНН"]);
    const coverage=sabyStoredSectionCoverage(entry.row,
      {transport:entry.transport});
    (coverage.trusted&&coverage.complete?completed:pending).push(inn);
  }
  return {completed,pending};
}

export function validateSabyOnlySource(value, {pipelineVersion=PIPELINE_VERSION}={}) {
  const checkpoint=normalizeCheckpoint(value);
  if(!checkpoint)return {ok:false,code:"CHECKPOINT_INVALID"};
  if(Number(checkpoint.pipeline_version||pipelineVersion)!==pipelineVersion)
    return {ok:false,code:"CHECKPOINT_VERSION_MISMATCH"};
  if(!["full","saby"].includes(String(checkpoint.source_mode||"full")) ||
     !["saby","completed"].includes(checkpoint.phase))
    return {ok:false,code:"SABY_FINALIZED_SOURCE_REQUIRED"};
  const result=checkpoint.final_result;
  if(!result ||
     !["direct_buyers","intermediaries","leasing","statistics"]
       .every(key=>Array.isArray(result[key])))
    return {ok:false,code:"SABY_SNAPSHOT_INCOMPLETE"};

  const plan=sabyEligibleRows(result);
  const legacy=legacySabyPlan(checkpoint,plan);
  if(legacy){
    // Only the normalized copy is amended. Original SQLite source remains
    // byte-for-byte unchanged; child checkpoint receives the derived plan.
    checkpoint.saby_completed_inns=legacy.completed;
    checkpoint.saby_deferred_inns=legacy.pending;
  }else if(!Array.isArray(checkpoint.saby_completed_inns) ||
           !Array.isArray(checkpoint.saby_deferred_inns)){
    return {ok:false,code:"SABY_SNAPSHOT_INCOMPLETE"};
  }
  if(checkpoint.saby_deferred_inns.length===0)
    return {ok:false,code:"NO_SABY_PENDING"};
  return {
    ok:true,checkpoint,pending:checkpoint.saby_deferred_inns.length,
    eligible:plan.eligible.length,
    commercialTotal:result.direct_buyers.length+
      result.intermediaries.length+result.leasing.length,
    invalid:plan.invalid.length,
    duplicates:plan.duplicates.length,
    bootstrap:!!legacy
  };
}

// A single Saby-only job should be able to traverse the full pending
// regional queue. This budget is ONLY used in Saby-only continuation;
// the paid full-research Stage12 retains the existing 30-minute default.
// 12 hours is intentionally conservative relative to observed throughput.
export const SABY_ONLY_DEFAULT_MAX_MS=12*60*60*1000;
export function sabyOnlyMaxDurationMs(env=process.env) {
  const raw=String(env.SABY_ONLY_MAX_MS??"").trim();
  if(!/^[0-9]+$/.test(raw))return SABY_ONLY_DEFAULT_MAX_MS;
  const value=Number(raw);
  if(!Number.isSafeInteger(value))return SABY_ONLY_DEFAULT_MAX_MS;
  return Math.max(30*60000,Math.min(24*60*60000,value));
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
    status:i===11?"running":i===12?"waiting":"done",
    detail:i===11?"Saby из SQLite · без OpenAI":i===12?"Ожидает Saby":"из сохранённого исследования"
  }));
  const report=async (stats,finished=false)=>{
    await onProgress({
      phase:finished?"completed":"saby",step:finished?13:12,
      percent:finished?100:96+Math.floor(3*Math.min(1,
        Number(stats?.processed||0)/Math.max(1,Number(stats?.scheduled||1)))),
      statuses:stageStatuses.map((s,i)=>
        finished&&i===11?{...s,status:"done",detail:"Saby-only завершён"}:
        finished&&i===12?{...s,status:"done",detail:"Приоритеты рассчитаны"}:s),
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
    saby_deferred_inns:source.saby_deferred_inns,
    saby_attempted_inns:source.saby_attempted_inns||[]
  });
  await report({processed:0,scheduled:checked.pending});
  const options={
    result,
    completedInns:source.saby_completed_inns,
    attemptedInns:source.saby_attempted_inns||[],
    maxDurationMs:sabyOnlyMaxDurationMs(env),
    env:{...env,SABY_CHECKPOINT_EVERY:"1"},signal,startedAt,
    onProgress:stats=>report(stats),
    persistCheckpoint:persist
  };
  // Deterministic offline tests inject a fake browser only. Production uses
  // the same real guarded Playwright collector as ordinary Stage12.
  if(sessionRunner)options.sessionRunner=sessionRunner;
  if(collectCompany)options.collectCompany=collectCompany;
  const outcome=await runCheckpointedSabyStage12(options);

  await onProgress({phase:"priority",step:13,percent:99,
    statuses:stageStatuses.map((s,i)=>i===11
      ?{...s,status:"done",detail:"Saby-only завершён"}:
      i===12?{...s,status:"running",detail:"Расчёт итогового коэффициента"}:s),
    sabyStats:outcome.stats});
  // Saby-only continuation historically promises no OpenAI costs. Keep that
  // promise unless specifically enabled for this mode and an API key exists.
  let priorityAIStats=null;
  if(String(env.STAGE13_AI_SABY_ONLY_ENABLED??"false").toLowerCase()==="true" &&
     String(env.STAGE13_AI_ENABLED??"true").toLowerCase()!=="false"){
    if(!String(env.OPENAI_API_KEY||"").trim())
      throw new Error("STAGE13_AI_SABY_ONLY_ENABLED requires OPENAI_API_KEY");
    const aiClient=new OpenAI({apiKey:env.OPENAI_API_KEY});
    const priorCost=Number(source.api_usage?.estimated_cost_usd||0);
    priorityAIStats=await classifyStage13UnknownModels(result,{
      client:aiClient,env,signal,
      previousRows:source.final_result?.direct_buyers||[],
      remainingOverallUsd:()=>Math.max(0,costEnvLimitUsd(env)-priorCost),
      onBatchComplete:aiState=>persist("priority",{
        completed_stage:12,final_result:result,priority_ai_stats:aiState
      })
    });
  }
  const priorityStats=applyPriorityStage13(result,{aiStats:priorityAIStats});
  await persist("completed",{
    completed_stage:9,
    final_result:result,
    saby_completed_inns:outcome.completedInns,
    saby_deferred_inns:outcome.deferredInns,
    saby_attempted_inns:outcome.attemptedInns,
    saby_stats:outcome.stats,
    priority_stats:priorityStats,
    priority_ai_stats:priorityAIStats,
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
    saby:outcome.stats,
    priority:priorityStats
  };
}
