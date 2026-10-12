import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { discoveryYieldStats } from "../src/pipeline.js";

function row(org, basis, segment, notes) {
  return {
    "Организация": org,
    "Город/район": "Смоленская область",
    "Техника/сегмент": segment,
    "Основание": basis,
    "ИНН": "",
    __evidence: { source_urls: [], notes }
  };
}

test("discovery yield uses deterministic evidence instead of model self-grade", () => {
  const result = {
    direct_buyers: [
      row(
        "АО «Реальный покупатель»",
        "A — закупка полуприцепа",
        "Полуприцеп для перевозки груза",
        ["Опубликована закупка полуприцепа ТОНАР 9594 для АО «Реальный покупатель»."]
      )
    ],
    intermediaries: [
      row(
        "ООО «Каталог Сервис»",
        "A — ремонт полуприцепов",
        "Ремонт Schmitz и Krone",
        ["Каталог указывает услугу ремонта полуприцепов; конкретные клиенты и выполненные работы не раскрыты."]
      )
    ],
    leasing: []
  };

  const stats = discoveryYieldStats(result, []);
  assert.equal(stats.gradingBasis, "deterministic_evidence");
  assert.equal(stats.modelPreliminary.A, 2);
  assert.equal(stats.a, 1);
  assert.equal(stats.strongNew, 1);
});

test("known organizations do not inflate deterministic marginal yield", () => {
  const result = {
    direct_buyers: [
      row(
        "ООО «Уже найденный перевозчик»",
        "A — собственный парк",
        "Полуприцепы Schmitz",
        ["Собственный парк включает тягачи DAF и полуприцепы Schmitz."]
      )
    ],
    intermediaries: [],
    leasing: []
  };
  const stats = discoveryYieldStats(result, ["ООО «Уже найденный перевозчик»"]);
  assert.equal(stats.newOrganizations, 0);
  assert.equal(stats.qualityScore, 0);
});

test("all nine discovery stages have explicit stage guardrails", () => {
  const source = readFileSync(new URL("../src/pipeline.js", import.meta.url), "utf8");
  const start = source.indexOf("const DISCOVERY_STAGE_GUARDRAILS = [");
  const end = source.indexOf("];", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  for (let stage = 1; stage <= 9; stage++) {
    assert.match(block, new RegExp("ЭТАП " + stage + ":"));
  }
  assert.match(source, /НЕ БОЛЕЕ 4 содержательных web-search проходов/);
  assert.match(source, /ПОЛОЖИТЕЛЬНЫЙ evidence-note/);
  assert.match(source, /DISCOVERY_STAGE_GUARDRAILS\[stageIndex\]/);
});
