import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { auditFinalResult, validInn, isGenericSource } from "../scripts/audit-final-result-readonly.js";

const empty=()=>({
  direct_buyers:[],intermediaries:[],leasing:[],
  qualification_review:[],qualification_excluded:[]
});
const row=(id,grade="C",inn="6732114166",url="")=>({
  __canonical_id:id,"Организация":"ООО Проверка","ИНН":inn,
  __final_grade:grade,__evidence:{
    notes:["Проверяемое действие по эксплуатации полуприцепа."],
    selected_a_provenance:{source_url:url,status:"inline_citation_only_not_live_verified",sources_rechecked:false}
  }
});

test("checksum rejects invalid and placeholder INNs without guessing",()=>{
  assert.equal(validInn("6732114166"),true);
  assert.equal(validInn("1111111111"),false);
  assert.equal(validInn("установить ИНН"),false);
  assert.equal(validInn(""),false);
});

test("concrete A evidence link passes technical check but is NOT live verified",()=>{
  const input=empty();
  input.direct_buyers.push(row("k001","A","6732114166","https://example.org/court/123"));
  const before=structuredClone(input);
  const report=auditFinalResult({final_result:input});
  assert.deepEqual(input,before,"auditor must not mutate source");
  assert.equal(report.critical_issue_count,0);
  assert.equal(report.grades.A,1);
  assert.equal(report.A_linked_not_live_verified.length,1);
  assert.equal(report.online_fact_verifications,0);
  assert.match(report.verdict,/not_primary_registry/);
});

test("source-free A and generic job-index A fail technical audit",()=>{
  const input=empty();
  input.direct_buyers.push(row("k001","A","6732114166",""));
  input.direct_buyers.push(row("k002","A","","https://smolensk.hh.ru/vacancies/voditel_kategorii_e"));
  const report=auditFinalResult(input);
  assert.ok(report.issues.some(v=>v.kind==="A_selected_claim_missing_url"));
  assert.ok(report.issues.some(v=>v.kind==="A_selected_claim_generic_index"));
  assert.equal(report.priority_missing_inn.length,1);
  assert.equal(report.verdict,"technical_blocked");
  assert.equal(isGenericSource("https://smolensk.hh.ru/vacancy/12345678"),false);
});

test("duplicate active INN, cross-queue duplicate ID and bad active INN are critical",()=>{
  const input=empty();
  input.direct_buyers.push(row("k001","B"));
  input.direct_buyers.push(row("k002","C"));
  input.leasing.push(row("k003","C","1111111111"));
  input.qualification_review.push(row("k001","", "проверить по реестру"));
  const report=auditFinalResult(input);
  assert.ok(report.issues.some(v=>v.kind==="active_duplicate_inn"));
  assert.ok(report.issues.some(v=>v.kind==="duplicate_canonical_id"));
  assert.ok(report.issues.some(v=>v.kind==="invalid_inn"&&v.id==="k003"));
  assert.ok(report.warnings.some(v=>v.kind==="queue_unverified_inn_or_placeholder"));
  assert.equal(report.all_current_records,4);
});

test("legacy queue placeholders warn but do not falsify valid commercial INNs",()=>{
  const input=empty();
  input.direct_buyers.push(row("k001","C"));
  input.qualification_review.push(row("k002","","пока не установлен"));
  const report=auditFinalResult(input);
  assert.equal(report.critical_issue_count,0);
  assert.equal(report.warnings.length,1);
  assert.equal(report.missing_inn.active,0);
});

test("CLI fail-on-critical and output are deterministic on all platforms",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"regional-final-audit-"));
  try{
    const script=fileURLToPath(new URL("../scripts/audit-final-result-readonly.js",import.meta.url));
    const input=empty();
    input.direct_buyers.push(row("k001","A","6732114166",""));
    const source=path.join(dir,"sample.json"),output=path.join(dir,"report.json");
    fs.writeFileSync(source,JSON.stringify({final_result:input}));
    const result=spawnSync(process.execPath,[script,source,"--out="+output,"--fail-on-critical"],{
      encoding:"utf8",timeout:15000
    });
    assert.equal(result.status,1,result.stderr);
    const saved=JSON.parse(fs.readFileSync(output,"utf8"));
    assert.equal(saved.critical_issue_count,1);
    assert.match(saved.source_json_sha256,/^[a-f0-9]{64}$/);
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test("missing required queues is an explicit error, not a silent zero",()=>{
  assert.throws(()=>auditFinalResult({direct_buyers:[],intermediaries:[],leasing:[]}),TypeError);
});
