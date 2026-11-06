#!/usr/bin/env node
// Overlay already-reviewed FULL CRM with qualification replay v8, OFFLINE.
// Does not rewrite source SQLite or old JSON/XLSX and performs no API calls.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import XLSX from "xlsx";
import { integrateReviewedReplay, integratedReviewedWorkbook } from "../src/offlineReviewIntegration.js";

const args=process.argv.slice(2);
const input=args.find(x=>!x.startsWith("--"));
const opt=k=>args.find(x=>x.startsWith("--"+k+"="))?.slice(k.length+3);
const qualification=opt("qualification"),out=opt("out"),sha=opt("qualifier-sha")||"";
if(!input||!qualification||!out){
 console.error("Usage: node scripts/integrate-reviewed-v8-offline.js <verified_aliases_FULL.json> --qualification=<qualification_replay_v8.json> --out=<NEW-dir> [--qualifier-sha=<git-sha>]");
 process.exit(2);
}
const inputPath=path.resolve(input), qualificationPath=path.resolve(qualification);
const first=fs.readFileSync(inputPath),second=fs.readFileSync(qualificationPath);
const hash=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
const integrated=integrateReviewedReplay(JSON.parse(first),JSON.parse(second),{qualificationSha:sha});
const dest=path.resolve(out);
fs.mkdirSync(dest,{recursive:true});
const prefix="integrated_reviewed_v8_"+integrated.report.checkpoint.slice(0,8);
const paths={
 json:path.join(dest,prefix+".json"),
 xlsx:path.join(dest,prefix+".xlsx"),
 audit:path.join(dest,prefix+"_audit.json")
};
if(Object.values(paths).some(fs.existsSync))
 throw Error("Output already exists; choose a new --out directory");
const audit={
 report:integrated.report,
 inputs:[{file:inputPath,sha256:hash(first)},{file:qualificationPath,sha256:hash(second)}],
 output_type:"detached_full_reviewed_json_plus_filtered_sales_workbook",
 method:"reviewed INNs/OGRN and aliases unchanged; v8 qualification overlaid by original canonical ID",
 source_sqlite_modified:false,web_search_calls:0,openai_calls:0
};
const buffers={
 [paths.json]:Buffer.from(JSON.stringify(integrated.data,null,2)),
 [paths.xlsx]:XLSX.write(integratedReviewedWorkbook(integrated.data,integrated.report),{type:"buffer",bookType:"xlsx"}),
 [paths.audit]:Buffer.from(JSON.stringify(audit,null,2))
};
const created=[];
try{
 for(const [name,bytes] of Object.entries(buffers)){
  fs.writeFileSync(name,bytes,{flag:"wx"});created.push(name);
 }
}catch(e){for(const name of created)try{fs.unlinkSync(name)}catch{}throw e;}
console.log(JSON.stringify({...integrated.report,outputs:paths},null,2));
