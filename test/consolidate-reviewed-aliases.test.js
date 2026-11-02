import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import XLSX from 'xlsx';

const script=fileURLToPath(new URL('../scripts/consolidate-reviewed-aliases.js',import.meta.url));
const base=[
 ['k000374','АО «Агропромышленная фирма «Наша Житница»','', 'C','direct_buyers','https://agrogi.ru/legal/'],
 ['k000188','АО «АПФ «Наша Житница»','', 'C','direct_buyers','https://agrogi.ru/legal/'],
 ['k000398','АО «Кардымовский молочноконсервный комбинат»','', 'C','direct_buyers','https://www.tbank.ru/business/contractor/legal/1026700975707/'],
 ['k000579','АО «Кардымовский МКК»','', 'C','direct_buyers','https://econ-kard.admin-smolensk.ru/files/288/zao-mkk.pdf'],
 ['k000260','ООО «Торговая компания БЕЛАТОРГ»','', 'C','direct_buyers','https://belatorg.ru/rekvizity/'],
 ['k000221','ООО «ТК БЕЛАТОРГ»','', 'C','intermediaries','https://belatorg.ru/rekvizity/'],
 ['k000526','ООО «ГАГАРИНАВТОГРУЗ»','6722029257','REVIEW','direct_buyers','https://synapsenet.ru'],
 ['k000455','ООО «Экотрейд — Смоленск»','6731079470','C','direct_buyers','https://check.tochka.com'],
 ['k000002','МУП ЖКХ «НАДЕЖДА»','6714035433','A','direct_buyers','https://injust.pro']
];
function fixture(corrupt=false){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reviewed-aliases-'));
 const input=path.join(dir,'input.json'),manifest=path.join(dir,'manifest.json');
 const workbook=path.join(dir,'input.xlsx'),out=path.join(dir,'out');
 const columns=['Организация','Управляющая компания','ИНН','Город/район','Техника/сегмент','Основание','Телефон','Следующее действие','Почему им нужно звонить / потенциальный интерес к САТ','Руководитель / ЛПР','Выручка последнего подтвержденного года','Численность'];
 const j={checkpoint_id:'fixture',summary:{total:9,with_inn:3,without_inn:6,
  grades:{A:1,B:0,C:7,REVIEW:1}},rows:[],final_result:{direct_buyers:[],intermediaries:[],leasing:[],statistics:[],qualification_review:[]}};
 for(const [id,name,inn,grade,section,url] of base){
  const row={__canonical_id:id,'Организация':name,'ИНН':inn,'Основание':grade+' — archived',
   'Телефон':id==='k000260'?'78001007543':'',__comment:'Source '+url,
   __replay_v5:{status:grade},__evidence:{source_urls:[url],notes:['Archived note '+id],facts:[]}};
  j.final_result[section].push(row);
  j.rows.push({canonical_id:id,organization:name,sheet:section,inn,status:grade,source_ids:[id]});
 }
 const pairs=[
  [0,1,'6229026994','1026201086735','https://agrogi.ru/legal/','https://www.tbank.ru/business/contractor/legal/1026201086735/'],
  [2,3,'6708000520','1026700975707','https://www.tbank.ru/business/contractor/legal/1026700975707/','https://econ-kard.admin-smolensk.ru/files/288/zao-mkk.pdf'],
  [5,4,'6732102259','1156733002876','https://belatorg.ru/rekvizity/','https://check.tochka.com/company/1156733002876/']
 ];
 const m={checkpoint_id:corrupt?'other':'fixture',reviewed_on:'2026-11-02',
  verified_alias_groups:pairs.map(([a,b,inn,ogrn,first,second])=>({
    survivor_id:base[a][0],survivor_name:base[a][1],survivor_sheet:base[a][4],
    absorbed_id:base[b][0],absorbed_name:base[b][1],absorbed_sheet:base[b][4],
    inn,ogrn,primary_url:first,secondary_url:second,reviewed_role:base[a][4],justification:'Official legal alias'
  })),
  legal_status_findings:[
    {canonical_id:'k000526',name:'ООО «ГАГАРИНАВТОГРУЗ»',inn:'6722029257',ogrn:'1156733012424',
     status:'LIQUIDATED_REPORTED',event_date:'2025-01-29',
     source_urls:['https://base.garant.ru/66956404/'],note:'Appeal rejected'},
    {canonical_id:'k000455',name:'ООО «Экотрейд — Смоленск»',inn:'6731079470',ogrn:'1106731001156',
     status:'LIQUIDATED_REPORTED',event_date:'2021-03-05',
     source_urls:['https://check.tochka.com/company/1106731001156/'],note:'Reported liquidation'},
    {canonical_id:'k000002',name:'МУП ЖКХ «НАДЕЖДА»',inn:'6714035433',ogrn:'1146733013448',
     status:'BANKRUPTCY_REPORTED_REQUIRES_EGRUL',event_date:'2021-07-10',
     source_urls:['https://injust.pro/proverka/6714035433'],note:'Bankruptcy'}
  ]};
 fs.writeFileSync(input,JSON.stringify(j));fs.writeFileSync(manifest,JSON.stringify(m));
 const wb=XLSX.utils.book_new();
 for(const [section,title] of [['direct_buyers','Прямые покупатели'],['intermediaries','Посредники'],['leasing','Лизинг']]){
  const ws=XLSX.utils.aoa_to_sheet([columns,...j.final_result[section].map(r=>columns.map(k=>r[k]||''))]);
  j.final_result[section].forEach((r,i)=>XLSX.utils.cell_add_comment(ws['A'+(i+2)],r.__comment,'RegionalResearch'));
  XLSX.utils.book_append_sheet(wb,ws,title);
 }
 XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Показатель','Значение'],['Компаний в рабочей копии',9]]),'Сводка v5');
 XLSX.writeFile(wb,workbook);
 const old=[fs.readFileSync(input),fs.readFileSync(manifest),fs.readFileSync(workbook)];
 const run=(dest=out)=>spawnSync(process.execPath,[script,input,'--manifest='+manifest,'--base-xlsx='+workbook,'--out='+dest],{encoding:'utf8',timeout:45000});
 return {dir,input,manifest,workbook,out,old,run};
}
test('verified legal aliases consolidate to single entities while preserving all original records in the archive',()=>{
 const x=fixture();
 try{
  const p=x.run();assert.equal(p.status,0,p.stderr);
  const response=JSON.parse(p.stdout);
  assert.equal(response.total,6);assert.equal(response.with_inn,6);assert.equal(response.merges,3);
  assert.equal(response.missing_inn,0);assert.deepEqual(response.grades,{A:1,B:0,C:4,REVIEW:1});
  const data=JSON.parse(fs.readFileSync(response.outputs.json));
  assert.equal(data.reviewed_alias_merges.archived_original_records.length,3);
  assert.equal(data.final_result.intermediaries.length,1);
  assert.equal(data.final_result.intermediaries[0]['ИНН'],'6732102259');
  assert.deepEqual(data.final_result.intermediaries[0].__merged_canonical_ids,['k000221','k000260']);
  assert.equal(data.final_result.intermediaries[0]['Телефон'],'78001007543');
  assert.equal(data.final_result.intermediaries[0].__evidence.facts.length,1);
  assert.equal(data.final_result.direct_buyers.find(r=>r.__canonical_id==='k000002').__replay_v5.status,'A');
  assert.equal(data.legal_status_review.items.length,3);
  const wb=XLSX.readFile(response.outputs.xlsx,{cellComments:true});
  assert.equal(XLSX.utils.sheet_to_json(wb.Sheets['Проверенные дубли']).length,3);
  assert.equal(XLSX.utils.sheet_to_json(wb.Sheets['Архив алиасов']).length,3);
  assert.equal(XLSX.utils.sheet_to_json(wb.Sheets['Прямые покупатели']).length,5);
  assert.ok(wb.Sheets['Посредники'].A2.c);
  assert.match(JSON.stringify(wb.Sheets['Посредники'].A2.c),/k000260|БЕЛАТОРГ/);
  assert.deepEqual([fs.readFileSync(x.input),fs.readFileSync(x.manifest),fs.readFileSync(x.workbook)],x.old);
  assert.notEqual(x.run().status,0,'Never overwrite an existing output');
 }finally{fs.rmSync(x.dir,{recursive:true,force:true});}
});
test('rejects mismatched manifest checkpoint before changing inputs',()=>{
 const x=fixture(true);
 try{
  const p=x.run();assert.notEqual(p.status,0);
  assert.match(p.stderr,/Checkpoint mismatch/);
  assert.deepEqual([fs.readFileSync(x.input),fs.readFileSync(x.manifest),fs.readFileSync(x.workbook)],x.old);
 }finally{fs.rmSync(x.dir,{recursive:true,force:true});}
});
