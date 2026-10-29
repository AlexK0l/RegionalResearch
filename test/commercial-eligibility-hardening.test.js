import test from "node:test";
import assert from "node:assert/strict";
import { commercialEligibility, classifyCommercialEntity, acceptedLegalStatusProof } from "../src/qualificationSafety.js";
import { deterministicQualificationDecision } from "../src/pipeline.js";

function row(name, inn = "", notes = [], extra = {}) {
  return { "Организация": name, "ИНН": inn, "Город/район": "Смоленская область",
    "Техника/сегмент": "Грузоперевозки; полуприцепы",
    __evidence: { source_urls: ["https://example.org/record"], notes }, ...extra };
}
function grade(name, inn, note, sheet = "direct_buyers") {
  return deterministicQualificationDecision({ sheet, row: row(name, inn, [note]) });
}

test("full official budget-entity names are excluded regardless of purchases", () => {
  const names = [
    "Федеральное государственное бюджетное учреждение культуры «Хмелита»",
    "Смоленское областное государственное бюджетное учреждение «Пожарно-спасательный центр»",
    "ФГБУК музей «Хмелита»"
  ];
  for (const name of names) {
    assert.equal(classifyCommercialEntity(row(name)), "budget_institution");
    assert.equal(grade(name, "", "Закуплен полуприцеп для перевозок.").decision, "exclude");
  }
});

test("short archived Khmelita, budget rescue and terminated company are INN-bound", () => {
  for (const [name, inn] of [
    ["Музей-заповедник «Хмелита»", "6722007648"],
    ["Смоленское областное государственное бюджетное учреждение «Пожарно-спасательный центр»", "6732008094"],
    ["ООО «Смоленская транспортная компания»", "6731065653"]
  ]) {
    const eligibility = commercialEligibility(row(name, inn));
    assert.equal(eligibility.blocked, true);
    assert.equal(eligibility.method, "audited_entity");
  }
  assert.equal(commercialEligibility(row("ООО «Смоленская транспортная компания»", "6731076084")).blocked, false);
  assert.equal(commercialEligibility(row("ООО «Хмелита Транспорт»", "6711111111")).blocked, false);
});

test("separate branch never becomes independently qualified company", () => {
  const name = "Обособленное подразделение «Тропарёво-Сычёвка» / группа «Останкино»";
  assert.equal(classifyCommercialEntity(row(name)), "branch");
  assert.equal(grade(name, "", "Свой парк тягачей и полуприцепов эксплуатирует.").decision, "exclude");
});

test("unknown or unverified closure is retained and flagged", () => {
  const r = row("ООО «Новая компания»", "6731000001", [
    "Identity: организация возможно ликвидирована, требуется проверка."
  ]);
  const e = commercialEligibility(r);
  assert.equal(e.blocked, false);
  assert.equal(e.needs_review, true);
  assert.equal(acceptedLegalStatusProof(r), null);
});

test("closure assertion with generic URL is not primary registry evidence", () => {
  const r = row("ООО «Компания»", "6731065653", [], {
    __evidence: { legal_status_verification: {
      inn: "6731065653", status: "liquidated",
      source_url: "https://egrul.nalog.ru/",
      evidence_excerpt: "Компания ИНН 6731065653 ликвидирована."
    } }
  });
  assert.equal(acceptedLegalStatusProof(r), null);
  assert.equal(commercialEligibility(r).blocked, false);
});

test("source-bound official closure with matching INN passes, mismatched INN fails", () => {
  const source = { inn: "6731123456", ogrn: "", status: "ceased",
    source_url: "https://service.nalog.ru/download/6731123456",
    evidence_excerpt: "ИНН 6731123456 деятельность прекращена" };
  const matched = row("ООО «Старая компания»", "6731123456", [], {
    __evidence: { legal_status_verification: source }
  });
  assert.equal(acceptedLegalStatusProof(matched)?.kind, "ceased");
  assert.equal(commercialEligibility(matched).blocked, true);
  matched["ИНН"] = "6731123457";
  assert.equal(commercialEligibility(matched).blocked, false);
});

test("customer third-party trailer procurement must not become direct A", () => {
  const d = grade("ООО «Складской оператор»", "6732111111",
    "Сторонний перевозчик использует полуприцеп Schmitz для перевозки продукции заказчика. Прицеп принадлежит подрядчику.");
  assert.notEqual(d.grade, "A");
});

test("strong first-party acquisition and fleet still permit A", () => {
  const d = grade("ООО «Перевозчик»", "6732111111",
    "ООО «Перевозчик» приобрело и эксплуатирует полуприцеп ТОНАР 9445 для перевозки зерна.");
  assert.equal(d.grade, "A");
});

test("company with identical name but different INN is not hard excluded", () => {
  const d = grade("ООО «Смоленская транспортная компания»", "6731076084",
    "ООО «Смоленская транспортная компания» эксплуатирует собственный парк седельных тягачей и полуприцепов.");
  assert.equal(d.grade, "A");
});
