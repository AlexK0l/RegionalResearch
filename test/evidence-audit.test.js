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
