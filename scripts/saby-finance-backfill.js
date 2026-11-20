#!/usr/bin/env node
// Offline preview + explicit Saby financial backfill for saved SQLite studies.
// Default is READ-ONLY. --run requests one bounded financial-only pass.
// No OpenAI/Google calls and no original checkpoint or XLSX modifications.
import fs from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";

function option(args,key,defaultValue=""){
  const token=args.find(arg=>arg.startsWith("--"+key+"="));
  return token?token.slice(key.length+3):defaultValue;
}
function guardUuid(value){
  return /^[a-f0-9-]{36}$/i.test(String(value||""));
}
async function main(){
  const args=process.argv.slice(2);
  if(args.includes("--help")||args.includes("-h")){
    console.log(
      "Saby finance backfill from persisted SQLite. READ-ONLY by default.\n"+
      "  node --env-file-if-exists=.env scripts/saby-finance-backfill.js "+
      "--db=/opt/regionalresearch/data/checkpoints.sqlite "+
      '--region="Ленинградская область"\n'+
      "  To run one company, add: --run --limit=1\n"+
      "  To pin an exact saved source, add: --checkpoint=UUID\n"+
      "  To test one eligible firm: --target-inn=4718000935 --limit=1\n"+
      "  To import prior verified smoke without browser: --run --limit=1 "+
      "--target-inn=... --import-smoke-json=/absolute/path.json\n"+
      "No OpenAI, no fleet or contacts. New SQLite child checkpoint; "+
      "original remains unchanged."
    );
    return;
  }
  const db=path.resolve(option(args,"db",""));
  if(!option(args,"db")||!path.isAbsolute(option(args,"db"))||
     !fs.existsSync(db)||!fs.statSync(db).isFile())
    throw new Error("Нужен существующий абсолютный путь --db=.../checkpoints.sqlite");
  const region=option(args,"region");
  const requested=option(args,"checkpoint");
  if(!region&&!requested)
    throw new Error("Укажите --region=... или --checkpoint=UUID");
  if(requested&&!guardUuid(requested))
    throw new Error("Некорректный --checkpoint (UUID)");
  const rawLimit=option(args,"limit","1");
  if(!/^[1-9]\d{0,4}$/.test(rawLimit)||
     Number(rawLimit)>10000)
    throw new Error("--limit должен быть целым числом от 1 до 10000");
  const limit=Number(rawLimit);
  const targetInn=option(args,"target-inn");
  if(targetInn&&(!/^(?:\d{10}|\d{12})$/.test(targetInn)||limit!==1))
    throw new Error("--target-inn требует ИНН из 10/12 цифр и --limit=1");
  const doRun=args.includes("--run");
  const smokeFile=option(args,"import-smoke-json");
  if(smokeFile&&(!doRun||!targetInn||limit!==1||
     !path.isAbsolute(smokeFile)||
     !fs.existsSync(smokeFile)||
     !fs.statSync(smokeFile).isFile()||
     fs.statSync(smokeFile).size>5_000_000))
    throw new Error("SMOKE_IMPORT_REQUIRES_EXPLICIT_RUN_TARGET_AND_FILE");
  // Imported AFTER choosing the persistent DB path to prevent creating an
  // independent copy inside a Git worktree.
  process.env.CHECKPOINT_DB_PATH=db;
  const {PIPELINE_VERSION,loadCheckpoint,listRegionCheckpoints,saveCheckpoint}
    =await import("../src/checkpointStore.js");
  const {validateFinanceBackfillCheckpoint,runSabyFinanceBackfill,
    planSabyFinanceBackfill,recoverLegacyFinanceReview,
    verifiedSabyFinanceFromSmoke}
    =await import("../src/sabyFinanceBackfill.js");
  let chosen=null,sourceId=requested||"";
  if(requested){
    chosen=await loadCheckpoint(requested);
    if(!chosen)throw new Error("Сохранённый checkpoint не найден по UUID");
  }else{
    // Never select a half-finished paid study over a finalized regional
    // checkpoint. Prefer the newest usable full/Saby child as the baseline.
    const meta=(await Promise.all(["saby","full"]
      .map(mode=>listRegionCheckpoints(region,mode,30))))
      .flat().filter(x=>x.status!=="superseded"&&
        Number(x.pipeline_version)===PIPELINE_VERSION)
      .sort((a,b)=>Date.parse(b.updated_at||0)-Date.parse(a.updated_at||0));
    for(const entry of meta){
      const candidate=await loadCheckpoint(entry.id);
      if(validateFinanceBackfillCheckpoint(candidate).ok){
        chosen=candidate;
        sourceId=entry.id;
        break;
      }
    }
    if(!chosen)throw new Error(
      "Не найдено завершённое исследование региона в SQLite");
  }
  // In the first one-company pilot, an unsuccessful card search was
  // incorrectly marked attempted. Recover only that uniquely identifiable
  // one-card review from its original immutable parent, in memory.
  const previousId=String(chosen?.saby_finance_backfill_source_job_id||"");
  if(previousId && chosen?.saby_finance_backfill_stats?.review===1){
    const before=await loadCheckpoint(previousId);
    if(before){
      const restored=recoverLegacyFinanceReview(chosen,{...before,id:previousId});
      if(restored.recovered){
        chosen=restored.checkpoint;
        console.log("[SABY_FINANCE_BACKFILL_LEGACY_REVIEW] "+JSON.stringify({
          restored:restored.recovered,source_checkpoint:sourceId,
          sqlite_changed:false
        }));
      }
    }
  }
  const valid=validateFinanceBackfillCheckpoint(chosen);
  if(!valid.ok)throw new Error(valid.code);
  if(region&&String(chosen.region).trim()!==region.trim())
    throw new Error("Регион исходного checkpoint не совпадает с --region");
  if(Number(chosen.pipeline_version||PIPELINE_VERSION)!==PIPELINE_VERSION)
    throw new Error("CHECKPOINT_VERSION_MISMATCH");
  const attempted=new Set(Array.isArray(chosen.saby_finance_backfill_attempted_inns)?
    chosen.saby_finance_backfill_attempted_inns:[]);
  const plan=planSabyFinanceBackfill(chosen.final_result);
  const reviewAttempts=chosen.saby_finance_backfill_review_attempts||{};
  const count=inn=>{
    const n=Number(reviewAttempts[inn]||0);
    return Number.isSafeInteger(n)?Math.min(2,Math.max(0,n)):0;
  };
  const pending=plan.eligible.filter(e=>!attempted.has(e.inn)&&count(e.inn)<2);
  const unvisited=pending.length;
  const reviewRetryable=pending.filter(e=>count(e.inn)>0).length;
  const reviewExhausted=plan.eligible.filter(e=>
    !attempted.has(e.inn)&&count(e.inn)>=2).length;
  if(targetInn && !pending.some(e=>e.inn===targetInn))
    throw new Error("FINANCE_BACKFILL_TARGET_NOT_ELIGIBLE_OR_ALREADY_ATTEMPTED");
  console.log("[SABY_FINANCE_BACKFILL_PLAN] "+JSON.stringify({
    region:chosen.region,source_checkpoint:sourceId,
    source_mode:String(chosen.source_mode||"full"),
    dry_run:!doRun,total:plan.total,
    revenue_missing:plan.missingRevenue,
    employees_missing:plan.missingEmployees,
    eligible_unique_inn:plan.eligible.length,
    unvisited,review_retryable:reviewRetryable,
    review_exhausted:reviewExhausted,
    excluded_invalid:plan.invalid,
    excluded_duplicate_inn:plan.duplicate,
    already_complete:plan.alreadyComplete,
    scheduled:targetInn?1:Math.min(unvisited,limit),
    ...(targetInn?{target_inn:targetInn}:{}),
    evidence_mode:smokeFile?"verified_smoke_offline":"saby_browser",
    openai_requests:0
  }));
  if(!doRun) {
    console.log("PREVIEW_ONLY: исходная SQLite не изменена. "+
      "Для отдельного финансового прохода добавьте --run --limit=1.");
    return;
  }
  if(unvisited===0){
    console.log("NO_UNVISITED_FINANCE_ROWS: новых карточек для проверки нет");
    return;
  }
  const childId=randomUUID();
  let importedRecord=null;
  if(smokeFile){
    let payload;
    try{payload=JSON.parse(fs.readFileSync(smokeFile,"utf8"));}
    catch{throw Error("FINANCE_BACKFILL_SMOKE_JSON_INVALID");}
    importedRecord=verifiedSabyFinanceFromSmoke(payload,targetInn);
    console.log("[SABY_FINANCE_SMOKE_IMPORT] "+JSON.stringify({
      status:"verified",revenue_rub:importedRecord.financials.revenue_rub,
      revenue_year:importedRecord.financials.revenue_year,
      employees:importedRecord.financials.employees,
      browser_requests:0
    }));
  }
  const env={
    ...process.env,
    SABY_STAGE12_ENABLED:"true",
    SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED:"true",
    SABY_SMOKE_ONLY:"false",
    SABY_FLEET_TAIL_CLICK_OPT_IN:"false",
    STAGE13_AI_SABY_ONLY_ENABLED:"false"
  };
  const {stats}=await runSabyFinanceBackfill({
    checkpoint:chosen,sourceJobId:sourceId,childJobId:childId,
    maxCompanies:limit,targetInn,env,
    ...(importedRecord?{
      sessionRunner:async task=>task({page:null,settings:{delayMs:250}}),
      collectCompany:async(_page,row)=>{
        if(String(row?.["ИНН"]||"")!==targetInn)
          throw Error("SMOKE_IMPORT_TARGET_MISMATCH");
        return importedRecord;
      }
    }:{}),
    onCheckpoint:cp=>saveCheckpoint(childId,cp),
    onProgress:s=>console.log("[SABY_FINANCE_BACKFILL_PROGRESS] "+
      JSON.stringify({processed:s.processed,scheduled:s.scheduled,
        revenue_added:s.revenueAdded,employees_added:s.employeesAdded,
        review:s.review,unavailable:s.unavailable,unchanged:s.unchanged,
        retries:s.retries,review_retryable:s.reviewRetryable,
        review_exhausted:s.reviewExhausted}))
  });
  console.log("[SABY_FINANCE_BACKFILL_DONE] "+JSON.stringify({
    child_checkpoint:childId,
    parent_checkpoint:sourceId,
    processed:stats.processed,revenue_added:stats.revenueAdded,
    employees_added:stats.employeesAdded,
    source_unavailable:stats.unavailable,
    no_new_numbers:stats.unchanged,review:stats.review,
    retries:stats.retries,review_retryable:stats.reviewRetryable,
    review_exhausted:stats.reviewExhausted,
    revenue_missing_after:stats.missingRevenueAfter,
    employees_missing_after:stats.missingEmployeesAfter,
    unvisited:stats.unvisited,browser_error:stats.browserError||null,
    openai_requests:0,
    browser_requests:importedRecord?0:null,
    original_checkpoint_unchanged:true
  }));
  // An unavailable Saby finance heading is not evidence of zero revenue
  // and not a failed command. Keep the gap and continue other legal INNs.
  // Identity mismatches and browser/session failures still require review.
  if(stats.browserError||stats.review>0)
    process.exitCode=2;
}
main().catch(error=>{
  console.error("[SABY_FINANCE_BACKFILL_ERROR] "+
    String(error?.message||"unavailable").slice(0,170));
  process.exitCode=1;
});
