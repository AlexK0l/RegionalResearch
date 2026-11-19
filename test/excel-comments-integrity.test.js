import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {decorateCompanyBasisForExport} from "../src/companyBasisNarrative.js";
import {buildReferenceWorkbookBuffer} from "../src/referenceWorkbookExport.js";

const root=fileURLToPath(new URL("../",import.meta.url));
const makeTemplate=path.join(root,"test","fixtures","create-test-reference.py");
const validator=path.join(root,"scripts","validate_xlsx_package.py");

function row(name,grade,claim,src){
  return {
    "Организация":name,
    "ИНН":"7707083893",
    "Основание":grade+" — В evidence одновременно подтверждены целевой груз/процесс и тяжелая автологистика или эксплуатационный сигнал.",
    "Электронная почта":"office@example.org",
    "Телефон":"+7 495 123-45-67",
    "Техника/сегмент":"Самосвальные полуприцепы",
    "__final_grade":grade,
    "__a_evidence":grade==="A"?claim+" "+src:"",
    "__comment":"Сайт/источник: "+src+"\nИНН: 7707083893\nДеятельность: Перевозка щебня и песка\nEmail: office@example.org",
    "__evidence":{
      source_urls:[src],notes:[claim+" "+src]
    }
  };
}
const run=(name,args,options={})=>spawnSync(name,args,{
  cwd:root,timeout:25000,maxBuffer:4_000_000,...options
});
const makeJson=(value)=>JSON.stringify(value);

test("organization popup begins with real company facts, never a long source URL",()=>{
  const src="https://example.org/"+("very-long-url-segment/").repeat(15);
  const record=row("ООО «ГрузЛом»","C",
    "Компания организует вывоз металлолома манипулятором и грузовиком; "+
    "собственный полуприцеп в источнике не подтверждён.",src);
  const raw={direct_buyers:[record],intermediaries:[],leasing:[],statistics:[]};
  const before=structuredClone(raw);
  const out=decorateCompanyBasisForExport(raw);
  const text=out.direct_buyers[0].__comment;
  assert.match(text,/^СВЕДЕНИЯ О КОМПАНИИ\nКраткое основание:/);
  assert.match(text,/Деятельность: Перевозка щебня и песка/);
  assert.ok(text.indexOf("Краткое основание:")<
    text.indexOf("Сайт/источник:"),"short explanation precedes long URL");
  assert.ok(text.indexOf("Деятельность:")<
    text.indexOf("Сайт/источник:"));
  assert.match(text,/Email: office@example.org/);
  assert.ok(text.includes(src),"source URL must not be dropped");
  assert.deepEqual(decorateCompanyBasisForExport(out),out,
    "on-demand repeated exports are idempotent");
  assert.deepEqual(raw,before);
});

test("real Excel has large legible VML notes and only one company note",async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"rr-excel-note-"));
  try{
    const template=path.join(dir,"template.xlsx"),out=path.join(dir,"out.xlsx");
    const created=run("python",[makeTemplate,template]);
    assert.equal(created.status,0,String(created.stderr));
    const result={
      direct_buyers:[
        row("ООО «Покупатель»","A",
          "Компания приобрела самосвальный полуприцеп ТОНАР 9523 по договору 2025 года.",
          "https://purchases.example/123"),
        row("=1+1","C",
          "Компания выполняет регулярную перевозку щебня из местного карьера.",
          "https://example.org/quarry")
      ],
      leasing:[row("ООО «Лизинг»","A",
        "Подписан договор лизинга полуприцепа Krone для грузоперевозчика.",
        "https://example.org/lease")],
      intermediaries:[row("ООО «Дилер»","B",
        "Дилер выполняет ремонт полуприцепов и продаёт их со склада.",
        "https://example.org/dealer")],
      statistics:[]
    };
    const saved=structuredClone(result);
    const book=await buildReferenceWorkbookBuffer(result,{templatePath:template});
    fs.writeFileSync(out,book);
    assert.deepEqual(saved,result,"export cannot mutate saved evidence");
    const valid=run("python",[validator,out],{encoding:"utf8"});
    assert.equal(valid.status,0,valid.stderr);
    assert.match(valid.stdout,/XLSX_PACKAGE_OK/);
    const inspect=[
      "import sys,json,zipfile,re",
      "from openpyxl import load_workbook",
      "w=load_workbook(sys.argv[1])",
      "out={'sheets':w.sheetnames}",
      "for name in ['Прямые покупатели','Лизинг','Посредники']:",
      "  s=w[name]",
      "  headers=[c.value for c in s[1]]",
      "  org=headers.index('Организация')+1",
      "  basis=headers.index('Основание')+1",
      "  n=s.cell(2,org).comment",
      "  b=s.cell(2,basis).comment",
      "  out[name]={'org':n.text if n else '',"+
      " 'basis':b.text if b else '',"+
      " 'check':s.cell(2,1).comment.text if s.cell(2,1).comment else '',"+
      " 'b_val':s.cell(2,basis).value}",
      "s=w['Прямые покупатели']",
      "out['formulaType']=s.cell(3,2).data_type",
      "out['formulaText']=s.cell(3,2).value",
      "with zipfile.ZipFile(sys.argv[1]) as z:",
      "  v=z.read('xl/drawings/commentsDrawing1.vml').decode('utf-8')",
      "  out['wide_note']=bool(re.search(r'width:500px;height:300px',v))",
      "sys.stdout.buffer.write(json.dumps(out,ensure_ascii=False).encode('utf-8'))"
    ].join("\n");
    const checked=run("python",["-c",inspect,out]);
    assert.equal(checked.status,0,String(checked.stderr));
    const report=JSON.parse(checked.stdout.toString("utf8"));
    assert.deepEqual(report.sheets,[
      "Прямые покупатели","Лизинг","Посредники",
      "Статистика","Легенда цветов"
    ]);
    for(const name of ["Прямые покупатели","Лизинг","Посредники"]){
      const r=report[name];
      assert.match(r.org,/^СВЕДЕНИЯ О КОМПАНИИ\nКраткое основание:/);
      assert.ok(r.org.indexOf("Краткое основание:")<
        r.org.indexOf("Сайт/источник:"));
      assert.match(r.basis,/Источник утверждения:/);
      assert.match(r.check,/Краткое основание:/,
        "checkbox retains a concise contractual note");
      assert.doesNotMatch(r.check,/https?:\/\//,
        "checkbox must not duplicate long source URL lists");
    }
    assert.equal(report.wide_note,true);
    assert.equal(report.formulaType,"s",
      "source text with leading '=' must not be an active Excel formula");
    assert.equal(report.formulaText,"=1+1");
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test("OOXML verifier rejects malformed note XML instead of serving Excel repair prompt",()=>{
  const py=[
    "import sys,zipfile",
    "from pathlib import Path",
    "p=Path(sys.argv[1])",
    "with zipfile.ZipFile(p,'w') as z:",
    "  z.writestr('[Content_Types].xml','<Types>')",
    "  z.writestr('_rels/.rels','<broken')",
    "  z.writestr('xl/workbook.xml','<workbook/>')",
    "  z.writestr('xl/_rels/workbook.xml.rels','<Relationships/>')"
  ].join("\n");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"rr-bad-xlsx-"));
  try{
    const filename=path.join(dir,"broken.xlsx");
    const created=run("python",["-c",py,filename],{encoding:"utf8"});
    assert.equal(created.status,0,created.stderr);
    const verify=run("python",[validator,filename],{encoding:"utf8"});
    assert.notEqual(verify.status,0);
    assert.match(verify.stderr,/XLSX malformed XML|XLSX archive is corrupt/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
