import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {buildReferenceWorkbookBuffer} from "../src/referenceWorkbookExport.js";

const root=fileURLToPath(new URL("../",import.meta.url));
// The private production template is intentionally NOT tracked in GitHub.
// Create the approved five-sheet structural fixture in a temporary folder.
const fixture=path.join(root,"test","fixtures","create-test-reference.py");
function sample(grade,org,claim,source){
  return {
    "Организация":org,"ИНН":"7707083893","Основание":
      grade+" — В evidence подтверждены целевой груз/процесс и конкретный транспортно-логистический сигнал, но недостаточно данных для A/B.",
    "Итоговый коэффициент":23,"Расчётный коэффициент":13,
    "Наличие транспорта":"","Телефон":"","Электронная почта":"info@example.org",
    "__final_grade":grade,
    "__a_evidence":grade==="A"?claim+" "+source:"",
    "__comment":"Деятельность: перевозка щебня и песка\n"+
      "Сайт/источник: "+source,
    "__evidence":{notes:[claim+" "+source],source_urls:[source]}
  };
}

test("real strict five-sheet Excel puts narrative in D/H and linked comments in same cells",async()=>{
  const evidence="В 2026 году предприятие заключило контракт на перевозку "+
    "зерна с использованием грузовых автопоездов";
  const source="https://example.org/tender/2026";
  const result={
    direct_buyers:[sample("A","ООО «Тест-покупатель»",
      "Компания приобрела полуприцеп-самосвал ТОНАР по договору 2025 года",
      "https://example.org/tonar")],
    leasing:[sample("A","ООО «Тест-лизинг»",
      "Лизинговый договор 2025 года передал тягач и полуприцеп клиенту",
      "https://example.org/lease")],
    intermediaries:[sample("C","ООО «Тест-перевозка»",evidence,source)],
    statistics:[]
  };
  const input=structuredClone(result);
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"rr-basis-notes-"));
  const templatePath=path.join(folder,"reference.xlsx");
  const created=spawnSync("python",[fixture,templatePath],{cwd:root,timeout:15000});
  assert.equal(created.status,0,String(created.stderr));
  // The synthetic reference template has generic placeholder headings in
  // E/F; declare the two user-facing coefficient headers for this test.
  const editHeaders=[
    "from openpyxl import load_workbook",
    "import sys",
    "w=load_workbook(sys.argv[1])",
    "s=w['Прямые покупатели']",
    "s['E1']='Итоговый коэффициент'",
    "s['F1']='Расчётный коэффициент'",
    "w.save(sys.argv[1])"
  ].join("\n");
  const patched=spawnSync("python",["-c",editHeaders,templatePath],{cwd:root,timeout:15000});
  assert.equal(patched.status,0,String(patched.stderr));
  const bytes=await buildReferenceWorkbookBuffer(result,{templatePath});
  assert.equal(Buffer.isBuffer(bytes),true);
  const python=[
    "import io,json,sys",
    "from openpyxl import load_workbook",
    "wb=load_workbook(io.BytesIO(sys.stdin.buffer.read()))",
    "out={'tabs':wb.sheetnames}",
    "for name,reasoncol,orgcol in [('Прямые покупатели',4,2),('Лизинг',8,3),('Посредники',8,3)]:",
    "  ws=wb[name]",
    "  out[name]={'basis':ws.cell(2,reasoncol).value,",
    "    'basis_note':ws.cell(2,reasoncol).comment.text if ws.cell(2,reasoncol).comment else None,",
    "    'organization_note':ws.cell(2,orgcol).comment.text if ws.cell(2,orgcol).comment else None,",
    "    'rows':[c.value for c in ws[1]],",
    "    'score':ws.cell(2,5).value if name=='Прямые покупатели' else None,",
    "    'untouched_f':ws.cell(2,6).value if name=='Прямые покупатели' else None}",
    "sys.stdout.buffer.write(json.dumps(out,ensure_ascii=False).encode('utf-8'))"
  ].join("\n");
  const run=spawnSync("python",["-c",python],{
    cwd:root,input:bytes,maxBuffer:2_000_000,timeout:15000
  });
  assert.equal(run.status,0,String(run.stderr));
  const x=JSON.parse(run.stdout.toString("utf8"));
  assert.deepEqual(x.tabs,[
    "Прямые покупатели","Лизинг","Посредники","Статистика","Легенда цветов"]);
  for(const [name,expected] of [
    ["Прямые покупатели","ТОНАР"],
    ["Лизинг","Лизинговый договор"],
    ["Посредники","контракт на перевозку зерна"]]){
    const row=x[name];
    assert.match(row.basis,new RegExp(expected,"i"),name);
    assert.match(row.basis_note,/Источник утверждения:/,name);
    assert.match(row.organization_note,/Краткое основание:/,name);
    assert.equal(row.rows.filter(h=>h==="Основание").length,1);
    assert.equal(row.rows.indexOf("Электронная почта")+1,
      row.rows.indexOf("Телефон"));
  }
  assert.equal(x["Прямые покупатели"].score,23);
  assert.equal(x["Прямые покупатели"].untouched_f,13);
  assert.deepEqual(result,input,"export must not mutate source JSON");
  fs.rmSync(folder,{recursive:true,force:true});
});
