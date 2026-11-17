#!/usr/bin/env node
// Stage 13 replay on saved, completed checkpoint: no earlier paid stages,
// no Saby, no web search and no SQLite mutation.
// --with-openai is an explicit, budgeted opt-in for unknown model types.
// Per-batch progress and token usage are saved separately from source.
import fs from "node:fs/promises";
import OpenAI from "openai";
import path from "node:path";
import {createHash} from "node:crypto";
import {buildReferenceWorkbookBuffer} from "../src/referenceWorkbookExport.js";
import {applyPriorityStage13,calculatePriority13} from "../src/priorityStage13.js";
import {finalizeStage13CommercialOutput} from "../src/priorityStage13Finalize.js";
import {classifyStage13UnknownModels,stage13AISettings} from "../src/priorityStage13AI.js";
import {stage13SourceAudit,stage13UsageSummary,stage13DiffAudit}
  from "../src/priorityStage13FullAudit.js";

const option=(args,name)=>{
  const arg=args.find(x=>x.startsWith("--"+name+"="));
  return arg?arg.slice(name.length+3):"";
};
const args=process.argv.slice(2);
const flag=name=>args.includes("--"+name);
const maybeRead=async pathName=>{
  try{return JSON.parse(await fs.readFile(pathName,"utf8"));}
  catch(e){if(e.code==="ENOENT")return null;throw e;}
};
const exists=async pathName=>{
  try{await fs.access(pathName);return true;}
  catch(e){if(e.code==="ENOENT")return false;throw e;}
};
const persistProgress=async(pathName,obj)=>{
  const temp=pathName+".writing";
  await fs.writeFile(temp,JSON.stringify(obj)+"\n",{mode:0o600,flag:"w"});
  await fs.rename(temp,pathName);
};
function usageRate(env,key,fallback){
  const value=Number(env[key]);
  return Number.isFinite(value)&&value>0?value:fallback;
}
function tokensOf(records,model,env){
  const input=usageRate(env,"OPENAI_ESTIMATE_INPUT_USD_PER_M",0.2);
  return stage13UsageSummary(records,{model,
    inputUsdPerM:input,
    outputUsdPerM:usageRate(env,"OPENAI_ESTIMATE_OUTPUT_USD_PER_M",1.2),
    cachedInputUsdPerM:usageRate(env,"STAGE13_AI_CACHED_INPUT_USD_PER_M",input/10)});
}
async function main(){
  if(flag("help")){
    console.log("Stage 13: --result=FINISHED.json --out-prefix=exports/stage13-region"+
      " [--preview|--preview-ai-candidates] [--with-openai] [--require-saby-completed]");
    return;
  }
  const input=option(args,"result"),prefix=option(args,"out-prefix");
  if(!input)throw new Error("Provide --result=FINISHED.json");
  const preview=flag("preview")||flag("preview-ai-candidates");
  if(preview&&flag("with-openai"))
    throw new Error("Preview modes are offline; use --with-openai with a NEW --out-prefix");
  if(!prefix&&!preview)throw new Error("Provide --out-prefix or --preview");
  const raw=await fs.readFile(path.resolve(input));
  const sourceHash=createHash("sha256").update(raw).digest("hex");
  const original=JSON.parse(raw.toString("utf8"));
  if(original.final_result&&original.phase&&original.phase!=="completed")
    throw new Error("Only a completed checkpoint can be recalculated");
  if(flag("require-saby-completed")&&
     (!original?.saby_stats?.fullSweepCompleted||original.source_mode!=="saby"))
    throw new Error("Input must be a completed Saby sweep checkpoint");
  const payload=structuredClone(original);
  const result=payload.final_result&&typeof payload.final_result==="object"
    ?payload.final_result:payload;
  if(!["direct_buyers","intermediaries","leasing","statistics"]
      .every(key=>Array.isArray(result[key])))
    throw new Error("Stage 13 requires a completed four-array final result");
  const sourceRows=structuredClone(result);
  const settings=stage13AISettings();
  const selection=stage13SourceAudit(result,settings);
  if(flag("preview-ai-candidates")){
    const {candidates_detail,model_inventory,rows_detail,...statistics}=selection;
    console.log(JSON.stringify({mode:"preview-ai-candidates",
      ...statistics,
      firstCandidates:candidates_detail.slice(0,35),
      firstCatalogModels:model_inventory.filter(x=>x.verification==="catalog").slice(0,15),
      firstUnattributedModels:candidates_detail.filter(x=>!x.evidence_eligible).slice(0,15),
      rows_without_concrete_model:rows_detail.filter(x=>!x.models_found).length,
      openai_calls:0,network_calls:0,original_unchanged:true},null,2));
    return;
  }
  if(flag("preview")){
    const stats={buyers:0,changedScores:0,
      tiers:{none:0,ordinary:0,white:0,green:0},rowsWithWarnings:0,
      firstChanges:[],firstWarnings:[]};
    for(const [index,row] of result.direct_buyers.entries()){
      if(!String(row["Организация"]||"").trim())continue;
      const v=calculatePriority13({c:row["Наличие транспорта"]||"",
        d:row["Основание"],revenue:row["Выручка последнего подтвержденного года"],
        staff:row["Численность"],notes:row.__evidence?.notes||[]});
      stats.buyers++;stats.tiers[v.tier]++;
      if(row["Итоговый коэффициент"]!==v.score){
        stats.changedScores++;
        if(stats.firstChanges.length<25)stats.firstChanges.push({
          row:index+2,buyer:row["Организация"],
          previous:row["Итоговый коэффициент"]??null,
          calculated:v.score,tier:v.tier,models:v.models
        });
      }
      if(v.warnings.length){
        stats.rowsWithWarnings++;
        if(stats.firstWarnings.length<15)stats.firstWarnings.push({
          row:index+2,buyer:row["Организация"],warnings:v.warnings
        });
      }
    }
    console.log(JSON.stringify({...stats,preview_only:true,source_unchanged:true},null,2));
    return;
  }
  const base=path.resolve(prefix),xlsx=base+".xlsx",json=base+".json",
    auditPath=base+"_audit.json",progressPath=base+".progress.json";
  await fs.mkdir(path.dirname(base),{recursive:true,mode:0o700});
  // Do not pay for API requests if output files would be overwritten.
  for(const p of [xlsx,json,auditPath]){
    if(await exists(p))throw Error("Output already exists: "+p);
  }
  const withOpenAI=flag("with-openai");
  if(withOpenAI&&!process.env.OPENAI_API_KEY)
    throw Error("--with-openai requires OPENAI_API_KEY");
  if(withOpenAI&&!settings.enabled)
    throw Error("STAGE13_AI_ENABLED=false; stage13 OpenAI is disabled");
  if(withOpenAI&&!selection.all_models_fit)
    throw Error("Insufficient batch capacity for FULL Stage13: "+
      selection.unique_models+" models require "+selection.planned_calls+
      " calls; configured maximum="+settings.maxCalls+
      ". Increase STAGE13_AI_MAX_CALLS and/or STAGE13_AI_BATCH_SIZE first.");
  console.log(JSON.stringify({
    phase:"stage13-preflight",source:path.resolve(input),
    source_sha256:sourceHash,buyers:selection.buyers,
    saby_sweep_completed:Boolean(original?.saby_stats?.fullSweepCompleted),
    candidate_rows:selection.candidate_rows,candidate_mentions:selection.candidates,
    distinct_models:selection.unique_models,expected_calls:selection.planned_calls,
    forecast:selection.token_forecast,
    calls_cap:settings.maxCalls,estimated_usd_cap:settings.maxUsd,
    paid_calls_enabled:withOpenAI
  },null,2));

  let aiStats=null,usageRecords=[],priorCalls=0,priorEstimate=0;
  if(withOpenAI){
    const progress=await maybeRead(progressPath);
    if(progress){
      if(progress.source_hash!==sourceHash||
         !Array.isArray(progress.rows)||progress.rows.length!==result.direct_buyers.length)
        throw Error("Progress checkpoint does not match the input; use another --out-prefix");
      for(let i=0;i<result.direct_buyers.length;i++){
        if(progress.rows[i])result.direct_buyers[i].__priority13_ai=progress.rows[i];
      }
      usageRecords=progress.usage||[];
      priorCalls=Number(progress.calls||0);
      priorEstimate=Number(progress.estimated_cost_usd||0);
      console.log(JSON.stringify({phase:"stage13-resume",prior_calls:priorCalls,
        saved_verdict_rows:progress.rows.filter(Boolean).length}));
    }
    const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
    const env={...process.env,
      STAGE13_AI_MAX_CALLS:String(Math.max(0,settings.maxCalls-priorCalls)),
      STAGE13_AI_MAX_ESTIMATED_USD:String(Math.max(0,settings.maxUsd-priorEstimate))};
    const latest=await classifyStage13UnknownModels(result,{client,env,
      onUsage:usage=>usageRecords.push(usage),
      onBatchComplete:async state=>{
        await persistProgress(progressPath,{
          source_hash:sourceHash,model:settings.model,
          calls:priorCalls+state.calls,
          estimated_cost_usd:Number((priorEstimate+state.estimated_cost_usd).toFixed(6)),
          usage:usageRecords,
          rows:result.direct_buyers.map(r=>r.__priority13_ai||null)
        });
        console.log(JSON.stringify({phase:"stage13-batch",
          calls:priorCalls+state.calls,classifications:state.classified,
          candidate_rows:selection.candidate_rows,
          recognized_semi:state.recognized_semi_trailers,
          estimated_cost_usd:priorEstimate+state.estimated_cost_usd}));
      }
    });
    aiStats={...latest,calls:priorCalls+latest.calls,
      estimated_cost_usd:Number((priorEstimate+latest.estimated_cost_usd).toFixed(6)),
      model:settings.model,
      unique_models_total:selection.unique_models,
      planned_calls:selection.planned_calls,
      candidates_total:selection.candidates,
      candidate_rows_total:selection.candidate_rows
    };
  }
  const usage=tokensOf(usageRecords,settings.model,process.env);
  const summary=applyPriorityStage13(result,{aiStats});
  const audit=stage13DiffAudit(sourceRows,result,aiStats||{},usage,selection);
  audit.source_sha256=sourceHash;
  audit.paid_api_calls=aiStats?.calls||0;
  audit.saby_calls=0;
  audit.web_search_calls=0;
  audit.source_file_unchanged=true;
  if(!audit.unchanged_source_fields){
    throw Error("Stage13 unexpectedly changed source fields: "+
      JSON.stringify(audit.unexpected_differences.slice(0,4)));
  }
  // Commercial routing and JSON e-mail hydration are explicit, audited
  // postprocessing steps, after the per-row immutable-input score audit.
  const commercialPostprocess=finalizeStage13CommercialOutput(result);
  audit.commercial_postprocess=commercialPostprocess;
  audit.delivered_counts=commercialPostprocess.roles.final;
  audit.score_audit_scope="All original direct buyers before commercial role routing";
  summary.commercial_postprocess=commercialPostprocess;
  if(aiStats)payload.priority_ai_stats=aiStats;
  if(payload!==result)payload.priority_stats=summary;
  const bytes=await buildReferenceWorkbookBuffer(result);
  // The names are checked before API usage. All writes use exclusive flags;
  // the original checkpoint is read only and no SQLite is opened.
  await fs.writeFile(xlsx,bytes,{flag:"wx",mode:0o600});
  await fs.writeFile(json,JSON.stringify(payload,null,2)+"\n",{flag:"wx",mode:0o600});
  await fs.writeFile(auditPath,JSON.stringify(audit,null,2)+"\n",
    {flag:"wx",mode:0o600});
  console.log(JSON.stringify({...summary,
    completed_all_model_candidates:audit.complete,
    models_considered:selection.unique_models,
    rows_with_score_changes:audit.score_changed,
    score_increased:audit.score_increased,score_decreased:audit.score_decreased,
    commercial_postprocess:commercialPostprocess,
    usage:{input_tokens:usage.input_tokens,output_tokens:usage.output_tokens,
      cached_input_tokens:usage.cached_input_tokens,
      estimated_token_cost_usd:usage.estimated_token_cost_usd},
    files:{xlsx,json,audit:auditPath},original_unchanged:true,sqlite_writes:0},null,2));
}
main().catch(e=>{console.error("Stage 13: "+String(e.message||e));process.exitCode=1;});
