#!/usr/bin/env node
// Offline, read-only Excel audit of role mismatches, INN discrepancies
// and possible duplicates in a completed qualification replay JSON.
import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";
import { auditReplayEvidence } from "../src/evidenceAudit.js";

const args = process.argv.slice(2);
const input = args.find((arg) => !arg.startsWith("--"));
const outDir = args.find((arg) => arg.startsWith("--out="))?.slice(6) ||
  "exports/offline-role-identity";
if (!input || !outDir) {
  console.error("Usage: node scripts/audit-role-identity-offline.js <replay.json> --out=exports/role-identity");
  process.exit(2);
}
const file = path.resolve(input);
if (!fs.existsSync(file)) throw new Error("Replay JSON not found: " + file);
const data = JSON.parse(fs.readFileSync(file, "utf8"));
if (!Array.isArray(data?.rows)) throw new Error("Replay JSON must contain rows[]");
const audit = auditReplayEvidence(data);
const roles = audit.records.flatMap((r) => r.role_and_legal_review_flags
  .filter((flag) => /(?:source_only|intermediary|lessor)/.test(flag.type))
  .map((flag) => ({...r,flag})));
const legal = audit.records.flatMap((r) => r.role_and_legal_review_flags
  .filter((flag) => !/(?:source_only|intermediary|lessor)/.test(flag.type))
  .map((flag) => ({...r,flag})));
const candidates = audit.records.flatMap((r) =>
  r.candidate_inns_for_review.map((item) => ({...r,item})));
const contradictions = audit.records.flatMap((r) =>
  r.conflicting_inns_in_saved_notes.map((item) => ({...r,item})));
const result = {
  checkpoint:audit.source_checkpoint,
  summary:{...audit.summary,role_issues:roles.length,
    legal_issues:legal.length,candidate_rows_without_inn:candidates.length,
    conflict_rows_with_filled_inn:contradictions.length,
    possible_shared_source_pairs:audit.shared_source_pairs.length,
    candidate_inn_groups:audit.candidate_inn_groups.length},
  roles,legal,candidates,contradictions,
  possible_duplicates:audit.candidate_inn_groups,
  shared_sources:audit.shared_source_pairs,
  source_unchanged:true,auto_filled_inns:0,auto_merged_rows:0,
  openai_calls:0,web_search_calls:0,
  caution:"Source-derived hints only. Verify legal names, OGRN, roles and ownership in primary records before changing any rows."
};
const wb=XLSX.utils.book_new();
function add(name,headers,rows,values) {
  const sheet=XLSX.utils.aoa_to_sheet([headers,...rows.map(values)]);
  sheet["!cols"]=headers.map((h,i)=>({wch:i===1?45:i>=5?65:25}));
  XLSX.utils.book_append_sheet(wb,sheet,name);
}
add("Итоги",["Показатель","Значение"],
  [["Checkpoint",result.checkpoint],...Object.entries(result.summary),
   ["OpenAI",0],["Web search",0],["Изменено строк",0],["Оговорка",result.caution]],x=>x);
const flagged=["ID","Организация","Класс","ИНН","Проблема","Рекомендация","Заметка","Источник"];
const flagValues=x=>[x.canonical_id,x.organization,x.current_grade,
  x.current_inn,x.flag.type,x.flag.proposed_role,x.flag.evidence_note,x.flag.source_url];
add("Несовпадения ролей",flagged,roles,flagValues);
add("Юридическая проверка",flagged,legal,flagValues);
add("ИНН в заметках",["ID","Организация","Класс","ИНН в строке","ИНН-кандидат","Статус","Существующие владельцы"],
  candidates,x=>[x.canonical_id,x.organization,x.current_grade,x.current_inn,
    x.item.inn,x.item.status,x.item.existing_owners.map(y=>y.organization).join(" | ")]);
add("Противоречия ИНН",["ID","Организация","Класс","ИНН в строке","Другой ИНН в заметке","Статус","Другие владельцы"],
  contradictions,x=>[x.canonical_id,x.organization,x.current_grade,x.current_inn,
    x.item.inn,x.item.status,x.item.existing_owners.map(y=>y.organization).join(" | ")]);
add("Группы дублей",["ИНН-кандидат","Количество строк","Возможные организации","ID","Результат"],
  result.possible_duplicates,x=>[x.inn,x.records.length,x.records.map(y=>y.organization).join(" | "),
    x.records.map(y=>y.canonical_id).join(" | "),x.status]);
add("Общие источники",["ID","Организации","ИНН","Количество общих ссылок","Общие URL","Статус"],
  result.shared_sources,x=>[x.ids.join(" | "),x.organizations.join(" | "),
    x.inns.join(" | "),x.shared_urls.length,x.shared_urls.join("\n"),x.status]);
add("Методика",["Правило","Пояснение"],[
  ["Только offline","Читаем сохранённый JSON без браузера, OpenAI или web_search"],
  ["Судьба компаний","Скрипт не меняет роли, grade, ИНН или JSON в SQLite"],
  ["ИНН","Проверка контрольных цифр не подтверждает правильность привязки к юрлицу"],
  ["Роль","Явная заметка об альтернативной роли требует сверки с первоисточником"],
  ["Дубли","Общий ИНН/URL/название не является разрешением на объединение"],
  ["Юрформа","Расхождение ООО/АО требует отдельной юридической идентификации"]
],x=>x);
const dir=path.resolve(outDir);
fs.mkdirSync(dir,{recursive:true});
const name="role_identity_"+(result.checkpoint||"unknown").slice(0,8);
const paths={json:path.join(dir,name+".json"),xlsx:path.join(dir,name+".xlsx")};
if(Object.values(paths).some(fs.existsSync)) {
  throw new Error("Output already exists. Choose another --out directory.");
}
const created=[];
try {
  fs.writeFileSync(paths.json,JSON.stringify(result,null,2),{flag:"wx"});
  created.push(paths.json);
  fs.writeFileSync(paths.xlsx,XLSX.write(wb,{type:"buffer",bookType:"xlsx"}),{flag:"wx"});
  created.push(paths.xlsx);
} catch(error) {
  for(const target of created)try{fs.unlinkSync(target)}catch{}
  throw error;
}
console.log(JSON.stringify({checkpoint:result.checkpoint,summary:result.summary,
  output:paths,source_unchanged:true,openai_calls:0},null,2));
