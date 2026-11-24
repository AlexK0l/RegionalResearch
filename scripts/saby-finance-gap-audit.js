#!/usr/bin/env node
// Offline, read-only summary for ONE explicitly selected SQLite checkpoint.
// No OpenAI, no browser, no website, no checkpoint writes and no company PII.
import fs from "node:fs";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {auditSabyFinanceGaps} from "../src/sabyFinanceGapAudit.js";

const arg=name=>process.argv.slice(2)
  .find(value=>value.startsWith("--"+name+"="))?.slice(name.length+3)||"";
const id=arg("checkpoint");
const file=arg("db");
if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(id)||!file){
  console.error("Usage: node scripts/saby-finance-gap-audit.js "+
    "--db=/path/to/checkpoints.sqlite --checkpoint=<UUID>");
  process.exitCode=2;
}else{
  let db;
  try{
    const source=path.resolve(file);
    if(!fs.statSync(source).isFile())throw Error("CHECKPOINT_DB_NOT_FILE");
    db=new DatabaseSync(source,{readOnly:true});
    db.exec("PRAGMA query_only=ON");
    const row=db.prepare(
      "SELECT payload FROM research_checkpoints WHERE id=?"
    ).get(id);
    if(!row?.payload)throw Error("CHECKPOINT_NOT_FOUND");
    const cp=JSON.parse(row.payload);
    const report=auditSabyFinanceGaps(cp,{checkpointId:id});
    console.log("[SABY_FINANCE_GAP_AUDIT] "+
      JSON.stringify(report,null,2));
  }catch(error){
    // Do not echo a raw SQLite query, credential or payload.
    console.error("[SABY_FINANCE_GAP_AUDIT_ERROR] "+
      (new Set(["CHECKPOINT_DB_NOT_FILE","CHECKPOINT_NOT_FOUND",
        "SABY_FINANCE_GAP_CHECKPOINT_REQUIRED"]).has(error?.message)?
        error.message:"READ_ONLY_AUDIT_UNAVAILABLE"));
    process.exitCode=2;
  }finally{
    if(db)db.close();
  }
}
