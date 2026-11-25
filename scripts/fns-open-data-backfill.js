#!/usr/bin/env node
// Explicit --run creates a NEW saved checkpoint; default is read-only plan.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {DatabaseSync} from "node:sqlite";
import {planFnsOpenData,applyFnsOpenData} from "../src/fnsOpenDataBackfill.js";
const args=process.argv.slice(2);
const arg=(key,d="")=>args.find(s=>s.startsWith("--"+key+"="))?.slice(key.length+3)??d;
const metric=(n,x)=>console.log("["+n+"] "+JSON.stringify(x));
const scanner=fileURLToPath(new URL("./fns-open-data-scan.py",import.meta.url));
async function scan(config){
  return new Promise((resolve,reject)=>{
    const p=spawn(process.env.REGIONALRESEARCH_PYTHON||(process.platform==="win32"?"python":"python3"),[scanner],
      {stdio:["pipe","pipe","inherit"],windowsHide:true});
    let size=0,settled=false;
    const chunks=[],fail=e=>{if(!settled){settled=true;reject(e);}};
    p.on("error",()=>fail(Error("FNS_SCAN_PROCESS_UNAVAILABLE")));
    p.stdin.on("error",()=>fail(Error("FNS_SCAN_PROCESS_UNAVAILABLE")));
    p.stdout.on("data",c=>{size+=c.length;if(size>64*1024*1024){p.kill();fail(Error("FNS_SCAN_RESULT_LIMIT"));}else chunks.push(c);});
    p.on("close",code=>{
      if(settled)return;
      if(code!==0)return fail(Error("FNS_SCAN_FAILED"));
      try{const value=JSON.parse(Buffer.concat(chunks).toString("utf8"));settled=true;resolve(value);}
      catch{fail(Error("FNS_SCAN_RESULT_INVALID"));}
    });
    p.stdin.end(JSON.stringify(config),"utf8");
  });
}
async function main(){
  if(args.includes("--help")){
    console.log("node scripts/fns-open-data-backfill.js --db=/absolute/checkpoints.sqlite --checkpoint=<UUID> --year=2025 [--sshr-url=...] [--rsmp-url=...] [--workdir=/absolute/path] [--run]");
    return;
  }
  const file=arg("db"),sourceId=arg("checkpoint"),workdir=arg("workdir",path.dirname(file)),year=Number(arg("year"));
  if(!path.isAbsolute(file)||!fs.existsSync(file)||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(sourceId)||
    !path.isAbsolute(workdir)||!fs.statSync(workdir).isDirectory()||!Number.isSafeInteger(year)||year<2000||year>2100)
    throw Error("FNS_OPEN_DATA_BAD_ARGS");
  let cp;
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    db.exec("PRAGMA query_only=ON");
    const row=db.prepare("SELECT payload FROM research_checkpoints WHERE id=?").get(sourceId);
    if(!row?.payload)throw Error("FNS_OPEN_DATA_CHECKPOINT_NOT_FOUND");
    cp=JSON.parse(row.payload);
  }finally{db.close();}
  const plan=planFnsOpenData(cp),run=args.includes("--run");
  const configs=[["sshr",arg("sshr-url")],["rsmp",arg("rsmp-url")]].filter(x=>x[1]);
  metric("FNS_OPEN_DATA_PLAN",{source_checkpoint:sourceId,region:cp.region,dry_run:!run,total:plan.total,
    employees_missing:plan.employees_missing,staff_eligible:plan.staff.length,missing_inn:plan.missing_inn,
    candidate_eligible:plan.candidates.length,datasets:configs.map(x=>x[0]),report_year:year,openai_requests:0,saby_requests:0});
  if(!run)return;
  if(!configs.length)throw Error("FNS_OPEN_DATA_NO_DATASET");
  process.env.CHECKPOINT_DB_PATH=file;
  const {saveCheckpoint,PIPELINE_VERSION}=await import("../src/checkpointStore.js");
  if(Number(cp.pipeline_version||PIPELINE_VERSION)!==PIPELINE_VERSION)throw Error("FNS_OPEN_DATA_CHECKPOINT_VERSION_MISMATCH");
  const archives=[],failed=[];
  for(const [kind,url] of configs){
    try{
      const a=await scan({kind,url,year,workdir,targets:plan.targets});
      if(a?.source?.kind!==kind||a.source.url!==url||a.source.report_year!==year)throw Error("FNS_SCAN_RESULT_INVALID");
      archives.push(a);
      metric("FNS_OPEN_DATA_SCAN",{kind,source:a.source,scan:a.stats});
    }catch{failed.push(kind);metric("FNS_OPEN_DATA_SOURCE_FAILED",{kind});}
  }
  if(!archives.length)throw Error("FNS_OPEN_DATA_ALL_SOURCES_FAILED");
  const childId=randomUUID(),out=applyFnsOpenData(cp,archives,{sourceId,childId});
  await saveCheckpoint(childId,out.snapshot);
  metric("FNS_OPEN_DATA_DONE",{child_checkpoint:childId,parent_checkpoint:sourceId,...out.stats,
    completed_datasets:archives.map(a=>a.source.kind),failed_datasets:failed,original_checkpoint_unchanged:true});
  if(failed.length)process.exitCode=2;
}
main().catch(e=>{
  metric("FNS_OPEN_DATA_ERROR",{reason:/^FNS_[A-Z_]{1,90}$/.test(e?.message||"")?e.message:"FNS_OPEN_DATA_UNAVAILABLE"});
  process.exitCode=2;
});
