import test from "node:test";
import assert from "node:assert/strict";
import {
  usableBatchEnrichmentItem,
  decideEnrichmentAction,
  countEnrichmentBatchCalls
} from "../src/enrichmentPolicy.js";

const entry = (id, fields = {}, __comment = "") => ({ id, fields, __comment });

test("completed batch answer with unknown values does NOT trigger a paid retry", () => {
  const decision = decideEnrichmentAction({
    batchAttempted: true,
    rowId: "q001",
    batchItem: entry("q001", {
      "Управляющая компания": "",
      "Выручка последнего подтвержденного года": "",
      "Численность": ""
    }),
    priority: 3,
    globalFallbackRemaining: 40,
    batchFallbackRemaining: 1
  });
  assert.equal(decision.action, "use_batch");
  assert.equal(decision.consumesFallback, false);
});

test("positive batch answer is used without another search", () => {
  assert.equal(decideEnrichmentAction({
    batchAttempted: true, rowId: "q001",
    batchItem: entry("q001", { "Численность": "120" }),
    priority: 3, globalFallbackRemaining: 20, batchFallbackRemaining: 1
  }).action, "use_batch");
});

test("batch omission can recover one high-priority company within retry budget", () => {
  const r = decideEnrichmentAction({
    batchAttempted: true, rowId: "q002", priority: 2,
    globalFallbackRemaining: 15, batchFallbackRemaining: 1
  });
  assert.equal(r.action, "fallback");
  assert.equal(r.consumesFallback, true);
});

test("low priority C batch omission is deferred rather than paid again", () => {
  const r = decideEnrichmentAction({
    batchAttempted: true, rowId: "q003", priority: 1,
    globalFallbackRemaining: 30, batchFallbackRemaining: 1
  });
  assert.equal(r.action, "defer");
});

test("retry budgets are hard stops even for A", () => {
  for (const budget of [
    { globalFallbackRemaining: 0, batchFallbackRemaining: 1 },
    { globalFallbackRemaining: 30, batchFallbackRemaining: 0 }
  ]) {
    assert.equal(decideEnrichmentAction({
      batchAttempted: true, rowId: "q004", priority: 3, ...budget
    }).action, "defer");
  }
});

test("request with no batch still gets normal targeted search", () => {
  assert.equal(decideEnrichmentAction({
    batchAttempted: false, rowId: "q005", priority: 1
  }).action, "single");
});

test("unknown or mismatching batch row cannot leak another company's values", () => {
  assert.equal(usableBatchEnrichmentItem(entry("q006", { "Численность": "9000" }), "q007"), false);
  assert.equal(decideEnrichmentAction({
    batchAttempted: true, rowId: "q007",
    batchItem: entry("q006", { "Численность": "9000" }), priority: 1
  }).action, "defer");
});

test("deadline blocks structural fallback", () => {
  assert.equal(decideEnrichmentAction({
    batchAttempted: true, rowId: "q008",
    priority: 3, globalFallbackRemaining: 40,
    batchFallbackRemaining: 1, deadlineRemainingMs: 4000
  }).action, "defer");
});

test("web usage can be audited independently of request count", () => {
  assert.deepEqual(countEnrichmentBatchCalls([2, 3], [1, 2]), {
    batch_web_calls: 5, fallback_web_calls: 3
  });
});
