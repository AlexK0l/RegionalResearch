import test from "node:test";
import assert from "node:assert/strict";
import {
  priorityRecoveryGaps,
  eligiblePriorityRecoveryRows,
  validPriorityBatchItem,
  applyPriorityRecoveryItem
} from "../src/priorityGapRecovery.js";

const makeRow = (overrides = {}) => ({
  __canonical_id: "q0001", __final_grade: "A",
  "Организация": "ООО «Карьер»", "ИНН": "6732001114",
  "Руководитель / ЛПР": "",
  "Выручка последнего подтвержденного года": "",
  "Численность": "",
  __evidence: { source_urls: ["https://source.example/1"], notes: [] },
  ...overrides
});
const item = (facts, overrides = {}) => ({
  id: "q0001", inn: "6732001114",
  organization: "ООО «Карьер»", facts, ...overrides
});
const fact = (field, value, excerpt, year = "") => ({
  field, value, source_url: "https://example.org/company/6732001114",
  evidence_excerpt: excerpt, year
});

test("A and B with verified legal INN are selected; C or unknown INN are not", () => {
  assert.deepEqual(priorityRecoveryGaps(makeRow()), [
    "Руководитель / ЛПР", "Выручка последнего подтвержденного года", "Численность"
  ]);
  const rows = [
    makeRow({ __canonical_id: "c", __final_grade: "C" }),
    makeRow({ __canonical_id: "bad", "ИНН": "" }),
    makeRow({ __canonical_id: "b", __final_grade: "B" }),
    makeRow({ __canonical_id: "a" })
  ];
  assert.deepEqual(eligiblePriorityRecoveryRows(rows, new Set(["b"]), (r) => r.__canonical_id).map((r) => r.__canonical_id), ["a"]);
});

test("attributed A/B financial and director facts are saved without overwriting prior good data", () => {
  const row = makeRow();
  const result = applyPriorityRecoveryItem(row, item([
    fact("Руководитель / ЛПР", "Иванов Иван Иванович", "ИНН 6732001114: генеральный директор Иванов Иван Иванович."),
    fact("Выручка последнего подтвержденного года", "125000000", "ИНН 6732001114, 2024 год, выручка 125000000 рублей.", "2024"),
    fact("Численность", "46", "ИНН 6732001114, среднесписочная численность 46 работников.")
  ]), "q0001");
  assert.equal(result.researched, true);
  assert.equal(result.applied.length, 3);
  assert.equal(row["Руководитель / ЛПР"], "Иванов Иван Иванович");
  assert.equal(row["Выручка последнего подтвержденного года"], 125000000);
  assert.equal(row["Численность"], 46);
  assert.equal(row.__evidence.priority_recovery_facts.length, 3);
  const second = applyPriorityRecoveryItem(row, item([
    fact("Выручка последнего подтвержденного года", "500", "ИНН 6732001114, 2025 год, выручка 500.", "2025")
  ]), "q0001");
  assert.equal(second.applied.length, 0);
  assert.equal(row["Выручка последнего подтвержденного года"], 125000000);
});

test("similar-name or wrong-INN company cannot contaminate A/B fields", () => {
  for (const bad of [
    item([], { id: "q222" }),
    item([], { inn: "6732001115" }),
    item([], { organization: "ООО «Карьер-2»" })
  ]) {
    const row = makeRow();
    assert.equal(applyPriorityRecoveryItem(row, bad, "q0001").researched, false);
  }
});

test("financial/leader facts lacking quoted exact legal INN or source are rejected", () => {
  const row = makeRow();
  const badFacts = [
    fact("Руководитель / ЛПР", "Петров Пётр", "ООО «Карьер»: Петров Пётр."),
    fact("Выручка последнего подтвержденного года", "33333", "ИНН 6732001114, 2024, выручка 66666.", "2024"),
    { ...fact("Численность", "17", "ИНН 6732001114, 17"), source_url: "http://example.org/" },
    fact("Численность", "0", "ИНН 6732001114 численность 0"),
    fact("Выручка последнего подтвержденного года", "33333", "ИНН 6732001114, выручка 33333.", ""),
  ];
  const result = applyPriorityRecoveryItem(row, item(badFacts), "q0001");
  assert.equal(result.researched, true);
  assert.equal(result.applied.length, 0);
});

test("valid empty cited batch answer counts as researched but does not invent data", () => {
  const row = makeRow();
  const result = applyPriorityRecoveryItem(row, item([]), "q0001");
  assert.equal(result.researched, true);
  assert.deepEqual(result.applied, []);
  assert.equal(row["Выручка последнего подтвержденного года"], "");
});
