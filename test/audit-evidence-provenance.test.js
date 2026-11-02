import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import XLSX from 'xlsx';
const script=fileURLToPath(new URL('../scripts/audit-evidence-provenance.js',import.meta.url));
function run(bad=false){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'evidence-provenance-'));
 const input=path.join(dir,'in.json'),xlsx=path.join(dir,'input.xlsx'),out=path.join(dir,'output');
 const make=(id,name,inn,grade,url)=>({__canonical_id:id,'Организация':name,'ИНН':inn,__comment:'Old comment '+id,
  __replay_v5:{status:grade,reason:'Archived'},__evidence:{facts:[],source_urls:[url],notes:[]}});
 const a=make('k1','ООО ПО «Энергоресурс»',bad?'6732191852':'6732191851','A','https://er67.ru/contact/');
 a.__verified_identity={inn:'6732191851',ogrn:'1206700002376',source_url:'https://er67.ru/contact/',checked_on:'2026-11-02',source_class:'first_party'};
 a.__evidence.identity_verification={inn:'6732191851',method:'final_inn_web',source_urls:['https://er67.ru/contact/']};
 const b=make('k2','Группа компаний','', 'A','https://example.org/brand');
 b.__evidence.identity_verification={inn:'6732191851',source_urls:['https://example.org/brand']};
 b.__evidence.contact_verification={inn:'6732191851',phone:'74812123456',source_url:'https://example.org/brand'};
 b.__evidence.notes=['Подтверждённый ИНН: 6732191851','Final INN conflict: incompatible identity','Прицепы — https://example.org/brand'];
 const c=make('k3','ООО Проверка','6722029257','REVIEW','https://base.garant.ru/66956404/');
 c.__evidence.facts=[{kind:'legal_status',value:'LIQUIDATED_REPORTED',sources:['https://base.garant.ru/66956404/']}];
 c.__legal_status_review={status:'LIQUIDATED_REPORTED',event_date:'2025-01-29',source_urls:['https://base.garant.ru/66956404/']};
 const obj={checkpoint_id:'test-checkpoint',summary:{total:3,with_inn:2,without_inn:1,grades:{A:2,B:0,C:0,REVIEW:1},facts_with_linked_sources:1},
  rows:[a,b,c].map(r=>({canonical_id:r.__canonical_id,inn:r['ИНН']})),
  final_result:{direct_buyers:[a,b,c],intermediaries:[],leasing:[]},
  identity_audit:{unresolved:[{inn:'6732191851',names:['Группа компаний'],identity_sources:['https://example.org/brand'],status:'insufficient_alias_evidence'}]}};
 fs.writeFileSync(input,JSON.stringify(obj));
 const w=XLSX.utils.book_new(),ws=XLSX.utils.aoa_to_sheet([['Организация','ИНН'],...obj.final_result.direct_buyers.map(r=>[r['Организация'],r['ИНН']])]);
 XLSX.utils.cell_add_comment(ws.A2,'Old comment k1','RegionalResearch');
 XLSX.utils.book_append_sheet(w,ws,'Прямые покупатели');
 XLSX.utils.book_append_sheet(w,XLSX.utils.aoa_to_sheet([['ID','Организация','Факт','Значение','ОГРН','Источник 1','Источник 2'],['k3','ООО Проверка','legal_status','LIQUIDATED_REPORTED','','https://base.garant.ru/66956404/','']]),'Факт и источник');
 XLSX.writeFile(w,xlsx);
 const before=[fs.readFileSync(input),fs.readFileSync(xlsx)];
 const call=(source=input,destination=out)=>spawnSync(process.execPath,[script,source,'--out='+destination,'--base-xlsx='+xlsx],{encoding:'utf8',timeout:40000});
 return {dir,input,xlsx,call,before};
}
test('promotes only earlier reviewed INN fact, not a conflicting brand INN or phone',()=>{
 const x=run();
 try{
  const proc=x.call();assert.equal(proc.status,0,proc.stderr);
  const response=JSON.parse(proc.stdout),summary=response.summary;
  assert.equal(summary.companies,3);
  assert.equal(summary.linked_facts_before,1);
  assert.equal(summary.linked_facts_after,2);
  assert.equal(summary.transferred_prior_reviewed_inns,1);
  assert.equal(summary.archived_identity_claims,1);
  assert.equal(summary.contact_identity_mismatch,1);
  assert.deepEqual(summary.missing_inn_priority,{P0:1,P1:0,P2:0,P3:0});
  const data=JSON.parse(fs.readFileSync(response.outputs.json));
  assert.equal(data.final_result.direct_buyers[0].__evidence.facts[0].value,'6732191851');
  assert.equal(data.final_result.direct_buyers[1]['ИНН'],'');
  assert.equal(data.final_result.direct_buyers[1].__evidence.facts.length,0);
  const audit=JSON.parse(fs.readFileSync(response.outputs.audit));
  assert.equal(audit.missing_inn[0].occupied[0].id,'k1');
  assert.equal(audit.archived_contact_claims[0].level,'SCOPE_MISMATCH_DO_NOT_TRANSFER');
  assert.equal(audit.legal_status_review[0].official_extract_received,false);
  const wb=XLSX.readFile(response.outputs.xlsx,{cellComments:true});
  assert.match(JSON.stringify(wb.Sheets['Прямые покупатели'].A2.c),/Old comment/);
  assert.equal(XLSX.utils.sheet_to_json(wb.Sheets['Факт и источник']).length,2);
  assert.deepEqual([fs.readFileSync(x.input),fs.readFileSync(x.xlsx)],x.before);
  assert.notEqual(x.call().status,0,'Must reject existing output');
  const again=x.call(response.outputs.json,path.join(x.dir,'another'));
  assert.notEqual(again.status,0);
  assert.match(again.stderr,/already applied/);
 }finally{fs.rmSync(x.dir,{recursive:true,force:true});}
});
test('rejects manually verified source mismatch, without writing exports',()=>{
 const x=run(true);
 try{
  const proc=x.call();assert.notEqual(proc.status,0);
  assert.match(proc.stderr,/Manual verification mismatch/);
  assert.deepEqual([fs.readFileSync(x.input),fs.readFileSync(x.xlsx)],x.before);
 }finally{fs.rmSync(x.dir,{recursive:true,force:true});}
});