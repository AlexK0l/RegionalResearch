import test from "node:test";
import assert from "node:assert/strict";
import {
  independentBSignals, verifiedInnFromEvidence,
  populateKnownEvidenceFields, populateCommercialActions, safeSearchPriority
} from "../src/researchQuality.js";

function row(notes = [], facts = []) {
  return {
    "Организация": "ООО Тест",
    "ИНН": "1234567890",
    "Техника/сегмент": "зерно",
    __evidence: { notes, source_urls: ["https://example.org/cargo"], facts }
  };
}

test("single generic note does not create independent B evidence", () => {
  assert.equal(independentBSignals(row(["Перевозка зерна автотранспортом"])).valid, false);
});

test("separate cargo and fleet evidence supports B", () => {
  const value = row(["Хозяйство выращивает зерно", "В собственности седельные тягачи для перевозок"]);
  assert.equal(independentBSignals(value).valid, true);
});

test("structured claims can establish independent B evidence", () => {
  const value = row([], [
    { fact_type: "cargo_process", source_url: "https://example.org/cargo", statement: "Производство и отгрузка зерна" },
    { fact_type: "heavy_transport", source_url: "https://example.org/fleet", statement: "Эксплуатируются седельные тягачи" }
  ]);
  assert.equal(independentBSignals(value).valid, true);
});

test("verified INN requires matching proof and source URL", () => {
  const value = row();
  const norm = (x) => String(x || "");
  assert.equal(verifiedInnFromEvidence(value, norm), "");
  value.__evidence.identity_verification = {
    inn: "1234567890", method: "identity_web", source_urls: ["https://example.org/inn"]
  };
  assert.equal(verifiedInnFromEvidence(value, norm), "1234567890");
  value.__evidence.identity_verification.inn = "9999999999";
  assert.equal(verifiedInnFromEvidence(value, norm), "");
});

test("local evidence reuse fills only unambiguous sourced numbers", () => {
  const value = row([], [
    { source_url: "https://example.org/fin", statement: "Выручка: 12000000 рублей" },
    { source_url: "https://example.org/fin", statement: "Численность: 31 сотрудников" }
  ]);
  assert.equal(populateKnownEvidenceFields(value), 2);
  assert.equal(value["Выручка последнего подтвержденного года"], 12000000);
  assert.equal(value["Численность"], 31);
});

test("commercial actions are populated without claiming an invented trigger", () => {
  const value = row(["Выращивание зерна подтверждено"]);
  populateCommercialActions(value, "direct_buyers", "C");
  assert.match(value["Следующее действие"], /перевозчика/);
  assert.match(value["Почему им нужно звонить \/ потенциальный интерес к САТ"], /зерна/);
  assert.equal(safeSearchPriority({ "Основание": "A — ..." }), 3);
});
