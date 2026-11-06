import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/pipeline.js", import.meta.url), "utf8").replace(/\r\n?/g, "\n");

test("discovery and identity web search have hard tool-call caps", () => {
  assert.match(source, /max_tool_calls = Math\.floor\(Number\(maxToolCalls\)\)/);
  assert.match(source, /maxToolCalls = 4/);
  assert.match(source, /identity \| .*maxToolCalls: 2/s);
  assert.match(source, /final inn \| .*maxToolCalls: 2/s);
  assert.match(source, /recovery[\s\S]*RESEARCH_MICRO_MAX_OUTPUT_TOKENS,[\s\S]*3\n\s*\)/);
});

test("INN is rechecked for every surviving company without deleting unresolved rows", () => {
  assert.match(source, /candidates: preIdentity\.candidates/);
  assert.match(source, /resolveFinalMissingInns\(\{/);
  assert.match(source, /ФИНАЛЬНАЯ ПОВТОРНАЯ ПРОВЕРКА ИНН/);
  assert.match(source, /existing_inn: normalizeInn/);
  assert.match(source, /FINAL_INN_RETRY_PLAN/);
  assert.match(source, /postInnDedupe\(finalResult, region/);
  assert.match(source, /clearUnresolvedInnConflicts/);
  assert.match(source, /enforceFinalInnRequirement\(finalResult\)/);
  assert.match(source, /kept_without_confirmed_inn/);
});

test("full stage 10 uses deterministic staging instead of mass final LLM batches", () => {
  assert.match(source, /\[DETERMINISTIC_STAGING\]/);
  assert.match(source, /skipped_mass_llm_batches/);
  const fullStart = source.indexOf("const canonicalPool = canonicalizeCandidates(identityResolution.candidates, region)");
  const dedupeStart = source.indexOf("const beforeDeterministicDedupe = makeQaRecords(stagedResult)", fullStart);
  assert.ok(fullStart >= 0 && dedupeStart > fullStart);
  const fullStaging = source.slice(fullStart, dedupeStart);
  assert.doesNotMatch(fullStaging, /processFinalBatchResilient\(/);
});

test("stage 10 has bounded concurrency and batched checkpoints", () => {
  assert.match(source, /OPENAI_FINAL_INN_CONCURRENCY \|\| 4/);
  assert.match(source, /OPENAI_ENRICHMENT_CONCURRENCY \|\| 8/);
  assert.match(source, /mapWithConcurrency\(\s*batches,\s*concurrency/);
  assert.match(source, /ENRICHMENT_CONCURRENCY/);
  assert.match(source, /createCheckpointBatcher/);
  assert.match(source, /CHECKPOINT_FLUSH_EVERY/);
  assert.match(source, /STAGE10_MAX_MS/);
});

test("global QA is deterministic-first and LLM sees only conflict groups", () => {
  assert.match(source, /const beforeDeterministicDedupe = makeQaRecords\(stagedResult\)/);
  assert.match(source, /deterministicGlobalDedupe\(beforeDeterministicDedupe, null, region\)/);
  assert.match(source, /FINAL_CONFLICT_GROUP_BATCH_SIZE/);
  assert.match(source, /schemaName: "final_conflict_delta"/);
  assert.doesNotMatch(source, /КОММЕРЧЕСКИЕ СТРОКИ JSON:/);
});

test("stage 11 is web-first and browser is only a bounded fallback", () => {
  assert.match(source, /searchContactsWithWeb/);
  assert.match(source, /contact web \|/);
  assert.match(source, /contact phone retry \|/);
  assert.match(source, /verifyPhoneWithWebSearch/);
  assert.match(source, /phone verify \|/);
  assert.match(source, /GOOGLE_FALLBACK_CONCURRENCY/);
  assert.match(source, /GOOGLE_AI_CIRCUIT_OPEN/);
  assert.match(source, /STAGE11_MAX_MS/);
  assert.doesNotMatch(
    source.slice(source.indexOf("const stage11StartedAt"), source.indexOf("return {\n    mode:", source.indexOf("const stage11StartedAt"))),
    /abortableSleep\(5000\)/
  );
});

test("entity census and coverage gap search run before full pre-identity", () => {
  assert.match(source, /ENTITY_CENSUS_BUCKETS/);
  assert.match(source, /runEntityCensusAndGapSearch/);
  assert.match(source, /ENTITY_CENSUS_SUMMARY/);
  assert.match(source, /coverage_snapshot/);
  const censusCall = source.indexOf("runEntityCensusAndGapSearch({");
  const candidatePool = source.indexOf("const candidatePool = flattenCandidates(parts)", censusCall);
  assert.ok(censusCall >= 0 && candidatePool > censusCall);
});

test("stage summaries no longer dump every company", () => {
  const summaryStart = source.indexOf('console.log("[DISCOVERY_STAGE_SUMMARY]');
  const summaryEnd = source.indexOf('console.log("[DISCOVERY_STAGE_COMPANIES_SAMPLE]', summaryStart);
  assert.ok(summaryStart >= 0 && summaryEnd > summaryStart);
  const summaryBlock = source.slice(summaryStart, summaryEnd);
  assert.doesNotMatch(summaryBlock, /companies:/);
  assert.match(source, /diagnosticDiscoveryRows\(combined\)\.slice\(0, 20\)/);
});
