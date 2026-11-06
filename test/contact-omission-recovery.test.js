import test from "node:test";
import assert from "node:assert/strict";
import { contactOmissionRecheckLimits, planContactOmissionRechecks } from "../src/contactOmissionRecovery.js";
import { contactResearchPriority } from "../src/researchCostPolicy.js";
const company = (id, grade="C", phone="", leader="") =>
  ({ id, __final_grade:grade, "Телефон":phone, "Руководитель / ЛПР":leader });
const plan = (rows, unsearched, completed=[], limits={batches:8,batchSize:3}) =>
  planContactOmissionRechecks(rows,new Set(unsearched),new Set(completed),
    row=>row.id, contactResearchPriority, limits);

test("recheck only omitted companies, never a source-backed completed not_found", () => {
  const rows=[company("already-not-found","A"),company("missing","A"),
    company("answered","B"),company("completed","C")];
  const result=plan(rows,["missing","completed"],["completed"]);
  assert.equal(result.eligible,1);
  assert.deepEqual(result.groups.map(g=>g.map(x=>x.id)),[["missing"]]);
});

test("within grades, recover missing phones before missing leaders", () => {
  const rows=[company("c-no-phone","C"),company("b-no-leader","B","79001234567"),
    company("a-no-leader","A","79001234567"),company("a-no-phone","A","", "Петров П.П.")];
  const result=plan(rows, rows.map(x=>x.id),[],{batches:2,batchSize:2});
  assert.deepEqual(result.groups.map(g=>g.map(x=>x.id)),[
    ["a-no-phone","a-no-leader"],["b-no-leader","c-no-phone"]
  ]);
});

test("limits ensure no accidental full-research contact replay", () => {
  const rows=Array.from({length:92},(_,i)=>company("k"+i,"C"));
  const result=plan(rows,rows.map(x=>x.id),[],{batches:8,batchSize:3});
  assert.equal(result.groups.length,8);
  assert.equal(result.selected,24);
  assert.equal(result.deferredWithoutRecheck,68);
  assert.equal(new Set(result.groups.flat().map(x=>x.id)).size,24);
});

test("rechecks can be disabled without mutating the unsearched set", () => {
  const rows=[company("a","A"),company("b","B")];
  const ids=new Set(["a","b"]);
  const result=planContactOmissionRechecks(rows,ids,new Set(),
    x=>x.id,contactResearchPriority,{batches:0,batchSize:3});
  assert.equal(result.selected,0);
  assert.equal(result.deferredWithoutRecheck,2);
  assert.equal(ids.size,2);
});

test("bounds protect from invalid user-supplied numeric controls", () => {
  assert.deepEqual(contactOmissionRecheckLimits({}),{
    batches:8,batchSize:3,reservedWebForPhoneConflicts:6});
  const caps=contactOmissionRecheckLimits({
    OPENAI_CONTACT_OMISSION_RECHECK_BATCHES:"999",
    OPENAI_CONTACT_OMISSION_RECHECK_BATCH_SIZE:"999"
  });
  assert.equal(caps.batches,12);
  assert.equal(caps.batchSize,4);
  assert.equal(contactOmissionRecheckLimits({
    OPENAI_CONTACT_OMISSION_RECHECK_BATCHES:"0"}).batches,0);
});
