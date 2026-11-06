#!/usr/bin/env node
// Offline Excel acceptance test. Uses the SAME exporter as the HTTP download
// handler, with a synthetic fixture or a pre-existing full-result JSON.
// Absolutely no OpenAI client, research pipeline, web browser, or SQLite used.
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildReferenceWorkbookBuffer } from "../src/referenceWorkbookExport.js";

const verifier=fileURLToPath(new URL("./verify-reference-xlsx.py",import.meta.url));

export function fixtureResult(label="A") {
  return {
    direct_buyers:[
      { "Организация":"ТЕСТ-ПОКУПАТЕЛЬ-"+label,
        "ИНН":"0012345678", "Основание":"B — демонстрационный грузопоток",
        "Телефон":"+7 (000) 000-00-00", "Цвет усл. форматирование":1,
        "Выручка последнего подтвержденного года":123456,
        "Численность":12, "Город/район":"ТЕСТОВЫЙ РАЙОН",
        "Техника/сегмент":"тестовый полуприцеп",
        "__comment":"Тестовое примечание. Нет настоящих компаний и API запросов." },
      { "Организация":"ТЕСТ-ПОКУПАТЕЛЬ-ВТОРОЙ-"+label,
        "ИНН":"0098765432", "Основание":"C — тестовый пример",
        "Цвет усл. форматирование":2, "__comment":"Второй тестовый комментарий" }
    ],
    leasing:[{"Организация":"ТЕСТ-ЛИЗИНГ-"+label,"ИНН":"0000000000",
      "Основание":"A — тестовое событие","__comment":"Тест лизинга"}],
    intermediaries:[{"Организация":"ТЕСТ-ПОСРЕДНИК-"+label,"ИНН":"0000000001",
      "Основание":"B — тестовый посредник","__comment":"Тест посредника"}],
    statistics:[{"Показатель":"Тестовое количество","Значение":2,
      "Единица измерения":"шт.","Период / дата актуальности":"ТЕСТ",
      "Источник":"https://example.org/test","Методика / примечание":"Только проверка оформления"}]
  };
}

export function unwrapResult(json) {
  const data=json?.final_result||json?.result||json;
  if(!data||typeof data!=="object"||!Array.isArray(data.direct_buyers)||
    !Array.isArray(data.intermediaries)||!Array.isArray(data.leasing)){
    throw new Error("Input must contain full result with direct_buyers, intermediaries and leasing arrays");
  }
  return data;
}

function option(args,key){
  const item=args.find(arg=>arg.startsWith("--"+key+"="));
  return item?item.slice(key.length+3):"";
}

async function verify(template, output, result){
  const python=String(process.env.SAT_PYTHON_BIN||"python").trim();
  const names=[
    result.direct_buyers?.[0]?.["Организация"]||"",
    result.leasing?.[0]?.["Организация"]||"",
    result.intermediaries?.[0]?.["Организация"]||""
  ];
  await new Promise((resolve,reject)=>{
    const child=spawn(python,[verifier,template,output,...names],{stdio:["ignore","pipe","pipe"],windowsHide:true});
    let stdout="",stderr="";
    child.stdout.on("data",data=>{stdout+=data.toString();});
    child.stderr.on("data",data=>{stderr+=data.toString();});
    child.once("error",e=>reject(new Error("Python XLSX verification unavailable: "+e.message)));
    child.once("close",code=>{
      if(code!==0)reject(new Error("XLSX verification failed:\n"+(stderr||stdout||"exit "+code)));
      else {process.stdout.write(stdout);resolve();}
    });
  });
}

async function main(){
  const args=process.argv.slice(2);
  if(args.includes("--help")||args.includes("-h")){
    console.log("Usage: npm run smoke:xlsx [-- full-result.json] [--out=exports/TEST.xlsx] [--template=PATH] [--parallel]");
    console.log("No input => synthetic organizations; --parallel => two simultaneous independent exports.");
    return;
  }
  const source=args.find(arg=>!arg.startsWith("--"));
  const label="A";
  const result=source?unwrapResult(JSON.parse(await fs.readFile(path.resolve(source),"utf8"))):fixtureResult(label);
  const template=path.resolve(option(args,"template")||process.env.SAT_XLSX_TEMPLATE_PATH||"data/SAT_reference_template.xlsx");
  const filename="SAT_reference_smoke_"+new Date().toISOString().replace(/[:.]/g,"-")+".xlsx";
  const output=path.resolve(option(args,"out")||path.join("exports",filename));
  const parallel=args.includes("--parallel");
  const outputs=parallel?[output,output.replace(/\.xlsx$/i,"_2.xlsx")]:[output];
  if(new Set(outputs).size!==outputs.length)throw new Error("Output paths must be distinct .xlsx files");
  for(const dest of outputs){
    if(!dest.toLowerCase().endsWith(".xlsx"))throw new Error("--out must have .xlsx extension");
    await fs.access(dest).then(()=>{throw new Error("Output already exists: "+dest);},err=>{
      if(err.code!=="ENOENT")throw err;
    });
  }
  const data=parallel?[result,source?result:fixtureResult("B")]:[result];
  const buffers=await Promise.all(data.map(item=>buildReferenceWorkbookBuffer(item,{templatePath:template})));
  for(let i=0;i<outputs.length;i++){
    await fs.mkdir(path.dirname(outputs[i]),{recursive:true});
    await fs.writeFile(outputs[i],buffers[i],{flag:"wx"});
    await verify(template,outputs[i],data[i]);
  }
  console.log(JSON.stringify({mode:source?"saved_result":"synthetic",outputs,paid_api_calls:0,
    research_started:false,checkpoint_modified:false},null,2));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(error=>{console.error(error?.message||String(error));process.exitCode=1;});
}
