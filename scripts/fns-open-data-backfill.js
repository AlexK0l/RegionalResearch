#!/usr/bin/env node
// Explicit --run creates a NEW saved checkpoint; default is read-only plan.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {randomUUID,createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {DatabaseSync} from "node:sqlite";
import {planFnsOpenData,applyFnsOpenData,combineFnsOpenDataTargets,FNS_BATCH_MAX_CHECKPOINTS} from "../src/fnsOpenDataBackfill.js";
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
// Retain only a compact plan and payload fingerprint for each parent.
// Do not keep several full research histories in memory during a large scan.
function loadSource(file,id){
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
    const row=db.prepare("SELECT payload FROM research_checkpoints WHERE id=?").get(id);
    if(!row?.payload)throw Error("FNS_OPEN_DATA_CHECKPOINT_NOT_FOUND");
    return {cp:JSON.parse(row.payload),fingerprint:createHash("sha256").update(row.payload).digest("hex")};
  }finally{db.close();}
}
function prepareSource(file,sourceId,version){
  const {cp,fingerprint}=loadSource(file,sourceId);
  if(Number(cp.pipeline_version||version)!==version)throw Error("FNS_OPEN_DATA_CHECKPOINT_VERSION_MISMATCH");
  const plan=planFnsOpenData(cp);
  return {sourceId,fingerprint,region:cp.region,targets:plan.targets,total:plan.total,
    employees_missing:plan.employees_missing,staff_eligible:plan.staff.length,
    missing_inn:plan.missing_inn,candidate_eligible:plan.candidates.length};
}
async function main(){
  if(args.includes("--help")){
    console.log("node scripts/fns-open-data-backfill.js --db=/absolute/checkpoints.sqlite --checkpoint=<UUID> [--checkpoint=<UUID> ... up to 6] --year=2025 [--sshr-url=...] [--rsmp-url=...] [--workdir=/absolute/path] [--run]");
    return;
  }
  const file=arg("db"),ids=args.filter(s=>s.startsWith("--checkpoint=")).map(s=>s.slice(13)),
    workdir=arg("workdir",path.dirname(file)),year=Number(arg("year"));
  if(!path.isAbsolute(file)||!fs.existsSync(file)||!ids.length||ids.length>FNS_BATCH_MAX_CHECKPOINTS||
    new Set(ids.map(x=>x.toLowerCase())).size!==ids.length||
    ids.some(id=>!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))||
    !path.isAbsolute(workdir)||!fs.statSync(workdir).isDirectory()||!Number.isSafeInteger(year)||year<2000||year>2100)
    throw Error("FNS_OPEN_DATA_BAD_ARGS");
  process.env.CHECKPOINT_DB_PATH=file;
  const {saveCheckpoint,PIPELINE_VERSION}=await import("../src/checkpointStore.js");
  const plans=ids.map(id=>prepareSource(file,id,PIPELINE_VERSION)),run=args.includes("--run");
  const configs=[["sshr",arg("sshr-url")],["rsmp",arg("rsmp-url")]].filter(x=>x[1]);
  const batch=plans.length>1;
  const targets=batch?combineFnsOpenDataTargets(plans.map(p=>p.targets)):plans[0].targets;
  for(const {sourceId,region,total,employees_missing,staff_eligible,missing_inn,candidate_eligible} of plans)
    metric("FNS_OPEN_DATA_PLAN",{source_checkpoint:sourceId,region,dry_run:!run,total,employees_missing,staff_eligible,
      missing_inn,candidate_eligible,datasets:configs.map(x=>x[0]),report_year:year,openai_requests:0,saby_requests:0});
  if(batch)metric("FNS_OPEN_DATA_BATCH_PLAN",{checkpoints:plans.length,inns:targets.inns.length,
    ogrns:targets.ogrns.length,names:targets.names.length,regions:targets.regional_targets.length,
    one_scan_per_dataset:true,dry_run:!run});
  if(!run)return;
  if(!configs.length)throw Error("FNS_OPEN_DATA_NO_DATASET");
  if(!targets.inns.length&&!targets.ogrns.length&&!targets.names.length){
    metric("FNS_OPEN_DATA_NO_TARGETS",{checkpoints:plans.length});return;
  }
  const archives=[],failed=[];
  for(const [kind,url] of configs){
    try{
      const a=await scan({kind,url,year,workdir,targets});
      if(a?.source?.kind!==kind||a.source.url!==url||a.source.report_year!==year||
        (batch&&(a.regional_key_mode!=="region_name_v1"||
          JSON.stringify(a.regional_keys)!==JSON.stringify(targets.regional_targets.map(x=>x.region).sort()))))
        throw Error("FNS_SCAN_RESULT_INVALID");
      archives.push(a);
      metric("FNS_OPEN_DATA_SCAN",{kind,source:a.source,scan:a.stats});
    }catch{failed.push(kind);metric("FNS_OPEN_DATA_SOURCE_FAILED",{kind});}
  }
  if(!archives.length)throw Error("FNS_OPEN_DATA_ALL_SOURCES_FAILED");
  let saved=0,skipped=0;
  for(const plan of plans){
    // A changing/removed source must not be silently applied to the old
    // plan. Other explicitly selected parents can still produce children.
    const loaded=loadSource(file,plan.sourceId);
    if(loaded.fingerprint!==plan.fingerprint){
      skipped++;
      metric("FNS_OPEN_DATA_PARENT_CHANGED",{parent_checkpoint:plan.sourceId});
      continue;
    }
    if(!plan.targets.inns.length&&!plan.targets.ogrns.length&&!plan.targets.names.length)continue;
    const childId=randomUUID(),out=applyFnsOpenData(loaded.cp,archives,{sourceId:plan.sourceId,childId});
    await saveCheckpoint(childId,out.snapshot);
    saved++;
    metric("FNS_OPEN_DATA_DONE",{child_checkpoint:childId,parent_checkpoint:plan.sourceId,...out.stats,
      completed_datasets:archives.map(a=>a.source.kind),failed_datasets:failed,original_checkpoint_unchanged:true});
  }
  if(batch)metric("FNS_OPEN_DATA_BATCH_DONE",{checkpoints:plans.length,saved,skipped,
    completed_datasets:archives.map(a=>a.source.kind),failed_datasets:failed,one_scan_per_dataset:true});
  if(failed.length||skipped)process.exitCode=2;
}
main().catch(e=>{
  metric("FNS_OPEN_DATA_ERROR",{reason:/^FNS_[A-Z_]{1,90}$/.test(e?.message||"")?e.message:"FNS_OPEN_DATA_UNAVAILABLE"});
  process.exitCode=2;
});
