#!/usr/bin/env node
// Offline plan by default; --run is an explicit bounded official registry
// check on a separate child. Never start while the small VPS is researching.
import fs from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {planFnsLegalStatus,runFnsLegalStatusCheck} from "../src/fnsLegalStatus.js";
const args=process.argv.slice(2),arg=(k,d="")=>args.find(s=>s.startsWith("--"+k+"="))?.slice(k.length+3)??d;
const metric=(tag,x)=>console.log("["+tag+"] "+JSON.stringify(x));
async function main(){
  if(args.includes("--help")){
    console.log("node scripts/fns-legal-status-backfill.js --db=/absolute/checkpoints.sqlite --checkpoint=<UUID> [--limit=25] [--retry-unavailable] [--run]");
    return;
  }
  const file=arg("db"),id=arg("checkpoint"),limit=Number(arg("limit","25")),run=args.includes("--run"),
    retryUnavailable=args.includes("--retry-unavailable");
  if(!path.isAbsolute(file)||!fs.existsSync(file)||!fs.statSync(file).isFile()||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)||!Number.isSafeInteger(limit)||limit<1||limit>100)
    throw Error("FNS_LEGAL_STATUS_BAD_ARGS");
  const db=new DatabaseSync(file,{readOnly:true});
  let source;
  try{
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
    const row=db.prepare("SELECT payload FROM research_checkpoints WHERE id=?").get(id);
    if(!row?.payload)throw Error("FNS_LEGAL_STATUS_PARENT_NOT_FOUND");
    source=JSON.parse(row.payload);
  }finally{db.close();}
  if(source.version!==1||!["full","saby"].includes(source.source_mode)||source.phase!=="completed"||
    !String(source.region||"").trim()||
    !["direct_buyers","intermediaries","leasing","statistics"].every(k=>Array.isArray(source.final_result?.[k])))
    throw Error("FNS_LEGAL_STATUS_PARENT_NOT_READY");
  process.env.CHECKPOINT_DB_PATH=file;
  const {saveCheckpoint,PIPELINE_VERSION}=await import("../src/checkpointStore.js");
  if(Number(source.pipeline_version||PIPELINE_VERSION)!==PIPELINE_VERSION)throw Error("FNS_LEGAL_STATUS_PARENT_VERSION");
  const result=source.final_result,priorOutcomes=source.fns_legal_status_outcomes||{};
  const {selected,...plan}=planFnsLegalStatus(result,{priorOutcomes,retryUnavailable});
  metric("FNS_LEGAL_STATUS_PLAN",{parent_checkpoint:id,region:source.region,dry_run:!run,limit,...plan,openai_requests:0,saby_requests:0});
  if(!run||!selected.length)return;
  const childId=randomUUID(),snapshot={...source,created_at:new Date().toISOString(),
    fns_legal_status_parent_id:id,fns_legal_status_root_id:source.fns_legal_status_root_id||id};
  const controller=new AbortController(),stop=()=>controller.abort();
  process.once("SIGINT",stop);process.once("SIGTERM",stop);
  let saved=false;
  try{
    const state=await runFnsLegalStatusCheck({result,priorOutcomes,retryUnavailable,limit,signal:controller.signal,
      onCheckpoint:async({stats,outcomes})=>{
        if(!stats.processed)return;
        snapshot.fns_legal_status_stats=stats;snapshot.fns_legal_status_outcomes=outcomes;
        snapshot.updated_at=new Date().toISOString();
        await saveCheckpoint(childId,snapshot);
        if(!saved){saved=true;metric("FNS_LEGAL_STATUS_CHILD",{parent_checkpoint:id,child_checkpoint:childId});}
        metric("FNS_LEGAL_STATUS_PROGRESS",stats);
      }});
    metric("FNS_LEGAL_STATUS_DONE",{parent_checkpoint:id,child_checkpoint:saved?childId:null,
      ...state.stats,original_checkpoint_unchanged:true,commercial_rows_unchanged:true});
    if(state.stats.stop_reason==="browser_unavailable"||state.stats.stop_reason==="source_unavailable")process.exitCode=2;
  }finally{process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop);}
}
main().catch(error=>{
  metric("FNS_LEGAL_STATUS_ERROR",{reason:/^(?:FNS_LEGAL_STATUS_[A-Z_]+|JOB_CANCELLED)$/.test(error?.message||"")?error.message:"FNS_LEGAL_STATUS_UNAVAILABLE"});
  process.exitCode=2;
});
