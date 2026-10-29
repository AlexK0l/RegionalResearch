import test from "node:test";
import assert from "node:assert/strict";
import {
  createFullWebBudget, reserveWebBudgetBeforeCall, releaseWebBudgetReservation,
  recordWebUsage, recordWebBudgetUsage, estimatedApiCostUsd
} from "../src/pipeline.js";

function fakeClient() {
  return {
    __webBudget: createFullWebBudget(),
    __webUsage: { total: 0, by_scope: {} },
    __tokenUsage: {
      input_tokens: 0, cached_input_tokens: 0, output_tokens: 0,
      reasoning_tokens: 0, total_tokens: 0
    }
  };
}
test("concurrent contact reservations cannot overspend a phase or total budget", () => {
  const c = fakeClient();
  const a = reserveWebBudgetBeforeCall(c, "contact batch | five", 2);
  const b = reserveWebBudgetBeforeCall(c, "contact batch | five", 2);
  assert.equal(a.calls, 2);
  assert.equal(b.calls, 2);
  assert.equal(c.__webBudget.reserved.contacts, 4);
  assert.equal(c.__webBudget.reserved.total, 4);
  recordWebUsage(c, "contact batch | five", 2);
  recordWebBudgetUsage(c, "contact batch | five", 2);
  releaseWebBudgetReservation(a);
  assert.equal(c.__webBudget.used.contacts, 2);
  assert.equal(c.__webBudget.reserved.contacts, 2);
  releaseWebBudgetReservation(b);
  assert.equal(c.__webBudget.reserved.total, 0);
});
test("phase cap blocks optional contacts but preserves independent identity budget", () => {
  const c = fakeClient();
  c.__webBudget.used.contacts = c.__webBudget.limits.contacts;
  c.__webBudget.used.total = c.__webBudget.limits.contacts;
  c.__webUsage.total = c.__webBudget.used.total;
  assert.throws(() => reserveWebBudgetBeforeCall(c, "contact batch | five", 2), /WEB_BUDGET_STOP:contacts/);
  const id = reserveWebBudgetBeforeCall(c, "final inn | five", 2);
  assert.equal(id.scope, "identity");
  releaseWebBudgetReservation(id);
});
test("global budget blocks all scopes even before the model returns", () => {
  const c = fakeClient();
  c.__webBudget.used.total = c.__webBudget.limits.total;
  c.__webUsage.total = c.__webBudget.used.total;
  assert.throws(() => reserveWebBudgetBeforeCall(c, "identity | case", 2), /WEB_BUDGET_STOP:total/);
});
test("last available search slot reduces tool-call budget to one", () => {
  const c = fakeClient();
  c.__webBudget.used.contacts = c.__webBudget.limits.contacts - 1;
  c.__webBudget.used.total = 0;
  const res = reserveWebBudgetBeforeCall(c, "contact web | company", 2);
  assert.equal(res.calls, 1);
  releaseWebBudgetReservation(res);
  assert.equal(c.__webBudget.reserved.total, 0);
});
test("token costs count towards the same $25 guardrail", () => {
  const c = fakeClient();
  c.__tokenUsage.input_tokens = 150_000_000; // $30 at the configured estimator.
  assert.ok(estimatedApiCostUsd(c) >= 25);
  assert.throws(() => reserveWebBudgetBeforeCall(c, "этап 1 | discovery", 2),
    /WEB_BUDGET_STOP:estimated_cost_usd/);
});
test("failed requests can release every reserved call without spending web quota", () => {
  const c = fakeClient();
  const res = reserveWebBudgetBeforeCall(c, "contact batch | five", 2);
  releaseWebBudgetReservation(res);
  assert.equal(c.__webBudget.reserved.total, 0);
  assert.equal(c.__webBudget.used.total, 0);
  const again = reserveWebBudgetBeforeCall(c, "contact batch | five", 2);
  assert.equal(again.calls, 2);
  releaseWebBudgetReservation(again);
});
