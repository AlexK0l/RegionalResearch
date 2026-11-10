#!/usr/bin/env node
// Bounded Saby legal-name diagnostic on selected source indices, not a
// 473-row sweep. No OpenAI/SQLite/CRM changes. No raw HTML or login data.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {withSabyBrowser} from "../src/sabyBrowser.js";
import {auditSourceRows,auditCompareIdentity} from "../src/sabyIdentityAudit.js";
import {auditSabyCompany} from "../src/sabyIdentityAuditBrowser.js";
import {probeSabyLegalNameFields} from "../src/sabyLegalNameProbe.js";
import {sabyInn} from "../src/sabyEnrichment.js";

const get=(args,key)=>{
  const v=args.find(x=>x.startsWith("--"+key+"="));
  return v?v.slice(key.length+3):"";
};
function parseIndexes(arg,total) {
  if(!arg||!/^(\d+)(,\d+)*$/.test(arg))
    throw Error("Укажите --indexes=8,95,... (1-12 номеров исходных строк)");
  const all=[...new Set(arg.split(",").map(Number))];
  if(all.length>12 || all.some(x=>!Number.isSafeInteger(x)||x<1||x>total))
    throw Error("Разрешено от 1 до 12 существующих номеров строк");
  return all;
}
async function main() {
  const args=process.argv.slice(2);
  if(args.includes("--help")){
    console.log("Saby identity probe: --result=PATH --indexes=8,95,181 " +
      "--profile=PATH --headless --out=PATH");
    return;
  }
  const input=get(args,"result"),output=get(args,"out");
  if(!input||!output)throw Error("Требуются --result и --out");
  const source=await fs.readFile(path.resolve(input));
  const items=auditSourceRows(JSON.parse(source.toString("utf8")));
  const indexes=parseIndexes(get(args,"indexes"),items.length);
  const env={...process.env};
  if(args.includes("--headless"))env.SABY_HEADLESS="true";
  if(get(args,"profile"))env.SABY_PROFILE_DIR=path.resolve(get(args,"profile"));
  const recorded=[];
  // Open only one Playwright persistent context; never simultaneously run
  // this against the same profile from another job.
  await withSabyBrowser(async ({page})=>{
    for(const index of indexes) {
      const sourceRow=items[index-1];
      const row=sourceRow.row;
      let observed={},probe={reason:"not_observed",candidates:[],labels:[],sections:[]};
      if(sabyInn(row?.["ИНН"])) {
        observed=await auditSabyCompany(page,row);
        probe=await probeSabyLegalNameFields(page,row["ИНН"]);
      }
      const compared=auditCompareIdentity(row,observed);
      const entry={
        index,group:sourceRow.group,group_row:sourceRow.group_row,
        source_inn:compared.source_inn,source_name:compared.source_name,
        search_name:compared.saby_search_name,
        title:compared.saby_title_name,
        requisites:compared.saby_requisites_candidates,
        detail_inns:compared.saby_detail_inns,
        selection:compared.saby_search_selection,
        status:compared.result,reason:compared.reason,probe
      };
      recorded.push(entry);
      console.log("[SABY_ID_PROBE] "+index+"/"+items.length+
        " "+entry.status+" / "+probe.reason+
        " candidate_fields="+probe.candidates.length);
      if(indexes.indexOf(index)!==indexes.length-1)
        await new Promise(resolve=>setTimeout(resolve,1500));
    }
  },{env});
  const target=path.resolve(output);
  await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
  const report={
    schema_version:1,kind:"saby_company_legal_name_structural_probe",
    generated_at:new Date().toISOString(),
    source_sha256:crypto.createHash("sha256").update(source).digest("hex"),
    source_row_count:items.length,
    sampled_indexes:indexes,
    important:"Это только наблюдения UI. Полное имя не считается подтверждённым "+
      "без однозначной привязки названия и ИНН к одному юридическому лицу.",
    records:recorded
  };
  await fs.writeFile(target,JSON.stringify(report,null,2)+"\n",
    {flag:"wx",mode:0o600});
  console.log(JSON.stringify({checked:recorded.length,
    candidate_fields:recorded.reduce((n,r)=>n+r.probe.candidates.length,0),
    output:target,source_unchanged:true,sqlite_writes:0,openai_requests:0},
    null,2));
}
main().catch(error=>{
  // Never echo browser/third-party URLs or DOM text.
  const safe=String(error?.message||"").startsWith("Укажите") ||
    String(error?.message||"").startsWith("Разрешено") ||
    String(error?.message||"").startsWith("Требуются") ?
    error.message : "Saby identity probe interrupted: check profile lock/authentication";
  console.error(safe);
  process.exitCode=1;
});
