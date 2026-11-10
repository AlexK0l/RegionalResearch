import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {
  auditLegalForm,auditCompareName,auditExtractRequisites,
  auditLabelledInns,auditSearchName,auditSelectSearchResult,
  auditCompareIdentity,auditSourceRows
} from "../src/sabyIdentityAudit.js";
import {auditPickTitle} from "../src/sabyIdentityAuditBrowser.js";

const inn="6700018766",kpp="670001001";
const full="АО «Смоленская агропромышленная компания»";
const official='АКЦИОНЕРНОЕ ОБЩЕСТВО "СМОЛЕНСКАЯ АГРОПРОМЫШЛЕННАЯ КОМПАНИЯ"';
const source={"ИНН":inn,"Организация":full,"Телефон":""};
const requisiteText=[
  "О компании","Сапк, АО","Реквизиты",
  "Название",official,"ИНН",inn,"КПП",kpp,
  "ОГРН","1246700008136","ОКПО","49663433"
].join("\n");

test("all source sections are included, without Stage12 phone-based filtering",()=>{
  const raw={final_result:{
    direct_buyers:[source],
    intermediaries:[{...source,"ИНН":inn,"Телефон":"+7 123 456 78 90"}],
    leasing:[{"Организация":"Тест, ООО","ИНН":""}],
    statistics:[{"Total":3}]
  }};
  const entries=auditSourceRows(raw);
  assert.equal(entries.length,3);
  assert.deepEqual(entries.map(x=>x.group),
    ["direct_buyers","intermediaries","leasing"]);
  assert.deepEqual(entries.map(x=>x.index),[1,2,3]);
  assert.deepEqual(entries.map(x=>x.group_row),[1,1,1]);
  assert.throws(()=>auditSourceRows({direct_buyers:[]}),/массивы/);
});

test("legal forms work with Cyrillic boundaries and short Saby suffixes",()=>{
  for(const [name,legal] of [
    ["ООО Ромашка","ООО"],
    ["Общество с ограниченной ответственностью Ромашка","ООО"],
    ["АО «САПК»","АО"],
    ["Сапк, АО","АО"],
    ["ПАО АО Пример","ПАО"],
    ["Публичное акционерное общество «Пример»","ПАО"],
    ["ОАО Ромашка","ОАО"],
    ["ЗАО Ромашка","ЗАО"],
    ["ИП Иванов Иван","ИП"],
    ["Индивидуальный предприниматель Иванов","ИП"],
    ["ГК Атолл Групп",""]
  ])assert.equal(auditLegalForm(name),legal,name);
});

test("source-full vs Saby-short is candidate, never automatically verified",()=>{
  assert.equal(auditCompareName(full,"Сапк, АО"),"short_name_candidate");
  assert.equal(auditCompareName(full,official),"normalized_equal");
  assert.equal(auditCompareName("ООО Ромашка","АО Ромашка"),"legal_form_conflict");
  assert.equal(auditCompareName("ООО Ромашка","ООО Ромашка-Регион"),"short_name_candidate");
  assert.equal(auditCompareName(full,""),"not_available");
  assert.equal(auditCompareName("ООО АЛЬФА БЕТА ВЕКТОР","ООО АБВ"),
    "initials_candidate");
  assert.equal(auditCompareName("ООО АЛЬФА","ООО БЕТА"),"different");
});

test("only explicitly labelled requisites contribute legal name, INN and KPP",()=>{
  assert.deepEqual(auditExtractRequisites(requisiteText),[
    {name:official,inn,kpp,ogrn:"1246700008136"}
  ]);
  assert.deepEqual(auditExtractRequisites(
    "Связанные компании\nНазвание\n"+official+"\nИНН\n"+inn),[]);
  assert.deepEqual(auditExtractRequisites("Реквизиты\nПодробности бизнеса"),[]);
  assert.deepEqual(auditLabelledInns("Сапк, АО\nИНН "+inn),[inn]);
  assert.deepEqual(auditLabelledInns("ИНН\n"+inn+"\nКПП\n"+kpp),[inn]);
  assert.deepEqual(auditLabelledInns("похожие компании "+inn),[]);
});

test("exact INN and correct name selection allow short title as a candidate",()=>{
  const row={text:"Сапк, АО\n"+inn+"\nСмоленск",rect:{x:1,y:2,w:200,h:40}};
  const selected=auditSelectSearchResult([row],inn,full);
  assert.equal(selected.kind,"unique_inn");
  assert.equal(selected.row,row);
  assert.equal(selected.names[0],"Сапк, АО");
  const strict={text:full+"\n"+inn+"\nСмоленск",rect:{x:2}};
  assert.equal(auditSelectSearchResult([row,strict],inn,full).row,strict);
  assert.equal(auditSelectSearchResult([row,{...row,rect:{x:10}}],
    inn,full).kind,"ambiguous");
  assert.equal(auditSearchName("Юрлицо, ООО\n"+inn,inn),"Юрлицо, ООО");
  assert.equal(auditSelectSearchResult([
    {text:"ООО Чужая 16700018766"}],inn,full).kind,"not_found");
});

