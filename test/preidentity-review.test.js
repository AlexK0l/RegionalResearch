import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/pipeline.js", import.meta.url), "utf8");
const start = source.indexOf("function appendReviewCandidates(");
const end = source.indexOf("\nfunction makeQaRecords(", start);
assert.ok(start >= 0 && end > start, "REVIEW helper must exist");
const context = vm.createContext({ console: { log() {} } });
vm.runInContext(source.slice(start, end), context);
const append = context.appendReviewCandidates;

test("REVIEW rows continue after identity without any network operation", () => {
  const kept = { candidate_id: "c1", data: { "Организация": "KEEP" } };
  const review = {
    candidate_id: "c2",
    data: {
      "Организация": "REVIEW",
      __evidence: { source_urls: ["https://example.org/evidence"], notes: ["Confirmed trailer lead"] }
    }
  };
  const result = append([kept], [review], "Смоленская область", "test");
  assert.equal(result.length, 2);
  assert.equal(result[0].candidate_id, "c1");
  assert.equal(result[1].candidate_id, "c2");
  assert.equal(result[1].data.__pre_identity_status, "REVIEW");
  assert.deepEqual(Array.from(result[1].data.__evidence.source_urls), ["https://example.org/evidence"]);
});

test("REVIEW never duplicates an already retained candidate", () => {
  const candidate = { candidate_id: "c1", data: {} };
  const result = append([candidate], [candidate], "Смоленская область", "test");
  assert.equal(result.length, 1);
});

test("Both diagnostic and full pipeline preserve REVIEW candidates", () => {
  assert.match(source, /identityResolution\.candidates = appendReviewCandidates\(\s*identityResolution\.candidates, reviewCandidates, region, "diagnostic"/);
  assert.match(source, /identityResolution\.candidates = appendReviewCandidates\(\s*identityResolution\.candidates, preIdentity\.reviewCandidates, region, "full"/);
});

test("INN checksum validation and triage audit are present", () => {
  assert.match(source, /function innChecksumValid\(digits\)/);
  assert.match(source, /\[PRE_IDENTITY_AUDIT\]/);
  assert.match(source, /status === "REVIEW"/);
});
