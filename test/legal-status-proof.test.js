import test from "node:test";
import assert from "node:assert/strict";
import {acceptedLegalStatusProof,commercialEligibility} from "../src/qualificationSafety.js";

const inn="7707083893";
const row=(evidence_excerpt,source_url="https://service.nalog.ru/download/7707083893",extra={})=>({
  "Организация":"ООО Альфа","ИНН":inn,
  __evidence:{legal_status_verification:{inn,status:"ceased",source_url,evidence_excerpt,...extra}}
});

test("explicit cessation with exact INN and an official entity source is retained",()=>{
  const r=row("ИНН 7707083893 деятельность прекращена");
  assert.equal(acceptedLegalStatusProof(r)?.kind,"ceased");
  assert.equal(commercialEligibility(r).blocked,true);
  assert.equal(acceptedLegalStatusProof(row("ИНН 7707083893 исключен из ЕГРЮЛ"))?.kind,"ceased");
});

test("negated, proposed or cancelled closure does not remove a company",()=>{
  for(const excerpt of [
    "ИНН 7707083893 не ликвидирован",
    "ИНН 7707083893 деятельность не прекращена",
    "ИНН 7707083893 не исключен из ЕГРЮЛ",
    "ИНН 7707083893 сведений о прекращении деятельности нет",
    "ИНН 7707083893 принято решение о предстоящем исключении из ЕГРЮЛ",
    "ИНН 7707083893 находится в процессе ликвидации",
    "ИНН 7707083893 может быть ликвидирован",
    "ИНН 7707083893 отменено решение о ликвидации",
    "ИНН 7707083893 ликвидирован филиал",
    "ИНН 7707083893 статус действующий; правопредшественник ликвидирован"
  ]){
    const r=row(excerpt);
    assert.equal(acceptedLegalStatusProof(r),null,excerpt);
    assert.equal(commercialEligibility(r).blocked,false,excerpt);
    assert.equal(commercialEligibility(r).needs_review,true,excerpt);
  }
});

test("mixed entities and numeric substrings cannot establish cessation",()=>{
  assert.equal(acceptedLegalStatusProof(row("ИНН 7707083893; ИНН 7702070139 ликвидирован")),null);
  assert.equal(acceptedLegalStatusProof(row("ИНН 17707083893 ликвидирован")),null);
  assert.equal(acceptedLegalStatusProof(row("ИНН 7707083893 ликвидирован","https://pb.nalog.ru/company/17707083893")),null);
});

test("generic, credential-bearing and nonstandard-port URLs are not registry proof",()=>{
  for(const url of ["https://egrul.nalog.ru/index.html","https://user@service.nalog.ru/download/7707083893","https://service.nalog.ru:8443/download/7707083893","https://service.nalog.ru/download/","https://service.nalog.ru.example/7707083893"])
    assert.equal(acceptedLegalStatusProof(row("ИНН 7707083893 ликвидирован",url)),null,url);
});
