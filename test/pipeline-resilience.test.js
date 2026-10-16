import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/pipeline.js", import.meta.url), "utf8");

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
  assert.match(source, /enforceFinalInnRequirement\(finalResult\)/);
  assert.match(source, /kept_without_confirmed_inn/);
  assert.match(source, /return \[\];/);
});

test("final batch is compact, structured and recursively splittable", () => {
  assert.match(source, /OPENAI_FINAL_BATCH_SIZE \|\| 30/);
  assert.match(source, /FINAL_BATCH_DELTA_SCHEMA/);
  assert.match(source, /schemaName: "final_batch_delta"/);
  assert.match(source, /FINAL_BATCH_SPLIT/);
  assert.match(source, /FINAL_BATCH_FALLBACK/);
  assert.match(source, /applyFinalBatchDelta/);
  assert.doesNotMatch(source, /Сохраняй максимум полезной информации из evidence\. Новый web_search здесь запрещён/);
});

test("global QA is deterministic-first and LLM sees only conflict groups", () => {
  assert.match(source, /const beforeDeterministicDedupe = makeQaRecords\(stagedResult\)/);
  assert.match(source, /deterministicGlobalDedupe\(beforeDeterministicDedupe, null, region\)/);
  assert.match(source, /FINAL_CONFLICT_GROUP_BATCH_SIZE/);
  assert.match(source, /schemaName: "final_conflict_delta"/);
  assert.doesNotMatch(source, /КОММЕРЧЕСКИЕ СТРОКИ JSON:/);
});

test("stage summaries no longer dump every company", () => {
  const summaryStart = source.indexOf('console.log("[DISCOVERY_STAGE_SUMMARY]');
  const summaryEnd = source.indexOf('console.log("[DISCOVERY_STAGE_COMPANIES_SAMPLE]', summaryStart);
  assert.ok(summaryStart >= 0 && summaryEnd > summaryStart);
  const summaryBlock = source.slice(summaryStart, summaryEnd);
  assert.doesNotMatch(summaryBlock, /companies:/);
  assert.match(source, /diagnosticDiscoveryRows\(combined\)\.slice\(0, 20\)/);
});
