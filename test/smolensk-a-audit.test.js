import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deterministicQualificationDecision } from "../src/pipeline.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/smolensk-a-audit-20261009.json", import.meta.url), "utf8"));

test("audited 38-company A fixture matches expected A vs downgrade decisions", () => {
  assert.equal(fixture.count, 38);
  assert.equal(fixture.expected_keep_a, 24);
  assert.equal(fixture.expected_downgrade, 14);
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
    const actualA = decision.grade === "A";
    if (actualA !== item.expected_a) {
      mismatches.push({
        organization: item.organization,
        expected_a: item.expected_a,
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
