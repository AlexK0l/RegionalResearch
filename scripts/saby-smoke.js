#!/usr/bin/env node
// Offline / Saby-only Windows acceptance test. No OpenAI API calls, no Google
// Sheets writes, and no modification of the source result or SQLite database.
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { withSabyBrowser } from "../src/sabyBrowser.js";
import { runSabyStage12 } from "../src/sabyStage12.js";
import { buildReferenceWorkbookBuffer } from "../src/referenceWorkbookExport.js";

function option(args, key, fallback="") {
  const value=args.find(a=>a.startsWith("--"+key+"="));
  return value===undefined ? fallback : value.slice(key.length+3);
}
const exists=async file=>fs.access(file).then(()=>true,()=>false);

async function main() {
  const args=process.argv.slice(2);
  if(args.includes("--help")||args.includes("-h")) {
    console.log("Saby-only test for Windows (NO OpenAI/Google Sheets calls):");
    console.log("  npm run saby:smoke -- --login");
    console.log("  npm run saby:smoke -- --inn=7707083893 --name=\\\"ПАО Сбербанк\\\" --limit=1");
    console.log("  npm run saby:smoke -- --result=SAT_Region.json --limit=3 --xlsx");
    console.log("  Optional: --profile=PATH --out=data/saby-smoke.json --headless");
    return;
  }
  const env={...process.env,SABY_STAGE12_ENABLED:"true",
    SABY_MAX_COMPANIES:option(args,"limit","1"),
    SABY_HEADLESS:args.includes("--headless")?"true":"false"};
  if(option(args,"profile"))env.SABY_PROFILE_DIR=option(args,"profile");
  if(args.includes("--login")) {
    await withSabyBrowser(async ({page})=>{
      await page.goto("https://profile.saby.ru/page/company-list-prof",
        {waitUntil:"domcontentloaded",timeout:60000});
      console.log("Войдите в Saby в открывшемся браузере, затем нажмите Enter здесь.");
      const rl=createInterface({input:process.stdin,output:process.stdout});
      await new Promise(resolve=>rl.question("Готово? Нажмите Enter: ",resolve));
      rl.close();
    },{env});
    console.log("Сессия Saby сохранена только в локальном профиле.");
    return;
  }
  let raw, source="single_company";
  const jsonFile=option(args,"result");
  if(jsonFile) {
    const file=path.resolve(jsonFile);
    raw=JSON.parse(await fs.readFile(file,"utf8"));
    source=file;
  } else {
    const inn=option(args,"inn"), name=option(args,"name");
    if(!inn||!name)throw new Error("Укажите --result=... либо --inn=... вместе с --name=...");
    raw={direct_buyers:[{"ИНН":inn,"Организация":name}],
      intermediaries:[],leasing:[],statistics:[]};
  }
  const base=raw?.final_result||raw?.result||raw;
  if(!base||!Array.isArray(base.direct_buyers)||
     !Array.isArray(base.intermediaries)||!Array.isArray(base.leasing)) {
    throw new Error("JSON должен содержать direct_buyers, intermediaries и leasing");
  }
  const result=structuredClone(base);
  console.log("Тестирую Saby без OpenAI и без изменения исходного JSON...");
  const response=await runSabyStage12({
    result,env,onProgress:async stats=>{
      console.log("Saby: "+stats.processed+"/"+stats.scheduled+
        " | проверено: "+stats.verified+" | review: "+stats.review);
    }
  });
  const output=path.resolve(option(args,"out",
    path.join("data","saby-smoke-"+Date.now()+".json")));
  await fs.mkdir(path.dirname(output),{recursive:true});
  if(await exists(output))throw new Error("Файл результата уже существует: "+output);
  await fs.writeFile(output,JSON.stringify({
    source, final_result:result, saby_stage12:response.stats
  },null,2)+"\n",{flag:"wx",mode:0o600});
  let xlsx="";
  if(args.includes("--xlsx")) {
    const target=output.replace(/\.json$/i,"")+".xlsx";
    if(await exists(target))throw new Error("Файл XLSX уже существует: "+target);
    const bytes=await buildReferenceWorkbookBuffer(result);
    await fs.writeFile(target,bytes,{flag:"wx"});
    xlsx=target;
  }
  console.log(JSON.stringify({
    checked:response.stats.verified,review:response.stats.review,
    contactUpdates:response.stats.phonesAdded,
    transportUpdates:response.stats.transportsAdded,
    deferred:response.stats.deferred,
    browserError:response.stats.browserError||null,
    json:output,excel:xlsx||null,
    openai_requests:0,google_sheets_writes:0,source_file_unchanged:true
  },null,2));
  if(response.stats.browserError||response.stats.review||
     (!response.stats.verified&&response.stats.scheduled))process.exitCode=2;
}

main().catch(error=>{console.error("Saby smoke:",error.message||String(error));process.exitCode=1;});
