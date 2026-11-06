#!/usr/bin/env node
// Read-only audit of unresolved INNs. Candidate values are not written to CRM.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import XLSX from 'xlsx';

const args=process.argv.slice(2);
const input=args.find(a=>!a.startsWith('--'));
const flag=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
const outDir=flag('out'), reviewFile=flag('review');
if(!input||!outDir){
  console.error('Usage: node scripts/audit-missing-inn-offline.js <full-verified.json> --out=<new-dir> [--review=<review.json>]');
  process.exit(2);
}
const source=fs.readFileSync(path.resolve(input));
const data=JSON.parse(source.toString('utf8'));
if(!data.checkpoint_id||!data.final_result)throw Error('Expected full verified JSON with checkpoint_id and final_result');
const indexed=new Map(),owners=new Map();
const grades=['A','B','REVIEW','C'];
for(const section of ['direct_buyers','intermediaries','leasing']){
 const rows=data.final_result[section];
 if(!Array.isArray(rows))throw Error('Missing company section: '+section);
 for(const row of rows){
  const id=String(row.__canonical_id||'').trim();
  if(!id||indexed.has(id))throw Error('Missing or duplicate canonical ID: '+id);
  indexed.set(id,{section,row});
  const inn=String(row['ИНН']||'').trim();
  if(inn){
   const group=owners.get(inn)||[];
   group.push({canonical_id:id,organization:row['Организация']});
   owners.set(inn,group);
  }
 }
}
let review=null;
const annotations=new Map();
if(reviewFile){
 review=JSON.parse(fs.readFileSync(path.resolve(reviewFile),'utf8'));
 if(review.checkpoint_id!==data.checkpoint_id||!Array.isArray(review.priority_review))
  throw Error('Research review checkpoint or schema mismatch');
 for(const a of review.priority_review){
  const id=String(a.canonical_id||'').trim();
  const r=indexed.get(id)?.row;
  if(!r||String(r['ИНН']||'').trim()||annotations.has(id)||r['Организация']!==a.organization)
   throw Error('Invalid or stale review annotation: '+id);
  if((r.__replay_v5?.status||'REVIEW')!==a.grade)throw Error('Review grade mismatch for '+id);
  annotations.set(id,a);
 }
}
const norm=s=>String(s||'').toLowerCase().replace(/ё/g,'е');
const re=/подтвержденн(?:ый|ого)\s+инн\s*:\s*(\d{12}|\d{10})(?!\d)/gi;
const rows=[];
for(const [id,{section,row}] of indexed){
 if(String(row['ИНН']||'').trim())continue;
 const grade=row.__replay_v5?.status||'REVIEW';
 if(!grades.includes(grade))throw Error('Unknown qualification: '+grade);
 const notes=row.__evidence?.notes||[];
 const urls=row.__evidence?.source_urls||[];
 const inNotes=[...new Set(notes.flatMap(n=>[...norm(n).matchAll(re)].map(x=>x[1])))];
 const embedded=String(row.__evidence?.identity_verification?.inn||'').trim();
 const observed=[...new Set([...inNotes,...(/^\d{10}(?:\d{2})?$/.test(embedded)?[embedded]:[])])];
 // A saved claim and a later explicit denial may coexist in the checkpoint.
 // The denial must remain visible rather than turning the claim into an INN.
 const contradictory=notes.some(n=>/инн\s*\d{10,12}.{0,90}не\s+подтвержден/.test(norm(n)));
 const occupied=observed.flatMap(inn=>(owners.get(inn)||[]).map(o=>({inn,...o})));
 const a=annotations.get(id);
 rows.push({canonical_id:id,organization:row['Организация'],sheet:section,grade,
  inn_candidate_notes:observed,inn_candidate_embedded:embedded,conflicting_identity_note:contradictory,
  inn_already_used_in_records:occupied,
  source_url:urls[0]||'',all_source_count:urls.length,note_count:notes.length,
  review_status:a?.review_status||(contradictory?'CONTRADICTORY_IDENTITY_NOTES':occupied.length?'POSSIBLE_DUPLICATE_REVIEW':'UNVERIFIED_MISSING_INN'),
  candidate_inn_from_research:a?.candidate_inn||'',legal_entity:a?.legal_entity||'',
  reason_no_fill:a?.reason_no_fill||'',
  next_action:a?.action||'Проверить юридическое лицо, ИНН/ОГРН и источник. Не переносить ИНН из заметки без подтверждения.',
  researched_source:a?.source_verification||'',needs_manual_identity_review:true});
}
rows.sort((a,b)=>grades.indexOf(a.grade)-grades.indexOf(b.grade)||a.organization.localeCompare(b.organization,'ru'));
const byGrade=Object.fromEntries(grades.map(g=>[g,rows.filter(r=>r.grade===g)]));
const summary={checkpoint_id:data.checkpoint_id,original_company_count:indexed.size,
 filled_inn:indexed.size-rows.length,missing_inn:rows.length,
 missing_by_grade:Object.fromEntries(grades.map(g=>[g,byGrade[g].length])),
 human_research_annotations:annotations.size,
 candidate_mentions_in_notes:rows.filter(r=>r.inn_candidate_notes.length).length,
 embedded_identity_candidates:rows.filter(r=>r.inn_candidate_embedded).length,
 contradictory_identity_notes:rows.filter(r=>r.conflicting_identity_note).length,
 candidate_inn_already_used_in_another_row:rows.filter(r=>r.inn_already_used_in_records.length).length,
 auto_filled_inns:0,auto_merged_companies:0,openai_calls:0,web_search_calls:0,
 source_input_sha256:crypto.createHash('sha256').update(source).digest('hex'),
 source_files_unchanged:true};
