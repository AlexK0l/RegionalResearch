// Export previously saved regional research directly from SQLite, even when
// the HTTP job map was lost after a service restart. NO OpenAI, network,
// browser, SQLite writes, or mutations of the input checkpoint.
import {applyPriorityStage13} from "./priorityStage13.js";
import {finalizeStage13CommercialOutput} from "./priorityStage13Finalize.js";
import {recoverPriorityCheckpointOffline} from "./priorityCheckpointRecovery.js";
import {decorateCompanyBasisForExport} from "./companyBasisNarrative.js";

const sections=["direct_buyers","intermediaries","leasing","statistics"];

export function preparePersistedCheckpointExport(checkpoint){
  if(!checkpoint||!["full","saby"].includes(checkpoint.source_mode))
    throw Error("CHECKPOINT_NOT_EXPORTABLE");
  let snapshot=checkpoint;
  if(checkpoint.source_mode==="full"&&checkpoint.phase==="priority"){
    // A crash after Stage13 did not persist "completed". Use the same
    // strict, offline verified reconstruction as the CLI salvage.
    snapshot=recoverPriorityCheckpointOffline(checkpoint).recovered;
  }else if(!(
    (checkpoint.source_mode==="full"&&checkpoint.phase==="completed")||
    (checkpoint.source_mode==="saby"&&
      ["saby","completed"].includes(checkpoint.phase))
  )){
    throw Error("CHECKPOINT_NOT_READY_FOR_EXPORT");
  }
  if(!snapshot.final_result||sections.some(
    key=>!Array.isArray(snapshot.final_result[key])))
    throw Error("CHECKPOINT_RESULT_INCOMPLETE");
  const result=structuredClone(snapshot.final_result);
  // During a Saby-only run, each company is persisted immediately. The
  // final Stage13 scoring runs at the end, so on-demand exports of a paused
  // child recompute scores from the latest *saved* fleet evidence only.
  if(snapshot.source_mode==="saby"&&snapshot.phase==="saby"){
    applyPriorityStage13(result,{aiStats:snapshot.priority_ai_stats||null});
    finalizeStage13CommercialOutput(result);
  }
  return {
    region:String(snapshot.region||""),
    final_result:decorateCompanyBasisForExport(result),
    final_quality_gate:snapshot.final_quality_gate||
      result.final_quality_gate||null,
    checkpoint_phase:checkpoint.phase,
    checkpoint_mode:checkpoint.source_mode,
    partial_saby:checkpoint.source_mode==="saby"&&
      checkpoint.phase==="saby",
    saby_stats:snapshot.saby_stats||null
  };
}
