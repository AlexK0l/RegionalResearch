#!/usr/bin/env node
// Reproducibly combine two already completed OFFLINE JSON exports.
// No SQLite writes, OpenAI calls, web requests or automatic identity merges.
import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";

const args=process.argv.slice(2);
const inputs=args.filter((x)=>!x.startsWith("--"));
const outDir=args.find((x)=>x.startsWith("--out="))?.slice(6);
if(inputs.length!==2 || !outDir){
  console.error("Usage: node scripts/compose-offline-crm.js <identity-result.json> <qualification-replay.json> --out=<new-output-directory>");
  process.exit(2);
}
const identity=JSON.parse(fs.readFileSync(path.resolve(inputs[0]),"utf8"));
const replay=JSON.parse(fs.readFileSync(path.resolve(inputs[1]),"utf8"));
if(!identity.checkpoint_id || identity.checkpoint_id!==replay.checkpoint){
  throw Error("Checkpoint mismatch: refusing to mix different research runs");
}
if(!identity.final_result || !Array.isArray(replay.rows)) {
  throw Error("Expected identity final_result and qualification rows[]");
}
const replayById=new Map();
for(const row of replay.rows) {
  if(!row.canonical_id || replayById.has(row.canonical_id)) {
    throw Error("Missing or repeated replay canonical_id");
  }
  replayById.set(row.canonical_id,row);
}
const allowed=new Set(["A","B","C","REVIEW"]);
const columns=[
  "Организация","Управляющая компания","ИНН","Город/район",
  "Техника/сегмент","Основание","Телефон","Следующее действие",
  "Почему им нужно звонить / потенциальный интерес к САТ","Руководитель / ЛПР",
  "Выручка последнего подтвержденного года","Численность"
];
const sheets=[
  ["direct_buyers","Прямые покупатели"],
  ["intermediaries","Посредники"],
  ["leasing","Лизинг"]
];
const safe=(value,field="")=>{
  if(value==null || typeof value==="object")return "";
  if(typeof value==="number")return value;
  const text=String(value);
  if(field==="ИНН")return text;
  return /^[=+\\-@]/.test(text)?"'"+text:text;
};
const workbook=XLSX.utils.book_new();
const counts={A:0,B:0,C:0,REVIEW:0};
const used=new Set(),changed=[],manual=[],active=[],archive=[];
const stepFor=(status)=>{
  if(status==="REVIEW")return "РУЧНАЯ ПРОВЕРКА: уточнить юридическую идентичность, роль и транспортный факт до включения в продажи.";
  if(status==="B")return "Связаться с ответственным за транспорт; проверить закрепление парка за юрлицом, типы полуприцепов и планы закупок.";
  if(status==="C")return "Проверить фактического перевозчика, грузопоток и наличие собственных полуприцепов; уровень A/B пока не подтверждён.";
  return "Проверить прямое свидетельство прицепной техники и актуальные планы её обновления.";
};
function addSheet(name,headers,rows,comments=null){
  const cells=[headers,...rows.map((r)=>headers.map((h)=>safe(r?.[h],h)))];
  const tab=XLSX.utils.aoa_to_sheet(cells);
  if(comments){
    rows.forEach((row,i)=>{
      const note=String(row?.__comment||"").trim();
      const cell=tab[XLSX.utils.encode_cell({r:i+1,c:0})];
      if(note && cell)XLSX.utils.cell_add_comment(cell,note,"RegionalResearch");
    });
  }
  tab["!cols"]=headers.map((x)=>({wch:x==="Организация"?46:x==="Основание"?76:x==="ИНН"?21:x==="Техника/сегмент"?70:40}));
  XLSX.utils.book_append_sheet(workbook,tab,name);
}
for(const [section,sheetName] of sheets){
  const source=identity.final_result[section];
  if(!Array.isArray(source))throw Error("Missing recovery sheet "+section);
  const output=[];
  for(const original of source){
    const row=structuredClone(original);
    const ids=row.__merged_canonical_ids?.length?row.__merged_canonical_ids:[row.__canonical_id];
    if(!row.__canonical_id || new Set(ids).size!==ids.length || !ids.includes(row.__canonical_id)){
      throw Error("Bad identity merge lineage for "+(row["Организация"]||"unknown"));
    }
    const qualifications=ids.map((id)=>{
      if(used.has(id))throw Error("Duplicate canonical_id in recovered rows: "+id);
      used.add(id);
      const ref=replayById.get(id);
      if(!ref)throw Error("No qualification row for "+id);
      return ref;
    });
    const grades=new Set(qualifications.map((q)=>{
      const grade=q.qualification_status||q.replay_grade||"REVIEW";
      if(!allowed.has(grade))throw Error("Invalid qualification "+grade);
      return grade;
    }));
    const grade=grades.size===1?[...grades][0]:"REVIEW";
    const prior=String(row.__final_grade||"");
    const reason=qualifications[0].why||"Недостаточно проверенных доказательств коммерческой релевантности.";
    const disagreement=grades.size!==1;
    if(prior!==grade || disagreement || grade==="REVIEW"){
      const saved={archived_basis:row["Основание"]||"",archived_action:row["Следующее действие"]||"",
        archived_call_reason:row["Почему им нужно звонить / потенциальный интерес к САТ"]||""};
      row.__archived_qualification=saved;
      row["Основание"]=grade==="REVIEW"?
        "REVIEW — ручная проверка; в сохранённых данных недостаточно доказательств для A/B/C.":
        grade+" — "+reason;
      row["Следующее действие"]=stepFor(grade);
      row["Почему им нужно звонить / потенциальный интерес к САТ"]=
        "Пересчёт v5: "+reason+" Не приписывать юрлицу неподтверждённый собственный полуприцеп.";
      changed.push({canonical_id:row.__canonical_id,organization:row["Организация"],source_sheet:sheetName,
        original_grade:prior,new_status:grade,inn:row["ИНН"]||"",reason,
        source_url:qualifications[0].source_urls?.[0]||"",
        merged_canonical_ids:ids,merged_grade_disagreement:disagreement});
    }
    if(grade==="REVIEW"){
      manual.push({canonical_id:row.__canonical_id,organization:row["Организация"],source_sheet:sheetName,
        inn:row["ИНН"]||"",archived_grade:prior,reason,
        source_url:qualifications[0].source_urls?.[0]||"",merged_grade_disagreement:disagreement});
      row.__decision="manual_review";
      row.__decision_reason=reason;
    }
    row.__replay_v5={status:grade,checkpoint:replay.checkpoint,reason,merged_grade_disagreement:disagreement};
    row.__final_grade=grade==="REVIEW"?"":grade;
    counts[grade]+=1;
    output.push(row);
    active.push({canonical_id:row.__canonical_id,organization:row["Организация"],
      sheet:section,inn:row["ИНН"]||"",status:grade,archived_grade:prior,source_ids:ids});
  }
  addSheet(sheetName,columns,output,true);
}
if(used.size!==replayById.size){
  throw Error("Recovered identities do not exactly cover qualification replay: "+
    used.size+" of "+replayById.size);
}
const total=active.length;
if(total!==Object.values(counts).reduce((sum,n)=>sum+n,0)){
  throw Error("Qualification total mismatch");
}
const withInn=active.filter((x)=>String(x.inn).trim()).length;
const qc=identity.final_result.qualification_review||[];
if(!Array.isArray(qc))throw Error("Expected qualification_review array");
archive.push(...qc.map((r)=>({
  canonical_id:r.__canonical_id,organization:r["Организация"],
  inn:r["ИНН"]||"",source_sheet:r.__qualification_origin_sheet||"",
  reason:r.__decision_reason||"",source_url:r.__evidence?.source_urls?.[0]||""
})));
const summary={
 checkpoint_id:identity.checkpoint_id,total,with_inn:withInn,without_inn:total-withInn,
 grades:counts,reclassified_rows:changed.length,manual_review_rows:manual.length,
 historical_review_outside_active:qc.length,
 restored_groups:identity.audit?.restored_groups?.length||0,
 unresolved_alias_rows:identity.audit?.unresolved?.length||0,
 conflicting_preexisting_inns:identity.audit?.untrusted_or_unmatched?.length||0,
 no_automatic_merges:true,no_external_calls:true,
 source_files_untouched:true,
 caution:"WORKING DRAFT: roles and EGRUL status were not reverified; 148 historical review rows are outside active company total."
};
addSheet("Сводка v5",["Показатель","Значение"],Object.entries({
 "Checkpoint":summary.checkpoint_id,
 "Компаний в рабочей копии":total,"Подтверждено А":counts.A,
 "Подтверждено B":counts.B,"Подтверждено C":counts.C,
 "Требуют проверки":counts.REVIEW,"Заполнено ИНН":withInn,
 "Нет ИНН":summary.without_inn,
 "Объединения из recovery":summary.restored_groups,
 "Остались спорные ИНН":summary.unresolved_alias_rows,
 "Конфликты заполненного ИНН":summary.conflicting_preexisting_inns,
 "Изменения относительно архива":changed.length,
 "Архив ручной проверки вне 491":qc.length,
 "Новые платные запросы":0
}).map(([k,v])=>({"Показатель":k,"Значение":v})));
addSheet("Изменения v5",
 ["ID","Организация","Исходный лист","ИНН","Старый класс","Новый статус","Причина","URL"],
 changed.map((r)=>({"ID":r.canonical_id,"Организация":r.organization,
   "Исходный лист":r.source_sheet,"ИНН":r.inn,
   "Старый класс":r.original_grade,"Новый статус":r.new_status,
   "Причина":r.reason,"URL":r.source_url})));
