import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {
  formatPhoneCell,parsePhoneEntries,extractSabyPhoneDetails,
  sanitizedPhoneWorkbookData
} from "../src/phoneExport.js";
import {applySabyEnrichment} from "../src/sabyEnrichment.js";
import {buildWorkbookBuffer} from "../src/xlsx.js";

test("phone column contains only numbers and explicit departments, never sources/emails",()=>{
  const raw=[
    "Saby: +7 (812) 267-30-97 (отдел продаж)",
    "Официальный сайт: 8 (495) 123-45-67 — бухгалтерия",
    "email: abc@example.com",
    "https://example.org/contact"
  ].join(";\n");
  assert.equal(formatPhoneCell(raw),
    "78122673097 (отдел продаж); 74951234567 (бухгалтерия)");
  assert.ok(!formatPhoneCell(raw).includes("Saby"));
  assert.ok(!formatPhoneCell(raw).includes("example"));
});

test("without reliable department evidence phone has no fabricated title",()=>{
  assert.equal(formatPhoneCell("Saby: 78122673097"),"78122673097");
  assert.equal(formatPhoneCell("Справочник компаний: 8 812 267 30 97"),"78122673097");
  assert.equal(formatPhoneCell("Телефон +7 (812) 267-30-97; телефон +7 (812) 267-30-97"),
    "78122673097");
  assert.equal(formatPhoneCell("ИНН 6027087063; drs60@mail.ru; Сайт https://saby.ru"),
    "");
  assert.deepEqual(parsePhoneEntries(null),[]);
});

test("when department labels conflict we do not attribute the number to either",()=>{
  assert.equal(formatPhoneCell(
    "78122673097 (бухгалтерия); 78122673097 (отдел продаж); 78122673097 (бухгалтерия)"
  ),"78122673097");
});

test("Saby contacts support explicitly labeled department on preceding or same line",()=>{
  const raw="Контакты компании\nОтдел продаж\n+7 (999) 111-22-33\n"+
    "Бухгалтерия: +7 (999) 444-55-66\nПочта: test@example.ru";
  assert.deepEqual(extractSabyPhoneDetails(raw),[
    {phone:"79991112233",department:"отдел продаж"},
    {phone:"79994445566",department:"бухгалтерия"}
  ]);
});

test("Saby stage 12 writes multiple distinct phones but not their source",()=>{
  const row={"Организация":"ООО Тест","ИНН":"7707083893","Телефон":""};
  const result={
    source:"SABY",
    source_url:"https://profile.saby.ru/page/contractor-info",
    collected_at:"2026-11-09T10:16:24Z",
    identity:{verified:true,inn:"7707083893",name:"ООО Тест"},
    contacts:{
      phones:["79991112233","+7 (999) 444-55-66"],
      phone_details:[
        {phone:"79991112233",department:"Отдел продаж"},
        {phone:"79994445566",department:"Бухгалтерия"}
      ],
      emails:["test@example.ru"]
    },
    trucks:{status:"missing"}
  };
  const outcome=applySabyEnrichment(row,result);
  assert.equal(outcome.status,"ok");
  assert.equal(outcome.phoneAdded,true);
  assert.equal(row["Телефон"],
    "79991112233 (отдел продаж); 79994445566 (бухгалтерия)");
  assert.equal(row.__evidence.saby.phones.length,2);
  assert.equal(row.__evidence.saby.phone_details.length,2);
  assert.match(row.__comment,/Saby/);
  assert.match(row.__comment,/test@example.ru/);
  assert.doesNotMatch(row["Телефон"],/Saby|example|https?:/i);
});

test("known numbers are never replaced, even when Saby has a new one",()=>{
  const row={"Организация":"ООО Тест","ИНН":"7707083893",
    "Телефон":"79112223344 (отдел снабжения)"};
  const record={identity:{verified:true,inn:"7707083893",name:"ООО Тест"},
    source_url:"https://profile.saby.ru/page/contractor-info",
    contacts:{phones:["79991112233"],emails:[]}};
  const outcome=applySabyEnrichment(row,record);
  assert.equal(outcome.phoneAdded,false);
  assert.equal(row["Телефон"],"79112223344 (отдел снабжения)");
});

test("XLSX fallback enforces phone-only values on all three commercial sheets",()=>{
  const rawPhone="Saby: +7 (812) 267-30-97 (отдел продаж); https://site.example";
  const result={direct_buyers:[{"Организация":"Покупатель","Телефон":rawPhone}],
    intermediaries:[{"Организация":"Посредник","Телефон":rawPhone}],
    leasing:[{"Организация":"Лизинг","Телефон":rawPhone}],
    statistics:[]};
  const buffer=buildWorkbookBuffer(result);
  const wb=XLSX.read(buffer,{type:"buffer"});
  assert.equal(wb.SheetNames.length,6);
  const lookup=[["Прямые покупатели",37],["Посредники",26],["Лизинг",27]];
  for(const [name,width] of lookup) {
    const sheet=XLSX.utils.sheet_to_json(wb.Sheets[name],{header:1});
    assert.equal(sheet[0].length,width,name);
    const phoneAt=sheet[0].indexOf("Телефон");
    assert.ok(phoneAt>=0,name);
    assert.equal(sheet[1][phoneAt],"78122673097 (отдел продаж)",name);
  }
});

test("export normalization does not modify originals, comments or workbook structure",()=>{
  const row={"Организация":"Покупатель","Телефон":"Saby: 78122673097",
    "__comment":"Сайт/источник: https://profile.saby.ru",
    "__evidence":{source_urls:["https://profile.saby.ru"]}};
  const original={direct_buyers:[row],intermediaries:[],leasing:[],statistics:[]};
  const clone=sanitizedPhoneWorkbookData(original);
  assert.notEqual(clone,original);
  assert.notEqual(clone.direct_buyers[0],row);
  assert.equal(clone.direct_buyers[0]["Телефон"],"78122673097");
  assert.equal(row["Телефон"],"Saby: 78122673097");
  assert.equal(clone.direct_buyers[0].__comment,row.__comment);
  assert.equal(clone.direct_buyers[0].__evidence,row.__evidence);
  assert.deepEqual(Object.keys(clone),Object.keys(original));
});
