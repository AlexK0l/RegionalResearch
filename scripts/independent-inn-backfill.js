#!/usr/bin/env node
// Dry run by default. Explicit --run creates a NEW checkpoint only.
// Public registry pages, no Saby authentication or OpenAI/paid API.
import fs from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {planIndependentInnBackfill,runIndependentInnBackfill}
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
      "[--run --max-pages=80] \n"+
      "Default: offline plan only. --run: public VBR/T-Bank pages, no OpenAI or Saby.");
    return;
  }
  const file=arg("db"),sourceId=arg("checkpoint");
  if(!path.isAbsolute(file)||!fs.existsSync(file)||!fs.statSync(file).isFile()||
    !uuid.test(sourceId))throw Error("REGISTRY_INN_BAD_SOURCE");
  const limit=number("limit",1,10000),maxPages=number("max-pages",80,3000);
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
  const plan=planIndependentInnBackfill(checkpoint,{limit,targetId});
  metric("INDEPENDENT_INN_PLAN",{region:checkpoint.region,source_checkpoint:sourceId,
    dry_run:!run,total:plan.total,missing:plan.missing,pending:plan.pending,
    scheduled:plan.scheduled,previously_reviewed:plan.previously_reviewed,
    saved_public_hints:plan.saved_public_hints,legal_name_unresolved:plan.legal_name_unresolved,
    max_page_navigations:maxPages,openai_requests:0,saby_requests:0});
  if(!run||!plan.scheduled)return;
  process.env.CHECKPOINT_DB_PATH=file;
  const {saveCheckpoint,PIPELINE_VERSION}=await import("../src/checkpointStore.js");
  if(Number(checkpoint.pipeline_version||PIPELINE_VERSION)!==PIPELINE_VERSION)
    throw Error("REGISTRY_INN_CHECKPOINT_VERSION_MISMATCH");
  const {withPublicRegistryLookup}=await import("../src/independentInnRegistryBrowser.js");
  const childId=randomUUID();
  let saved=false;
  let final;
  try{
    final=await withPublicRegistryLookup(async lookup=>{
      const out=await runIndependentInnBackfill({checkpoint,sourceId,childId,
        limit,targetId,lookup,
        onCheckpoint:async cp=>{
          await saveCheckpoint(childId,cp);
          if(!saved){
            saved=true;
            metric("INDEPENDENT_INN_CHILD",{child_checkpoint:childId,parent_checkpoint:sourceId});
          }
        },
        onProgress:stats=>metric("INDEPENDENT_INN_PROGRESS",{
          ...stats,page_navigations:lookup.pages
        })});
      return {...out,page_navigations:lookup.pages};
    },{maxPages});
  }catch{
    metric("INDEPENDENT_INN_ERROR",{reason:"registry_run_unavailable",
      child_checkpoint:saved?childId:null,parent_checkpoint:sourceId});
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
    ...stats,missing_after:plan.missing-stats.added,
    page_navigations:final.page_navigations,by_reason:counts,
    openai_requests:0,saby_requests:0,original_checkpoint_unchanged:true});
  if(stats.stop_reason)process.exitCode=2;
}
main().catch(error=>{
  metric("INDEPENDENT_INN_ERROR",{reason:/^[A-Z_a-z-]{1,90}$/.test(error?.message||"")?
    error.message:"registry_run_unavailable"});
  process.exitCode=1;
});
