#!/usr/bin/env node
// Dry-run, offline missing-INN evidence recovery queue for a final SAT JSON.
// Does not modify source, checkpoint, browser profile, XLSX or database.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {buildMissingInnRecoveryQueue} from "../src/sabyMissingInnRecovery.js";

const option=(args,key)=>{
  const x=args.find(a=>a.startsWith("--"+key+"="));
  return x?x.slice(key.length+3):"";
};
async function main() {
  const args=process.argv.slice(2);
  if(args.includes("--help")){
    console.log("Offline INN candidate queue: --result=SAT_region.json " +
      "--out-prefix=exports/missing-inn-region OR "+
      "--db=/path/to/checkpoints.sqlite --checkpoint=<UUID> " +
      "--out-prefix=exports/missing-inn-checkpoint");
    return;
  }
  const filename=option(args,"result");
  const dbFile=option(args,"db"),checkpointId=option(args,"checkpoint");
  const prefix=option(args,"out-prefix");
  const checkpointMode=Boolean(dbFile||checkpointId);
  if(!prefix || (checkpointMode ?
    (!dbFile||!checkpointId||Boolean(filename)):
    !filename))
    throw Error("Необходимо задать --out-prefix и ровно один источник: "+
      "--result либо --db плюс --checkpoint");
  let input;
  if(checkpointMode){
    // Open the LIVE SQLite checkpoint using read-only mode (including WAL).
    // Existing checkpoint and finished reports must remain byte-identical.
    if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(checkpointId))
      throw Error("Неверный формат checkpoint UUID");
    const source=path.resolve(dbFile);
    const info=await fs.stat(source);
    if(!info.isFile())throw Error("Checkpoint SQLite is not a file");
    const db=new DatabaseSync(source,{readOnly:true});
    try{
      db.exec("PRAGMA query_only=ON");
      const row=db.prepare(
        "SELECT payload FROM research_checkpoints WHERE id=?"
      ).get(checkpointId);
      if(!row?.payload)throw Error("Checkpoint not found");
      input=Buffer.from(row.payload,"utf8");
    }finally{db.close();}
  }else{
    input=await fs.readFile(path.resolve(filename));
  }
  const raw=JSON.parse(input.toString("utf8"));
  if(checkpointMode&&!raw?.final_result)
    throw Error("Checkpoint missing completed result");
  const report=buildMissingInnRecoveryQueue(raw);
  if(checkpointMode)report.source_checkpoint=checkpointId;
  const base=path.resolve(prefix),jsonPath=base+".json";
  const xlsxPath=base+".xlsx",zipPath=base+".zip";
  await fs.mkdir(path.dirname(base),{recursive:true,mode:0o700});
  report.source_sha256=crypto.createHash("sha256").update(input).digest("hex");
  report.created_at=new Date().toISOString();
  await fs.writeFile(jsonPath,JSON.stringify(report,null,2)+"\n",
    {flag:"wx",mode:0o600});
  const python=process.env.SAT_PYTHON_BIN||"python3";
  const exporter=fileURLToPath(new URL("./saby-missing-inn-export.py",import.meta.url));
  const result=spawnSync(python,[exporter,jsonPath,xlsxPath,zipPath],{
    timeout:120000,windowsHide:true,encoding:"utf8",maxBuffer:1000000
  });
  const exported=!result.error&&result.status===0;
  if(!exported)
    console.warn("Saby missing-INN: JSON готов; XLSX/ZIP не созданы. "+
      "Проверьте openpyxl и SAT_PYTHON_BIN.");
  console.log(JSON.stringify({
    ...(checkpointMode?{source_checkpoint:checkpointId}:{}),
    ...report.summary,
    files:{json:jsonPath,xlsx:exported?xlsxPath:null,
      zip:exported?zipPath:null},
    source_unchanged:true,sqlite_writes:0
  },null,2));
}
main().catch(error=>{
  const message=String(error?.message||"");
  console.error(message.startsWith("Необходимо") ? message :
    "Не удалось создать офлайн-очередь ИНН: проверьте путь и доступ к файлам.");
  process.exitCode=1;
});
