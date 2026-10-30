import test from "node:test";
import assert from "node:assert/strict";
import { deterministicQualificationDecision } from "../src/pipeline.js";

function classify(name, notes, { sheet = "direct_buyers", segment = "Перевозки зерна, песка, щебня" } = {}) {
  return deterministicQualificationDecision({
    sheet,
    row: {
      "Организация": name, "Город/район": "Смоленская область",
      "Техника/сегмент": segment,
      "Основание": "",
      __evidence: { source_urls: ["https://example.org/a"], notes }
    }
  });
}

const badA = [
  ["No trailer identified", "Сигнал относится к эксплуатации тяжелой техники, но прицепная техника отдельно не названа."],
  ["No acquisition", "Нет положительного события по покупке, лизингу или эксплуатации прицепа."],
  ["Trailer ownership unproved", "Основание C: целевой груз подтвержден, собственная эксплуатация прицепной техники не доказана."],
  ["Negative trailer event", "Событие покупки, лизинга или эксплуатации полуприцепа отсутствует."],
  ["Tractor-only leasing", "Лизингополучатель — седельные тягачи — необходимость комплектования прицепного парка."],
  ["Unestablished tractor fleet", "Форма владения автопарком и тип прицепной техники не установлены."],
  ["Scales for Tonar", "Наличие весов для тонаров подтверждает автомобильную отгрузку, но не собственный парк."],
  ["No independent operation", "Нет независимого подтверждения собственного парка тягачей/полуприцепов или конкретной сделки."],
  ["Grain logistics inference", "Связка зерно — корма — животноводство формирует грузопоток, текущий парк прицепной техники не установлен."],
  ["Public supplier only", "Приписывать организации собственный автопарк или полуприцепы нельзя: источник подтверждает только роль поставщика."],
  ["Weak explicit evidence", "Положительного evidence-note о конкретном прицепе, тягачах или автопарке в найденных материалах нет."],
  ["Potential new trailers", "Компания эксплуатирует собственные самосвалы; это повод для обновления тяжелой прицепной техники."],
  ["Rail-only and inferred trailers", "Тентованный транспорт и дальние перевозки — сильный сигнал эксплуатации прицепных составов."],
  ["Missing trailer details", "Эксплуатация 8 автомобилей подтверждена, но не конкретный тип прицепов."],
  ["Earlier classification reference", "Источники требуют отдельное подтверждение для повышения уровня до B по перевозке лома и полуприцепам."]
];

for (const [label, note] of badA) {
  test("Smolensk false A prevented: " + label, () => {
    const d = classify("ООО «Тестовый грузовладелец»", [note]);
    assert.notEqual(d.grade, "A", label);
  });
}

test("third-party hauler does not establish trailer owned by cargo manufacturer", () => {
  const d = classify("ООО «Древоплита»", [
    "Перевозка ДСП с площадки тягачом MAN с полуприцепом.",
    "Полуприцеп в описанном рейсе принадлежал перевозчику, а не производителю ДСП."
  ]);
  assert.notEqual(d.grade, "A");
});

test("legal identity notes do not independently establish commercial A", () => {
  const d = classify("ООО «Завод»", [
    "Final INN: ООО «Завод» имеет парк грузовых полуприцепов и ИНН подтвержден.",
    "Предприятие производит бетон."
  ]);
  assert.notEqual(d.grade, "A");
});

test("positive own Schmitz fleet remains A", () => {
  const d = classify("ООО «Перевозчик»", [
    "Собственный парк седельных тягачей и полуприцепов Schmitz Cargobull эксплуатируется для перевозки грузов."
  ]);
  assert.equal(d.grade, "A");
});

test("registered ownership A remains even if specific trip not observed", () => {
  const d = classify("ООО «Владелец»", [
    "Организация подтверждена как собственник зарегистрированного прицепного парка; фактическая эксплуатация в акте отдельно не установлена."
  ]);
  assert.equal(d.grade, "A");
});