addSheet("Проверка v5",
 ["ID","Организация","Исходный лист","ИНН","Архивный класс","Причина","URL"],
 manual.map((r)=>({"ID":r.canonical_id,"Организация":r.organization,
  "Исходный лист":r.source_sheet,"ИНН":r.inn,
  "Архивный класс":r.archived_grade,"Причина":r.reason,"URL":r.source_url})));
addSheet("Алиасы на проверку",
 ["ИНН","Организация","Статус","ОГРН","Решение","Первый источник"],
 (identity.audit?.unresolved||[]).map((u)=>({
  "ИНН":u.inn,"Организация":u.names?.join(" | ")||"","Статус":u.status,
  "ОГРН":u.ogrns?.join(" | ")||"",
  "Решение":u.decisions?.map((d)=>d.reason).join(" | ")||"Недостаточно доказательств",
  "Первый источник":u.identity_sources?.[0]||""
 })));
addSheet("Конфликты ИНН",
 ["Компания","ИНН в записи","ИНН из заметки","Причина","Исходный лист"],
 (identity.audit?.untrusted_or_unmatched||[]).map((u)=>({
  "Компания":u.company,"ИНН в записи":u.existingInn||"",
  "ИНН из заметки":u.inn,"Причина":u.reason,"Исходный лист":u.sheet
 })));
