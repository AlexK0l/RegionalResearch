import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyEntityType, deterministicQualificationDecision } from "../src/pipeline.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/smolensk-a-audit-20261009.json", import.meta.url), "utf8"));

test("audited 38-company A fixture respects the commercial entity policy", () => {
  assert.equal(fixture.count, 38);
  assert.equal(fixture.expected_keep_a, 23);
  assert.equal(fixture.expected_downgrade, 15);
  const mismatches = [];
  for (const item of fixture.companies) {
    const decision = deterministicQualificationDecision({
      id: item.organization,
      sheet: item.sheet,
      row: {
        "Организация": item.organization,
        "Город/район": item.city,
        "Техника/сегмент": item.segments.join(" | "),
        "Основание": "",
        "ИНН": "",
        __evidence: { source_urls: [], notes: [item.a_evidence] }
      }
    });
    const entityType = classifyEntityType({ "Организация": item.organization });
    const expectedA = item.expected_a &&
      entityType !== "government_body" &&
      entityType !== "budget_institution";
    const actualA = decision.grade === "A";
    if (actualA !== expectedA) {
      mismatches.push({
        organization: item.organization,
        expected_a: expectedA,
        original_expected_a: item.expected_a,
        entity_type: entityType,
        actual_grade: decision.grade,
        a_rule: decision.aRule || ""
      });
    }
  }
  console.log("[A_AUDIT_REPLAY] " + JSON.stringify({
    total: fixture.count,
    expected_keep_a: fixture.expected_keep_a,
    expected_downgrade: fixture.expected_downgrade,
    mismatches
  }));
  assert.deepEqual(mismatches, []);
});
