#!/usr/bin/env node
// Offline evidence provenance: only carry forward source-reviewed INNs, never infer
// a legal identity or qualification from adjacent notes or another company's INN.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import XLSX from 'xlsx';

const args=process.argv.slice(2),input=args.find(a=>!a.startsWith('--'));
const opt=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
const out=opt('out'),base=opt('base-xlsx');
if(!input||!out){
 console.error('Usage: node scripts/audit-evidence-provenance.js <verified-aliases-full.json> --out=<new-directory> [--base-xlsx=<original.xlsx>]');
 process.exit(2);
}
const raw=fs.readFileSync(path.resolve(input));
const data=JSON.parse(raw.toString('utf8'));
if(!data.checkpoint_id||!data.final_result||!Array.isArray(data.rows))throw Error('Expected full company JSON with checkpoint and compact index');
if(data.evidence_provenance_review)throw Error('Evidence audit already applied; use a pre-audit full JSON');
const all=new Map(),owners=new Map();
for(const section of ['direct_buyers','intermediaries','leasing']){
 const list=data.final_result[section];
 if(!Array.isArray(list))throw Error('Missing company section '+section);
 for(const r of list){
  const id=r.__canonical_id;
  if(!id||all.has(id))throw Error('Duplicate or missing canonical ID');
  if(!r.__evidence||!Array.isArray(r.__evidence.facts)||!Array.isArray(r.__evidence.source_urls)||!r.__evidence.source_urls.length)throw Error('Missing evidence arrays: '+id);
  if(!r.__replay_v5?.status)throw Error('Missing qualification: '+id);
  all.set(id,r);
  const inn=String(r['ИНН']||'').trim();
  if(inn){
   if(owners.has(inn))throw Error('Duplicate INN in source: '+inn);
   owners.set(inn,{id,name:r['Организация']});
  }
 }
}
if(all.size!==data.rows.length||new Set(data.rows.map(x=>x.canonical_id)).size!==all.size||
 !data.rows.every(x=>all.has(x.canonical_id)))throw Error('Full company JSON does not match compact index');
const norm=s=>String(s||'').toLowerCase().replace(/ё/g,'е');
const uniq=a=>[...new Set(a.filter(Boolean))];
const validInn=s=>{
 if(!/^\d{10}(?:\d{2})?$/.test(s))return false;
 const d=[...s].map(Number),c=(i,w)=>w.reduce((n,k,j)=>n+d[j]*k,0)%11%10===d[i];
 return s.length===10?c(9,[2,4,10,3,5,9,4,6,8]):
  c(10,[7,2,4,10,3,5,9,4,6,8])&&c(11,[3,7,2,4,10,3,5,9,4,6,8]);
};
const validOgrn=s=>/^\d{13}$/.test(s)&&Number(s.slice(-1))===Number(BigInt(s.slice(0,12))%11n%10n);
const facts=[],reviewed=[],claims=[],contacts=[],noteUrls=[],missing=[],review=[],legal=[],gradeCounts={A:0,B:0,C:0,REVIEW:0};
for(const r of all.values()){
 const id=r.__canonical_id,name=r['Организация'],inn=String(r['ИНН']||'').trim(),grade=r.__replay_v5.status,e=r.__evidence;
 if(!(grade in gradeCounts))throw Error('Unsupported grade '+grade);
 gradeCounts[grade]++;
 if(inn&&!validInn(inn))throw Error('Bad INN checksum: '+id);
 for(const f of e.facts)if(f.sources?.length){
  facts.push({id,name,grade,kind:f.kind,value:f.value,ogrn:f.ogrn||'',urls:f.sources,level:'PRIOR_STRUCTURED_NOT_RECHECKED'});
 }
 if(r.__verified_identity){
  const v=r.__verified_identity;
  if(!inn||inn!==v.inn||!validInn(inn)||!validOgrn(v.ogrn)||!e.source_urls.includes(v.source_url))throw Error('Manual verification mismatch: '+id);
  if(e.facts.some(f=>f.kind==='legal_identity'&&f.value===inn))throw Error('Previously structured fact already exists: '+id);
  e.facts.push({kind:'legal_identity',field:'inn',value:inn,ogrn:v.ogrn,sources:[v.source_url],
   verified_on:v.checked_on,entity_scope:'registered_legal_person',
   review_basis:'previous_manual_verification_from_manifest',
   verification_status:'carried_forward_not_live_rechecked',source_class:v.source_class});
  reviewed.push({id,name,grade,inn,ogrn:v.ogrn,url:v.source_url,source_class:v.source_class,reviewed_on:v.checked_on});
  facts.push({id,name,grade,kind:'legal_identity',value:inn,ogrn:v.ogrn,urls:[v.source_url],level:'PRIOR_MANUAL_REVIEW_CARRIED_FORWARD'});
 }
 const iv=e.identity_verification||{};
 if(inn&&iv.inn===inn&&Array.isArray(iv.source_urls)&&iv.source_urls.length){
  claims.push({id,name,grade,inn,method:iv.method||'',urls:iv.source_urls,level:'STORED_CLAIM_NOT_RECHECKED'});
 }
 const cv=e.contact_verification||{};
 if(cv.phone&&cv.source_url)contacts.push({id,name,grade,inn,other_inn:cv.inn||'',phone:cv.phone,url:cv.source_url,
  level:inn&&cv.inn===inn?'STORED_CLAIM_NOT_RECHECKED':'SCOPE_MISMATCH_DO_NOT_TRANSFER'});
 for(const [i,n] of (e.notes||[]).entries()){
  for(const url of uniq(String(n).match(/https?:\/\/[^\s<>\])]+/g)||[])){
   noteUrls.push({id,name,grade,note_index:i+1,note:String(n),url,level:'INLINE_NOTE_CLAIM_NOT_RECHECKED'});
  }
 }
 if(!inn){
  const notes=(e.notes||[]).map(norm),text=notes.join('\n');
  const observed=notes.flatMap(n=>[...n.matchAll(/подтвержденн(?:ый|ого)\s+инн\s*:\s*(\d{12}|\d{10})(?!\d)/gi)].map(x=>x[1]));
  const candidates=uniq([iv.inn||'',...observed]);
  const occupied=candidates.filter(x=>owners.has(x)).map(x=>({inn:x,...owners.get(x)}));
  const priority=grade==='A'?'P0':grade==='B'||grade==='REVIEW'?'P1':candidates.length?'P2':'P3';
  missing.push({id,name,grade,priority,candidates,occupied,first_url:e.source_urls[0],total_urls:e.source_urls.length,
   conflicts:/final inn conflict:|не подтвержд|не является отдельным юридическим|не раскрыт/.test(text),
   group_or_branch:/филиал|группа компаний|гк «|гк /i.test(name),
   action:occupied.length?'Verify legal alias/branch with OGRN; INN is already assigned to another record':
    candidates.length?'Validate candidate against exact registered legal person and OGRN':
    'Look up exact name, address and legal operator; obtain FNS EGRUL extract'});
 }
 if(grade==='REVIEW')review.push({id,name,inn,reason:r.__replay_v5.reason||'',url:e.source_urls[0],
  legal_status:r.__legal_status_review?.status||'NOT_CHECKED'});
 if(r.__legal_status_review){
  const l=r.__legal_status_review;
  legal.push({id,name,inn,grade,status:l.status,event_date:l.event_date,urls:l.source_urls,
   official_extract_received:false});
 }
}
const resolved=new Set((data.reviewed_alias_merges?.merges||[]).flatMap(m=>
 [m.primary_name,m.absorbed_name].map(name=>m.inn+'\t'+name)));