test("concrete trailer acquisition remains A", () => {
  const d = classify("АО «СмоленскРыбХоз»", [
    "АО «СмоленскРыбХоз» приобрело грузовой полуприцеп для перевозки рыбы по контракту."
  ]);
  assert.equal(d.grade, "A");
});

test("clear own fleet remains A even with a separate unrelated third-party note", () => {
  const d = classify("ООО «Собственный парк»", [
    "Компания эксплуатирует собственный парк тягачей и полуприцепов Schmitz.",
    "В отдельных рейсах может использоваться подрядчик с полуприцепом стороннего перевозчика."
  ]);
  assert.equal(d.grade, "A");
});


// Recorded failures from the 2026-10-30 finished Smolensk checkpoint.
// A note that says NO own fleet/transaction cannot establish a concrete A event.
const actualFalseA = [
  ["АО «ПСКОВВТОРМЕТ»", "Подтвержден целевой груз — лом черных и цветных металлов; сведений о собственном автопарке и прицепах в источнике нет."],
  ["АО «Стройиндустрия»", "Наличие карьерного ассортимента подтверждено, но источник не связывает компанию с конкретными тонарными полуприцепами, закупкой техники или собственным автопарком."],
  ["Общество с ограниченной ответственностью «РУФ»", "Источник не содержит сведений о собственном автопарке или конкретных прицепах."]
];
for (const [name, note] of actualFalseA) {
  test("2026-10-30 real negative A note: " + name, () => {
    const d = classify(name, [note], { segment: "Лом, щебень, древесные отходы; тонарные полуприцепы" });
    assert.notEqual(d.grade, "A");
    assert.equal(d.aEvidence, "");
  });
}

test("independent positive ownership note can still establish A after a negative source", () => {
  const d = classify("ООО «Свой подтверждённый парк»", [
    "Источник не содержит сведений о собственном автопарке или конкретных прицепах.",
    "Позднее в акте подтверждён собственный парк тягачей и полуприцепов Schmitz, эксплуатируется на перевозках."
  ]);
  assert.equal(d.grade, "A");
});

 
// Actual false-positive A evidence from the completed 492-company replay.
const newlyDetectedFalseA = [
  ["Карьер «Плоское»", "Собственный автопарк прямо указан, но конкретные модели прицепов или полуприцепов не приведены."],
  ["ООО «СКСплюсА»", "Источники не дают достаточных сведений о собственном парке, тягачах или полуприцепах."],
  ["ООО «СПЕЦПРАЙМ»", "Источник подтверждает эксплуатацию самосвальной техники, но не полуприцепную технику."],
  ["ООО «Форест Групп»", "Связь с веткой установлена через отраслевой лесопромышленный профиль; наличие конкретного полуприцепа не заявлено, поэтому уровень ограничен B."]
];
for (const [name, note] of newlyDetectedFalseA) {
  test("492-company saved evidence does not invent A: " + name, () => {
    const d = classify(name, [note], {segment: "Карьер, лес, металлолом; тяжелый транспорт"});
    assert.notEqual(d.grade, "A");
    assert.equal(d.aEvidence, "");
  });
}

test("own trailer fleet stays A when only model is unknown", () => {
  const d = classify("ООО «Собственные полуприцепы»", [
    "Компания эксплуатирует собственный парк тягачей и полуприцепов, хотя конкретные модели не приведены."
  ]);
  assert.equal(d.grade, "A");
});

test("later independent positive source overrides an older unproved-fleet note", () => {
  const d = classify("АО «ПСКОВВТОРМЕТ»", [
    "Сведений о собственном автопарке и прицепах в старой странице нет.",
    "На официальной странице автотранспорта указан собственный автопарк с КамАЗами и полуприцепами типа опентоп, используемый для вывоза металлолома."
  ]);
  assert.equal(d.grade, "A");
});
