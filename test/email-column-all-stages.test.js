import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {
  EMAIL_COLUMN,normalizeEmail,parseEmailEntries,formatEmailCell,
  companyEmailCell,mergeCompanyEmail
} from "../src/emailContact.js";
import {applySabyEnrichment} from "../src/sabyEnrichment.js";
import {reuseIdentityObservedFacts} from "../src/identityFactReuse.js";
import {validBatchContactItem} from "../src/researchCostPolicy.js";
import {buildWorkbookBuffer} from "../src/xlsx.js";
import {sanitizedPhoneWorkbookData} from "../src/phoneExport.js";

const company=(inn="7707083893")=>({
  "Организация":"ООО Проверка", "ИНН":inn,
  "Телефон":"79991112233", "Электронная почта":"",
  "Основание":"C — подтверждено","__comment":"Email: не найден",
  "__evidence":{source_urls:["https://company.example/contacts"],notes:[]}
});

test("email columns hold addresses only, deduplicate case and preserve multiple legal contacts",()=>{
  assert.equal(EMAIL_COLUMN,"Электронная почта");
  assert.equal(normalizeEmail("MAILTO:Sales@Company.Example"),"sales@company.example");
  assert.equal(normalizeEmail("bad@@example.org"),"");
  assert.equal(formatEmailCell("Email: SALES@company.ru; help@company.ru; SALES@company.ru; не найден"),
    "sales@company.ru; help@company.ru");
  assert.deepEqual(parseEmailEntries(null),[]);
});

test("old SQLite comments hydrate email without mutating original JSON",()=>{
  const row=company();
  row.__comment="Сайт/источник: https://company.example/contacts\nEmail: Main@Company.Example";
  const snapshot=JSON.stringify(row);
  const out=sanitizedPhoneWorkbookData({
    direct_buyers:[row],intermediaries:[],leasing:[],statistics:[]
  });
  assert.equal(out.direct_buyers[0][EMAIL_COLUMN],"main@company.example");
  assert.equal(out.direct_buyers[0]["Телефон"],"79991112233");
  assert.equal(JSON.stringify(row),snapshot);
  assert.equal(mergeCompanyEmail(row,"SUPPORT@company.example"),true);
  assert.equal(row[EMAIL_COLUMN],"main@company.example; support@company.example");
});

test("Saby email can be used only for exact-INN collected source",()=>{
  const row=company();
  row.__evidence.saby={
    inn:row["ИНН"],source_url:"https://profile.saby.ru/page/contractor-info",
    collection:{contacts:"collected"},emails:["SALES@saby-check.example"]
  };
  assert.equal(companyEmailCell(row),"sales@saby-check.example");
  const wrongInn=structuredClone(row);
  wrongInn.__evidence.saby.inn="7707083000";
  assert.equal(companyEmailCell(wrongInn),"");
  const wrongHost=structuredClone(row);
  wrongHost.__evidence.saby.source_url="https://untrusted.example/page";
  assert.equal(companyEmailCell(wrongHost),"");
  const unresolved=structuredClone(row);
  unresolved.__evidence.saby.collection.contacts="review";
  assert.equal(companyEmailCell(unresolved),"");
});

test("exact-INN identity observation sources the email field, not a name-only candidate",()=>{
  const row=company(),source="https://company.example/contacts";
  const identity={
    confirmed_inn:row["ИНН"],source_urls:[source],
    observed_facts:[{
      field:"Email",value:"Director@company.example",
      source_url:source,evidence_excerpt:
        "ИНН 7707083893, официальный e-mail Director@company.example"
    }]
  };
  assert.equal(reuseIdentityObservedFacts(row,identity).length,1);
  assert.equal(row[EMAIL_COLUMN],"director@company.example");
  const wrong=company();
  identity.confirmed_inn="7707083888";
  assert.deepEqual(reuseIdentityObservedFacts(wrong,identity),[]);
  assert.equal(wrong[EMAIL_COLUMN],"");
});

test("Stage11 cited web batch email is accepted only when id, INN and name match",()=>{
  const row=company(),id="k000001";
  const source="https://company.example/contacts";
  const item={id,inn:row["ИНН"],organization:row["Организация"],status:"ok",
    phones:[],emails:["HQ@company.example"],leader:"",official_site:source,
    source_urls:[source],note:"Sourced"};
  assert.deepEqual(validBatchContactItem(item,row,id).emails,["hq@company.example"]);
  assert.equal(validBatchContactItem({...item,inn:"7707083894"},row,id),null);
  assert.equal(validBatchContactItem({...item,source_urls:[]},row,id),null);
  assert.equal(validBatchContactItem({...item,organization:"ООО Другая"},row,id),null);
});

test("Saby Stage12 populates email even when phone was previously known and fleet is unavailable",()=>{
  const row=company();
  const result={
    source:"SABY",source_url:"https://profile.saby.ru/page/contractor-info",
    identity:{verified:true,inn:row["ИНН"],name:row["Организация"]},
    contacts:{status:"collected",phones:[],emails:["Office@company.example"]},
    trucks:{status:"review"}
  };
  const beforeGrade=row["Основание"];
  const applied=applySabyEnrichment(row,result,{transport:true});
  assert.equal(applied.status,"ok");
  assert.equal(applied.emailAdded,true);
  assert.equal(applied.transportAdded,false);
  assert.equal(row[EMAIL_COLUMN],"office@company.example");
  assert.equal(row["Телефон"],"79991112233");
  assert.equal(row["Основание"],beforeGrade);
  assert.equal(row.__evidence.saby.collection.trucks,"review");
});

test("legacy six-sheet XLSX also places email immediately before phone on all three commercial tabs",()=>{
  const r=company();
  r.__comment="Email: billing@company.example";
  const result={direct_buyers:[r],intermediaries:[r],leasing:[r],statistics:[]};
  const wb=XLSX.read(buildWorkbookBuffer(result),{type:"buffer",cellFormula:true});
  for(const [sheet,count]of [
    ["Прямые покупатели",38],["Посредники",27],["Лизинг",28]
  ]){
    const data=XLSX.utils.sheet_to_json(wb.Sheets[sheet],{header:1,defval:""});
    const h=data[0],i=h.indexOf(EMAIL_COLUMN),j=h.indexOf("Телефон");
    assert.equal(i+1,j,sheet);
    assert.equal(h.length,count,sheet);
    assert.equal(data[1][i],"billing@company.example");
    assert.equal(data[1][j],"79991112233");
  }
  assert.match(wb.Sheets["Статистика по цветам"].D5.f,/\$L\$/);
});
