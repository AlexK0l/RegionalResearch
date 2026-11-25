import test from "node:test";
import assert from "node:assert/strict";
import {numberedLegalNameConflict,mergedNumberedLegalNameConflict,
  legalEvidenceConflict,confirmedInnAliasDecision} from "../src/legalIdentity.js";
import {canonicalizeCandidates,postInnDedupe,deterministicQualificationDecision,
  actionableUnqualifiedLead} from "../src/pipeline.js";
import {rejectUnsafeAEvidence,insufficientTrailerEvidence} from "../src/qualificationSafety.js";
import {disclaimsSelectedTrailerEvidence,finalizeProductionResearch} from "../src/productionFinalQuality.js";
import {decorateCompanyBasisForExport} from "../src/companyBasisNarrative.js";

const inn="7707083893",region="Тестовая область";
const source="https://example.org/transport";
const make=(name,innValue="",id="")=>({"Организация":name,"ИНН":innValue,
  "Город/район":region,"Техника/сегмент":"Доставка песка и щебня автотранспортом",
  "Основание":"C — Действующий грузопоток",__canonical_id:id,
  __final_grade:"C",__evidence:{source_urls:[source],notes:[
    "Предприятие добывает песок и регулярно отгружает продукцию автомобильным транспортом. "+source]}});
const one='АО «Грузовой парк № 1 Север»',two='АО «Грузовой парк № 6 Север»',
  generic='АО «Грузовой парк Север»';
const result=rows=>({direct_buyers:rows,intermediaries:[],leasing:[],statistics:[],
  qualification_review:[],qualification_excluded:[]});
test("numbered names: conflicting digits defeat fuzzy/INN match, not identical spelling variations",()=>{
  assert.equal(numberedLegalNameConflict(one,two),true);
  assert.equal(numberedLegalNameConflict(one,'АО Грузовой парк N 1 Север'),false);
  assert.equal(legalEvidenceConflict(make(one),make(two)),"different_numbered_legal_names");
  assert.equal(confirmedInnAliasDecision(make(one,inn),make(two,inn),inn,()=>true).merge,false);
});
test("early canonicalization and later dedupe cannot bridge numbered names via unnumbered alias",()=>{
  const rows=[make(generic,inn,"g"),make(one,inn,"a"),make(two,inn,"b")];
  const early=canonicalizeCandidates(rows.map((data,i)=>({data,candidate_id:"c"+i,source_step:1,source_sheet:"direct_buyers"})),region);
  assert.equal(early.length,2);
  assert.ok(early.every(group=>!(group.evidence.some(x=>x.data.__canonical_id==="a")&&group.evidence.some(x=>x.data.__canonical_id==="b"))));
  const later=postInnDedupe(result([make(generic,"","g"),make(one,"","a"),make(two,"","b")]),region);
  assert.ok(later.records.length>=2);
  assert.ok(later.records.every(x=>!mergedNumberedLegalNameConflict(x.row)));
  const exact=postInnDedupe(result([make(one,inn,"a"),make('АО «Грузовой парк №1 Север»',inn,"b")]),region);
  assert.equal(exact.records.length,1);
});
test("existing contaminated merged lineage is preserved in REVIEW, never an active survivor",()=>{
  const row=make(one,inn,"a");
  row.__merged_canonical_ids=["a","b"];
  row.__merged_original_records=[make(two,"","b")];
  assert.equal(mergedNumberedLegalNameConflict(row),true);
  const before=structuredClone(row);
  const out=finalizeProductionResearch(result([row]),{qualify:()=>({decision:"include",grade:"C",reason:"cargo"}),
    isActionable:()=>true});
  assert.equal(out.result.direct_buyers.length,0);
  assert.equal(out.result.qualification_review.length,1);
  assert.ok(out.result.qualification_review[0].__quality_gate.issues.includes("merged_numbered_legal_names_conflict"));
  assert.deepEqual(row,before);
});
const weak=[
  "Организация перевозит щебень, но для уровня B недостаточно второго независимого сигнала о тяжёлом парке или эксплуатации прицепной техники.",
  "Карьерная деятельность создаёт регулярный поток навалочного груза, однако подтверждений эксплуатации самосвальных полуприцепов недостаточно для уровня A/B."
];
test("insufficiency of trailer evidence cannot be selected as a positive A",()=>{
  for(const note of weak){
    const row=make('ООО «Тестовый перевозчик»',inn,"a");
    row.__evidence.notes.push(note);
    const record={sheet:"direct_buyers",row};
    assert.equal(insufficientTrailerEvidence(note),true);
    assert.equal(disclaimsSelectedTrailerEvidence(note),true);
    assert.ok(rejectUnsafeAEvidence(record,note));
    assert.notEqual(deterministicQualificationDecision(record).grade,"A");
    const positive="ООО «Тестовый перевозчик» эксплуатирует собственные седельные тягачи с полуприцепами Schmitz. "+source;
    row.__evidence.notes.push(positive);
    const decision=deterministicQualificationDecision(record);
    assert.equal(decision.grade,"A");
    assert.equal(decision.aEvidence,positive);
  }
  assert.equal(insufficientTrailerEvidence("Данных о моделях полуприцепов недостаточно."),false);
});
test("export removes stale email absence and empty citation labels without changing evidence or grade",()=>{
  const row=make('ООО «Тест»',inn,"a");
  row["Электронная почта"]="office@example.org; sales@example.org";
  row["Основание"]="C — Предприятие производит щебень (Источник: ).";
  row.__comment="Email: не найден\nСайт/источник: "+source;
  const data=result([row]),before=structuredClone(data);
  const out=decorateCompanyBasisForExport(data),r=out.direct_buyers[0];
  assert.match(r.__comment,/^Email: office@example\.org; sales@example\.org$/m);
  assert.doesNotMatch(r.__comment,/Email: не найден/);
  assert.doesNotMatch(r["Основание"],/\(Источник:/);
  assert.match(r.__basis_comment,/https:\/\/example\.org\/transport/);
  assert.equal(r.__final_grade,"C");
  assert.deepEqual(data,before);
  assert.deepEqual(decorateCompanyBasisForExport(out),out);
});
