#!/usr/bin/env node
// Export a failed-after-Stage13 full job from SQLite without running paid
// research, changing the database, or marking any live checkpoint completed.
import fs from "node:fs/promises";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {recoverPriorityCheckpointOffline} from "../src/priorityCheckpointRecovery.js";
import {buildReferenceWorkbookBuffer} from "../src/referenceWorkbookExport.js";

const args=process.argv.slice(2);
const option=name=>args.find(a=>a.startsWith("--"+name+"="))?.slice(name.length+3)||"";
const preview=args.includes("--preview");
const allowed=new Set(["--db=","--job-id=","--out-prefix=","--preview"]);
if(args.some(a=>![...allowed].some(v=>a===v||v!=="--preview"&&a.startsWith(v))))
  throw Error("Unknown argument. Use --db, --job-id, --out-prefix and optional --preview");

const dbPath=path.resolve(option("db")||process.env.CHECKPOINT_DB_PATH||"data/checkpoints.sqlite");
const jobId=option("job-id");
const prefix=option("out-prefix");
if(!jobId||(!preview&&!prefix))
  throw Error("Usage: npm run recover:priority:offline -- "+
    "--db=/path/checkpoints.sqlite --job-id=ID --out-prefix=/path/NEW-prefix [--preview]");

async function main(){
  let db;
  try{
    db=new DatabaseSync(dbPath,{readOnly:true});
    db.exec("PRAGMA query_only=ON");
    const row=db.prepare(
      "SELECT id,region,mode,status,phase,pipeline_version,payload "+
      "FROM research_checkpoints WHERE id=?"
    ).get(jobId);
    if(!row)throw Error("No checkpoint for the specified job ID");
    if(row.mode!=="full"||row.status!=="resumable"||row.phase!=="priority")
      throw Error("Checkpoint must be resumable, full and in priority phase");
    const payload=JSON.parse(row.payload);
    if(payload.region!==row.region||payload.phase!==row.phase||
       Number(payload.pipeline_version)!==Number(row.pipeline_version))
      throw Error("Checkpoint metadata mismatch; do not recover");
    const {recovered,audit,summary}=recoverPriorityCheckpointOffline(payload,{jobId});
    if(preview){
      console.log(JSON.stringify({mode:"read_only_preflight",...summary,
        input_checkpoint_status:"resumable",
        original_checkpoint_unchanged:true},null,2));
      return;
    }
    const base=path.resolve(prefix),files={
      json:base+".json",xlsx:base+".xlsx",audit:base+"_audit.json"
    };
    if(Object.values(files).some(f=>f===dbPath))throw Error("Output overlaps input");
    // Check all three output names before any Excel generation or writes.
    for(const file of Object.values(files)){
      try{await fs.access(file);throw Error("Output already exists: "+file)}
      catch(error){if(error.code!=="ENOENT")throw error}
    }
    const excel=await buildReferenceWorkbookBuffer(recovered.final_result);
    const bytes={
      json:Buffer.from(JSON.stringify(recovered,null,2)+"\n"),
      xlsx:excel,
      audit:Buffer.from(JSON.stringify(audit,null,2)+"\n")
    };
    await fs.mkdir(path.dirname(base),{recursive:true,mode:0o700});
    const written=[];
    try{
      for(const kind of ["json","xlsx","audit"]){
        await fs.writeFile(files[kind],bytes[kind],{flag:"wx",mode:0o600});
        written.push(files[kind]);
      }
    }catch(error){
      for(const file of written)await fs.unlink(file).catch(()=>{});
      throw error;
    }
    console.log(JSON.stringify({mode:"offline_priority_checkpoint_recovery",
      ...summary,original_checkpoint_unchanged:true,files},null,2));
  }finally{if(db)db.close();}
}
main().catch(error=>{console.error("Offline priority recovery: "+
  String(error?.stack||error));process.exitCode=1});
