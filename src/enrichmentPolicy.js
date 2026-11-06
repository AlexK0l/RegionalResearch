// Deterministic, offline-testable budget policy for stage-10 enrichment.
// A valid "not found" / empty batch answer is a completed research attempt,
// not a technical failure requiring a second paid search.

export function usableBatchEnrichmentItem(item, requestedId) {
  if (!item || typeof item !== "object") return false;
  if (String(item.id || "") !== String(requestedId || "")) return false;
  if (!item.fields || typeof item.fields !== "object" || Array.isArray(item.fields)) return false;
  if (typeof item.__comment !== "string") return false;
  return true;
}

export function decideEnrichmentAction({
  batchAttempted = false,
  batchItem = null,
  rowId = "",
  priority = 1,
  globalFallbackRemaining = 0,
  batchFallbackRemaining = 0,
  deadlineRemainingMs = Infinity
} = {}) {
  if (usableBatchEnrichmentItem(batchItem, rowId)) {
    // The source was searched already. Empty fields may truly be unavailable.
    return { action: "use_batch", reason: "batch_answer_complete", consumesFallback: false };
  }
  if (!batchAttempted) {
    return { action: "single", reason: "not_batched", consumesFallback: false };
  }
  if (deadlineRemainingMs <= 7000) {
    return { action: "defer", reason: "deadline", consumesFallback: false };
  }
  if (priority >= 2 && globalFallbackRemaining > 0 && batchFallbackRemaining > 0) {
    // Technical omission from a batch, not merely an unknown field.
    return { action: "fallback", reason: "batch_item_missing_or_invalid", consumesFallback: true };
  }
  return { action: "defer", reason: "low_priority_or_retry_budget_exhausted", consumesFallback: false };
}

export function countEnrichmentBatchCalls(webSearchByBatch = [], webSearchByFallback = []) {
  const sum = (values) => values.reduce((total, value) => total + (Number(value) || 0), 0);
  return { batch_web_calls: sum(webSearchByBatch), fallback_web_calls: sum(webSearchByFallback) };
}
