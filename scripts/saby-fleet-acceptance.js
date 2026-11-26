#!/usr/bin/env node
// A small offline plan / explicit live diagnostic / offline comparison.
// Never writes production SQLite or replaces a cohort/report.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {auditSavedFleetCoverage,buildFleetCohort,validateFleetCohort,
  cohortResult,summarizeFleetAcceptance,compareFleetAcceptance} from "../src/sabyFleetAcceptance.js";
const args=process.argv.slice(2),arg=(key,fallback="")=>
  args.find(x=>x.startsWith("--"+key+"="))?.slice(key.length+3)??fallback;
const has=key=>args.includes("--"+key);
const emit=(event,data)=>console.log("["+event+"] "+JSON.stringify(data));
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const load=file=>JSON.parse(fs.readFileSync(file,"utf8"));
const privateWrite=(file,data)=>{
  if(!file)throw Error("FLEET_ACCEPTANCE_OUTPUT_REQUIRED");
  fs.writeFileSync(path.resolve(file),JSON.stringify(data,null,2)+"\n",{flag:"wx",mode:0o600});
};
function git(root,...command){
  const r=spawnSync("git",["-C",root,...command],{encoding:"utf8",timeout:10000,windowsHide:true});
  if(r.status!==0||r.error)throw Error("FLEET_ACCEPTANCE_CODE_NOT_CLEAN");
  return r.stdout.trim();
}
function requireIdleVps(){
  if(process.platform!=="linux"||!has("idle-confirmed"))
    throw Error("FLEET_ACCEPTANCE_IDLE_VPS_REQUIRED");
  const check=spawnSync("systemctl",["show","regionalresearch","-p","LoadState","-p","ActiveState"],
    {encoding:"utf8",timeout:10000});
  const fields=String(check.stdout||"").trim().split(/\r?\n/);
  if(check.status!==0||!fields.includes("LoadState=loaded")||!fields.includes("ActiveState=inactive"))
    throw Error("FLEET_ACCEPTANCE_SERVICE_NOT_STOPPED");
}
async function main(){
  if(has("help")){
    console.log("Offline: --audit|--plan --db=/absolute/checkpoints.sqlite --checkpoint=<UUID> [--limit=12 --out=/private/cohort.json]\n"+
      "Live Linux only, service stopped and all browser jobs idle: --run --idle-confirmed --cohort=/private/cohort.json --code-root=/trusted/checkout --out=/private/report.json\n"+
      "Offline compare: --compare --baseline=/private/old.json --candidate=/private/new.json");
    return;
  }
  if(["audit","plan","run","compare"].filter(has).length!==1)
    throw Error("FLEET_ACCEPTANCE_BAD_MODE");
  if(has("audit")||has("plan")){
    const file=arg("db"),id=arg("checkpoint"),limit=Number(arg("limit","12"));
    if(!path.isAbsolute(file)||!fs.statSync(file).isFile()||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))
      throw Error("FLEET_ACCEPTANCE_BAD_SOURCE");
    const db=new DatabaseSync(file,{readOnly:true});
    let cp;
    try{
      db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
      const row=db.prepare("SELECT payload FROM research_checkpoints WHERE id=? AND phase='completed' AND status='completed'").get(id);
      if(!row?.payload)throw Error("FLEET_ACCEPTANCE_COMPLETED_SOURCE_REQUIRED");
      cp=JSON.parse(row.payload);
    }finally{db.close();}
    emit("SABY_SAVED_FLEET_AUDIT",{checkpoint:id,...auditSavedFleetCoverage(cp)});
    if(has("plan")){
      const cohort=buildFleetCohort(cp,{limit,sourceId:id});
      privateWrite(arg("out"),cohort);
      const selected={};
      for(const row of cohort.selected)selected[row.stratum]=(selected[row.stratum]||0)+1;
      emit("SABY_FLEET_COHORT",{checkpoint:id,selected,available:cohort.available,
        total:cohort.selected.length,openai_requests:0,sqlite_writes:0});
    }
    return;
  }
  if(has("compare")){
    emit("SABY_FLEET_COMPARISON",compareFleetAcceptance(load(arg("baseline")),load(arg("candidate"))));
    return;
  }
  requireIdleVps();
  // The only code-root accepted here is an explicitly trusted LOCAL git
  // checkout. Never import paths or code from a cohort or remote result.
  const root=path.resolve(arg("code-root",fileURLToPath(new URL("..",import.meta.url))));
  if(fs.realpathSync(git(root,"rev-parse","--show-toplevel"))!==fs.realpathSync(root))
    throw Error("FLEET_ACCEPTANCE_CODE_NOT_CLEAN");
  const commit=git(root,"rev-parse","HEAD");
  git(root,"diff","--quiet","HEAD","--","src","package.json","package-lock.json");
  // No hidden untracked module overrides in the code under test.
  if(git(root,"ls-files","--others","--exclude-standard","--","src"))
    throw Error("FLEET_ACCEPTANCE_CODE_NOT_CLEAN");
  const bytes=fs.readFileSync(arg("cohort")),cohort=validateFleetCohort(JSON.parse(bytes.toString("utf8")));
  const output=arg("out");
  if(!output||fs.existsSync(path.resolve(output)))throw Error("FLEET_ACCEPTANCE_OUTPUT_REQUIRED");
  if(!fs.statSync(path.dirname(path.resolve(output))).isDirectory())throw Error("FLEET_ACCEPTANCE_OUTPUT_REQUIRED");
  const profile=path.resolve(process.env.SABY_PROFILE_DIR||"data/saby-profile");
  if(!fs.statSync(profile).isDirectory())throw Error("FLEET_ACCEPTANCE_PROFILE_REQUIRED");
  // The profile must be the existing authorized headed profile, not a
  // newly guessed identity. Freeze comparable settings for BOTH versions.
  const integerSetting=(name,def,min,max)=>{
    const value=Number(process.env[name]??def);
    if(!Number.isSafeInteger(value)||value<min||value>max)
      throw Error("FLEET_ACCEPTANCE_BAD_SETTING");
    return String(value);
  };
  const settings={
    SABY_STAGE12_ENABLED:"true",SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED:"true",
    SABY_FLEET_TREE_PRODUCTION_ENABLED:"true",SABY_HEADLESS:"false",
    SABY_MAX_COMPANIES:"0",SABY_FAST_PASS_ENABLED:"true",
    SABY_ALL_COMPANY_FLEETS_ENABLED:"false",SABY_ADAPTIVE_DELAY_ENABLED:"false",
    SABY_INN_RECOVERY_ENABLED:"false",GIRBO_STAGE_ENABLED:"false",
    SABY_SMOKE_ONLY:"false",SABY_FLEET_TAIL_CLICK_OPT_IN:"false",
    SABY_FLEET_SNAPSHOT_OPT_IN:"false",
    SABY_DELAY_MS:integerSetting("SABY_DELAY_MS",1500,250,30000),
    SABY_COMPANY_TIMEOUT_MS:integerSetting("SABY_COMPANY_TIMEOUT_MS",45000,15000,90000),
    SABY_BROWSER_RECYCLE_EVERY:integerSetting("SABY_BROWSER_RECYCLE_EVERY",25,1,200),
    SABY_GC_EVERY:integerSetting("SABY_GC_EVERY",10,1,100),
    SABY_CIRCUIT_AFTER:integerSetting("SABY_CIRCUIT_AFTER",3,1,10)
  };
  const policy={...settings,profile_sha256:sha(fs.realpathSync(profile)),
    browser_channel:process.env.SABY_BROWSER_CHANNEL||"",gc_exposed:typeof global.gc==="function",
    node_version:process.version,package_lock_sha256:sha(fs.readFileSync(path.join(root,"package-lock.json")))};
  const lock=path.join(profile,".regionalresearch-acceptance-lock");
  fs.mkdirSync(lock,{mode:0o700});
  try{
    requireIdleVps();
    const {runSabyContactFirst}=await import(pathToFileURL(path.join(root,"src/sabyContactFirst.js")).href);
    const result=cohortResult(cohort),start=performance.now();
    const outcome=await runSabyContactFirst({result,
      env:{...process.env,...settings,SABY_PROFILE_DIR:profile},
      // Do not write the production checkpoint store. This benchmark
      // measures browser+scheduler time, not the SQLite disk cost.
      persistCheckpoint:async()=>{},onProgress:async()=>{}});
    const report=summarizeFleetAcceptance({cohort,result,outcome,
      elapsedMs:Math.max(1,Math.round(performance.now()-start)),commit,cohortSha:sha(bytes),policy});
    privateWrite(output,report);
    emit("SABY_FLEET_ACCEPTANCE_DONE",{commit,cohort_sha256:report.cohort_sha256,
      elapsed_ms:report.elapsed_ms,full_sweep_completed:report.full_sweep_completed,...report.metrics,
      openai_requests:0,sqlite_writes:0});
    if(!report.full_sweep_completed)process.exitCode=2;
  }finally{fs.rmdirSync(lock);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{
  emit("SABY_FLEET_ACCEPTANCE_ERROR",{reason:/^FLEET_ACCEPTANCE_[A-Z_]+$/.test(e?.message||"")?
    e.message:"FLEET_ACCEPTANCE_UNAVAILABLE"});
  process.exitCode=2;
});
