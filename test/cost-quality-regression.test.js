import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pipeline = readFileSync(new URL("../src/pipeline.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const ui = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const checkpoints = readFileSync(new URL("../src/checkpointStore.js", import.meta.url), "utf8");
const benchmark = readFileSync(new URL("../scripts/benchmark-reference.js", import.meta.url), "utf8");

test("full research has both web-call and cost guardrails", () => {
  assert.match(pipeline, /OPENAI_FULL_WEB_MAX_CALLS/);
  assert.match(pipeline, /OPENAI_MAX_RESEARCH_COST_USD/);
  assert.match(pipeline, /estimated_api_cost_usd/);
});

test("batch enrichment uses structured ids and fallback", () => {
  assert.match(pipeline, /ENRICHMENT_BATCH_SCHEMA/);
  assert.match(pipeline, /ENRICHMENT_BATCH_FALLBACK/);
  assert.match(pipeline, /groupedResults\.get\(rowId\)/);
  assert.match(pipeline, /OPENAI_ENRICHMENT_BATCH_SIZE/);
});

test("INN provenance survives merging and invalid evidence triggers a web lookup", () => {
  assert.match(pipeline, /identity_verification: \{ inn, method: "identity_web"/);
  assert.match(pipeline, /verifiedInnFromEvidence\(row, normalizeInn\)/);
  assert.match(pipeline, /identityVerification = ev\.identity_verification/);
});

test("paid API can be protected by a configured bearer token", () => {
  assert.match(server, /API_ACCESS_TOKEN/);
  assert.match(server, /timingSafeEqual/);
  assert.match(ui, /regionalresearch_api_token/);
});

test("historical contacts require matching INN, source and 90 day limit", () => {
  assert.match(checkpoints, /loadLatestCompletedResearch/);
  assert.match(pipeline, /OPENAI_PREVIOUS_CONTACT_CACHE/);
  assert.match(pipeline, /90 \* 24 \* 3600 \* 1000/);
  assert.match(pipeline, /contact_verification/);
});

test("frozen priority benchmark does not add reference organizations to discovery", () => {
  assert.match(benchmark, /reference_priority_recall_pct/);
  assert.match(benchmark, /BENCHMARK_MIN_PRIORITY_RECALL/);
  assert.doesNotMatch(pipeline, /benchmark-reference\.js/);
});
