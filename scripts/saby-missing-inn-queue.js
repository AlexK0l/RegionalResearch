#!/usr/bin/env node
// Dry-run, offline missing-INN evidence recovery queue for a final SAT JSON.
// Does not modify source, checkpoint, browser profile, XLSX or database.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {buildMissingInnRecoveryQueue} from "../src/sabyMissingInnRecovery.js";

const option=(args,key)=>{
  const x=args.find(a=>a.startsWith("--"+key+"="));
  return x?x.slice(key.length+3):"";
};
async function main() {
  const args=process.argv.slice(2);
  if(args.includes("--help")){
    console.log("Offline INN candidate queue: --result=SAT_region.json " +
      "--out-prefix=exports/missing-inn-region");
    return;
  }
  const filename=option(args,"result"),prefix=option(args,"out-prefix");
  if(!filename||!prefix)throw Error("Необходимо задать --result и --out-prefix");
  const input=await fs.readFile(path.resolve(filename));
  const report=buildMissingInnRecoveryQueue(JSON.parse(input.toString("utf8")));
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
