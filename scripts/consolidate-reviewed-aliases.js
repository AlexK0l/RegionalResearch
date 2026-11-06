#!/usr/bin/env node
// Apply ONLY explicitly reviewed legal-entity aliases to a detached offline copy.
// No OpenAI calls, no web requests, no checkpoint or input mutation.
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';

const args=process.argv.slice(2);
const input=args.find(x=>!x.startsWith('--'));
const flag=k=>args.find(x=>x.startsWith('--'+k+'='))?.slice(k.length+3);
const manifestFile=flag('manifest'),outDir=flag('out'),baseXlsx=flag('base-xlsx');
if(!input||!manifestFile||!outDir){
 console.error('Usage: node scripts/consolidate-reviewed-aliases.js <full-verified.json> --manifest=<reviewed.json> --out=<new-dir> [--base-xlsx=<verified.xlsx>]');
 process.exit(2);
}
const original=fs.readFileSync(path.resolve(input));
const data=JSON.parse(original.toString('utf8'));
const manifest=JSON.parse(fs.readFileSync(path.resolve(manifestFile),'utf8'));
if(data.checkpoint_id!==manifest.checkpoint_id)throw Error('Checkpoint mismatch');
if(!data.final_result||!Array.isArray(data.rows))throw Error('Full JSON must contain final_result and rows');
if(!Array.isArray(manifest.verified_alias_groups)||!Array.isArray(manifest.legal_status_findings))throw Error('Invalid alias manifest');
const sections={direct_buyers:'Прямые покупатели',intermediaries:'Посредники',leasing:'Лизинг'};
const columns=['Организация','Управляющая компания','ИНН','Город/район','Техника/сегмент','Основание','Телефон','Следующее действие','Почему им нужно звонить / потенциальный интерес к САТ','Руководитель / ЛПР','Выручка последнего подтвержденного года','Численность'];
const validInn=s=>{
 if(!/^\d{10}(?:\d{2})?$/.test(s))return false;
 const d=[...s].map(Number),check=(n,w)=>w.reduce((sum,k,i)=>sum+d[i]*k,0)%11%10===d[n];
 return s.length===10?check(9,[2,4,10,3,5,9,4,6,8]):
  check(10,[7,2,4,10,3,5,9,4,6,8])&&check(11,[3,7,2,4,10,3,5,9,4,6,8]);
};
const validOgrn=s=>/^\d{13}$/.test(s)&&Number(s.slice(-1))===Number(BigInt(s.slice(0,12))%11n%10n);
const map=new Map(),byInn=new Map(),idx=new Map();
for(const section of Object.keys(sections)){
 if(!Array.isArray(data.final_result[section]))throw Error('Missing section '+section);
 for(const row of data.final_result[section]){
  const id=row.__canonical_id;
  if(!id||map.has(id))throw Error('Bad canonical ID '+id);
  map.set(id,{row,section});
  const inn=String(row['ИНН']||'').trim();
  if(inn){
   if(byInn.has(inn))throw Error('Preexisting repeated INN '+inn);
   byInn.set(inn,id);
  }
 }
}
for(const r of data.rows){
 if(!r.canonical_id||idx.has(r.canonical_id))throw Error('Bad compact canonical ID');
 idx.set(r.canonical_id,r);
}
if(idx.size!==map.size||![...map.keys()].every(id=>idx.has(id)))throw Error('Compact/full JSON mismatch');
const seen=new Set(),seenNewInn=new Set();
for(const group of manifest.verified_alias_groups){
 const {survivor_id,absorbed_id,survivor_name,absorbed_name,survivor_sheet,absorbed_sheet,inn,ogrn,primary_url,secondary_url,reviewed_role}=group;
 if(!survivor_id||!absorbed_id||survivor_id===absorbed_id||seen.has(survivor_id)||seen.has(absorbed_id)||seenNewInn.has(inn))
  throw Error('Repeated or missing reviewed alias identity');
 if(!validInn(inn)||!validOgrn(ogrn)||!/^https:\/\//.test(primary_url)||!/^https:\/\//.test(secondary_url))
  throw Error('Bad verified identity or source URL');
 const a=map.get(survivor_id),b=map.get(absorbed_id);
 if(!a||!b||a.section!==survivor_sheet||b.section!==absorbed_sheet||reviewed_role!==survivor_sheet ||
    a.row['Организация']!==survivor_name||b.row['Организация']!==absorbed_name)throw Error('Alias names/roles do not match input');
 if(a.row['ИНН']||b.row['ИНН']||byInn.has(inn))throw Error('Cannot overwrite or duplicate an existing INN');
 if(!a.row.__replay_v5||a.row.__replay_v5.status!=='C'||b.row.__replay_v5?.status!=='C')
  throw Error('Only C/C reviewed aliases may be merged by this manifest');
 const urls=[...(a.row.__evidence?.source_urls||[]),...(b.row.__evidence?.source_urls||[])];
 if(!urls.includes(primary_url)&&!urls.includes(secondary_url))throw Error('No source provenance in input for reviewed alias');
 seen.add(survivor_id);seen.add(absorbed_id);seenNewInn.add(inn);
}
for(const status of manifest.legal_status_findings){
 const x=map.get(status.canonical_id);
 if(!x||x.row['Организация']!==status.name||String(x.row['ИНН'])!==status.inn||
   !validInn(status.inn)||!validOgrn(status.ogrn)||!Array.isArray(status.source_urls)||!status.source_urls.length)
  throw Error('Legal status reference is not tied to exact legal identity');
 if(!['LIQUIDATED_REPORTED','BANKRUPTCY_REPORTED_REQUIRES_EGRUL'].includes(status.status))
  throw Error('Unsupported legal status');
}
const merges=[],archived=[];
for(const group of manifest.verified_alias_groups){
 const a=map.get(group.survivor_id),b=map.get(group.absorbed_id);
 const winner=a.row,loser=b.row;
 const originalWinner=structuredClone(winner),originalLoser=structuredClone(loser);
 const conflicts={};
 for(const field of columns.slice(1)){
  if(field==='ИНН')continue;
  if(JSON.stringify(winner[field]||'')!==JSON.stringify(loser[field]||''))
   conflicts[field]={primary:winner[field]||'',absorbed:loser[field]||''};
 }
 for(const field of ['Телефон','Руководитель / ЛПР','Управляющая компания','Численность','Выручка последнего подтвержденного года'])
  if(!winner[field]&&loser[field])winner[field]=loser[field];
 winner['ИНН']=group.inn;
 winner.__merged_canonical_ids=[...new Set([...(winner.__merged_canonical_ids||[group.survivor_id]),...(loser.__merged_canonical_ids||[group.absorbed_id])])];
 winner.__evidence ||= {};
 winner.__evidence.source_urls=[...new Set([...(winner.__evidence.source_urls||[]),...(loser.__evidence?.source_urls||[]),group.primary_url,group.secondary_url])];
 winner.__evidence.notes=[...new Set([...(winner.__evidence.notes||[]),...(loser.__evidence?.notes||[]),
  'Reviewed alias '+manifest.reviewed_on+': '+group.justification+' '+group.primary_url])];
 winner.__evidence.facts ||= [];
 winner.__evidence.facts.push({kind:'legal_identity',field:'inn',value:group.inn,ogrn:group.ogrn,
   sources:[group.primary_url,group.secondary_url],verified_on:manifest.reviewed_on,entity_scope:'single_registered_legal_person'});
 winner.__verified_alias_resolution={primary_id:group.survivor_id,absorbed_id:group.absorbed_id,
  primary_before:originalWinner,absorbed_record:originalLoser,field_conflicts:conflicts,
  source_urls:[group.primary_url,group.secondary_url],verified_on:manifest.reviewed_on};
 winner.__legal_identity={inn:group.inn,ogrn:group.ogrn,source_url:group.primary_url,
   reviewed_role:group.reviewed_role,verified_on:manifest.reviewed_on};
 winner.__comment=String(winner.__comment||'')+
  '\n\n[Проверенный алиас '+manifest.reviewed_on+'] '+loser['Организация']+
  '; ИНН '+group.inn+'; ОГРН '+group.ogrn+'; '+group.primary_url+
  '\n'+String(loser.__comment||'');
 const list=data.final_result[b.section];
 const position=list.findIndex(x=>x.__canonical_id===group.absorbed_id);
 if(position<0)throw Error('Absorbed row not found');
 list.splice(position,1);
 const small=idx.get(group.survivor_id);
 small.inn=group.inn;small.source_ids=winner.__merged_canonical_ids;small.sheet=group.survivor_sheet;
 const index=data.rows.findIndex(x=>x.canonical_id===group.absorbed_id);
 if(index<0)throw Error('Absorbed index not found');
 data.rows.splice(index,1);
 merges.push({primary_id:group.survivor_id,absorbed_id:group.absorbed_id,primary_name:winner['Организация'],
   absorbed_name:loser['Организация'],primary_sheet:a.section,absorbed_sheet:b.section,
   inn:group.inn,ogrn:group.ogrn,source_url:group.primary_url,secondary_url:group.secondary_url,
   grade:'C',reason:group.justification,field_conflicts:conflicts});
 archived.push({canonical_id:group.absorbed_id,original_sheet:b.section,retained_with:group.survivor_id,record:originalLoser});
}
const legal=[];
for(const status of manifest.legal_status_findings){
 const row=map.get(status.canonical_id).row;
 row.__legal_status_review={status:status.status,event_date:status.event_date,
  reviewed_on:manifest.reviewed_on,source_urls:status.source_urls,
  note:status.note,requires_current_fns_extract:true,grade_unchanged:true};
 row.__evidence ||= {};row.__evidence.facts ||= [];
 row.__evidence.facts.push({kind:'legal_status',value:status.status,event_date:status.event_date,
  sources:status.source_urls,reviewed_on:manifest.reviewed_on,needs_fns_extract:true});
 row.__evidence.source_urls=[...new Set([...(row.__evidence.source_urls||[]),...status.source_urls])];
 row.__evidence.notes ||= [];
 row.__evidence.notes.push('Legal status reviewed '+manifest.reviewed_on+': '+status.note);
 row.__comment=String(row.__comment||'')+'\n\n[Юридический статус '+manifest.reviewed_on+'] '+status.note;
 legal.push({canonical_id:status.canonical_id,organization:row['Организация'],grade:row.__replay_v5.status,
  status:status.status,date:status.event_date,source_urls:status.source_urls,note:status.note});
}
const all=Object.keys(sections).flatMap(section=>data.final_result[section]);
const distinct=new Set(all.map(r=>r.__canonical_id));
if(all.length!==distinct.size||data.rows.length!==all.length)throw Error('Output row count mismatch');
const grades={A:0,B:0,C:0,REVIEW:0};
let withInn=0,sourceCount=0,factCount=0;
const priority=[],blank=[];
const owner=new Set();
for(const row of all){
 const grade=row.__replay_v5?.status;
 if(!(grade in grades))throw Error('Missing qualification grade');
 grades[grade]++;
 const inn=String(row['ИНН']||'').trim();
 if(inn){
  if(owner.has(inn)||!validInn(inn))throw Error('Bad or duplicate merged INN');
  owner.add(inn);withInn++;
 }else{
  blank.push(row);
  if(grade!=='C')priority.push(row);
 }
 sourceCount+=(row.__evidence?.source_urls||[]).length;
 factCount+=(row.__evidence?.facts||[]).length;
}
if(!all.every(r=>r.__comment&&String(r.__comment).trim()))throw Error('Missing first-cell company note');
// Keep the historical identity audit immutable, but recalculate current pending
// reviews after precisely verified aliases are matched by INN and legal name.
const historicalAliases=Array.isArray(data.identity_audit?.unresolved)
 ? data.identity_audit.unresolved : null;
const aliasReviewBefore=historicalAliases?.length ?? Number(data.summary.unresolved_alias_rows||0);
const acceptedAliasKeys=new Set(merges.flatMap(m=>[m.primary_name,m.absorbed_name]
 .map(name=>m.inn+'\t'+name)));
const aliasReviewResolved=historicalAliases
 ? historicalAliases.filter(item=>(item.names||[]).some(name=>
     acceptedAliasKeys.has(String(item.inn)+'\t'+name))).length : 0;
const aliasReviewRemaining=aliasReviewBefore-aliasReviewResolved;
if(aliasReviewRemaining<0)throw Error('Resolved alias count exceeds original review queue');
data.summary={...data.summary,total:all.length,with_inn:withInn,without_inn:blank.length,
 grades,full_records_in_json:all.length,stored_evidence_source_urls:sourceCount,
 verified_legal_alias_merges:merges.length,archived_absorbed_alias_records:archived.length,
 recorded_legal_status_findings:legal.length,facts_with_linked_sources:factCount,
 unresolved_alias_rows_before_consolidation:aliasReviewBefore,
 resolved_alias_review_rows:aliasReviewResolved,
 unresolved_alias_rows:aliasReviewRemaining,
 operational_working_copy_pending_egrul:true};
data.reviewed_alias_merges={reviewed_on:manifest.reviewed_on,merges,archived_original_records:archived,
 original_company_count:map.size,no_unreviewed_merges:true,
 initial_alias_review_rows:aliasReviewBefore,resolved_alias_review_rows:aliasReviewResolved,
 pending_alias_review_rows:aliasReviewRemaining};
data.legal_status_review={reviewed_on:manifest.reviewed_on,items:legal,requires_fns_confirmation:true};
data.working_draft_not_approved_for_crm=true;
const wb=baseXlsx?XLSX.readFile(path.resolve(baseXlsx),{cellStyles:true,cellComments:true}):XLSX.utils.book_new();
for(const [section,name] of Object.entries(sections)){
 const rows=data.final_result[section];
 const ws=XLSX.utils.aoa_to_sheet([columns,...rows.map(r=>columns.map(k=>r[k]??''))]);
 rows.forEach((r,i)=>{const c=ws['A'+(i+2)];if(c)XLSX.utils.cell_add_comment(c,String(r.__comment),'RegionalResearch');});
 ws['!cols']=columns.map(k=>({wch:k==='Организация'?46:k==='Основание'?80:k==='ИНН'?20:38}));
 if(wb.SheetNames.includes(name))wb.Sheets[name]=ws;
 else XLSX.utils.book_append_sheet(wb,ws,name);
}
function add(name,headers,items,mapper){
 if(wb.SheetNames.includes(name))throw Error('Audit tab already exists: '+name);
 const ws=XLSX.utils.aoa_to_sheet([headers,...items.map(mapper)]);
 ws['!cols']=headers.map(h=>({wch:String(h).includes('Организация')?46:40}));
 XLSX.utils.book_append_sheet(wb,ws,name);
}
add('Проверенные дубли',['Основной ID','Организация','Архивный ID','Алиас','ИНН','ОГРН','Раздел','Прежний раздел','Источник','Основание'],
 merges,m=>[m.primary_id,m.primary_name,m.absorbed_id,m.absorbed_name,m.inn,m.ogrn,
  m.primary_sheet,m.absorbed_sheet,m.source_url,m.reason]);
add('Архив алиасов',['Исходный ID','Название','Основной ID','Исходный раздел','Старое основание','Исходные URL','Примечание'],
 archived,a=>[a.canonical_id,a.record['Организация'],a.retained_with,a.original_sheet,
  a.record['Основание']||'',(a.record.__evidence?.source_urls||[]).join('\n'),a.record.__comment||'']);
add('Правовой статус',['ID','Организация','Класс','Статус','Дата','Комментарий','Источник 1','Источник 2'],
 legal,l=>[l.canonical_id,l.organization,l.grade,l.status,l.date,l.note,l.source_urls[0],l.source_urls[1]||'']);
add('Остаток без ИНН',['ID','Организация','Класс','Первый источник','ИНН из identity_verification','Следующий шаг'],
 blank,b=>[b.__canonical_id,b['Организация'],b.__replay_v5.status,
  b.__evidence?.source_urls?.[0]||'',b.__evidence?.identity_verification?.inn||'',
  'Установить точное ЮЛ и ОГРН. Не присваивать ИНН бренду или группе автоматически.']);
add('Факт и источник',['ID','Организация','Факт','Значение','ОГРН','Источник 1','Источник 2'],
 all.flatMap(r=>(r.__evidence?.facts||[]).filter(f=>f.kind==='legal_identity'||f.kind==='legal_status')
  .map(f=>({r,f}))),x=>[x.r.__canonical_id,x.r['Организация'],x.f.kind,x.f.value,
  x.f.ogrn||'',x.f.sources?.[0]||'',x.f.sources?.[1]||'']);
const summaries=new Map([
 ['Компаний в рабочей копии',all.length],['Подтверждено А',grades.A],
 ['Подтверждено B',grades.B],['Подтверждено C',grades.C],
 ['Требуют проверки',grades.REVIEW],['Заполнено ИНН',withInn],
 ['Нет ИНН',blank.length],['Полных записей в JSON',all.length],
 ['Сохранённых ссылок на источники',sourceCount],
 ['Остались спорные ИНН',aliasReviewRemaining]
]);
const sumTab=wb.Sheets['Сводка v5'];
if(sumTab){
 XLSX.utils.sheet_to_json(sumTab,{header:1,defval:''}).forEach((r,i)=>{
  const label=String(r[0]||'').trim();
  if(i&&label.startsWith('Архив ручной проверки вне ')){
   const name='A'+(i+1);
   sumTab[name]={...(sumTab[name]||{}),t:'s',v:'Архив ручной проверки вне '+all.length};
  }
  if(i&&!summaries.has(label))return;
  if(i){const key='B'+(i+1);sumTab[key]={...(sumTab[key]||{}),t:'n',v:summaries.get(label)};}
 });
}else{
 add('Сводка консолидации',['Показатель','Значение'],[...summaries],x=>x);
}
// Update inherited documentation without altering research-stage evidence.
if(wb.Sheets['Методика']){
 const method=wb.Sheets['Методика'];
 const entries=XLSX.utils.sheet_to_json(method,{header:1,defval:''});
 entries.slice(1).forEach((row,i)=>{
  if(String(row[0])==='Полный JSON'){
   const cell='B'+(i+2);
   const updated=String(row[1]||'').replace(/contains all \d+ complete records/,
    'contains all '+all.length+' complete records');
   method[cell]={...(method[cell]||{}),t:'s',v:updated};
  }
 });
 if(!entries.some(row=>String(row[0])==='Алиасы после консолидации')){
  XLSX.utils.sheet_add_aoa(method,[['Алиасы после консолидации',
   'Historical identity_audit.unresolved keeps '+aliasReviewBefore+
   ' pre-consolidation records; '+aliasReviewResolved+
   ' are now resolved, leaving '+aliasReviewRemaining+' pending.']],{origin:-1});
 }
}
if(wb.Sheets['Алиасы на проверку']){
 const tab=wb.Sheets['Алиасы на проверку'];
 XLSX.utils.sheet_to_json(tab,{header:1,defval:''}).slice(1).forEach((r,i)=>{
  const matched=merges.find(m=>String(r[0])===m.inn&&[m.primary_name,m.absorbed_name].includes(String(r[1])));
  if(matched){
   for(const [col,val] of [['C','RESOLVED_VERIFIED_ALIAS'],['D',matched.ogrn],['E','См. лист Проверенные дубли']]){
    const cell=col+(i+2);tab[cell]={t:'s',v:String(val)};
   }
  }
 });
}
const target=path.resolve(outDir);
fs.mkdirSync(target,{recursive:true});
const prefix='verified_aliases_'+String(data.checkpoint_id).slice(0,8);
const outputs={xlsx:path.join(target,prefix+'.xlsx'),json:path.join(target,prefix+'.json'),audit:path.join(target,prefix+'_audit.json')};
if(Object.values(outputs).some(fs.existsSync))throw Error('Output exists; choose a new --out directory');
const audit={checkpoint_id:data.checkpoint_id,source_rows:map.size,output_rows:all.length,
 merges,archived_rows:archived.length,legal_status_findings:legal,
 filled_inn:withInn,missing_inn:blank.length,grades,source_urls:sourceCount,
 linked_facts:factCount,priority_without_inn:priority.length,
 initial_alias_review_rows:aliasReviewBefore,resolved_alias_review_rows:aliasReviewResolved,
 pending_alias_review_rows:aliasReviewRemaining,
 no_paid_api_calls:true,requires_current_fns_extract:true};
const buffers={
 [outputs.json]:Buffer.from(JSON.stringify(data,null,2)),
 [outputs.audit]:Buffer.from(JSON.stringify(audit,null,2)),
 [outputs.xlsx]:XLSX.write(wb,{type:'buffer',bookType:'xlsx'})
};
const written=[];
try{
 for(const [file,bytes] of Object.entries(buffers)){fs.writeFileSync(file,bytes,{flag:'wx'});written.push(file);}
}catch(e){for(const f of written)try{fs.unlinkSync(f)}catch{}throw e;}
console.log(JSON.stringify({checkpoint_id:data.checkpoint_id,total:all.length,with_inn:withInn,
 missing_inn:blank.length,grades,merges:merges.length,legal_status_findings:legal.length,
 priority_without_inn:priority.length,outputs,openai_calls:0},null,2));
