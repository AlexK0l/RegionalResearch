import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as XLSX from "xlsx";

const script=fileURLToPath(new URL("../scripts/finalize-research-offline.js",import.meta.url));
test("normal production completion is reproducible from a saved checkpoint entirely offline",()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"final-production-"));
 const input=path.join(tmp,"checkpoint.json"),dest=path.join(tmp,"out");
 const sample={
  version:1,region:"Смоленская область",phase:"completed",
  final_result:{statistics:[],intermediaries:[],leasing:[],
   qualification_review:[],qualification_excluded:[],
   direct_buyers:[{
    __canonical_id:"k1","Организация":"ООО «Тестовый Автопарк»",
    "Основание":"C — прежнее правило",
    "Телефон":"79991234567","ИНН":"",
    "Техника/сегмент":"грузовые полуприцепы",
    __final_grade:"C",
    __evidence:{source_urls:["https://example.org/actual"],facts:[],
      notes:["Компания эксплуатирует собственный парк тягачей и полуприцепов Schmitz Cargobull."]}
   }]}
 };
 try{
  fs.writeFileSync(input,JSON.stringify(sample));
  const old=fs.readFileSync(input);
  const run=()=>spawnSync(process.execPath,[script,input,"--out="+dest],
   {encoding:"utf8",timeout:45000});
  const out=run();assert.equal(out.status,0,out.stderr);
  const record=JSON.parse(out.stdout);
  assert.equal(record.report.grades.A,1);
  assert.equal(record.report.active_commercial_records,1);
  assert.equal(record.report.without_inn_commercial,1);
  assert.equal(record.report.openai_calls,0);
  assert.equal(record.report.originals_lost,0);
  assert.equal(JSON.parse(fs.readFileSync(record.outputs.json)).final_result.direct_buyers[0]["Телефон"],"79991234567");
  const wb=XLSX.read(fs.readFileSync(record.outputs.xlsx),{type:"buffer",cellComments:true});
  assert.equal(wb.SheetNames.length,6);
  assert.equal(XLSX.utils.sheet_to_json(wb.Sheets["Прямые покупатели"]).length,1);
  assert.ok(fs.existsSync(record.outputs.audit));
  assert.notEqual(run().status,0,"second run may not overwrite");
  assert.deepEqual(fs.readFileSync(input),old,"source file untouched");
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test("offline finalizer refuses checkpoints which have no final classification",()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"prequal-final-"));
 try{
  const input=path.join(tmp,"in.json");fs.writeFileSync(input,JSON.stringify({
   version:1,region:"Смоленская область",phase:"discovery",final_result:{direct_buyers:[],intermediaries:[],leasing:[]}
  }));
  const p=spawnSync(process.execPath,[script,input,"--out="+path.join(tmp,"o")],
   {encoding:"utf8",timeout:45000});
  assert.notEqual(p.status,0);
  assert.match(p.stderr,/predates final INN/);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});


test("offline CLI accepts fully reviewed legacy v8 JSON and reports only current REVIEW, not historical",()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"legacy-reviewed-v8-"));
 const input=path.join(tmp,"verified.json"),out=path.join(tmp,"out");
 try {
  const createRow=(id,name)=>({
   __canonical_id:id,"Организация":name,"ИНН":"",
   "Основание":"C — действующий процесс",
   "Город/район":"Смоленская область",
   "Техника/сегмент":"зерно и отгрузка",
   __final_grade:"C",
   __evidence:{source_urls:["https://example.org/"+id],
    notes:["Компания выращивает зерно и ведёт отгрузку продукции."]}
  });
  const legacy={
   checkpoint_id:"f677c97e-21ed-46cf-bd4a-43ba9cceea6a",
   final_result:{
    direct_buyers:[createRow("main","ООО Производитель")],intermediaries:[],leasing:[],statistics:[],
    qualification_review:Array.from({length:148},(_,i)=>createRow("old_"+i,"Старый "+i)),
    qualification_review_v5_archived:Array.from({length:148},(_,i)=>createRow("old_"+i,"Старый "+i)),
    qualification_review_v8:Array.from({length:7},(_,i)=>createRow("new_"+i,"Новый "+i)),
    qualification_excluded_v8:Array.from({length:2},(_,i)=>createRow("ex_"+i,"Исключённый "+i))
   }
  };
  fs.writeFileSync(input,JSON.stringify(legacy));
  const p=spawnSync(process.execPath,[script,input,"--out="+out],
    {encoding:"utf8",timeout:45000});
  assert.equal(p.status,0,p.stderr);
  const parsed=JSON.parse(p.stdout);
  assert.equal(parsed.report.original_row_count,10);
  assert.equal(parsed.report.review_records,7);
  assert.equal(parsed.report.excluded_records,2);
  assert.equal(parsed.report.historical_review_records_preserved,148);
  const result=JSON.parse(fs.readFileSync(parsed.outputs.json));
  assert.equal(result.final_result.qualification_review.length,7);
  assert.equal(result.final_result.qualification_review_v5_archived.length,148);
  assert.equal(result.final_quality_gate.originals_lost,0);
 }finally {fs.rmSync(tmp,{recursive:true,force:true});}
});
