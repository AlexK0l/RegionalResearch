#!/usr/bin/env node
// Default offline plan. No API key, paid subscription, Saby or OpenAI.
import fs from "node:fs";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import {planGirBoBackfill,runGirBoBackfill} from "../src/girBoBackfill.js";
import {createGirBoLookup} from "../src/girBoLookup.js";
const args=process.argv.slice(2),arg=(k,d="")=>args.find(a=>a.startsWith("--"+k+"="))?.slice(k.length+3)??d;
const metric=(n,x)=>console.log("["+n+"] "+JSON.stringify(x));
const int=(k,d,max)=>{
  const v=Number(arg(k,String(d)));
  if(!Number.isSafeInteger(v)||v<1||v>max)throw Error("GIRBO_BAD_ARGS");
  return v;
};
async function main(){
  if(args.includes("--help")){
    console.log("node scripts/girbo-backfill.js --db=/absolute/checkpoints.sqlite --checkpoint=<UUID> [--limit=10000] [--year=2025] [--max-requests=1500] [--confirmation=json|pdf] [--run]");
    return;
  }
  const file=arg("db"),sourceId=arg("checkpoint"),year=int("year",new Date().getUTCFullYear()-1,2100),
    limit=int("limit",10000,10000),maxRequests=int("max-requests",1500,3000),
    confirmationMode=arg("confirmation","json");
  if(!["json","pdf"].includes(confirmationMode))throw Error("GIRBO_BAD_ARGS");
  if(!path.isAbsolute(file)||!fs.existsSync(file)||!fs.statSync(file).isFile()||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(sourceId))throw Error("GIRBO_BAD_ARGS");
  const db=new DatabaseSync(file,{readOnly:true});
  let cp;
  try{
    db.exec("PRAGMA query_only=ON");
    const row=db.prepare("SELECT payload FROM research_checkpoints WHERE id=?").get(sourceId);
    if(!row?.payload)throw Error("GIRBO_CHECKPOINT_NOT_FOUND");
    cp=JSON.parse(row.payload);
  }finally{db.close();}
  const plan=planGirBoBackfill(cp,{limit,year,confirmationMode}),run=args.includes("--run");
  const {selected,...summary}=plan;
  metric("GIRBO_PLAN",{source_checkpoint:sourceId,region:cp.region,dry_run:!run,
    ...summary,scheduled:selected.length,confirmation_mode:confirmationMode,max_requests:maxRequests,openai_requests:0,saby_requests:0});
  if(!run||!selected.length)return;
  if(confirmationMode==="pdf"){
    const poppler=spawnSync("pdftotext",["-v"],{encoding:"utf8",timeout:5000,windowsHide:true});
    if(poppler.error||poppler.status!==0)throw Error("GIRBO_PDFTOTEXT_MISSING");
  }
  process.env.CHECKPOINT_DB_PATH=file;
  const {saveCheckpoint,PIPELINE_VERSION}=await import("../src/checkpointStore.js");
  if(Number(cp.pipeline_version||PIPELINE_VERSION)!==PIPELINE_VERSION)throw Error("GIRBO_CHECKPOINT_VERSION_MISMATCH");
  const lookup=createGirBoLookup({maxRequests,metric}),childId=randomUUID();
  let saved=false;
  const result=await runGirBoBackfill({checkpoint:cp,sourceId,childId,limit,year,confirmationMode,lookup,
    onCheckpoint:async child=>{
      await saveCheckpoint(childId,child);
      if(!saved){saved=true;metric("GIRBO_CHILD",{child_checkpoint:childId,parent_checkpoint:sourceId});}
    },
    onProgress:stats=>metric("GIRBO_PROGRESS",{...stats,http_requests:lookup.requests})});
  metric("GIRBO_DONE",{child_checkpoint:childId,parent_checkpoint:sourceId,
    ...result.stats,http_requests:lookup.requests,original_checkpoint_unchanged:true});
  if(result.stats.stop_reason)process.exitCode=2;
}
main().catch(e=>{metric("GIRBO_ERROR",{reason:/^GIRBO_[A-Z_]{1,90}$/.test(e?.message||"")?e.message:"GIRBO_UNAVAILABLE"});process.exitCode=2;});
