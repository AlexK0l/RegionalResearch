// Resume from an already completed contact stage without executing the
// paid Stage10/Stage11 pipeline again. Saved Saby/Stage13 snapshots also
// continue from their own phase. No discovery/INN/contact API calls.
import {recoverPriorityCheckpointOffline} from "./priorityCheckpointRecovery.js";
import {runCheckpointedSabyStage12} from "./sabyCheckpointIntegration.js";
import {classifyStage13UnknownModels} from "./priorityStage13AI.js";
import {applyPriorityStage13} from "./priorityStage13.js";
import {finalizeStage13CommercialOutput} from "./priorityStage13Finalize.js";

const SECTIONS=["direct_buyers","intermediaries","leasing","statistics"];
const laterPhases=new Set(["saby","priority","completed"]);

export function canResumeFromCompletedContacts(checkpoint){
  if(!checkpoint||checkpoint.source_mode!=="full"||
     !checkpoint.final_result||!checkpoint.contact_stats||
     SECTIONS.some(name=>!Array.isArray(checkpoint.final_result[name])))
    return false;
  if(!checkpoint.final_quality_gate &&
     !checkpoint.final_result.final_quality_gate)return false;
  if(checkpoint.phase==="contacts")return checkpoint.stage11_completed===true;
  return laterPhases.has(checkpoint.phase);
}

const clone=v=>v===undefined?undefined:structuredClone(v);
const asArray=v=>Array.isArray(v)?v:[];
const asNumber=v=>Number.isFinite(Number(v))?Number(v):0;

function lateResultSummary(source,result,saby,priority,quality){
  const buyers=asArray(result.direct_buyers);
  const intermediaries=asArray(result.intermediaries);
  const leasing=asArray(result.leasing);
  const total=buyers.length+intermediaries.length+leasing.length;
  const c=source.contact_stats||{};
  return {
    mode:"resume",
    result,quality,
    region:source.region,
    counts:{
      direct_buyers:buyers.length,intermediaries:intermediaries.length,
      leasing:leasing.length,statistics:asArray(result.statistics).length
    },
    contacts:{
      total,checked:asNumber(c.primaryProcessed||c.ok+c.notFound+c.unavailable),
      ok:asNumber(c.ok),unavailable:asNumber(c.unavailable),
      notFound:asNumber(c.notFound),
      unsearched:asNumber(c.unsearched),
      stage11DurationMs:asNumber(source.stage11_duration_ms)
    },
    saby:saby||null,priority:priority||null
  };
}

