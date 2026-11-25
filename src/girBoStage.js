// Public finance enrichment before Saby. Production rows and checkpoint
// references are kept intact; only verified blank revenue fields may change.
import {randomUUID} from "node:crypto";
import {auditSourceRows} from "./sabyIdentityAudit.js";
import {REVENUE_FIELD} from "./preSabyFinancials.js";
import {planGirBoBackfill,runGirBoBackfill} from "./girBoBackfill.js";
import {createGirBoLookup,sharedGirBoGate} from "./girBoLookup.js";

export const girboStageEnabled=(env=process.env)=>String(env.GIRBO_STAGE_ENABLED||"false").toLowerCase()==="true";
const bound=(raw,fallback,min,max)=>{
  const s=String(raw??"").trim(),n=Number(s);
  return /^\d+$/.test(s)&&Number.isSafeInteger(n)?Math.max(min,Math.min(max,n)):fallback;
};
export function girboStageSettings(env=process.env){
  const maxCompanies=bound(env.GIRBO_STAGE_MAX_COMPANIES,300,1,1000);
  return {enabled:girboStageEnabled(env),maxCompanies,maxRequests:2*maxCompanies,
    maxDurationMs:bound(env.GIRBO_STAGE_MAX_MS,900000,60000,1800000)};
}
const asNumber=v=>(typeof v==="number"||typeof v==="string"&&/^\d+$/.test(v.trim()))&&Number.isSafeInteger(Number(v))&&Number(v)>=0;
const log=(n,x)=>console.info("["+n+"] "+JSON.stringify(x));

export async function runGirBoStage({result,priorOutcomes={},env=process.env,signal=null,
  persistCheckpoint,lookupFactory=createGirBoLookup,metric=log,onProgress=async()=>{},year=new Date().getUTCFullYear()-1}={}){
  const settings=girboStageSettings(env);
  if(!settings.enabled)return {enabled:false};
  if(signal?.aborted)throw Error("JOB_CANCELLED");
  if(typeof persistCheckpoint!=="function")throw Error("GIRBO_STAGE_CHECKPOINT_REQUIRED");
  // The standalone planner uses checkpoint-shaped inputs; this synthetic
  // envelope is never saved as a separate study or exposed as a real job.
  const cp={version:1,source_mode:"saby",phase:"saby",final_result:result,
    girbo_backfill_outcomes:priorOutcomes||{}};
  let plan;
  try{plan=planGirBoBackfill(cp,{limit:settings.maxCompanies,year});}
  catch(e){
    const stats={enabled:true,stop_reason:"GIRBO_STAGE_PLAN_UNAVAILABLE",added:0,processed:0};
    metric("GIRBO_STAGE_DONE",stats);
    return stats;
  }
  const {selected,...summary}=plan;
  metric("GIRBO_STAGE_PLAN",{...summary,scheduled:selected.length,enabled:true,openai_requests:0,saby_requests:0});
  if(!selected.length){
    const stats={enabled:true,scheduled:0,processed:0,added:0,pending:0,
      missing_before:plan.missing,missing_after:plan.missing,stop_reason:"",http_requests:0};
    metric("GIRBO_STAGE_DONE",stats);
    return stats;
  }
  const originals=new Map(auditSourceRows(result).map(({row})=>[String(row.__canonical_id).trim(),row]));
  const lookup=lookupFactory({maxRequests:settings.maxRequests,maxDurationMs:settings.maxDurationMs,signal,metric});
  const out=await runGirBoBackfill({checkpoint:cp,sourceId:"stage:"+randomUUID(),childId:"stage:"+randomUUID(),
    limit:settings.maxCompanies,year,lookup,signal,
    onCheckpoint:async snapshot=>{
      for(const {row:updated} of auditSourceRows(snapshot)){
        const original=originals.get(String(updated.__canonical_id).trim());
        if(!original||String(original["ИНН"]??"")!==String(updated["ИНН"]??""))
          throw Error("GIRBO_STAGE_ROW_CHANGED");
        if(asNumber(original[REVENUE_FIELD]))continue;
        if(!asNumber(updated[REVENUE_FIELD]))continue;
        const proof=updated.__evidence?.girbo_finance_backfill;
        if(proof?.source!=="GIR_BO"||proof.inn!==String(original["ИНН"]).trim()||
          proof.revenue_rub!==updated[REVENUE_FIELD])throw Error("GIRBO_STAGE_PROOF_MISSING");
        original[REVENUE_FIELD]=updated[REVENUE_FIELD];
        original.__evidence=updated.__evidence;
        original.__comment=updated.__comment;
      }
      // Persist the real current job through the existing durable callback,
      // not a new DB child. A storage error propagates rather than triggering
      // a paid fallback or allowing the stage to report success.
      await persistCheckpoint("saby",{completed_stage:9,stage11_completed:true,
        final_result:result,girbo_backfill_outcomes:snapshot.girbo_backfill_outcomes,
        girbo_backfill_stats:{...snapshot.girbo_backfill_stats,enabled:true,http_requests:lookup.requests??0}});
    },
    onProgress:async stats=>{
      const progress={...stats,http_requests:lookup.requests??0};
      metric("GIRBO_STAGE_PROGRESS",progress);
      await onProgress(progress);
    }});
  const stats={...out.stats,enabled:true,http_requests:lookup.requests??0};
  if(stats.stop_reason==="GIRBO_CONSECUTIVE_PROOF_FAILURES")
    sharedGirBoGate.cooldown(stats.stop_reason,5*60000);
  metric("GIRBO_STAGE_DONE",stats);
  return stats;
}
