// Safe, offline salvage of a full study that reached Stage13 but crashed
// before its final "completed" SQLite write. No API clients or browser imports.
import {createHash} from "node:crypto";
import {applyPriorityStage13} from "./priorityStage13.js";
import {stage13AISettings} from "./priorityStage13AI.js";
import {stage13SourceAudit,stage13DiffAudit} from "./priorityStage13FullAudit.js";
import {finalizeStage13CommercialOutput} from "./priorityStage13Finalize.js";

const REQUIRED=["direct_buyers","intermediaries","leasing","statistics"];
const count=result=>["direct_buyers","intermediaries","leasing"]
  .reduce((n,key)=>n+result[key].length,0);
const blank=v=>typeof v!=="string"||!v.trim();

export function recoverPriorityCheckpointOffline(checkpoint,{jobId="",env=process.env}={}){
  if(!checkpoint||checkpoint.source_mode!=="full"||checkpoint.phase!=="priority")
    throw Error("Requires a full research checkpoint saved in priority phase");
  if(!checkpoint.final_result||REQUIRED.some(k=>!Array.isArray(checkpoint.final_result[k])))
    throw Error("Priority checkpoint has no complete four-section final_result");
  if(blank(checkpoint.region))throw Error("Checkpoint region is missing");
  if(!checkpoint.saby_stats||!checkpoint.contact_stats)
    throw Error("Stage11 or Stage12 checkpoint metadata missing; cannot claim finalization");
  if(!checkpoint.priority_ai_stats)
    throw Error("Missing Stage13 AI batch summary; cannot confirm model coverage");
  const original=checkpoint.final_result;
  const before=structuredClone(original);
  const result=structuredClone(original);
  const settings=stage13AISettings(env);
  const inventory=stage13SourceAudit(before,{
    maxPerBuyer:settings.maxPerBuyer,
    batchSize:settings.batchSize,maxCalls:settings.maxCalls
  });
  if(inventory.models_skipped_due_to_limit)
    throw Error("Stage13 source inventory was truncated; offline completion refused");

  const ai=structuredClone(checkpoint.priority_ai_stats);
  const priority=applyPriorityStage13(result,{aiStats:ai});
  const audit=stage13DiffAudit(before,result,ai,{},inventory);
  if(!audit.unchanged_source_fields)
    throw Error("Offline score recalculation changed original source fields");
  if(!audit.complete)
    throw Error("Stage13 classification is incomplete in this checkpoint: "+
      JSON.stringify({candidates:audit.requested_model_mentions,
        classified:audit.classified_model_mentions,pending:audit.pending_candidates,
        stopped_reason:ai.stopped_reason||""})+
      ". No paid calls were made; do not label this checkpoint completed");

  const postprocess=finalizeStage13CommercialOutput(result);
  priority.commercial_postprocess=postprocess;
  const originalCount=count(before),currentCount=count(result);
  if(originalCount!==currentCount+postprocess.roles.deduplicated_count)
    throw Error("Commercial records were lost during offline finalization");

  const recovered={
    ...structuredClone(checkpoint),
    phase:"completed",
    final_result:result,
    // Production QA was saved inside final_result before the Stage13 crash.
    // Restore the same report at the normal completed-checkpoint level.
    final_quality_gate: structuredClone(checkpoint.final_quality_gate ||
      checkpoint.final_result?.final_quality_gate || null),
    priority_stats:priority,
    // Preserve source usage, contacts, Saby evidence and source QA state.
    // Stage13 duration and any absent final-quality report are NOT invented.
    offline_recovery:{
      version:1,method:"saved_priority_stage13_evidence_only",
      source_job_id:String(jobId),
      source_phase:"priority",
      source_checkpoint_unchanged:true,sqlite_writes:0,
      new_openai_calls:0,new_web_search_calls:0,new_saby_calls:0,
      full_stage13_classification_covered:true,
      final_quality_report_present:Boolean(checkpoint.final_quality_gate || checkpoint.final_result?.final_quality_gate),
      source_sha256:createHash("sha256")
        .update(JSON.stringify(checkpoint)).digest("hex"),
      recovered_at:new Date().toISOString()
    }
  };
  return {
    recovered,
    audit:{
      ...audit,
      recovery:recovered.offline_recovery,
      before_count:originalCount,after_count:currentCount,
      commercial_postprocess:postprocess,
      source_file_unchanged:true,sqlite_writes:0,
      new_openai_calls:0,new_web_search_calls:0,new_saby_calls:0
    },
    summary:{
      region:checkpoint.region,
      source_job_id:String(jobId),
      original_sections:{
        direct_buyers:before.direct_buyers.length,
        intermediaries:before.intermediaries.length,
        leasing:before.leasing.length
      },
      recovered_sections:{
        direct_buyers:result.direct_buyers.length,
        intermediaries:result.intermediaries.length,
        leasing:result.leasing.length
      },
      ai_classification_complete:audit.complete,
      saved_ai_verdict_rows:audit.ai_rows_with_verdicts,
      source_fields_unchanged:audit.unchanged_source_fields,
      score_changed:audit.score_changed,
      priority_tiers:priority.tiers,
      final_quality_report_present:Boolean(checkpoint.final_quality_gate || checkpoint.final_result?.final_quality_gate),
      new_paid_calls:0,
      sqlite_writes:0
    }
  };
}
