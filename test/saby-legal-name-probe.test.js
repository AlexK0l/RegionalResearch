import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {fileURLToPath} from "node:url";
import {
  safeSabyLegalNameCandidate,summarizeSabyNameEvidence,
  probeSabyLegalNameFields
} from "../src/sabyLegalNameProbe.js";

const INN="6700018766";

test("legal-name field probe rejects contacts, email and registration numbers",()=>{
  for(const value of [
    "office@company.example","+7 (999) 123-45-67",
    "Контакты","Реквизиты","670001001",
    "Телефон 8 (800) 200-00-00"
  ]) assert.equal(safeSabyLegalNameCandidate(value),"",value);
  assert.equal(safeSabyLegalNameCandidate(
    "Акционерное общество Смоленская агропромышленная компания"),
    "Акционерное общество Смоленская агропромышленная компания");
});

test("probe records candidate labels without asserting registered legal identity",()=>{
  const text="Акционерное общество «Смоленская агропромышленная компания»";
  const report=summarizeSabyNameEvidence({
    values:[
      {label:"Название",candidate:text,context:"adjacent_line",
        sameInnBlock:true},
      {label:"Название",candidate:text,context:"adjacent_line",
        sameInnBlock:true},
      {label:"Телефон",candidate:"+7 999 123-45-67",context:"sibling",
        sameInnBlock:true},
      {label:"Краткое наименование",candidate:"Сапк, АО",context:"sibling",
        sameInnBlock:false}
    ],
    labels:["Название","КПП","ИНН","Реквизиты"],
    sections:["Реквизиты"],
    exactInnVisible:true,labelledInnVisible:true,labelledKppVisible:true
  },INN);
  assert.equal(report.reason,"observed_not_verified");
  assert.equal(report.candidates.length,2);
  assert.equal(report.candidates[0].name,text);
  assert.equal(report.sameOwnerScopeProven,false);
  assert.equal(report.labelledInnVisible,true);
  assert.equal(report.candidates.find(x=>x.label==="Телефон"),undefined);
});

test("probe enforces first-party detail page",async()=>{
  const wrong={
    url:()=>"https://evil.example/page/contractor-info",
    evaluate:async()=>{throw Error("Unexpected evaluate");}
  };
  assert.equal((await probeSabyLegalNameFields(wrong,INN)).reason,
    "not_detail_page");
  const detail={
    url:()=>"https://profile.saby.ru/page/contractor-info",
    evaluate:async()=>({
      values:[{label:"Полное наименование",candidate:"САПК, АО",
        context:"sibling",sameInnBlock:false}],
      labels:["Полное наименование"],sections:["О компании"],
      exactInnVisible:true
    })
  };
  const result=await probeSabyLegalNameFields(detail,INN);
  assert.equal(result.candidates[0].name,"САПК, АО");
  assert.equal(result.sameOwnerScopeProven,false);
});

test("probe command cannot silently change strict Stage12 identity acceptance",()=>{
  const script=fs.readFileSync(fileURLToPath(new URL(
    "../scripts/saby-identity-probe.js",import.meta.url)),"utf8");
  const src=fs.readFileSync(fileURLToPath(new URL(
    "../src/sabyLegalNameProbe.js",import.meta.url)),"utf8");
  assert.match(script,/auditSabyCompany\(page,row\)/);
  assert.match(script,/probeSabyLegalNameFields\(page,row\["ИНН"\]\)/);
  assert.match(src,/sameOwnerScopeProven:false/);
  assert.doesNotMatch(script,/applySabyEnrichment|runSabyStage12|writeFile.*SAT_/);
});
