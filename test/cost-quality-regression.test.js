import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { previousContactCacheEnabled } from "../src/researchCostPolicy.js";

const pipeline = readFileSync(new URL("../src/pipeline.js", import.meta.url), "utf8");
const costPolicy = readFileSync(new URL("../src/researchCostPolicy.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const browserSessionAuth = readFileSync(new URL("../src/browserSessionAuth.js", import.meta.url), "utf8");
const ui = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const checkpoints = readFileSync(new URL("../src/checkpointStore.js", import.meta.url), "utf8");
const benchmark = readFileSync(new URL("../scripts/benchmark-reference.js", import.meta.url), "utf8");

test("full research has both web-call and cost guardrails", () => {
  assert.match(costPolicy, /OPENAI_FULL_WEB_MAX_CALLS/);
  assert.match(costPolicy, /OPENAI_MAX_RESEARCH_COST_USD/);
  assert.match(pipeline, /reserveWebBudgetBeforeCall/);
  assert.match(pipeline, /estimated_api_cost_usd/);
});

test("batch enrichment uses structured ids and fallback", () => {
  assert.match(pipeline, /ENRICHMENT_BATCH_SCHEMA/);
  assert.match(pipeline, /ENRICHMENT_BATCH_FALLBACK/);
  assert.match(pipeline, /groupedResults\.get\(rowId\)/);
  assert.match(pipeline, /OPENAI_ENRICHMENT_BATCH_SIZE/);
});

test("INN provenance survives merging and invalid evidence triggers a web lookup", () => {
  assert.match(pipeline, /method:"identity_web"/);
  assert.match(pipeline, /unmatched_identity_candidates/);
  assert.match(pipeline, /cluster_mentions_lack_independent_source_link/);
  assert.match(pipeline, /verifiedInnFromEvidence\(row, normalizeInn\)/);
  assert.match(pipeline, /identityVerification = ev\.identity_verification/);
});

test("paid API can be protected by a configured bearer token", () => {
  assert.match(server, /API_ACCESS_TOKEN/);
  assert.match(server, /browserAuth\.bearerMatches\(provided\)/);
  assert.match(browserSessionAuth, /timingSafeEqual/);
  assert.match(ui, /regionalresearch_api_token/);
});

test("historical contacts require matching INN, source and 90 day limit", () => {
  assert.match(checkpoints, /loadLatestCompletedResearch/);
  assert.match(costPolicy, /OPENAI_PREVIOUS_CONTACT_CACHE/);
  assert.match(pipeline, /previousContactCacheEnabled\(process.env\)/);
  assert.match(pipeline, /90 \* 24 \* 3600 \* 1000/);
  assert.match(pipeline, /contact_verification/);
});

test("frozen priority benchmark does not add reference organizations to discovery", () => {
  assert.match(benchmark, /reference_priority_recall_pct/);
  assert.match(benchmark, /BENCHMARK_MIN_PRIORITY_RECALL/);
  assert.doesNotMatch(pipeline, /benchmark-reference\.js/);
});

test("independent research disables previous-run contact reuse despite old local env", () => {
  assert.equal(previousContactCacheEnabled({}),false);
  assert.equal(previousContactCacheEnabled({
    OPENAI_AUTONOMOUS_DISCOVERY_ENABLED:"true",OPENAI_PREVIOUS_CONTACT_CACHE:"true"
  }),false);
  assert.equal(previousContactCacheEnabled({
    OPENAI_AUTONOMOUS_DISCOVERY_ENABLED:"false",OPENAI_PREVIOUS_CONTACT_CACHE:"true"
  }),true);
  assert.equal(previousContactCacheEnabled({
    OPENAI_AUTONOMOUS_DISCOVERY_ENABLED:"false",OPENAI_PREVIOUS_CONTACT_CACHE:"false"
  }),false);
});
