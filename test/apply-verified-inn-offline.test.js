import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import XLSX from 'xlsx';

const script=fileURLToPath(new URL('../scripts/apply-verified-inn-offline.js',import.meta.url));
const company=(id,name,inn)=>({
 'Организация':name,'ИНН':inn,'__canonical_id':id,
 '__comment':'Исторический источник',
 '__replay_v5':{status:'A',checkpoint:'test'},
 '__evidence':{source_urls:['https://example.org/prior'],notes:['Старое свидетельство'],facts:[]}
});
function trial(overrides={}){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'inn-verification-'));
 const input=path.join(temp,'combined.json'),manifest=path.join(temp,'manifest.json');
 const workbook=path.join(temp,'original.xlsx'),out=path.join(temp,'output');
 const rows=[company('k1','ООО ПО «Энергоресурс»',''),company('k2','Другая фирма',overrides.filledInn??'')];
 const j={checkpoint_id:'test',summary:{total:2,with_inn:overrides.filledInn?1:0,
  without_inn:overrides.filledInn?1:2,grades:{A:2,B:0,C:0,REVIEW:0}},
  rows:rows.map(r=>({canonical_id:r.__canonical_id,organization:r['Организация'],
   inn:r['ИНН'],status:'A',source_ids:[r.__canonical_id]})),
  final_result:{direct_buyers:rows,intermediaries:[],leasing:[],statistics:[],qualification_review:[]}};
 const m={checkpoint_id:overrides.checkpoint??'test',reviewed_on:'2026-11-02',verified_inns:[{
  canonical_id:'k1',organization:'ООО ПО «Энергоресурс»',inn:'6732191851',ogrn:'1206700002376',
  source_class:'first_party',source_url:'https://er67.ru/contact/',checked_on:'2026-11-02',notes:'Verified'}]};
 fs.writeFileSync(input,JSON.stringify(j));fs.writeFileSync(manifest,JSON.stringify(m));
 const wb=XLSX.utils.book_new(),ws=XLSX.utils.aoa_to_sheet([['Организация','Управляющая компания','ИНН'],
  ...rows.map(r=>[r['Организация'],'',r['ИНН']])]);
 XLSX.utils.cell_add_comment(ws.A2,'Исторический источник','RegionalResearch');
 XLSX.utils.book_append_sheet(wb,ws,'Прямые покупатели');
 XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Организация','ИНН']]),'Посредники');
 XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Организация','ИНН']]),'Лизинг');
 if(!overrides.noSummary){
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([
   ['Показатель','Значение'],
   ['Заполнено ИНН',overrides.filledInn?1:0],
   ['Нет ИНН',overrides.filledInn?1:2],
   ['Сохранённых ссылок на источники',2]
  ]),'Сводка v5');
 }

 XLSX.writeFile(wb,workbook);
 const before=[fs.readFileSync(input),fs.readFileSync(manifest),fs.readFileSync(workbook)];
 const run=()=>spawnSync(process.execPath,[script,input,'--manifest='+manifest,'--out='+out,'--base-xlsx='+workbook],
  {encoding:'utf8',timeout:40000});
 return {temp,input,manifest,workbook,out,before,run};
}
test('verified exact legal identity adds INN and source without changing original inputs',()=>{
 const x=trial();
 try{
  const p=x.run();assert.equal(p.status,0,p.stderr);
  assert.deepEqual([fs.readFileSync(x.input),fs.readFileSync(x.manifest),fs.readFileSync(x.workbook)],x.before);
  const out=JSON.parse(p.stdout);
  assert.equal(out.with_inn,1);assert.equal(out.verified,1);
  const d=JSON.parse(fs.readFileSync(out.outputs.json));
  assert.equal(d.final_result.direct_buyers.length,2);
  assert.equal(d.final_result.direct_buyers[0]['ИНН'],'6732191851');
  assert.equal(d.final_result.direct_buyers[1]['ИНН'],'');
  assert.equal(d.rows[0].inn,'6732191851');
  assert.equal(d.final_result.direct_buyers[0].__evidence.source_urls.length,2);
  assert.equal(d.final_result.direct_buyers[0].__replay_v5.status,'A');
  const w=XLSX.readFile(out.outputs.xlsx,{cellComments:true});
  assert.equal(w.Sheets['Прямые покупатели'].C2.v,'6732191851');
  assert.match(JSON.stringify(w.Sheets['Прямые покупатели'].A2.c),/er67.ru/);
  assert.ok(w.Sheets['ИНН проверены']);
  const stats=XLSX.utils.sheet_to_json(w.Sheets['Сводка v5'],{header:1});
  const values=new Map(stats.slice(1));
  assert.equal(values.get('Заполнено ИНН'),1);
  assert.equal(values.get('Нет ИНН'),1);
  assert.equal(values.get('Сохранённых ссылок на источники'),3);
  assert.notEqual(x.run().status,0,'Refuse overwrite');
 }finally{fs.rmSync(x.temp,{recursive:true,force:true});}
});
test('refuses an INN already used by another company',()=>{
 const x=trial({filledInn:'6732191851'});
 try{
  const p=x.run();assert.notEqual(p.status,0);assert.match(p.stderr,/INN already assigned/);
  assert.deepEqual([fs.readFileSync(x.input),fs.readFileSync(x.manifest),fs.readFileSync(x.workbook)],x.before);
 }finally{fs.rmSync(x.temp,{recursive:true,force:true});}
});
test('refuses checkpoint mismatch',()=>{
 const x=trial({checkpoint:'other'});
 try{
  const p=x.run();assert.notEqual(p.status,0);assert.match(p.stderr,/Checkpoint mismatch/);
  assert.ok(!fs.existsSync(path.join(x.out,'verified_inn_test.json')));
 }finally{fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('fails with actionable message for a legacy compact combined JSON',()=>{
 const x=trial();
 try{
  const compact=JSON.parse(fs.readFileSync(x.input,'utf8'));
  delete compact.final_result;
  fs.writeFileSync(x.input,JSON.stringify(compact));
  const before=fs.readFileSync(x.input);
  const p=x.run();
  assert.notEqual(p.status,0);
  assert.match(p.stderr,/final_result is missing/);
  assert.match(p.stderr,/compose:offline/);
  assert.match(p.stderr,/--out=<NEW-directory>/);
  assert.deepEqual(fs.readFileSync(x.input),before);
  assert.ok(!fs.existsSync(x.out));
 }finally{fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('standalone workbook with no legacy summary receives a current verification summary',()=>{
 const x=trial({noSummary:true});
 try{
  const p=x.run();assert.equal(p.status,0,p.stderr);
  const out=JSON.parse(p.stdout);
  const wb=XLSX.readFile(out.outputs.xlsx);
  const values=new Map(XLSX.utils.sheet_to_json(wb.Sheets['Сводка после ИНН'],{header:1}).slice(1));
  assert.equal(values.get('Заполнено ИНН'),1);
  assert.equal(values.get('Нет ИНН'),1);
  assert.equal(values.get('Сохранённых ссылок на источники'),3);
 }finally{fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('two successive manifests append to existing verification sheet and preserve both audit histories',()=>{
 const x=trial();
 try{
  const first=x.run();
  assert.equal(first.status,0,first.stderr);
  const firstResult=JSON.parse(first.stdout);
  const firstXlsx=firstResult.outputs.xlsx;
  const beforeFirst=fs.readFileSync(firstXlsx);
  const secondManifest=path.join(x.temp,'verified-second.json');
  const secondOutput=path.join(x.temp,'verified-second');
  fs.writeFileSync(secondManifest,JSON.stringify({
   checkpoint_id:'test',reviewed_on:'2026-11-02',
   verified_inns:[{canonical_id:'k2',organization:'Другая фирма',
    inn:'6713005690',ogrn:'1046745602221',
    source_class:'government_and_registry',
    source_url:'https://smolensk-gov.ru/doc/120340',
    checked_on:'2026-11-02',notes:'Second verified source'}]
  }));
  const second=spawnSync(process.execPath,[script,firstResult.outputs.json,
   '--manifest='+secondManifest,'--base-xlsx='+firstXlsx,'--out='+secondOutput],
   {encoding:'utf8',timeout:40000});
  assert.equal(second.status,0,second.stderr);
  assert.deepEqual(fs.readFileSync(firstXlsx),beforeFirst,'Prior Excel must stay untouched');
  const next=JSON.parse(second.stdout);
  assert.equal(next.with_inn,2);
  assert.equal(next.without_inn,0);
  assert.deepEqual(next.grades,{A:2});
  const full=JSON.parse(fs.readFileSync(next.outputs.json));
  assert.equal(full.summary.manually_verified_inns_added,2);
  assert.equal(full.summary.stored_evidence_source_urls,4);
  assert.equal(full.identity_verification_audit.changes.length,2);
  assert.deepEqual(full.identity_verification_audit.changes.map(c=>c.canonical_id),['k1','k2']);
  assert.equal(full.identity_verification_audit.latest_changes.length,1);
  assert.equal(full.identity_verification_audit.previous_verification_count,1);
  assert.equal(full.rows.find(r=>r.canonical_id==='k1').inn,'6732191851');
  assert.equal(full.rows.find(r=>r.canonical_id==='k2').inn,'6713005690');
  const audit=JSON.parse(fs.readFileSync(next.outputs.audit));
  assert.equal(audit.changes.length,1);
  assert.equal(audit.cumulative_changes.length,2);
  const workbook=XLSX.readFile(next.outputs.xlsx,{cellComments:true});
  const records=XLSX.utils.sheet_to_json(workbook.Sheets['ИНН проверены']);
  assert.equal(records.length,2);
  assert.deepEqual(records.map(r=>r.ID),['k1','k2']);
  const metrics=new Map(XLSX.utils.sheet_to_json(workbook.Sheets['Сводка v5'],{header:1}).slice(1));
  assert.equal(metrics.get('Заполнено ИНН'),2);
  assert.equal(metrics.get('Нет ИНН'),0);
  assert.equal(metrics.get('Сохранённых ссылок на источники'),4);
  assert.match(JSON.stringify(workbook.Sheets['Прямые покупатели'].A2.c),/er67.ru/);
  assert.match(JSON.stringify(workbook.Sheets['Прямые покупатели'].A3.c),/smolensk-gov.ru/);
  const rerun=spawnSync(process.execPath,[script,next.outputs.json,
   '--manifest='+secondManifest,'--base-xlsx='+next.outputs.xlsx,
   '--out='+path.join(x.temp,'duplicate-attempt')],{encoding:'utf8',timeout:40000});
  assert.notEqual(rerun.status,0,'Repeated INN must never be applied twice');
 }finally{fs.rmSync(x.temp,{recursive:true,force:true});}
});