const aliases=[];
for(const x of data.identity_audit?.unresolved||[])for(const name of x.names||[]){
 if(resolved.has(x.inn+'\t'+name))continue;
 const r=[...all.values()].find(z=>z['Организация']===name);
 aliases.push({id:r?.__canonical_id||'',name,inn_candidate:x.inn,current_inn:r?.['ИНН']||'',grade:r?.__replay_v5.status||'',
  status:x.status,source_url:x.identity_sources?.[0]||''});
}
missing.sort((a,b)=>a.priority.localeCompare(b.priority)||a.name.localeCompare(b.name,'ru'));
const byPriority={P0:0,P1:0,P2:0,P3:0};
missing.forEach(x=>byPriority[x.priority]++);
const initialFacts=facts.length-reviewed.length;
data.summary.facts_with_linked_sources=facts.length;
data.summary.new_facts_from_prior_manual_verification=reviewed.length;
data.summary.source_linked_identity_claims_requiring_review=claims.length;
data.summary.missing_inn_alias_entries_actionable=aliases.filter(x=>!x.current_inn).length;
const sha=crypto.createHash('sha256').update(raw).digest('hex');
data.evidence_provenance_review={
 audit_date:new Date().toISOString().slice(0,10),source_input_sha256:sha,
 linked_facts_before:initialFacts,linked_facts_after:facts.length,
 previously_reviewed_inn_facts_added:reviewed.length,
 identity_claims_not_rechecked:claims.length,
 contact_scope_mismatches:contacts.filter(x=>x.level==='SCOPE_MISMATCH_DO_NOT_TRANSFER').length,
 no_auto_inn_updates:true,no_auto_merges:true,grades_unchanged:true,
 legal_status_requires_signed_fns_extract:true,openai_calls:0,web_search_calls:0
};
const report={checkpoint_id:data.checkpoint_id,source_input_sha256:sha,
 summary:{companies:all.size,with_inn:owners.size,without_inn:missing.length,grades:gradeCounts,
  linked_facts_before:initialFacts,linked_facts_after:facts.length,
  transferred_prior_reviewed_inns:reviewed.length,archived_identity_claims:claims.length,
  archived_contact_claims:contacts.length,contact_identity_mismatch:contacts.filter(x=>x.level==='SCOPE_MISMATCH_DO_NOT_TRANSFER').length,
  notes_with_inline_links:noteUrls.length,pending_alias_history_rows:aliases.length,
  pending_alias_rows_without_inn:aliases.filter(x=>!x.current_inn).length,
  missing_inn_priority:byPriority,qualification_review_count:review.length,
  legal_status_review_pending:legal.length,source_url_count:[...all.values()].reduce((n,r)=>n+r.__evidence.source_urls.length,0),
  no_paid_calls:true},
 facts,new_reviewed_facts:reviewed,archived_identity_claims:claims,archived_contact_claims:contacts,
 note_inline_links:noteUrls,missing_inn:missing,remaining_aliases:aliases,
 qualification_review:review,legal_status_review:legal,
 method:'Only previously manually reviewed legal identities become structured facts. Archived claims remain explicitly unverified. Official legal status requires current signed FNS extract.'};
