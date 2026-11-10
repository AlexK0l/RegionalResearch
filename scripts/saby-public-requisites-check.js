#!/usr/bin/env node
// Second-pass PUBLIC Saby confirmation only for companies whose INN and KPP
// were observed in the FIRST completed audit. NOT another 473-company sweep.
// No OpenAI, no SQLite or research JSON/XLSX edits.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {withSabyBrowser} from "../src/sabyBrowser.js";
import {auditSourceRows} from "../src/sabyIdentityAudit.js";
import {verifyPublicSabyIdentity} from "../src/sabyPublicRegisteredIdentity.js";
import {sabyInn} from "../src/sabyEnrichment.js";

const get=(args,key)=>{
  const opt=args.find(a=>a.startsWith("--"+key+"="));
  return opt?opt.slice(key.length+3):"";
};
const sha256=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
function selectAuditEntries(audit,original){
  const entries=audit?.records;
  if(!Array.isArray(entries)||entries.length!==original.length)
    throw Error("Неполный аудит: отсутствуют 473 записи");
  const result=[];
  for(const row of entries){
    const index=Number(row.index);
    if(!Number.isSafeInteger(index)||index<1||index>original.length)
      throw Error("Недопустимый индекс аудита");
    const source=original[index-1].row;
    const inn=sabyInn(source["ИНН"]);
    if(!inn||row.source_inn!==inn||
       row.source_name!==String(source["Организация"]||"").trim())
      continue;
    const kpp=String(row.saby_requisites_kpp||"");
    if(!/^\d{9}$/.test(kpp) ||
       row.saby_requisites_inn!==inn||row.saby_detail_inn!==inn)
      continue;
    result.push({index,inn,kpp,source_name:source["Организация"],
      observed_title:row.saby_title_name||""});
  }
  return result;
}
async function main(){
  const args=process.argv.slice(2);
  if(args.includes("--help")){
    console.log("Saby public legal name check: --result=SAT.json "+
      "--audit=existing.comparison.json --out=separate-output.json "+
      "[--indexes=8,95,181,...] [--profile=PATH] --headless");
    return;
  }
  const resultPath=get(args,"result"),auditPath=get(args,"audit"),
    output=get(args,"out");
  if(!resultPath||!auditPath||!output)
    throw Error("Укажите --result, --audit и --out");
  const bytes=await fs.readFile(path.resolve(resultPath));
  const original=auditSourceRows(JSON.parse(bytes.toString("utf8")));
  const audit=JSON.parse(await fs.readFile(path.resolve(auditPath),"utf8"));
  const sourceHash=sha256(bytes);
  if(audit?.metadata?.source_sha256!==sourceHash)
    throw Error("Исходный JSON не соответствует SHA256 полного аудита");
  let targets=selectAuditEntries(audit,original);
  const wanted=get(args,"indexes");
  if(wanted){
    if(!/^(\d+)(,\d+)*$/.test(wanted))
      throw Error("Укажите существующие --indexes=8,95,...");
    const set=new Set(wanted.split(",").map(Number));
    if(set.size>12)throw Error("Не более 12 контрольных карточек");
    targets=targets.filter(x=>set.has(x.index));
    if(targets.length!==set.size)
      throw Error("В аудите нет точного ИНН и КПП для части выбранных индексов");
  }
  if(targets.length>20)throw Error("Слишком много контрольных карточек");
  const env={...process.env};
  if(args.includes("--headless"))env.SABY_HEADLESS="true";
  if(get(args,"profile"))
    env.SABY_PROFILE_DIR=path.resolve(get(args,"profile"));
  const rows=[];
  // Opening public pages reuses a browser instance, not the Saby account
  // company-list search, and does not perform another Saby login.
  if(targets.length)await withSabyBrowser(async({page})=>{
    for(const target of targets){
      const verified=await verifyPublicSabyIdentity(page,target.inn,
        target.kpp,target.source_name);
      rows.push({...target,...verified});
      console.log("[SABY_PUBLIC_REQUISITES] #"+target.index+
        " status="+verified.status+" reason="+verified.reason);
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  },{env,autoLogin:false});
  const counts={},reasons={};
  for(const row of rows){
    counts[row.status]=(counts[row.status]||0)+1;
    reasons[row.reason]=(reasons[row.reason]||0)+1;
  }
  const report={
    kind:"saby_public_registered_name_verification",
    source_sha256:sourceHash,
    checked:rows.length,
    candidates_in_existing_audit:selectAuditEntries(audit,original).length,
    statuses:counts,reasons,
    warning:"Подтверждение основано на реквизитах Saby; это не "+
      "официальная выписка ФНС. Результаты не переносятся в Stage 12.",
    rows
  };
  const target=path.resolve(output);
  await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
  await fs.writeFile(target,JSON.stringify(report,null,2)+"\n",
    {flag:"wx",mode:0o600});
  console.log(JSON.stringify({
    checked:rows.length,statuses:counts,reasons,output:target,
    source_unchanged:true,sqlite_writes:0,openai_requests:0
  },null,2));
}
main().catch(error=>{
  const s=String(error?.message||"");
  console.error(
    /^(?:Укажите|В аудите|Неполный аудит|Недопустимый индекс|Исходный JSON|Не более|Слишком много)/.test(s) ?
      s : "Публичная проверка Saby не завершена: проверьте доступность браузера"
  );
  process.exitCode=1;
});
