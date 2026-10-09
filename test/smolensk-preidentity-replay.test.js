import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prefilterCandidatesForIdentity, appendReviewCandidates } from "../src/pipeline.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/smolensk-stage3-20261009.json", import.meta.url), "utf8"));

test("Smolensk stage3 fixture exactly matches the completed Render run", () => {
  assert.equal(fixture.candidates.length, 176);
  assert.equal(fixture.expected_input_mentions, 176);
});

test("preidentity triage preserves REVIEW without adding identity web work", () => {
  const result = prefilterCandidatesForIdentity(fixture.candidates, fixture.region);
  const retained = appendReviewCandidates(result.candidates, result.reviewCandidates, fixture.region, "offline-replay");

  console.log("[OFFLINE_REVIEW_CANDIDATES] " + JSON.stringify(
    result.decisions.filter((x) => x.status === "REVIEW").map((x) => ({
      organization: x.organization,
      city: x.city,
      reason: x.reason
    }))
  ));
  console.log("[OFFLINE_PREIDENTITY_REPLAY] " + JSON.stringify({
    input_mentions: result.inputMentions,
    local_canonical: result.localCanonical,
    local_after_dedupe: result.localAfterDedupe,
    keep_canonical: result.qualified,
    review_canonical: result.review,
    exclude_canonical: result.excluded,
    keep_mentions: result.candidates.length,
    review_mentions: result.reviewCandidates.length,
    exclude_mentions: result.excludedCandidates.length,
    retained_mentions_without_extra_web: retained.length
  }));

  assert.equal(result.inputMentions, 176);
  assert.equal(result.qualified + result.review + result.excluded, result.localAfterDedupe);
  assert.equal(
    result.candidates.length + result.reviewCandidates.length + result.excludedCandidates.length,
    176
  );
  assert.equal(retained.length, result.candidates.length + result.reviewCandidates.length);
  assert.ok(result.review > 0, "audit should surface REVIEW candidates on this fixture");
});
