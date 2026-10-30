import test from "node:test";
import assert from "node:assert/strict";
import {
  restoredDeferredContactIds,
  pendingContactRows,
  recordContactAttempt
} from "../src/checkpointContinuation.js";

const rows = [
  { id: "a", grade: "A" },
  { id: "b", grade: "B" },
  { id: "c1", grade: "C" },
  { id: "c2", grade: "C" }
];

test("completed checkpoint resumes only the deferred C rows without rerunning completed A/B", () => {
  const snapshot = { contact_unsearched_ids: ["c1", "c2", "ghost", "a"] };
  const completed = new Set(["a", "b"]);
  const deferred = restoredDeferredContactIds(snapshot, rows.map((r) => r.id), completed);
  assert.deepEqual([...deferred].sort(), ["c1", "c2"]);
  const pending = pendingContactRows(rows, completed, new Map(), (r) => r.id);
  assert.deepEqual(pending.map((r) => r.id), ["c1", "c2"]);

  assert.equal(recordContactAttempt("c1", true, completed, deferred), true);
  completed.add("c1"); // only after applying a legitimate researched result
  assert.equal(recordContactAttempt("c2", false, completed, deferred), false);
  assert.deepEqual([...deferred], ["c2"]);
  assert.deepEqual(pendingContactRows(rows, completed, {}, (r) => r.id).map((r) => r.id), ["c2"]);
});

test("missing batch reply never marks a contact complete", () => {
  const completed = new Set();
  const deferred = new Set();
  assert.equal(recordContactAttempt("unknown", false, completed, deferred), false);
  assert.equal(completed.has("unknown"), false);
  assert.equal(deferred.has("unknown"), true);
});

test("saved primary response waits for apply phase instead of being researched again", () => {
  const pending = pendingContactRows(rows, new Set(["a"]), new Map([["c1", { status: "not_found" }]]), (r) => r.id);
  assert.deepEqual(pending.map((r) => r.id), ["b", "c2"]);
});

test("no phantom deferred identifiers after a company is removed from the CRM", () => {
  assert.deepEqual([...restoredDeferredContactIds({
    contact_unsearched_ids: ["missing", "c2"]
  }, ["a", "c2"], new Set(["c2"]))], []);
});
