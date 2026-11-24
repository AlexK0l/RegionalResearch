#!/usr/bin/env node
// Dry run by default. Explicit --run creates a NEW checkpoint only.
// Public registry pages, no Saby authentication or OpenAI/paid API.
import fs from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {planIndependentInnBackfill,runIndependentInnBackfill,
  checkFnsRegistryCanary}
  from "../src/independentInnBackfill.js";
const args=process.argv.slice(2);
const arg=(name,fallback="")=>args.find(s=>s.startsWith("--"+name+"="))
  ?.slice(name.length+3)??fallback;
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const metric=(name,value)=>console.log("["+name+"] "+JSON.stringify(value));
function number(name,def,max){
  const raw=arg(name,String(def));
  if(!/^[1-9]\d*$/.test(raw)||Number(raw)>max)throw Error("BAD_"+name.toUpperCase());
  return Number(raw);
}
async function main(){
  if(args.includes("--help")){
    console.log("node scripts/independent-inn-backfill.js "+
      "--db=/absolute/checkpoints.sqlite --checkpoint=<UUID> "+
      "[--limit=1] [--target-id=<canonical_id>] "+
      "[--provider=fns|vbr] [--confirmation=extract|registry] [--run --max-pages=80] \n"+
      "Default: offline plan only. FNS --run uses official EGRUL PDFs (pdftotext required). --confirmation=registry retains the earlier independent card route. No OpenAI or Saby.");
    return;
  }
  const file=arg("db"),sourceId=arg("checkpoint");
  if(!path.isAbsolute(file)||!fs.existsSync(file)||!fs.statSync(file).isFile()||
    !uuid.test(sourceId))throw Error("REGISTRY_INN_BAD_SOURCE");
  const limit=number("limit",1,10000),maxPages=number("max-pages",80,3000);
  const provider=arg("provider","fns");
  if(!["fns","vbr"].includes(provider))throw Error("REGISTRY_INN_BAD_PROVIDER");
  const confirmationMode=arg("confirmation",provider==="fns"?"extract":"registry");
  if(!["extract","registry"].includes(confirmationMode)||
    (provider!=="fns"&&confirmationMode!=="registry"))
    throw Error("REGISTRY_INN_BAD_CONFIRMATION");
  const targetId=arg("target-id");
  if(targetId&&(!/^[a-z0-9_.:-]{1,100}$/i.test(targetId)||limit!==1))
    throw Error("REGISTRY_INN_BAD_TARGET");
  const run=args.includes("--run");
  const db=new DatabaseSync(file,{readOnly:true});
  let checkpoint;
  try{
    db.exec("PRAGMA query_only=ON");
    const row=db.prepare("SELECT payload FROM research_checkpoints WHERE id=?").get(sourceId);
    if(!row?.payload)throw Error("REGISTRY_INN_CHECKPOINT_NOT_FOUND");
    checkpoint=JSON.parse(row.payload);
  }finally{db.close();}
  const plan=planIndependentInnBackfill(checkpoint,{limit,targetId,provider});
  metric("INDEPENDENT_INN_PLAN",{region:checkpoint.region,source_checkpoint:sourceId,
    dry_run:!run,total:plan.total,missing:plan.missing,pending:plan.pending,
    scheduled:plan.scheduled,previously_reviewed:plan.previously_reviewed,
    provider,confirmation_mode:confirmationMode,reopened_from_vbr:plan.reopened_from_vbr,
    reopened_fns_name_search:plan.reopened_fns_name_search,
    saved_public_hints:plan.saved_public_hints,legal_name_unresolved:plan.legal_name_unresolved,
    max_page_navigations:maxPages,openai_requests:0,saby_requests:0});
  if(!run||!plan.scheduled)return;
  process.env.CHECKPOINT_DB_PATH=file;
  const {saveCheckpoint,PIPELINE_VERSION}=await import("../src/checkpointStore.js");
  if(Number(checkpoint.pipeline_version||PIPELINE_VERSION)!==PIPELINE_VERSION)
    throw Error("REGISTRY_INN_CHECKPOINT_VERSION_MISMATCH");
  const {withPublicRegistryLookup}=await import("../src/independentInnRegistryBrowser.js");
  const childId=randomUUID();
  let saved=false,canaryFailed=false;
  let final;
  try{
    final=await withPublicRegistryLookup(async lookup=>{
      if(provider==="fns"){
        let canary;
        try{
          canary=await checkFnsRegistryCanary(checkpoint,lookup);
        }catch(error){
          const allowed=new Set(["navigation_budget","registry_http_unavailable",
            "registry_route_untrusted","registry_browser_unavailable","registry_confirmation_unavailable",
            "fns_invalid_query","fns_form_unavailable",
          "fns_query_input_unavailable","fns_submit_button_unavailable",
          "fns_query_not_set","fns_exact_checkbox_unavailable",
          "fns_exact_checkbox_not_selected","fns_submit_failed","fns_captcha_required",
            "fns_search_token_missing","fns_search_token_conflict",
            "fns_response_unreadable","fns_result_unavailable","fns_submit_unobserved",
            "fns_extract_download_unavailable","fns_extract_pdftotext_missing","fns_extract_unavailable"]);
          canary={verified:false,reason:allowed.has(error?.code)?
            error.code:"fns_canary_unavailable"};
        }
        metric("INDEPENDENT_INN_CANARY",{...canary,page_navigations:lookup.pages,
          extract_downloads:lookup.extractDownloads});
        if(!canary.verified){
          canaryFailed=true;
          return null;
        }
      }
      const out=await runIndependentInnBackfill({checkpoint,sourceId,childId,
        limit,targetId,provider,lookup,
        onCheckpoint:async cp=>{
          await saveCheckpoint(childId,cp);
          if(!saved){
            saved=true;
            metric("INDEPENDENT_INN_CHILD",{child_checkpoint:childId,parent_checkpoint:sourceId});
          }
        },
        onProgress:stats=>metric("INDEPENDENT_INN_PROGRESS",{
          ...stats,page_navigations:lookup.pages,extract_downloads:lookup.extractDownloads
        })});
      return {...out,page_navigations:lookup.pages,extract_downloads:lookup.extractDownloads};
    },{maxPages,provider,confirmationMode,onDiagnostic:value=>metric("INDEPENDENT_INN_REGISTRY_DIAG",value)});
  }catch{
    metric("INDEPENDENT_INN_ERROR",{reason:"registry_run_unavailable",
      child_checkpoint:saved?childId:null,parent_checkpoint:sourceId});
    process.exitCode=2;
    return;
  }
  if(canaryFailed){
    metric("INDEPENDENT_INN_ERROR",{reason:"fns_preflight_failed",
      child_checkpoint:null,parent_checkpoint:sourceId,
      processed:0,openai_requests:0,saby_requests:0});
    process.exitCode=2;
    return;
  }
  const stats=final.stats;
  const counts={};
  for(const outcome of Object.values(final.snapshot.independent_inn_backfill_outcomes||{})){
    const reason=String(outcome.reason||"unclassified");
    // Only fixed internal machine codes. Never print raw source records.
    const code=/^[a-z_]{1,80}$/.test(reason)?reason:"unclassified";
    counts[code]=(counts[code]||0)+1;
  }
  metric("INDEPENDENT_INN_DONE",{child_checkpoint:childId,parent_checkpoint:sourceId,
    ...stats,provider,missing_after:plan.missing-stats.added,
    page_navigations:final.page_navigations,extract_downloads:final.extract_downloads,
    confirmation_mode:confirmationMode,by_reason:counts,
    openai_requests:0,saby_requests:0,original_checkpoint_unchanged:true});
  if(stats.stop_reason)process.exitCode=2;
}
main().catch(error=>{
  metric("INDEPENDENT_INN_ERROR",{reason:/^[A-Z_a-z-]{1,90}$/.test(error?.message||"")?
    error.message:"registry_run_unavailable"});
  process.exitCode=1;
});
