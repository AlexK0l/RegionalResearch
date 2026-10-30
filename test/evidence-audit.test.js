import test from "node:test";
import assert from "node:assert/strict";
import { auditReplayEvidence } from "../src/evidenceAudit.js";
test("never supplies a missing INN from an unverified note", () => {
 const input={checkpoint:"c",rows:[
  {canonical_id:"a",organization:"Unknown",inn:"",replay_grade:"B",
   evidence_notes:["Подтверждённый ИНН: 6731069440","Своя машина [источник](https://source.example/1)"]},
  {canonical_id:"b",organization:"Other owner",inn:"6731069440",evidence_notes:[]}
 ]};
 const before=JSON.stringify(input);
 const r=auditReplayEvidence(input);
 assert.equal(JSON.stringify(input),before);
 assert.equal(input.rows[0].inn,"");
 assert.equal(r.records[0].candidate_inns_for_review[0].status,"already_used_by_another_row");
 assert.equal(r.records[0].claims_with_inline_urls.length,1);
 assert.equal(r.records[0].claims_with_inline_urls[0].status,"explicit_inline_url_not_independently_verified");
 assert.equal(r.no_api_calls,true);
});
test("note without inline URL is not fabricated into fact",()=>{
 const r=auditReplayEvidence({rows:[{organization:"Company",inn:"",evidence_notes:["Собственный автопарк подтверждён."],source_urls:["https://example.org"]}]});
 assert.equal(r.summary.fact_records_with_explicit_inline_urls,0);
 assert.equal(r.records[0].notes_without_inline_urls,1);
});

test("both Russian spellings of confirmed INN are recognized without changing the row", () => {
 const input={checkpoint:"spellings",rows:[{
   canonical_id:"x",organization:"Candidate",inn:"",replay_grade:"B",
   evidence_notes:[
     "Подтверждённый ИНН: 6731069440",
     "Подтвержденный ИНН: 6731069440",
     "Подтвержденного ИНН: 6731069440"
   ]
 }]};
 const snapshot=JSON.stringify(input);
 const report=auditReplayEvidence(input);
 assert.equal(report.records[0].candidate_inns_for_review.length,1);
 assert.equal(report.records[0].candidate_inns_for_review[0].inn,"6731069440");
 assert.equal(report.records[0].candidate_inns_for_review[0].status,"candidate_requires_legal_verification");
 assert.equal(report.summary.inn_candidates_for_manual_review,1);
 assert.equal(input.rows[0].inn,"");
 assert.equal(JSON.stringify(input),snapshot);
});

test("explicit saved roles and wrong legal form are triaged without changing classification", () => {
 const input={checkpoint:"roles",rows:[
  {canonical_id:"x",organization:"Журнал «ЛесПромИнформ»",sheet:"direct_buyers",replay_grade:"C",inn:"7810776348",
    evidence_notes:["Роль — информационный и профессиональный discovery-канал; конечными потенциальными покупателями являются предприятия."]},
  {canonical_id:"y",organization:"АО «ЖелДорЭкспедиция»",sheet:"direct_buyers",replay_grade:"C",inn:"7718725461",
    evidence_notes:["Роль классифицирована как посредник/экспедитор.",
      "Final INN: ИНН подтверждён для ООО «ЖелДорЭкспедиция»; в исходном названии указана некорректная организационно-правовая форма."]},
  {canonical_id:"z",organization:"ООО «Перевозчик»",sheet:"direct_buyers",replay_grade:"A",inn:"",
    evidence_notes:["Организация эксплуатирует собственные полуприцепы; не только экспедитор."]}
 ]};
 const before=JSON.stringify(input),r=auditReplayEvidence(input);
 assert.equal(JSON.stringify(input),before);
 assert.deepEqual(r.records[0].role_and_legal_review_flags.map(f=>f.type),["source_only_in_direct_buyers"]);
 assert.deepEqual(r.records[1].role_and_legal_review_flags.map(f=>f.type),["intermediary_in_direct_buyers","legal_form_mismatch"]);
 assert.equal(r.records[2].role_and_legal_review_flags.length,0);
 assert.equal(r.summary.explicit_role_and_legal_flags,3);
});

test("filled row with a second valid INN in saved notes is a conflict, not a replacement", () => {
 const input={rows:[
  {canonical_id:"a",organization:"ООО «КВВ-АГРО»",inn:"6713017400",evidence_notes:[
    "Подтверждённый ИНН: 6713017400","Подтвержденный ИНН: 6714049860"]},
  {canonical_id:"b",organization:"ООО «ОЛАКС-АГРО»",inn:"",evidence_notes:["Подтверждённый ИНН: 6714049860"]}
 ]};
 const before=JSON.stringify(input),result=auditReplayEvidence(input);
 assert.equal(result.records[0].current_inn,"6713017400");
 assert.equal(result.records[0].conflicting_inns_in_saved_notes.length,1);
 assert.equal(result.records[0].conflicting_inns_in_saved_notes[0].inn,"6714049860");
 assert.equal(result.summary.filled_rows_with_conflicting_saved_inn,1);
 assert.equal(result.candidate_inn_groups.length,1);
 assert.equal(JSON.stringify(input),before);
});

test("shared group domain is reported only with two shared exact URLs, not as a merge",()=>{
 const data={rows:[
  {canonical_id:"a",organization:"ООО «Транс-СМ»",inn:"6713006768",source_urls:["https://tsmru.com","https://tsmru.com/o-kompanii"]},
  {canonical_id:"b",organization:"ООО «ФАНТОМ ГРУПП»",inn:"6731063021",source_urls:["https://tsmru.com","https://tsmru.com/o-kompanii"]}
 ]};
 const result=auditReplayEvidence(data);
 assert.equal(result.shared_source_pairs.length,1);
 assert.equal(result.shared_source_pairs[0].shared_urls.length,2);
 assert.equal(result.shared_source_pairs[0].status,"source_overlap_not_an_identity_or_ownership_proof");
});
