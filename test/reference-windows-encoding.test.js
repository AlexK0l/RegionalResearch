import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath,pathToFileURL} from "node:url";
import {fixtureResult} from "../scripts/smoke-reference-xlsx.js";

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
}
test("Python reads UTF-8 JSON correctly with Windows cp1251 configured",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"sat-utf8-py-"));
 try {
  const template=path.join(dir,"template.xlsx"),output=path.join(dir,"out.xlsx");
  run(py,[generator,template],{env:utf8});
  const data=fixtureResult("ЖЁЛТЫЙ");
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