test("title selection skips navigation sections, preserving real card heading",()=>{
  assert.equal(auditPickTitle(["Контакты","Реквизиты","Сапк, АО",
    "Сведения о компании"]),"Сапк, АО");
  assert.equal(auditPickTitle([]),"");
});

test("verified requires independent detail INN and full name+INN requisites",()=>{
  const observation={
    searchCount:1,searchName:"Сапк, АО",searchNames:["Сапк, АО"],
    searchSelection:"unique_inn",opened:true,title:"Сапк, АО",
    headings:["Сапк, АО"],detailInns:[inn],
    requisites:auditExtractRequisites(requisiteText),
    route:"detail",requisitesSurface:"detail"
  };
  const ok=auditCompareIdentity(source,observation);
  assert.equal(ok.result,"verified");
  assert.equal(ok.title_relation,"short_name_candidate");
  assert.equal(ok.requisites_relation,"normalized_equal");
  assert.equal(ok.detail_inn_relation,"exact");
  assert.equal(ok.requisites_inn_relation,"exact");
  assert.equal(ok.saby_requisites_name,official);
  const noRequisites=auditCompareIdentity(source,{
    ...observation,requisites:[]
  });
  assert.equal(noRequisites.result,"review");
  assert.equal(noRequisites.reason,"short_title_without_registered_proof");
  const wrongRequisites=auditCompareIdentity(source,{
    ...observation,requisites:[{...observation.requisites[0],
      name:"ООО Чужая организация"}]
  });
  assert.equal(wrongRequisites.result,"conflict");
  assert.equal(wrongRequisites.reason,"registered_name_mismatch");
  const wrongInn=auditCompareIdentity(source,{
    ...observation,detailInns:["6700018767"]
  });
  assert.equal(wrongInn.result,"conflict");
  assert.equal(wrongInn.reason,"inn_mismatch");
  const missingInn=auditCompareIdentity(source,{
    ...observation,detailInns:[]
  });
  assert.equal(missingInn.result,"review");
});

test("source invalid, missing result, and ambiguous search are separate",()=>{
  assert.equal(auditCompareIdentity(source,{}).result,"not_found");
  assert.equal(auditCompareIdentity(source,
    {searchCount:2,opened:false}).result,"ambiguous");
  assert.equal(auditCompareIdentity({...source,"ИНН":"67000"},{}).result,
    "source_invalid");
  assert.equal(auditCompareIdentity(source,{failure:"browser_page_error"}).result,
    "error");
});

test("offline invalid-source audit produces real resumable JSON, XLSX and ZIP",()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"saby-audit-"));
  try {
    const file=path.join(folder,"sample.json");
    const prefix=path.join(folder,"identity");
    const raw={direct_buyers:[{"Организация":"ООО Без ИНН","ИНН":""}],
      intermediaries:[{"Организация":"ООО Некорректный ИНН","ИНН":"123"}],
      leasing:[],statistics:[]};
    fs.writeFileSync(file,JSON.stringify(raw));
    const cli=fileURLToPath(new URL("../scripts/saby-identity-audit.js",import.meta.url));
    const args=[cli,"--result="+file,"--out-prefix="+prefix,"--resume","--headless"];
    const run=()=>spawnSync(process.execPath,args,{
      encoding:"utf8",timeout:30000,
      env:{...process.env,SAT_PYTHON_BIN:process.env.SAT_PYTHON_BIN||"python"}
    });
    const first=run();
    assert.equal(first.status,0,first.stdout+"\n"+first.stderr);
    const report=JSON.parse(fs.readFileSync(prefix+".comparison.json","utf8"));
    assert.equal(report.summary.total,2);
    assert.equal(report.summary.recorded,2);
    assert.equal(report.summary.completed,true);
    assert.deepEqual(report.records.map(x=>x.result),
      ["source_invalid","source_invalid"]);
    assert.ok(fs.statSync(prefix+".xlsx").size>1000);
    assert.ok(fs.statSync(prefix+".zip").size>1000);
    const before=fs.readFileSync(prefix+".records.jsonl","utf8");
    const resumed=run();
    assert.equal(resumed.status,0,resumed.stdout+"\n"+resumed.stderr);
    assert.equal(fs.readFileSync(prefix+".records.jsonl","utf8"),before);
    fs.writeFileSync(file,JSON.stringify({...raw,statistics:[{"changed":true}]}));
    const changed=run();
    assert.equal(changed.status,1);
    assert.match(changed.stderr,/Исходный JSON изменился/);
  } finally {
    fs.rmSync(folder,{recursive:true,force:true});
  }
});
