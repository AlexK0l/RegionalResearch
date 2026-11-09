import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath,pathToFileURL} from "node:url";
import {fixtureResult} from "../scripts/smoke-reference-xlsx.js";
import {formatPhoneCell} from "../src/phoneExport.js";

const root=fileURLToPath(new URL("../",import.meta.url));
const generator=fileURLToPath(new URL("./fixtures/create-test-reference.py",import.meta.url));
const exporter=fileURLToPath(new URL("../scripts/export-reference-xlsx.py",import.meta.url));
const verifier=fileURLToPath(new URL("../scripts/verify-reference-xlsx.py",import.meta.url));
const py=process.env.SAT_PYTHON_BIN||"python";
const utf8={...process.env,PYTHONIOENCODING:"utf-8",PYTHONUTF8:"1"};
const windows={...process.env,PYTHONIOENCODING:"cp1251",PYTHONUTF8:"0"};

function run(program,args,options={}){
 const x=spawnSync(program,args,{encoding:"utf8",timeout:30000,windowsHide:true,...options});
 assert.equal(x.status,0,program+" "+args[0]+" failed: "+
  (x.error||x.stderr||x.stdout||"unknown"));
 return x;
}
function check(template,output,data){
 const names=[data.direct_buyers[0]["Организация"],data.leasing[0]["Организация"],
  data.intermediaries[0]["Организация"]];
 run(py,[verifier,template,output,...names],{env:utf8});
 const cmd="import sys,json;from openpyxl import load_workbook;w=load_workbook(sys.argv[1]);"+
  "print(json.dumps([w['Прямые покупатели']['B2'].value,w['Лизинг']['C2'].value,"+
  "w['Посредники']['C2'].value],ensure_ascii=True))";
 const values=JSON.parse(run(py,["-c",cmd,output],{env:utf8}).stdout.trim());
 assert.deepEqual(values,names);
 assert.ok(values.every(value=>!value.includes("OLD-COMPANY")));
 const transportCmd="import sys,json;from openpyxl import load_workbook;w=load_workbook(sys.argv[1]);"+
   "print(json.dumps([w['Прямые покупатели']['C1'].value,w['Прямые покупатели']['C2'].value],ensure_ascii=True))";
 const transport=JSON.parse(run(py,["-c",transportCmd,output],{env:utf8}).stdout.trim());
 assert.equal(transport[0],"Наличие транспорта");
 assert.match(transport[1],/Saby \(грузовые\):/);
 // Only telephone numbers and proven department labels may appear in the
 // three original phone columns. Existing column positions are unchanged.
 const phoneCmd="import sys,json;from openpyxl import load_workbook;w=load_workbook(sys.argv[1]);"+
   "a=[];"+
   "[(a.append(w[n].cell(2,[c.value for c in w[n][1]].index('Телефон')+1).value)) for n in "+
   "['Прямые покупатели','Посредники','Лизинг']];"+
   "print(json.dumps(a,ensure_ascii=True))";
 const cells=JSON.parse(run(py,["-c",phoneCmd,output],{env:utf8}).stdout.trim());
 const rows=[data.direct_buyers[0],data.intermediaries[0],data.leasing[0]];
 assert.deepEqual(cells,rows.map(row=>formatPhoneCell(row["Телефон"])));
 assert.ok(cells.every(cell=>!/(?:saby|https?:|source|@)/i.test(cell||"")));
}
test("Python reads UTF-8 JSON correctly with Windows cp1251 configured",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"sat-utf8-py-"));
 try {
  const template=path.join(dir,"template.xlsx"),output=path.join(dir,"out.xlsx");
  run(py,[generator,template],{env:utf8});
  const data=fixtureResult("ЖЁЛТЫЙ");
  data.direct_buyers[0]["Телефон"]="Saby: +7 (812) 267-30-97 (отдел продаж); drs60@mail.ru";
  data.intermediaries[0]["Телефон"]="Официальный сайт: 8 (495) 123-45-67 (бухгалтерия)";
  data.leasing[0]["Телефон"]="Saby: 78122673097; https://example.org";
  run(py,[exporter,template,output],{env:windows,input:JSON.stringify(data)});
  check(template,output,data);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test("Node exporter overrides Windows cp1251 and supports two simultaneous exports",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"sat-utf8-node-"));
 try {
  const template=path.join(dir,"template.xlsx"),a=path.join(dir,"a.xlsx"),
   b=path.join(dir,"b.xlsx"),input=path.join(dir,"fixture.json");
  run(py,[generator,template],{env:utf8});
  const data=fixtureResult("ЖЁЛТЫЙ"),other=fixtureResult("ФИОЛЕТОВЫЙ");
  for(const item of [data,other]) {
    item.direct_buyers[0]["Телефон"]="Saby: +7 (812) 267-30-97 (отдел продаж)";
    item.intermediaries[0]["Телефон"]="Контакты: +7 (495) 123-45-67 (бухгалтерия)";
    item.leasing[0]["Телефон"]="Справочник: +7 (999) 123-45-67; email@example.com";
  }
  fs.writeFileSync(input,JSON.stringify({data,other}),"utf8");
  const url=pathToFileURL(path.join(root,"src","referenceWorkbookExport.js")).href;
  const script="import fs from 'node:fs';"+
   "import {buildReferenceWorkbookBuffer} from "+JSON.stringify(url)+";"+
   "const args=process.argv.slice(1);"+
   "const {data,other}=JSON.parse(fs.readFileSync(args[0],'utf8'));"+
   "const buffers=await Promise.all([buildReferenceWorkbookBuffer(data,{templatePath:args[1]}),"+
   "buildReferenceWorkbookBuffer(other,{templatePath:args[1]})]);"+
   "fs.writeFileSync(args[2],buffers[0]);fs.writeFileSync(args[3],buffers[1]);";
  run(process.execPath,["--input-type=module","-e",script,input,template,a,b],
   {env:windows,cwd:root});
  check(template,a,data);
  check(template,b,other);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
