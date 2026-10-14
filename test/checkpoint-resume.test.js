import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkpointSummary, normalizeCheckpoint } from "../src/checkpointStore.js";

const pipeline = readFileSync(new URL("../src/pipeline.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("checkpoint format validates and summarizes resume state", () => {
  const checkpoint = normalizeCheckpoint({
    version: 1,
    region: "Смоленская область",
    phase: "final_batches",
    completed_stage: 9,
    completed_final_batches: 4,
    enrichment_completed_ids: ["k1"],
    contact_completed_ids: ["k2"]
  });
  assert.ok(checkpoint);
  assert.deepEqual(checkpointSummary(checkpoint), {
    version: 1,
    region: "Смоленская область",
    phase: "final_batches",
    completed_stage: 9,
    completed_final_batches: 4,
    enrichment_completed: 1,
    contacts_completed: 1,
    pipeline_version: 0,
    updated_at: null
  });
  assert.equal(normalizeCheckpoint({ version: 2, region: "x" }), null);
});

test("full pipeline persists checkpoints at every expensive boundary", () => {
  for (const phase of [
    "discovery",
    "pre_identity",
    "identity",
    "final_batches",
    "dedupe",
    "qualification",
    "enrichment",
    "statistics",
    "contacts",
    "completed"
  ]) {
    assert.match(pipeline, new RegExp('persistCheckpoint\\("' + phase + '"'));
  }
  assert.match(pipeline, /completedFinalBatches/);
  assert.match(pipeline, /enrichmentCompleted/);
  assert.match(pipeline, /contactCompleted/);
  assert.match(pipeline, /RESUME_IDENTITY_CHECKPOINT/);
  assert.match(pipeline, /RESUME_QUALIFICATION_CHECKPOINT/);
});

test("server exposes checkpoint download and resume APIs", () => {
  assert.match(server, /"resume"/);
  assert.match(server, /\/api\/jobs\/:id\/checkpoint/);
  assert.match(server, /\/api\/jobs\/:id\/resume/);
  assert.match(server, /loadCheckpoint\(req\.params\.id\)/);
  assert.match(server, /updateCheckpoint\(checkpoint\)/);
});

test("discovery economics and evidence-oriented recovery are logged", () => {
  assert.match(pipeline, /OPENAI_WEB_SEARCH_COST_PER_CALL/);
  assert.match(pipeline, /unique_per_web/);
  assert.match(pipeline, /strong_per_web/);
  assert.match(pipeline, /stageRecoveryEvidenceOriented/);
  assert.match(pipeline, /evidence_oriented_saturation_stop/);
  assert.match(pipeline, /sourceFamilyNovelty/);
});


test("checkpoint backend uses SQLite and region-aware lookup", () => {
  const store = readFileSync(new URL("../src/checkpointStore.js", import.meta.url), "utf8");
  assert.match(store, /from "node:sqlite"/);
  assert.match(store, /CREATE TABLE IF NOT EXISTS research_checkpoints/);
  assert.match(store, /findLatestCheckpoint/);
  assert.match(store, /supersedeRegionCheckpoints/);
  assert.match(store, /CHECKPOINT_DB_PATH/);
  assert.doesNotMatch(store, /redis|createClient/i);
  assert.match(server, /checkpoints = await checkpointBackendStatus/);
  assert.match(server, /app\.get\("\/api\/checkpoints"/);
  assert.match(server, /CHECKPOINT_EXISTS/);
  assert.match(server, /startFresh/);
  assert.match(server, /checkpointId/);
});

test("large discovery diagnostics are sampled instead of fully dumped", () => {
  assert.doesNotMatch(pipeline, /companies: diagnosticDiscoveryRows\(normalized\)/);
  assert.doesNotMatch(pipeline, /companies: diagnosticDiscoveryRows\(branchResult\)/);
  assert.doesNotMatch(pipeline, /companies: diagnosticDiscoveryRows\(value\)/);
  assert.match(pipeline, /DISCOVERY_SCOPE_COMPANIES_SAMPLE/);
  assert.match(pipeline, /DISCOVERY_BRANCH_COMPANIES_SAMPLE/);
  assert.match(pipeline, /DISCOVERY_RECOVERY_COMPANIES_SAMPLE/);
});

test("non-A enrichment never spends a standalone search only for revenue or headcount", () => {
  assert.match(pipeline, /function prioritizedResearchGaps\(row\)/);
  assert.match(pipeline, /if \(grade === "A"\) return gaps/);
  assert.match(pipeline, /const coreGaps = gaps\.filter/);
  assert.match(pipeline, /const gaps = prioritizedResearchGaps\(row\)/);
});
