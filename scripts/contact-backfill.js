#!/usr/bin/env node
// Dry plan by default. Explicit --run creates an independent SQLite child.
// Source checkpoint and all financial, identity, fleet and score data stay
// unchanged. Run only when no research is active on this small VPS.
import fs from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {planPublicContactEnrichment,runPublicContactEnrichment} from "../src/publicContactEnrichment.js";
import {runFnsContactEnrichment} from "../src/publicContactFns.js";
const args=process.argv.slice(2),arg=(k,d="")=>args.find(x=>x.startsWith("--"+k+"="))?.slice(k.length+3)??d;
const metric=(label,body)=>console.log("["+label+"] "+JSON.stringify(body));
const int=(k,d,max)=>{
  const n=Number(arg(k,String(d)));
  if(!Number.isSafeInteger(n)||n<1||n>max)throw Error("CONTACT_BAD_ARGUMENT");
  return n;
};
async function main(){
  if(args.includes("--help")){
    console.log("npm run contacts:backfill -- --db=/absolute/checkpoints.sqlite --checkpoint=<UUID> [--limit=350] [--max-requests=750] [--phone-only] [--fns] [--fns-only] [--retry-unavailable] [--run]");
    return;
  }
  const file=arg("db"),id=arg("checkpoint"),run=args.includes("--run"),
    onlyFns=args.includes("--fns-only"),fns=onlyFns||args.includes("--fns"),
    retryUnavailable=args.includes("--retry-unavailable"),phoneOnly=args.includes("--phone-only");
  if(phoneOnly&&fns)throw Error("CONTACT_BAD_ARGUMENT");
  const prefix=phoneOnly?"public_phone_backfill":"public_contact";
  if(!path.isAbsolute(file)||!fs.existsSync(file)||!fs.statSync(file).isFile()||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))
    throw Error("CONTACT_BAD_ARGUMENT");
  const db=new DatabaseSync(file,{readOnly:true});
  let source;
  try{
    db.exec("PRAGMA query_only=ON");
    const row=db.prepare("SELECT payload FROM research_checkpoints WHERE id=?").get(id);
    if(!row)throw Error("CONTACT_CHECKPOINT_NOT_FOUND");
    source=JSON.parse(row.payload);
  }finally{db.close();}
  if(Number(source.version)!==1||!String(source.region||"").trim()||
    !((source.source_mode==="full"&&source.phase==="completed")||
      (source.source_mode==="saby"&&["saby","completed"].includes(source.phase)))||
    !["direct_buyers","intermediaries","leasing","statistics"].every(k=>Array.isArray(source.final_result?.[k])))
    throw Error("CONTACT_CHECKPOINT_NOT_READY");
  const result=source.final_result;
  const htmlPlan=planPublicContactEnrichment(result,{priorOutcomes:source[prefix+"_outcomes"]||{},retryUnavailable,phoneOnly});
  const fnsPlan=planPublicContactEnrichment(result,{priorOutcomes:source.fns_contact_outcomes||{},source:"fns",retryUnavailable});
  const summary=p=>Object.fromEntries(Object.entries(p).filter(([k])=>k!=="selected"));
  metric("CONTACT_BACKFILL_PLAN",{parent_checkpoint:id,region:source.region,dry_run:!run,
    phone_only:phoneOnly,html:onlyFns?null:summary(htmlPlan),fns:fns?summary(fnsPlan):null,openai_requests:0,saby_requests:0});
  if(!run||!(onlyFns?0:htmlPlan.eligible)&&!(fns&&fnsPlan.eligible))return;
  process.env.CHECKPOINT_DB_PATH=file;
  const {saveCheckpoint,PIPELINE_VERSION}=await import("../src/checkpointStore.js");
  if(Number(source.pipeline_version||PIPELINE_VERSION)!==PIPELINE_VERSION)throw Error("CONTACT_CHECKPOINT_VERSION_MISMATCH");
  const childId=randomUUID();
  const snapshot={...source,created_at:new Date().toISOString(),
    contact_backfill_parent_id:id,contact_backfill_root_id:source.contact_backfill_root_id||id};
  const env={...process.env,PUBLIC_CONTACTS_ENABLED:"true",PUBLIC_CONTACTS_CHECKPOINT_EVERY:"1",
    PUBLIC_CONTACTS_MAX_COMPANIES:String(int("limit",350,3000)),
    PUBLIC_CONTACTS_MAX_REQUESTS:String(int("max-requests",750,5000)),
    PUBLIC_CONTACTS_FNS_ENABLED:fns?"true":"false"};
  let saved=false;
  const controller=new AbortController();
  const stop=()=>controller.abort();
  process.once("SIGINT",stop);process.once("SIGTERM",stop);
  const persist=async(prefix,{stats,outcomes})=>{
    snapshot[prefix+"_stats"]=stats;snapshot[prefix+"_outcomes"]=outcomes;
    snapshot.updated_at=new Date().toISOString();
    snapshot.contact_backfill_in_progress=true;
    await saveCheckpoint(childId,snapshot);
    if(!saved){saved=true;metric("CONTACT_BACKFILL_CHILD",{parent_checkpoint:id,child_checkpoint:childId});}
    metric("CONTACT_BACKFILL_PROGRESS",{source:prefix,processed:stats.processed,pending:stats.pending,
      phone_added:stats.phone_added,email_added:stats.email_added,leader_added:stats.leader_added});
  };
  try{
    if(!onlyFns)await runPublicContactEnrichment({result,env,signal:controller.signal,
      priorOutcomes:source[prefix+"_outcomes"]||{},retryUnavailable,phoneOnly,
      onCheckpoint:x=>persist(prefix,x)});
    if(fns)await runFnsContactEnrichment({result,env,signal:controller.signal,
      priorOutcomes:source.fns_contact_outcomes||{},retryUnavailable,
      onCheckpoint:x=>persist("fns_contact",x)});
    if(saved){snapshot.contact_backfill_in_progress=false;await saveCheckpoint(childId,snapshot);}
    metric("CONTACT_BACKFILL_DONE",{parent_checkpoint:id,child_checkpoint:saved?childId:null,
      phone_only:phoneOnly,html:snapshot[prefix+"_stats"]||null,fns:fns?snapshot.fns_contact_stats||null:null,
      original_checkpoint_unchanged:true,openai_requests:0,saby_requests:0});
  }finally{process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop);}
}
main().catch(error=>{metric("CONTACT_BACKFILL_ERROR",{reason:/^(?:CONTACT_[A-Z_]+|JOB_CANCELLED)$/.test(error?.message||"")?error.message:"CONTACT_BACKFILL_UNAVAILABLE"});process.exitCode=2;});
