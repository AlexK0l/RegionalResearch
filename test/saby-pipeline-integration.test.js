import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath, pathToFileURL} from "node:url";
import {runCheckpointedSabyStage12} from "../src/sabyCheckpointIntegration.js";
import {buildReferenceWorkbookBuffer} from "../src/referenceWorkbookExport.js";

const root=fileURLToPath(new URL("../",import.meta.url));
const generator=fileURLToPath(new URL("./fixtures/create-test-reference.py",import.meta.url));
const verifier=fileURLToPath(new URL("../scripts/verify-reference-xlsx.py",import.meta.url));
const storeUrl=new URL("../src/checkpointStore.js",import.meta.url).href;
const python=process.env.SAT_PYTHON_BIN||"python";

function row(name,inn,phone="",transport="") {
  return {
    "Организация":name,"ИНН":inn,"Телефон":phone,
    "Наличие транспорта":transport,"Основание":"C — существующее исследование",
    "__final_grade":"C",
    "__evidence":{source_urls:["https://official.example/"],notes:["Existing research"]},
    "__comment":"Сайт/источник: https://official.example/\nEmail: не найден"
  };
}
function fixture(){
  return {
    direct_buyers:[
      row("ООО Альфа","7707083893","74951234567 (отдел продаж)",
        "TORGBOX: Krone — 1 шт."),
      row("ООО Бета","7702070139"),
      row("ООО Гамма","7736207543")
    ],
    intermediaries:[row("ООО Посредник","7710140679","74951234568")],
    leasing:[row("ООО Лизинг","7707083900","74951234569")],
    statistics:[]
  };
}

function recordFor(company) {
  const inn=company["ИНН"];
  const name=company["Организация"];
  const special=inn==="7707083893";
  const list=special?
    [{model:"МАЗ 5516",year:2017}]:
    inn==="7702070139"?
      [{model:"КАМАЗ 5490",year:2020},{model:"КАМАЗ 5490",year:2020}]:[];
  const phone=inn==="7702070139" ? "+7 (999) 111-22-33" :
    inn==="7736207543" ? "+7 (999) 444-55-66" : "+7 (999) 888-77-66";
  return {
    source:"SABY",
    source_url:"https://profile.saby.ru/page/contractor-info",
    collected_at:"2026-11-09T09:00:00Z",
    identity:{inn,name,verified:true},
    contacts:{
      status:"collected",phones:[phone],
      phone_details:[{phone,department:"Отдел закупок"}],
      emails:[name.includes("Бета")?"beta@example.org":"office@example.org"]
    },
    trucks:{status:"verified",count:list.length,vehicles:list},
    errors:[]
  };
}

function run(program,args,opts={}){
  const out=spawnSync(program,args,{
    encoding:"utf8",timeout:40000,windowsHide:true,cwd:root,...opts
  });
  assert.equal(out.status,0,
    program+" failed: "+(out.error||out.stderr||out.stdout||"unknown"));
  return out;
}

