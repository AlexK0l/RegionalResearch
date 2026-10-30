import test from "node:test";
import assert from "node:assert/strict";
import { independentBSignals } from "../src/researchQuality.js";

function row(notes) {
  return { __evidence: { source_urls: ["https://example.org/plant"], notes, facts: [] } };
}

test("negated Tonar and own-fleet mentions cannot establish B", () => {
  const d = independentBSignals(row([
    "АО Стройиндустрия добывает и продает щебень и песок.",
    "Источник не связывает организацию с тонарными полуприцепами или собственным автопарком."
  ]));
  assert.equal(d.valid, false);
});

test("denial of own trucks cannot establish B for sawdust producer", () => {
  const d = independentBSignals(row([
    "Компания перерабатывает древесные отходы в брикеты.",
    "Источник не содержит сведений о собственном автопарке или конкретных полуприцепах."
  ]));
  assert.equal(d.valid, false);
});

test("positive independent cargo and operating-fleet claims still establish B", () => {
  const d = independentBSignals(row([
    "Завод добывает щебень и песок для строительной отрасли.",
    "Компания эксплуатирует собственные самосвалы для доставки щебня заказчикам."
  ]));
  assert.equal(d.valid, true);
});