export async function runLateCheckpointResume({
  checkpoint,sourceJobId="",client=null,env=process.env,signal=null,
  statuses,progress,persistCheckpoint,
  remainingOverallUsd=()=>Infinity,onAIUsage=()=>{}
}={}){
  if(!canResumeFromCompletedContacts(checkpoint))
    throw Error("LATE_CHECKPOINT_NOT_READY");
  if(typeof progress!=="function"||typeof persistCheckpoint!=="function"||
     !Array.isArray(statuses)||statuses.length<13)
    throw TypeError("Late resume requires progress and durable checkpoint callbacks");
  if(signal?.aborted)throw Error("JOB_CANCELLED");

  const source=clone(checkpoint);
  const result=clone(source.final_result);
  const quality=clone(source.final_quality_gate||result.final_quality_gate);
  const markDone=(index,detail)=>{
    statuses[index].status="done";
    statuses[index].detail=detail;
    statuses[index].completedAt=Date.now();
  };
  for(let i=0;i<9;i++)markDone(i,"восстановлен из checkpoint");
  markDone(9,"этап 10 сохранён: повторные платные запросы не выполняются");
  markDone(10,"этап 11 завершён, контакты/QA из checkpoint · отложено: "+
    asNumber(source.contact_stats.unsearched));

  // Previously completed Stage13 must never replay Stage10/11, and must
  // not run Saby or OpenAI simply because the earlier crash left phase=priority.
  if(source.phase==="priority"){
    try{
      const {recovered}=recoverPriorityCheckpointOffline(source,{
        jobId:sourceJobId,env
      });
      markDone(11,"результат Saby восстановлен");
      markDone(12,"Stage13 восстановлен из проверенного checkpoint (без API)");
      await persistCheckpoint("completed",{
        ...recovered,stage11_completed:true,
        final_result:recovered.final_result,
        final_quality_gate:recovered.final_quality_gate
      });
      await progress({phase:"completed",step:13,percent:100,statuses});
      console.info("[PIPELINE_LATE_RESUME] "+JSON.stringify({
        source_phase:source.phase,restored_stage:13,
        paid_requests:0,source_job_id:sourceJobId
      }));
      return lateResultSummary(source,recovered.final_result,
        recovered.saby_stats,recovered.priority_stats,
        recovered.final_quality_gate);
    }catch(error){
      // Only incomplete Stage13 classifications continue into Stage13,
      // never fall through to paid discovery/enrichment/contact searches.
      console.warn("[PIPELINE_STAGE13_CHECKPOINT_INCOMPLETE] "+JSON.stringify({
        reason:String(error?.message||"incomplete_stage13").slice(0,180)
      }));
    }
  }

  if(source.phase==="completed"){
    markDone(11,"Saby из завершённого checkpoint");
    markDone(12,"Stage13 из завершённого checkpoint");
    await progress({phase:"completed",step:13,percent:100,statuses});
    return lateResultSummary(source,result,source.saby_stats,
      source.priority_stats,quality);
  }

  let saby={
    stats:source.saby_stats||null,
    completedInns:asArray(source.saby_completed_inns),
    deferredInns:asArray(source.saby_deferred_inns),
    attemptedInns:asArray(source.saby_attempted_inns)
  };
  if(source.phase!=="priority"){
    statuses[11].status="running";
    statuses[11].startedAt=Date.now();
    statuses[11].detail="продолжение Stage12 из сохранённых контактов";
    await progress({phase:"saby",step:12,percent:96,statuses});
    const startedAt=Date.now();
    saby=await runCheckpointedSabyStage12({
      result,
      completedInns:saby.completedInns,
      attemptedInns:saby.attemptedInns,
      env,signal,startedAt,
      persistCheckpoint:async(phase,patch)=>
        persistCheckpoint(phase,{stage11_completed:true,...patch}),
      onProgress:async stats=>{
        statuses[11].detail="Saby: обработано "+asNumber(stats.processed)+
          " / "+asNumber(stats.scheduled)+
          ", отложено "+asNumber(stats.deferred);
        const ratio=stats.scheduled?stats.processed/stats.scheduled:1;
        await progress({phase:"saby",step:12,percent:96+
          Math.floor(3*Math.min(1,ratio)),statuses,
          sabyCurrent:stats.processed,sabyTotal:stats.scheduled,
          sabyStats:stats});
      }
    });
  }
  markDone(11,"Saby: сохранены подтверждённые данные, отложено "+
    asNumber(saby.stats?.deferred));

  if(signal?.aborted)throw Error("JOB_CANCELLED");
  statuses[12].status="running";
  statuses[12].startedAt=Date.now();
  statuses[12].detail="приоритеты по сохранённым фактам";
  await progress({phase:"priority",step:13,percent:99,statuses});

  const ai=await classifyStage13UnknownModels(result,{
    client,env,signal,previousRows:source.final_result.direct_buyers,
    remainingOverallUsd,onUsage:onAIUsage,
    onBatchComplete:async aiStats=>{
      await persistCheckpoint("priority",{
        completed_stage:12,stage11_completed:true,
        final_result:result,
        priority_ai_stats:aiStats,
        saby_stats:saby.stats,
        saby_completed_inns:saby.completedInns,
        saby_deferred_inns:saby.deferredInns,
        saby_attempted_inns:saby.attemptedInns
      });
    }
  });
  const priority=applyPriorityStage13(result,{aiStats:ai});
  priority.commercial_postprocess=finalizeStage13CommercialOutput(result);
  markDone(12,"коэффициенты пересчитаны без повторения этапов 10 и 11");

  await persistCheckpoint("completed",{
    completed_stage:9,stage11_completed:true,
    final_result:result,final_quality_gate:quality,
    saby_stats:saby.stats,
    saby_completed_inns:saby.completedInns,
    saby_deferred_inns:saby.deferredInns,
    saby_attempted_inns:saby.attemptedInns,
    priority_stats:priority,priority_ai_stats:ai
  });
  await progress({phase:"completed",step:13,percent:100,statuses});
  console.info("[PIPELINE_LATE_RESUME] "+JSON.stringify({
    source_phase:source.phase,restored_stage:11,
    skipped_paid_stages:[10,11],source_job_id:sourceJobId
  }));
  return lateResultSummary(source,result,saby.stats,priority,quality);
}
