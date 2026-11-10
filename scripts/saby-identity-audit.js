#!/usr/bin/env node
// Full-region Saby identity evidence audit. No OpenAI, SQLite or CRM changes.
// Records each original row (not just Stage12-eligible rows), including
// missing/duplicate INNs and unsuccessful Saby lookups. Durable resume journal.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {withSabyBrowser} from "../src/sabyBrowser.js";
import {sabyInn,sabyNameTokens} from "../src/sabyEnrichment.js";
import {auditCompareIdentity} from "../src/sabyIdentityAudit.js";
import {auditSabyCompany} from "../src/sabyIdentityAuditBrowser.js";

const own=(obj,key)=>Object.prototype.hasOwnProperty.call(obj,key);
const option=(args,name,fallback="")=>{
  const arg=args.find(x=>x.startsWith("--"+name+"="));
  return arg===undefined?fallback:arg.slice(name.length+3);
};
const exists=async file=>fs.access(file).then(()=>true,()=>false);
const asInt=(value,name,min,max)=>{
  if(!/^(?:0|[1-9]\d*)$/.test(String(value)))throw Error(
    name+" должен быть целым числом от "+min+" до "+max);
  const n=Number(value);
  if(!Number.isSafeInteger(n)||n<min||n>max)throw Error(
    name+" должен быть целым числом от "+min+" до "+max);
  return n;
};
const fileNames=prefix=>({
  meta:prefix+".meta.json",
  records:prefix+".records.jsonl",
  progress:prefix+".progress.json",
  comparison:prefix+".comparison.json",
  summary:prefix+".summary.json",
  workbook:prefix+".xlsx",
  bundle:prefix+".zip"
});
async function atomicJson(file,data) {
  const temp=file+"."+process.pid+".tmp";
  await fs.writeFile(temp,JSON.stringify(data,null,2)+"\n",
    {flag:"wx",mode:0o600});
  await fs.rename(temp,file);
}
export function sourceRows(raw) {
  const base=raw?.final_result||raw?.result||raw;
  if(!base||!Array.isArray(base.direct_buyers)||
     !Array.isArray(base.intermediaries)||!Array.isArray(base.leasing))
    throw Error("JSON должен содержать массивы direct_buyers, intermediaries, leasing");
  const list=[];
  for(const group of ["direct_buyers","intermediaries","leasing"]) {
    base[group].forEach((row,i)=>{
      list.push({index:list.length+1,group,group_row:i+1,row});
    });
  }
  return list;
}
async function journalRows(journal,meta,{repair=false}={}) {
  let data=await fs.readFile(journal);
  if(data.length && data[data.length-1]!==10) {
    if(!repair)throw Error("Журнал содержит оборванную строку: используйте --resume");
    const ending=data.lastIndexOf(10);
    const repaired=ending>=0?data.subarray(0,ending+1):Buffer.alloc(0);
    await fs.truncate(journal,repaired.length);
    console.warn("Saby audit: последняя оборванная запись отброшена");
    data=repaired;
  }
  const seen=new Map();
  for(const line of data.toString("utf8").split("\n").filter(Boolean)) {
    const item=JSON.parse(line);
    if(!Number.isSafeInteger(item.index)||item.index<1||
       item.index>meta.total||seen.has(item.index))
      throw Error("Журнал содержит повторный/недопустимый index");
    seen.set(item.index,item);
  }
  return seen;
}
function rollup(entries,seen) {
  const counts={},reasons={},relations={};
  for(const entry of seen.values()) {
    const code=entry.result||"unknown",reason=entry.reason||"";
    counts[code]=(counts[code]||0)+1;
    reasons[reason]=(reasons[reason]||0)+1;
    for(const field of ["search_name_relation","title_relation",
      "requisites_relation","detail_inn_relation","requisites_inn_relation"]){
      const key=entry[field]||"not_available";
      if(!relations[field])relations[field]={};
      relations[field][key]=(relations[field][key]||0)+1;
    }
  }
  const candidatePairs=[...seen.values()]
    .filter(r=>r.source_name&&r.saby_title_name&&
      r.title_relation!=="normalized_equal")
    .map(r=>({
      index:r.index,source_inn:r.source_inn,source_name:r.source_name,
      short_title:r.saby_title_name,
      official_requisites:r.saby_requisites_name,
      requisites_inn:r.saby_requisites_inn,
      title_relation:r.title_relation,
      status:r.result,reason:r.reason
    }));
  return {
    total:entries.length,recorded:seen.size,remaining:entries.length-seen.size,
    completed:seen.size===entries.length,
    results:counts,reasons,relations,
    short_name_candidates:candidatePairs.length,
    // Pairs are observations, not approved automatic alias mappings.
    title_name_candidates:candidatePairs
  };
}
async function exportResults(files,meta,entries,seen,{python,includeWorkbook=true}={}) {
  const stats=rollup(entries,seen);
  const records=[...seen.values()].sort((a,b)=>a.index-b.index);
  const summary={
    audit_kind:"saby_regional_identity_only",
    generated_at:new Date().toISOString(),
    source_sha256:meta.source_sha256,
    group_counts:meta.group_counts,
    ...stats,
    title_name_candidates:undefined,
    // Normalization rules will be derived only after review of source
    // evidence; do not train/approve short aliases from unverified titles.
    warning:"Короткое имя или совпадение ИНН в поиске не подтверждает юрлицо. " +
      "Пустые реквизиты означают отсутствие доступных данных, а не несовпадение."
  };
  await atomicJson(files.summary,summary);
  await atomicJson(files.comparison,{
    metadata:meta,summary,records,
    unapproved_title_name_candidates:stats.title_name_candidates
  });
  let workbook="";
  let bundle="";
  if(includeWorkbook){
    const script=fileURLToPath(new URL("./saby-identity-audit-export.py",import.meta.url));
    const args=[script,files.comparison,files.summary,files.records,
      files.meta,files.workbook,files.bundle];
    const run=spawnSync(python||"python3",args,{
      timeout:120000,encoding:"utf8",maxBuffer:1000000,
      windowsHide:true
    });
    if(run.error || run.status!==0){
      console.warn("Saby audit: xlsx/zip не сформированы; JSON сохранён. "+
        "Проверьте SAT_PYTHON_BIN и openpyxl. Код="+String(run.status??"unknown"));
    } else {
      workbook=files.workbook;
      bundle=files.bundle;
    }
  }
  return {stats,workbook,bundle};
}
async function main() {
  const args=process.argv.slice(2);
  if(args.includes("--help")||args.includes("-h")){
    console.log("Full regional Saby identity audit (NO OpenAI, no CRM/SQLite writes)");
    console.log("  npm run saby:identity-audit -- --result=/path/SAT_region.json --headless --resume --out-prefix=/path/exports/saby-identity-region");
    console.log("  Optional: --profile=PATH --delay-ms=2000 --batch-size=25 --limit=5 --export-only");
    return;
  }
  const input=path.resolve(option(args,"result"));
  if(!option(args,"result"))throw Error("Укажите --result=/path/SAT_Region.json");
  const source=await fs.readFile(input);
  const parsed=JSON.parse(source.toString("utf8"));
  const entries=sourceRows(parsed);
  const sourceHash=crypto.createHash("sha256").update(source).digest("hex");
  const prefix=path.resolve(option(args,"out-prefix",path.join("exports",
    "saby-identity-audit-"+new Date().toISOString().slice(0,10))));
  const files=fileNames(prefix);
  const batchSize=asInt(option(args,"batch-size","25"),"--batch-size",1,100);
  const limit=asInt(option(args,"limit","20000"),"--limit",1,20000);
  const delayMs=asInt(option(args,"delay-ms","2000"),"--delay-ms",750,30000);
  const python=process.env.SAT_PYTHON_BIN||"python3";
  await fs.mkdir(path.dirname(prefix),{recursive:true,mode:0o700});
  const counts={direct_buyers:0,intermediaries:0,leasing:0};
  for(const item of entries)counts[item.group]++;
  const expectedMeta={
    schema_version:1,source_path:input,source_sha256:sourceHash,
    total:entries.length,group_counts:counts
  };
  let meta;
  if(await exists(files.meta)){
    if(!args.includes("--resume")&&!args.includes("--export-only"))
      throw Error("Аудит с этим --out-prefix уже существует; используйте --resume");
    meta=JSON.parse(await fs.readFile(files.meta,"utf8"));
    if(meta.source_sha256!==expectedMeta.source_sha256 ||
       meta.total!==expectedMeta.total ||
       JSON.stringify(meta.group_counts)!==JSON.stringify(expectedMeta.group_counts))
      throw Error("Исходный JSON изменился: нельзя продолжить старый журнал");
  } else {
    if(args.includes("--export-only"))throw Error("Журнал отсутствует");
    meta={...expectedMeta,created_at:new Date().toISOString()};
    await atomicJson(files.meta,meta);
    await fs.writeFile(files.records,"",{flag:"wx",mode:0o600});
  }
  const seen=await journalRows(files.records,meta,{repair:args.includes("--resume")});
  if(args.includes("--export-only")){
    const out=await exportResults(files,meta,entries,seen,{python});
    console.log(JSON.stringify({status:"exported",...out.stats,
      xlsx:out.workbook,zip:out.bundle},null,2));
    return;
  }
  const env={...process.env};
  if(args.includes("--headless"))env.SABY_HEADLESS="true";
  if(option(args,"profile"))env.SABY_PROFILE_DIR=path.resolve(option(args,"profile"));
  let interrupted=false;
  const stop=()=>{interrupted=true;};
  process.on("SIGINT",stop);
  process.on("SIGTERM",stop);
  let stopReason="";
  const pending=entries.filter(entry=>!seen.has(entry.index)).slice(0,limit);
  const persist=async(entry,observed)=>{
    const comparison=auditCompareIdentity(entry.row,observed);
    const record={
      index:entry.index,group:entry.group,group_row:entry.group_row,
      audited_at:new Date().toISOString(),...comparison
    };
    await fs.appendFile(files.records,JSON.stringify(record)+"\n",
      {encoding:"utf8",mode:0o600});
    seen.set(entry.index,record);
    const stats=rollup(entries,seen);
    await atomicJson(files.progress,{
      generated_at:new Date().toISOString(),
      total:stats.total,recorded:stats.recorded,remaining:stats.remaining,
      results:stats.results,last_index:entry.index,stopped:interrupted
    });
    console.log("Saby identity "+stats.recorded+"/"+stats.total+
      " | #"+entry.index+" "+record.result+" ("+record.reason+")");
  };
  let consecutiveHard=0;
  try {
    for(let start=0;start<pending.length&&!interrupted;start+=batchSize){
      const block=pending.slice(start,start+batchSize);
      // Browser context is restarted every batch to bound Playwright SPA
      // memory; the authorised profile persists across batches.
      await withSabyBrowser(async ({page})=>{
        for(const entry of block){
          if(interrupted)break;
          let observed={};
          if(!sabyInn(entry.row?.["ИНН"])||
             !sabyNameTokens(entry.row?.["Организация"]).length) {
            observed={failure:""};
          } else {
            observed=await auditSabyCompany(page,entry.row);
          }
          await persist(entry,observed);
          const isHard=["company_search_field_missing",
            "profile_search_unavailable","browser_page_error"].includes(observed.failure);
          consecutiveHard=isHard?consecutiveHard+1:0;
          if(consecutiveHard>=3) {
            stopReason="three_consecutive_browser_failures";
            interrupted=true;
            console.warn("[SABY_AUDIT_CIRCUIT] "+stopReason);
            break;
          }
          if(!interrupted)await new Promise(resolve=>setTimeout(resolve,delayMs));
        }
      },{env});
    }
  } catch {
    stopReason="browser_session_unavailable";
    interrupted=true;
    console.warn("[SABY_AUDIT_STOP] browser_session_unavailable");
  } finally {
    process.removeListener("SIGINT",stop);
    process.removeListener("SIGTERM",stop);
  }
  const out=await exportResults(files,meta,entries,seen,{python});
  console.log(JSON.stringify({
    status:out.stats.completed?"complete":interrupted?"interrupted":"partial",
    ...out.stats,title_name_candidates:undefined,
    stopped_reason:stopReason||null,
    files:{json:files.comparison,journal:files.records,summary:files.summary,
      progress:files.progress,xlsx:out.workbook||null,zip:out.bundle||null},
    source_file_unchanged:true,
    sqlite_writes:0,openai_requests:0,google_sheets_writes:0
  },null,2));
  if(interrupted||(!out.stats.completed&&pending.length>0))process.exitCode=2;
}
main().catch(error=>{
  console.error("Saby identity audit:",String(error?.message||error).slice(0,300));
  process.exitCode=1;
});