const output={summary,rows,alias_groups:review?.alias_groups||[],
 notes:'Candidate INNs are review hints only. This script never edits input rows, grades, or company identities.'};
const wb=XLSX.utils.book_new();
function sheet(name,headers,items,fn){
 const tab=XLSX.utils.aoa_to_sheet([headers,...items.map(fn)]);
 tab['!cols']=headers.map((h,i)=>({wch:i===1?48:i>=4?68:23}));
 XLSX.utils.book_append_sheet(wb,tab,name);
}
sheet('Итоги',['Показатель','Значение'],Object.entries(summary),x=>x);
const headers=['ID','Организация','Раздел','ИНН в заметках','Уже занят другой записью','Статус',
 'ИНН-кандидат','Вероятное юрлицо','Архивный источник','Источник проверки','Действие'];
const cells=r=>[r.canonical_id,r.organization,r.sheet,r.inn_candidate_notes.join('; '),
 r.inn_already_used_in_records.map(v=>v.inn+' -> '+v.canonical_id).join('; '),
 r.review_status,r.candidate_inn_from_research,r.legal_entity,r.source_url,r.researched_source,r.next_action];
for(const grade of grades)sheet(grade+' без ИНН',headers,byGrade[grade],cells);
sheet('Алиасы на проверку',['Пара','ID','ИНН','ОГРН','Статус','Действие','Источник'],
 output.alias_groups,r=>[r.name,(r.ids||[]).join(' / '),r.candidate_inn,r.candidate_ogrn,r.status,r.action,r.source]);
sheet('Методика',['Правило','Описание'],[
 ['Только offline','Команда не выполняет внешних запросов. Публикации не переверифицируются.'],
 ['Без изменений CRM','Вводимые данные и классы не изменяются; ИНН из заметки является лишь кандидатом.'],
 ['Алиасы','Общий URL, название или ИНН не разрешает автоматическое объединение юридических лиц.'],
 ['Доказательство','Нужно подтвердить точное юрлицо, ОГРН, роль, дату и источник.']
],x=>x);
const dir=path.resolve(outDir);
fs.mkdirSync(dir,{recursive:true});
const prefix='missing_inn_audit_'+data.checkpoint_id.slice(0,8);
const outputs={json:path.join(dir,prefix+'.json'),xlsx:path.join(dir,prefix+'.xlsx')};
if(Object.values(outputs).some(fs.existsSync))throw Error('Output exists; choose a new --out directory');
const buffers={
 [outputs.json]:Buffer.from(JSON.stringify(output,null,2),'utf8'),
 [outputs.xlsx]:XLSX.write(wb,{bookType:'xlsx',type:'buffer'})
};
const written=[];
try{
 for(const [file,bytes] of Object.entries(buffers)){
  fs.writeFileSync(file,bytes,{flag:'wx'});written.push(file);
 }
}catch(e){for(const p of written)try{fs.unlinkSync(p)}catch{}throw e;}
console.log(JSON.stringify({summary,outputs},null,2));
