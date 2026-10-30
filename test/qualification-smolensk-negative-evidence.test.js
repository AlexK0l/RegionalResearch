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

 
// Remaining false A from the second replay of the 492-company checkpoint.
const additionalRealNegatives = [
  ["ООО «Трансавто»", "Парк и типы прицепной техники требуют отдельной проверки."],
  ["ООО «ТЦ «Тюменские аккумуляторы»", "Публичных подтверждений собственного парка, лизинга либо эксплуатации полуприцепов в найденной ветке нет."],
  ["ООО «Сафоновский завод ЖБИ»", "Склад и автопарк указывают на регулярный оборот готовых ЖБИ и потребность в дополнительной прицепной технике."]
];
for (const [name, note] of additionalRealNegatives) {
  test("492-company v2 false positive A prevented: " + name, () => {
    const d = classify(name, [note], { segment: "Перевозки песка, щебня; прицепы и полуприцепы" });
    assert.notEqual(d.grade, "A");
    assert.equal(d.aEvidence, "");
  });
}

test("confirmed own semitrailer fleet remains A even if remaining park needs review", () => {
  const d = classify("ООО «Проверенный перевозчик»", [
    "Компания эксплуатирует собственный парк тягачей и полуприцепов Schmitz; остальной парк требует отдельной проверки."
  ]);
  assert.equal(d.grade, "A");
});

test("verified procurement remains A despite incomplete information on the remaining fleet", () => {
  const d = classify("ООО «Закупка полуприцепа»", [
    "Компания приобрела полуприцеп Schmitz для перевозок; остальные типы прицепной техники требуют отдельной проверки."
  ]);
  assert.equal(d.grade, "A");
});


test("negative public-proof note does not mask a later affirmative fleet source", () => {
  const d = classify("ООО «Собственник парка»", [
    "Публичных подтверждений собственного парка, лизинга либо эксплуатации полуприцепов в найденной ветке нет.",
    "Позднее опубликован официальный акт: компания эксплуатирует собственный парк полуприцепов Schmitz на перевозках."
  ]);
  assert.equal(d.grade, "A");
});


// Real A defects found in replay v3 (checkpoint f677c97e).
const v3RemainingFalseA = [
  ["ООО «ГАГАРИНАВТОГРУЗ»", [
    "Официальный реестр содержит ООО «ГАГАРИНАВТОГРУЗ» с адресом в Гагарине и сведениями о деятельности по перевозке автомобильным транспортом.",
    "Запись относится к периоду до 2021 года; актуальность конкретного состава автопарка не подтверждена.",
    "Не повышать до A/B без отдельного доказательства груза, тягача, полуприцепа, закупки, лизинга или ремонта."
  ]],
  ["ООО «Мяснойэксперт»", [
    "Вакансия «Водитель категории Е» у ООО «Мяснойэксперт».",
    "Организация связана с перевозкой/дистрибуцией мясной продукции; сочетание товарного профиля и категории E делает релевантной тягачную и полуприцепную технику.",
    "Конкретная модель полуприцепа в найденной карточке не указана."
  ]],
  ["ITECO", [
    "В Ярцево опубликована вакансия водителя категории Е/дальнобойщика.",
    "В агрегированной карточке указано поступление техники и типовые роли водителя тягача, фуры и полуприцепа.",
    "Отдельная модель или марка прицепа не подтверждена."
  ]],
  ["ООО «ФАНТОМ ГРУПП»", [
    "Организация выделена отдельно от ООО «Транс-СМ», поскольку источник прямо называет оба предприятия.",
    "Связь с прицепной техникой подтверждена общим описанием парка предприятий.",
    "Источник прямо относит ООО «ФАНТОМ ГРУПП» к предприятиям компании в Смоленске; тот же источник раскрывает собственный парк седельных тягачей и полуприцепов Schmitz/Kögel.",
    "Источник описывает общий собственный парк группы с тягачами DAF и полуприцепами Schmitz Cargobull/Kögel.",
    "Распределение 23 единиц между «Транс-СМ» и «ФАНТОМ ГРУПП» отдельно не раскрыто; кандидат сохранён как участник эксплуатирующей транспортной группы."
  ]]
];
for (const [name, notes] of v3RemainingFalseA) {
  test("v3 ambiguous or negative A cannot be promoted: " + name, () => {
    const d = classify(name, notes, {segment: "Грузоперевозки; полуприцепы и тяжёлая техника"});
    assert.notEqual(d.grade, "A");
    assert.equal(d.aEvidence, "");
  });
}

test("independent evidence for a subsidiary's specific trailer overrides unresolved group fleet", () => {
  const notes = [
    "Распределение 23 полуприцепов между предприятиями группы отдельно не раскрыто.",
    "ООО «ФАНТОМ ГРУПП» приобрело грузовой полуприцеп Schmitz для собственного парка по отдельному договору."
  ];
  const d=classify("ООО «ФАНТОМ ГРУПП»", notes);
  assert.equal(d.grade, "A");
});

test("concrete driver CE + semitrailer event still qualifies as A", () => {
  const d=classify("ООО «Перевозчик CE»", [
    "Вакансия водителя категории CE предусматривает перевозки на тягаче DAF с полуприцепом Schmitz, эксплуатируемым компанией."
  ]);
  assert.equal(d.grade, "A");
});
