import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import XLSX from 'xlsx';

const script=fileURLToPath(new URL('../scripts/audit-missing-inn-offline.js',import.meta.url));
const company=(id,name,inn,grade,notes=[],urls=[])=>({
 __canonical_id:id,'Организация':name,'ИНН':inn,
 __replay_v5:{status:grade},__evidence:{notes,source_urls:urls}
});
function fixture(mutator=()=>{},badReview=false){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'missing-inn-audit-'));
 const input=path.join(dir,'full.json'),review=path.join(dir,'research.json'),out=path.join(dir,'audit');
 const data={checkpoint_id:'f677c97e-test',final_result:{
  direct_buyers:[
   company('a','ООО Уже с ИНН','6732191851','A',[],['https://one.example/']),
   company('b','Группа компаний','', 'A',['Подтверждённый ИНН: 6732191851'],['https://one.example/']),
   company('c','ООО Без ИНН','', 'B',[],['https://two.example/']),
   company('e','ООО Неизвестное','', 'C',[],[]),
   company('f','ITECO','', 'REVIEW',[],['https://iteco.com/contacts'])
  ],intermediaries:[],leasing:[]}};
 mutator(data);
 const supplement={checkpoint_id:badReview?'another':data.checkpoint_id,
  priority_review:[{canonical_id:'b',organization:'Группа компаний',grade:'A',
    review_status:'ПРОВЕРИТЬ АЛИАС',candidate_inn:'6732191851',action:'Сравнить ОГРН'}],
  alias_groups:[]};
 fs.writeFileSync(input,JSON.stringify(data));fs.writeFileSync(review,JSON.stringify(supplement));
 const before=[fs.readFileSync(input),fs.readFileSync(review)];
 const run=()=>spawnSync(process.execPath,[script,input,'--out='+out,'--review='+review],
  {encoding:'utf8',timeout:30000});
 return {dir,input,review,out,before,run};
}
test('review detects candidate owned by another row and preserves source data',()=>{
 const x=fixture();
 try{
  const p=x.run();assert.equal(p.status,0,p.stderr);
  const r=JSON.parse(p.stdout);
  assert.equal(r.summary.original_company_count,5);
  assert.deepEqual(r.summary.missing_by_grade,{A:1,B:1,REVIEW:1,C:1});
  assert.equal(r.summary.human_research_annotations,1);
  assert.equal(r.summary.candidate_inn_already_used_in_another_row,1);
  assert.equal(r.summary.auto_filled_inns,0);
  assert.equal(r.summary.openai_calls,0);
  assert.deepEqual([fs.readFileSync(x.input),fs.readFileSync(x.review)],x.before);
  const output=JSON.parse(fs.readFileSync(r.outputs.json));
  assert.equal(output.rows.length,4);
  const match=output.rows.find(a=>a.canonical_id==='b');
  assert.deepEqual(match.inn_candidate_notes,['6732191851']);
  assert.equal(match.inn_already_used_in_records[0].canonical_id,'a');
  assert.equal(match.review_status,'ПРОВЕРИТЬ АЛИАС');
  const wb=XLSX.readFile(r.outputs.xlsx);
  assert.deepEqual(wb.SheetNames,['Итоги','A без ИНН','B без ИНН','REVIEW без ИНН',
   'C без ИНН','Алиасы на проверку','Методика']);
  assert.equal(XLSX.utils.sheet_to_json(wb.Sheets['C без ИНН']).length,1);
  assert.notEqual(x.run().status,0);
 }finally{fs.rmSync(x.dir,{recursive:true,force:true});}
});
test('stale research review is refused',()=>{
 const x=fixture(()=>{},true);
 try{
  const p=x.run();assert.notEqual(p.status,0);
  assert.match(p.stderr,/checkpoint or schema mismatch/);
 }finally{fs.rmSync(x.dir,{recursive:true,force:true});}
});
test('duplicate canonical IDs are rejected without writing output',()=>{
 const x=fixture(d=>d.final_result.direct_buyers[1].__canonical_id='a');
 try{
  const p=x.run();assert.notEqual(p.status,0);
  assert.match(p.stderr,/duplicate canonical ID/);
 }finally{fs.rmSync(x.dir,{recursive:true,force:true});}
});
