import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {buildReferenceWorkbookBuffer} from "../src/referenceWorkbookExport.js";

const root=fileURLToPath(new URL("../",import.meta.url));
const createTemplate=path.join(root,"test","fixtures","create-test-reference.py");
const exec=(args,opts={})=>spawnSync("python",args,{
  cwd:root,timeout:30000,maxBuffer:4_000_000,encoding:"utf8",...opts
});

function company(name,revenue,staff){
  return {
    "Организация":name,
    "ИНН":"7707083893",
    "Основание":"C — логистическая деятельность",
    "Выручка последнего подтвержденного года":revenue,
    "Численность":staff,
    "__comment":"Источник: https://profile.saby.ru"
  };
}

test("Saby financial columns export only digit-only Excel numbers on all 3 commercial sheets",async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"rr-finance-numeric-"));
  try {
    const template=path.join(dir,"template.xlsx");
    const output=path.join(dir,"output.xlsx");
    const generated=exec([createTemplate,template]);
    assert.equal(generated.status,0,generated.stderr);
    // Emulate a styled reference whose number formats would otherwise
    // display currency symbols, words and grouping on the user-facing XLSX.
    const modify=[
      "import sys",
      "from openpyxl import load_workbook",
      "w=load_workbook(sys.argv[1])",
      "for tab in ['Прямые покупатели','Лизинг','Посредники']:",
      "  sh=w[tab]",
      "  sh.cell(1,18,'Выручка последнего подтвержденного года')",
      "  sh.cell(1,19,'Численность')",
      "  sh.cell(2,18).number_format='#,##0 \"руб.\"'",
      "  sh.cell(2,19).number_format='0 \"чел.\"'",
      "w.save(sys.argv[1])"
    ].join("\n");
    const modified=exec(["-c",modify,template]);
    assert.equal(modified.status,0,modified.stderr);
    const data={
      direct_buyers:[
        company("ООО Одна",460300000,8),
        company("ООО Два","460 300 000","8"),
        company("ООО Три","460,3 млн ₽","8 чел."),
      ],
      intermediaries:[
        company("ООО Четыре",460300000,8),
        company("ООО Пять","460\u00a0300\u202f000","0"),
        company("ООО Шесть",true,"8.5")
      ],
      leasing:[
        company("ООО Семь",460300000,8),
        company("ООО Восемь",460300000.0,8.0),
        company("ООО Девять","-200","человек 8")
      ],
      statistics:[]
    };
    const original=structuredClone(data);
    const bytes=await buildReferenceWorkbookBuffer(data,{templatePath:template});
    fs.writeFileSync(output,bytes);
    assert.deepEqual(data,original,"XLSX export cannot mutate original checkpoint");

    const inspect=[
      "import sys,json",
      "from openpyxl import load_workbook",
      "w=load_workbook(sys.argv[1])",
      "out={}",
      "for tab in ['Прямые покупатели','Лизинг','Посредники']:",
      "  sh=w[tab]",
      "  heads=[c.value for c in sh[1]]",
      "  rev=heads.index('Выручка последнего подтвержденного года')+1",
      "  staff=heads.index('Численность')+1",
      "  out[tab]=[]",
      "  for row in [2,3,4]:",
      "    pair=[]",
      "    for col in [rev,staff]:",
      "      c=sh.cell(row,col)",
      "      pair.append([c.value,c.data_type,c.number_format])",
      "    out[tab].append(pair)",
      "print(json.dumps(out))"
    ].join("\n");
    const checked=exec(["-c",inspect,output]);
    assert.equal(checked.status,0,checked.stderr);
    const result=JSON.parse(checked.stdout);
    for(const tab of ["Прямые покупатели","Посредники","Лизинг"]){
      assert.deepEqual(result[tab][0],[[460300000,"n","0"],[8,"n","0"]],tab);
      assert.deepEqual(result[tab][1][0][2],"0");
      assert.deepEqual(result[tab][1][1][2],"0");
      assert.deepEqual(result[tab][2],[[null,"n","0"],[null,"n","0"]],
        "unit-bearing, negative and fractional values cannot enter numerical cells");
    }
    assert.deepEqual(result["Прямые покупатели"][1],
      [[460300000,"n","0"],[8,"n","0"]]);
    assert.deepEqual(result["Посредники"][1],
      [[460300000,"n","0"],[0,"n","0"]]);
    assert.deepEqual(result["Лизинг"][1],
      [[460300000,"n","0"],[8,"n","0"]]);
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test("Saby numerical fields are stored in JSON as integers, not text or currency",async()=>{
  const {parseSabyFinancialSnapshot}=await import("../src/sabyFinancials.js");
  const {applySabyEnrichment}=await import("../src/sabyEnrichment.js");
  const financial=parseSabyFinancialSnapshot({
    years:["2024","2025"],
    reportScale:"млн ₽",
    revenueRows:[["279.4","460.3"]],
    banner:"Выручка: 460.3 млн ₽",
    employeeTexts:["8"]
  },{nowYear:2026});
  const row=company("ООО Тест",null,null);
  const evidence={
    source:"SABY",
    source_url:"https://profile.saby.ru/page/contractor-info?id=company-1",
    identity:{verified:true,inn:"7707083893",name:"ООО Тест"},
    contacts:{status:"collected",phones:[],emails:[]},
    trucks:{status:"missing"},financials:financial
  };
  const updated=applySabyEnrichment(row,evidence);
  assert.equal(updated.status,"ok");
  for(const key of ["Выручка последнего подтвержденного года","Численность"]){
    assert.equal(typeof row[key],"number",key);
    assert.match(String(row[key]),/^[0-9]+$/,key);
  }
  assert.equal(row["Выручка последнего подтвержденного года"],460300000);
  assert.equal(row["Численность"],8);
});
