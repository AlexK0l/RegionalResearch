#!/usr/bin/env node
// Read-only post-Saby audit: no network, OpenAI, browser or checkpoint writes.
// Example: node scripts/post-saby-remediation.js
//   --result=SAT_region.json --out-prefix=exports/saby-followup-region
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {buildPostSabyRemediation} from "../src/postSabyRemediation.js";

const option=(args,name)=>{
  const value=args.find(arg=>arg.startsWith("--"+name+"="));
  return value?value.slice(name.length+3):"";
};
async function main(){
  const args=process.argv.slice(2);
  if(args.includes("--help")){
    console.log("Read-only post-Saby remediation: --result=SAT_region.json "+
      "--out-prefix=exports/saby-followup-region");
    return;
  }
  const input=option(args,"result"),prefix=option(args,"out-prefix");
  if(!input||!prefix)throw Error("Both --result and --out-prefix are required");
  const bytes=await fs.readFile(path.resolve(input));
  const report=buildPostSabyRemediation(JSON.parse(bytes.toString("utf8")));
  report.source_sha256=crypto.createHash("sha256").update(bytes).digest("hex");
  report.created_at=new Date().toISOString();
  const base=path.resolve(prefix);
  await fs.mkdir(path.dirname(base),{recursive:true,mode:0o700});
  const jsonPath=base+".json",xlsxPath=base+".xlsx";
  // Exclusive output: never replace an older review or production artifact.
  await fs.writeFile(jsonPath,JSON.stringify(report,null,2)+"\n",
    {flag:"wx",mode:0o600});
  const python=String(process.env.SAT_PYTHON_BIN||"python3");
  const script=fileURLToPath(new URL("./post-saby-remediation-export.py",import.meta.url));
  const child=spawnSync(python,[script,jsonPath,xlsxPath],{
    timeout:120000,windowsHide:true,encoding:"utf8",maxBuffer:1000000
  });
  const ok=!child.error&&child.status===0;
  if(!ok)console.warn("Audit JSON saved, but XLSX export failed. "+
    "Check Python openpyxl and SAT_PYTHON_BIN.");
  console.log(JSON.stringify({
    ...report.summary,
    files:{json:jsonPath,xlsx:ok?xlsxPath:null},
    original_unchanged:true,sqlite_writes:0
  },null,2));
}
main().catch(error=>{
  console.error("Unable to build post-Saby audit: "+
    String(error?.message||error).slice(0,350));
  process.exitCode=1;
});