const folder=path.resolve(out);fs.mkdirSync(folder,{recursive:true});
const prefix='evidence_provenance_'+data.checkpoint_id.slice(0,8);
const outputs={json:path.join(folder,prefix+'.json'),
 audit:path.join(folder,prefix+'_audit.json'),
 xlsx:path.join(folder,prefix+'.xlsx')};
if(Object.values(outputs).some(fs.existsSync))throw Error('Output exists; choose another --out directory');
const book=base?XLSX.readFile(path.resolve(base),{cellComments:true}):XLSX.utils.book_new();
function tab(name,headers,records,fn){
 if(book.SheetNames.includes(name))throw Error('Audit worksheet already exists: '+name);
 const cells=[headers,...records.map(x=>fn(x).map(v=>{
  if(v==null)return '';
  if(typeof v==='object')return JSON.stringify(v);
  return typeof v==='string'&&'=+-@'.includes(v[0])?"'"+v:v;
 }))];
 const ws=XLSX.utils.aoa_to_sheet(cells);
 ws['!cols']=headers.map((_,i)=>({wch:i===1?50:i>=5?68:24}));
 XLSX.utils.book_append_sheet(book,ws,name);
}
tab('Источники итоги v1',['Метрика','Значение'],Object.entries(report.summary),x=>x);
tab('Факты URL v1',['ID','Организация','Класс','Факт','Значение','ОГРН','Статус','URL'],facts,x=>
 [x.id,x.name,x.grade,x.kind,x.value,x.ogrn,x.level,x.urls.join('; ')]);
tab('Очередь ИНН v1',['Приоритет','ID','Организация','Класс','Кандидаты','Занято','Противоречия','Источник','Действие'],missing,x=>
 [x.priority,x.id,x.name,x.grade,x.candidates.join('; '),x.occupied,x.conflicts,x.first_url,x.action]);
tab('Заявления ИНН v1',['ID','Организация','ИНН','Метод','Ссылки','Уровень'],claims,x=>
 [x.id,x.name,x.inn,x.method,x.urls.join('; '),x.level]);
tab('Заявления связи v1',['ID','Организация','Текущий ИНН','Контактный ИНН','Телефон','URL','Уровень'],contacts,x=>
 [x.id,x.name,x.inn,x.other_inn,x.phone,x.url,x.level]);
tab('Заметки URL v1',['ID','Организация','Класс','Номер заметки','Заметка','URL','Уровень'],noteUrls,x=>
 [x.id,x.name,x.grade,x.note_index,x.note,x.url,x.level]);
tab('Алиасы остаток v1',['ID','Организация','Класс','ИНН кандидат','Текущий ИНН','Старый статус','URL'],aliases,x=>
 [x.id,x.name,x.grade,x.inn_candidate,x.current_inn,x.status,x.source_url]);
tab('Статусы ЮЛ v1',['ID','Организация','ИНН','Класс','Статус','Дата','URL','Актуальная выписка'],legal,x=>
 [x.id,x.name,x.inn,x.grade,x.status,x.event_date,x.urls.join('; '),'НЕ ПОЛУЧЕНА']);
tab('REVIEW компании v1',['ID','Организация','ИНН','Статус ЮЛ','Причина','URL'],review,x=>
 [x.id,x.name,x.inn,x.legal_status,x.reason,x.url]);
if(book.Sheets['Факт и источник']&&reviewed.length){
 XLSX.utils.sheet_add_aoa(book.Sheets['Факт и источник'],reviewed.map(x=>
 [x.id,x.name,'legal_identity',x.inn,x.ogrn,x.url,'']),{origin:-1});
}
const buffers={
 [outputs.json]:Buffer.from(JSON.stringify(data,null,2)),
 [outputs.audit]:Buffer.from(JSON.stringify(report,null,2)),
 [outputs.xlsx]:XLSX.write(book,{type:'buffer',bookType:'xlsx'})
};
const written=[];
try{for(const [p,v] of Object.entries(buffers)){fs.writeFileSync(p,v,{flag:'wx'});written.push(p);}}
catch(e){for(const p of written)try{fs.unlinkSync(p)}catch{}throw e;}
console.log(JSON.stringify({checkpoint_id:data.checkpoint_id,summary:report.summary,outputs},null,2));