addSheet("История алиасов",
 ["Основная компания","ИНН","Объединённые имена","Исходные ID","Доказательство","Первый источник"],
 (identity.audit?.restored_groups||[]).map((u)=>({
  "Основная компания":u.winner_name,"ИНН":u.inn,
  "Объединённые имена":u.absorbed_names?.join(" | ")||"",
  "Исходные ID":u.original_canonical_ids?.join(" | ")||"",
  "Доказательство":u.reason,"Первый источник":u.source_urls?.[0]||""
 })));
addSheet("Прежняя проверка",
 ["ID","Организация","ИНН","Первоначальный лист","Причина","URL"],
 archive.map((u)=>({"ID":u.canonical_id,"Организация":u.organization,
  "ИНН":u.inn,"Первоначальный лист":u.source_sheet,
  "Причина":u.reason,"URL":u.source_url})));
const stats=identity.final_result.statistics||[];
if(!Array.isArray(stats))throw Error("Expected statistics[]");
const statHeaders=[...new Set(stats.flatMap((r)=>Object.keys(r).filter((x)=>!x.startsWith("__"))))];
addSheet("Статистика",statHeaders,stats);
addSheet("Методика",["Правило","Описание"],[
 {"Правило":"Сверка двух версий","Описание":"Input JSON identity recovery and qualification replay must have the same checkpoint ID."},
 {"Правило":"A/B/C","Описание":"Only replay v5 may change the classification. Old grade and why are preserved in JSON."},
 {"Правило":"Разные классы объединённых алиасов","Описание":"The single merged row is retained as REVIEW. No silent highest-grade selection."},
 {"Правило":"Ручная проверка","Описание":"The 4 REVIEW candidates remain on their original tabs and are duplicated as references on the review tab."},
 {"Правило":"Старые 148","Описание":"Historical qualification_review rows are outside the active company count; listed on a separate tab."},
 {"Правило":"CRM и примечания","Описание":"The 12 main columns are kept; notes remain in comments to the first column."},
 {"Правило":"Источники","Описание":"Stored links and notes were not downloaded or verified again; EGRUL status is not verified."},
 {"Правило":"Стоимость","Описание":"Zero OpenAI calls, zero web_search calls, no SQLite mutations or data rewriting."}
]);
const dir=path.resolve(outDir);
fs.mkdirSync(dir,{recursive:true});
const filePrefix="combined_offline_"+identity.checkpoint_id.slice(0,8);
const output={
 xlsx:path.join(dir,filePrefix+".xlsx"),
 json:path.join(dir,filePrefix+".json")
};
if(Object.values(output).some((p)=>fs.existsSync(p))){
  throw Error("Output exists: choose a new --out directory, inputs are unchanged");
}
const combined={
 checkpoint_id:identity.checkpoint_id,region:identity.region,
 summary,rows:active,changed,review_queue:manual,
 archived_review:archive,identity_audit:identity.audit,
 source_qualification_counts:replay.counts,
 openai_calls:0,web_search_calls:0,
 working_draft_not_approved_for_crm:true
};
const made=[];
try {
 fs.writeFileSync(output.xlsx,XLSX.write(workbook,{type:"buffer",bookType:"xlsx"}),{flag:"wx"});
 made.push(output.xlsx);
 fs.writeFileSync(output.json,JSON.stringify(combined,null,2),{flag:"wx"});
 made.push(output.json);
} catch(err) {
 for(const p of made)try{fs.unlinkSync(p)}catch{}
 throw err;
}
console.log(JSON.stringify({checkpoint:combined.checkpoint_id,summary,output},null,2));
