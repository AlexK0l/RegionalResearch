import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const pipeline = readFileSync(new URL("../src/pipeline.js", import.meta.url), "utf8");

test("completed checkpoint tolerates disabled historical recall after Stage13", () => {
  // Historical recall is off by default with autonomous discovery. Its
  // historicalCoverage declaration is block-local, so final persistence
  // must not reference it unconditionally after the priority stage.
  assert.match(pipeline, /if \(HISTORICAL_RECALL_ENABLED\) \{/);
  assert.match(pipeline, /historical_coverage: finalQuality\.report\.historical_coverage \?\? null/);
  assert.doesNotMatch(pipeline, /historical_coverage:\s*historicalCoverage\s*,/);
  const priority = pipeline.indexOf("const priorityStats=applyPriorityStage13(finalResult");
  const completed = pipeline.indexOf('await persistCheckpoint("completed",', priority);
  const safeCoverage = pipeline.indexOf(
    "historical_coverage: finalQuality.report.historical_coverage ?? null", completed);
  assert.ok(priority >= 0 && completed > priority && safeCoverage > completed);
});
