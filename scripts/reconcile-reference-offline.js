#!/usr/bin/env node
// Deterministic local reconciliation: current final JSON + frozen reference JSON.
// No OpenAI client is constructed. Inputs are read-only, output paths must be new.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as XLSX from "xlsx";
import { reconcileReference } from "../src/referenceReconciliation.js";
import { finalizeProductionResearch } from "../src/productionFinalQuality.js";
import { deterministicQualificationDecision, actionableUnqualifiedLead } from "../src/pipeline.js";
import { buildWorkbookBuffer } from "../src/xlsx.js";
const args=process.argv.slice(2);
const arg=k=>args.find(x=>x.startsWith("--"+k+"="))?.slice(k.length+3);
const input=args.find(x=>!x.startsWith("--")),baseline=arg("reference"),out=arg("out");
if(!input||!baseline||!out){
 console.error("Usage: node scripts/reconcile-reference-offline.js <current.json> --reference=<frozen.json> --out=<NEW-dir> [--as-of=YYYY-MM-DD]");
 process.exit(2);
}
const source=fs.readFileSync(path.resolve(input));
const frozen=fs.readFileSync(path.resolve(baseline));
const current=JSON.parse(source),old=JSON.parse(frozen);
if(!current.final_result||!old.final_result)throw Error("Both JSON files must contain final_result");
const {result:qualified,report:quality}=finalizeProductionResearch(current.final_result,{
 qualify:deterministicQualificationDecision,isActionable:actionableUnqualifiedLead
});
const {result,report}=reconcileReference(qualified,old.final_result,{referenceAsOf:arg("as-of")||""});
const output=path.resolve(out);
fs.mkdirSync(output,{recursive:true});
const outputs={
 crm:path.join(output,"SAT_Смоленская_область_сверенная_офлайн.json"),
 xlsx:path.join(output,"SAT_Смоленская_область_сверенная_офлайн.xlsx"),
 audit:path.join(output,"SAT_Смоленская_область_аудит_сверки.json"),
 review:path.join(output,"SAT_Смоленская_область_очередь_сверки.xlsx")
};
if(Object.values(outputs).some(fs.existsSync))throw Error("Output exists; use a new directory");
const reviewWb=XLSX.utils.book_new();
const add=(name,header,items,map)=>{
 const ws=XLSX.utils.aoa_to_sheet([header,...items.map(map)]);
 ws["!cols"]=header.map((_,i)=>({wch:i===0?42:i===header.length-1?75:31}));
 XLSX.utils.book_append_sheet(reviewWb,ws,name);
};
add("Пропуски эталона",["ИНН","Организация v8","Лист v8","ID v8","Причина","Найденные имена","Источники"],
 report.reference_review,r=>[r.inn,r.old_name,r.old_sheet,r.old_canonical_id,r.reason,r.new_names.join("; "),r.old_source_urls.join("\n")]);
add("Без подтверждения поля",["ИНН","Организация","Поле","Старое значение","Причина"],report.historical_field_review,
 r=>[r.inn,r.organization,r.field,r.old_value,r.reason]);
add("Перенесено с источником",["ИНН","Организация","Поле","Значение","Источник"],report.historical_field_carry,
 r=>[r.inn,r.organization,r.field,r.value,r.source_url]);
add("Конфликты идентичности",["Организация","Новый ИНН","Старый ИНН","ID v8","ID нового"],report.identity_conflicts,
 r=>[r.name,r.new_inn,r.old_inn,r.old_canonical_id,r.new_canonical_id]);
add("A без привязки",["ID","Организация","Правило A","Статус","Выбранное доказательство"],
 quality.a_claim_attribution_review,r=>[r.canonical_id,r.organization,r.a_rule,r.status,r.selected_a_evidence]);
add("Конфликты истории ID",["ID источника","Другой survivor","Survivor"],
 quality.source_id_cross_survivor_conflicts,r=>[r.source_id,r.other_survivor,r.survivor]);
const hash=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
const doc={...current,final_result:result,final_quality_gate:quality,
 reference_reconciliation:{...report,reference_sha256:hash(frozen),current_sha256:hash(source)}};
const audit={region:current.region,source_json_sha256:hash(source),
 reference_json_sha256:hash(frozen),source_modified:false,paid_api_calls:0,
 final_quality_gate:quality,reference_reconciliation:report};
const files=[
 [outputs.crm,Buffer.from(JSON.stringify(doc,null,2))],
 [outputs.xlsx,buildWorkbookBuffer(result)],
 [outputs.audit,Buffer.from(JSON.stringify(audit,null,2))],
 [outputs.review,XLSX.write(reviewWb,{type:"buffer",bookType:"xlsx"})]
];
const done=[];
try{for(const [name,bytes] of files){fs.writeFileSync(name,bytes,{flag:"wx"});done.push(name);}}
catch(err){for(const name of done)try{fs.unlinkSync(name);}catch{}throw err;}
console.log(JSON.stringify({
 commercial:report.commercial_after,review:report.current_review_after,
 excluded:report.current_excluded_after,grades:quality.grades,
 carried:report.historical_fields_carried,missing_reference:report.reference_only_or_unresolved_records,
 blocked_invalid_inn:quality.flags.filter(f=>f.reasons.includes("llc_with_individual_inn")).length,
 source_unlinked_a:quality.a_claim_source_missing,paid_api_calls:0,outputs
},null,2));