test("production stage-12 boundary checkpoints, resumes without duplicates, and exports exact 5-sheet XLSX offline",async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"saby-stage12-endtoend-"));
  try {
    const result=fixture();
    const original=JSON.stringify(result);
    const checkpointPath=path.join(dir,"stage12-checkpoint.json");
    const visits=[];
    let flushes=0;
    const persistCheckpoint=async (phase,patch)=>{
      flushes++;
      fs.writeFileSync(checkpointPath,JSON.stringify({
        version:1,region:"Смоленская область",source_mode:"full",phase,
        ...structuredClone(patch)
      }),"utf8");
    };
    const sessionRunner=async task=>task({page:{},settings:{}});
    const collectCompany=async (_page,company)=>{
      visits.push(company["ИНН"]);
      return recordFor(company);
    };

    // Real stage 12 integration boundary, with the actual persistence
    // callback, simulated browser and no paid OpenAI API.
    const first=await runCheckpointedSabyStage12({
      result,env:{SABY_STAGE12_ENABLED:"true",SABY_MAX_COMPANIES:"1",
        SABY_CHECKPOINT_EVERY:"1",SABY_DELAY_MS:"250"},
      persistCheckpoint,sessionRunner,collectCompany
    });
    assert.equal(first.stats.verified,1);
    assert.equal(flushes,2); // per-company checkpoint + terminal snapshot
    assert.deepEqual(visits,["7702070139"]); // missing contacts first
    const saved=JSON.parse(fs.readFileSync(checkpointPath,"utf8"));
    assert.equal(saved.phase,"saby");
    assert.equal(saved.completed_stage,9);
    assert.deepEqual(saved.saby_completed_inns,["7702070139"]);
    assert.equal(saved.saby_deferred_inns.length,2);
    assert.equal(saved.final_result.direct_buyers[1]["Телефон"],
      "79991112233 (отдел закупок)");
    assert.match(saved.final_result.direct_buyers[1].__comment,
      /^Email: beta@example\.org$/m);
    assert.doesNotMatch(saved.final_result.direct_buyers[1].__comment,
      /^Email: не найден$/m);
    assert.equal(JSON.stringify(fixture()),original); // reference unaffected

    // Test real SQLite checkpoint serialization and load in a short-lived
    // child process so no database file handle remains on Windows.
    const program=[
      'import fs from "node:fs";',
      'import {saveCheckpoint,loadCheckpoint,checkpointSummary} from '+
        JSON.stringify(storeUrl)+';',
      'const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));',
      'await saveCheckpoint("saby-offline-check",value);',
      'const again=await loadCheckpoint("saby-offline-check");',
      'console.log(JSON.stringify({phase:again.phase,',
      'completed:again.saby_completed_inns,',
      'deferred:again.saby_deferred_inns.length,',
      'phone:again.final_result.direct_buyers[1]["Телефон"],',
      'summary:checkpointSummary(again),checkpoint:again}));'
    ].join("");
    const sqlite=run(process.execPath,["--input-type=module","-e",program,checkpointPath],{
      env:{...process.env,CHECKPOINT_DB_PATH:path.join(dir,"checkpoints.sqlite")}
    });
    const restored=JSON.parse(sqlite.stdout.trim());
    assert.equal(restored.phase,"saby");
    assert.deepEqual(restored.completed,["7702070139"]);
    assert.equal(restored.deferred,2);
    assert.equal(restored.summary.saby_completed,1);

    // Restore the serialized snapshot, not the original in-memory rows.
    const resumed=structuredClone(restored.checkpoint.final_result);
    const secondVisits=[];
    const second=await runCheckpointedSabyStage12({
      result:resumed,completedInns:restored.checkpoint.saby_completed_inns,
      env:{SABY_STAGE12_ENABLED:"true",SABY_MAX_COMPANIES:"0",
        SABY_CHECKPOINT_EVERY:"1",SABY_DELAY_MS:"250"},
      persistCheckpoint,sessionRunner,collectCompany:async (_page,company)=>{
        secondVisits.push(company["ИНН"]);
        return recordFor(company);
      }
    });
    assert.equal(second.stats.verified,2);
    assert.equal(second.stats.previouslyCompleted,1);
    assert.equal(second.stats.deferred,0);
    assert.deepEqual(secondVisits,["7736207543","7707083893"]);
    assert.equal(resumed.direct_buyers[0]["Телефон"],
      "74951234567 (отдел продаж)");
    assert.match(resumed.direct_buyers[0]["Наличие транспорта"],
      /TORGBOX: Krone/);
    assert.match(resumed.direct_buyers[0]["Наличие транспорта"],
      /Saby \(грузовые\): МАЗ 5516 \(2017 г\.\) — 1 шт\./);
    assert.match(resumed.direct_buyers[1]["Наличие транспорта"],
      /КАМАЗ 5490 \(2020 г\.\) — 2 шт\./);
    assert.equal(resumed.direct_buyers[1]["Телефон"],
      "79991112233 (отдел закупок)");
    for(const company of resumed.direct_buyers){
      assert.equal(company["Основание"],"C — существующее исследование");
      assert.equal(company.__final_grade,"C");
      assert.equal(company.__evidence.source_urls[0],"https://official.example/");
    }
    const after=JSON.parse(fs.readFileSync(checkpointPath,"utf8"));
    assert.equal(after.saby_completed_inns.length,3);
    assert.deepEqual(after.saby_deferred_inns,[]);

    // The exact strict-format exporter used by the HTTP server, not xlsx.js.
    const template=path.join(dir,"reference.xlsx");
    const output=path.join(dir,"result.xlsx");
    run(python,[generator,template]);
    const bytes=await buildReferenceWorkbookBuffer(resumed,{templatePath:template});
    fs.writeFileSync(output,bytes);
    run(python,[verifier,template,output,
      "ООО Альфа","ООО Лизинг","ООО Посредник"]);
    const cmd=[
      "import sys,json",
      "from openpyxl import load_workbook",
      "w=load_workbook(sys.argv[1])",
      "s=w['Прямые покупатели']",
      "print(json.dumps({'tabs':w.sheetnames,'head':s['C1'].value,'phone':s['G2'].value,"+
        "'transport':s['C2'].value,'comment':"+
        "(s['A3'].comment.text if s['A3'].comment else '')},ensure_ascii=True))"
    ].join(";");
    const excel=JSON.parse(run(python,["-c",cmd,output]).stdout.trim());
    assert.equal(excel.tabs.length,5);
    assert.equal(excel.head,"Наличие транспорта");
    assert.equal(excel.phone,"74951234567 (отдел продаж)");
    assert.match(excel.transport,/Saby \(грузовые\):/);
    assert.match(excel.comment,/Email: beta@example\.org/);
    assert.doesNotMatch(excel.phone,/Saby|source|http|@/i);
  }finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test("Saby browser failure defers rows, leaves original research unchanged and strict XLSX remains exportable",async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"saby-browser-failure-"));
  try {
    const result=fixture();
    const before=JSON.stringify(result);
    const checkpoints=[];
    const output=await runCheckpointedSabyStage12({
      result,
      env:{SABY_STAGE12_ENABLED:"true",SABY_MAX_COMPANIES:"5"},
      sessionRunner:async()=>{throw new Error("Chromium is not available");},
      collectCompany:()=>{throw new Error("must not reach collector");},
      persistCheckpoint:async (phase,patch)=>{
        checkpoints.push({phase,snapshot:structuredClone(patch)});
      }
    });
    assert.equal(output.stats.enabled,true);
    assert.equal(output.stats.verified,0);
    assert.equal(output.stats.processed,0);
    assert.equal(output.stats.deferred,3);
    assert.match(output.stats.browserError,/Chromium is not available/);
    assert.equal(checkpoints.length,1);
    assert.equal(checkpoints[0].phase,"saby");
    assert.equal(JSON.stringify(result),before);
    const template=path.join(dir,"reference.xlsx");
    run(python,[generator,template]);
    const bytes=await buildReferenceWorkbookBuffer(result,{templatePath:template});
    assert.ok(bytes.length>1000);
    const outfile=path.join(dir,"failure-still-exports.xlsx");
    fs.writeFileSync(outfile,bytes);
    run(python,[verifier,template,outfile,
      "ООО Альфа","ООО Лизинг","ООО Посредник"]);
  }finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test("disabled Saby stage never invokes browser and modifies no input",async()=>{
  const result=fixture(),before=JSON.stringify(result);
  let started=false,saveCalls=0;
  const out=await runCheckpointedSabyStage12({
    result,
    env:{SABY_STAGE12_ENABLED:"false"},
    sessionRunner:async()=>{started=true;throw Error("browser started");},
    persistCheckpoint:async()=>{saveCalls++;}
  });
  assert.equal(out.stats.enabled,false);
  assert.equal(started,false);
  assert.equal(saveCalls,0); // full pipeline stores its final checkpoint
  assert.equal(JSON.stringify(result),before);
});

test("pipeline calls the same checkpointed Saby adapter only after final QA",()=>{
  const code=fs.readFileSync(path.join(root,"src/pipeline.js"),"utf8");
  const qa=code.lastIndexOf("finalizeProductionResearch(finalResult");
  const stage=code.lastIndexOf("runCheckpointedSabyStage12({");
  assert.ok(qa>0 && stage>qa);
  assert.match(code,/completedInns:resumeCheckpoint\?\.saby_completed_inns/);
  assert.match(code,/persistCheckpoint,/);
  assert.match(code,/saby_completed_inns: sabyOutcome\.completedInns/);
  assert.match(code,/saby_deferred_inns: sabyOutcome\.deferredInns/);
  assert.match(code,/await persistCheckpoint\("completed"/);
});
