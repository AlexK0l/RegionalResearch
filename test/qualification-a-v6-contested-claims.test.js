import test from "node:test";
import assert from "node:assert/strict";
import { deterministicQualificationDecision } from "../src/pipeline.js";
import { rejectUnsafeAEvidence } from "../src/qualificationSafety.js";

function record(name, notes, segment = "Прицепная техника; грузовая логистика; зерно, щебень и древесина") {
  return { sheet: "direct_buyers", row: {
    "Организация": name,
    "Город/район": "Смоленская область",
    "Техника/сегмент": segment,
    "Основание": "",
    __evidence: { source_urls: ["https://example.org/source"], notes }
  }};
}
function grade(name, notes, segment) {
  return deterministicQualificationDecision(record(name, notes, segment));
}

test("ANIKS OIL: debtor's Kogel auction lots and a retrospective fleet are not A", () => {
  const d = grade("ООО «АНИКС ОЙЛ»", [
    "В публикации по торгам прямо указаны должник ООО «АНИКС ОЙЛ» и четыре полуприцепа KOGEL SN24 2011 года.",
    "Пакет из нескольких однотипных полуприцепов — сильный сигнал ранее сформированного парка и регулярной тяжёлой автологистики.",
    "Карточка должника → ООО «АНИКС ОЙЛ», ИНН 6732068086 → несколько лотов KOGEL SN24 с конкретными VIN.",
    "Организация указана должником по делу о банкротстве, а KOGEL SN24 — отдельным лотом имущества должника."
  ]);
  assert.notEqual(d.grade, "A");
  assert.equal(d.aEvidence, "");
});

test("ENERGOMASTER: repossessed collateral with VIN does not imply current buyer A", () => {
  const d = grade("ООО «ЭНЕРГОМАСТЕР»", [
    "Источник → лот по продаже залогового имущества → собственник/должник ООО «ЭНЕРГОМАСТЕР» → конкретный прицеп 86122В и VIN X9H86122BB0000048.",
    "Прицеп находился в Смоленской области, Вяземский район, с. Андрейково."
  ]);
  assert.notEqual(d.grade, "A");
  assert.equal(d.aEvidence, "");
});

test("PREFAB: buying delivery services with trailers is not buying a trailer", () => {
  const d = grade("ООО «Префаб Технологии»", [
    "В региональной подборке закупок указана закупка услуг по перевозке строительных материалов бортовыми полуприцепами для подразделений ООО «Префаб Технологии».",
    "В отдельной тендерной карточке перечислены полуприцепы, бортовые и низкорамные площадки, а ООО «Префаб Технологии» указано среди фактических грузовладельцев/заказчиков перевозки.",
    "Роль организации — заказчик перевозки строительных материалов, а не автоматически собственник техники."
  ]);
  assert.notEqual(d.grade, "A");
});

test("MP: PRKT-10-02 tractor-feed trailer is not a road semitrailer A", () => {
  const d = grade("ООО «МП»", [
    "Договор №30205964 с АО «Росагролизинг»: предмет — полуприцеп для раздачи кормов тракторный ПРКТ-10-02; договор указан как действующий."
  ], "Производство кормов и сельское хозяйство");
  assert.notEqual(d.grade, "A");
});

test("PROMAGRO: 2PTS-6.5 tractor trailer tender is not a road semitrailer A", () => {
  const d = grade("ООО «АПК «Промагро»", [
    "Предмет закупки — полуприцеп самосвальный тракторный 2ПТС-6,5 с надставными бортами; место поставки — Смоленская область."
  ], "Зерно и корма");
  assert.notEqual(d.grade, "A");
});

test("mixed road payload semitrailer procurement remains A despite agricultural implements", () => {
  const d = grade("АО «Авангард»", [
    "Закупки: полуприцеп г/п 28,5 т, полуприцеп и тракторные прицепы для нужд предприятия."
  ]);
  assert.equal(d.grade, "A");
});

test("Smolenskoe: PRT-12 farm roll trailer alone must not promote to A", () => {
  const d = grade("АО «Смоленское» по племенной работе", [
    "Закупка зерновоза в лизинг — 2025 год.",
    "Закупка полуприцепа-рулоновоза ПРТ-12 — конкретное событие обновления парка."
  ], "Зерно и корма");
  assert.notEqual(d.grade, "A");
});

test("subsequent exact-entity road trailer purchase survives older bankruptcy auction", () => {
  const d = grade("ООО «Автопарк»", [
    "В прошлом организация была должником по делу о банкротстве; прицеп выставлялся на торги.",
    "Позднее по отдельному договору ООО «Автопарк» приобрело грузовой полуприцеп Schmitz для собственных перевозок."
  ]);
  assert.equal(d.grade, "A");
  assert.match(d.aEvidence, /отдельному договору/i);
});

test("an explicit purchaser of an auction lot remains A, unlike the debtor", () => {
  const d = grade("ООО «Победитель торгов»", [
    "ООО «Победитель торгов» приобрело грузовой полуприцеп Schmitz на торгах как покупатель лота, а не должник."
  ]);
  assert.equal(d.grade, "A");
});

test("independent actual road semitrailer evidence survives an unrelated tractor implement", () => {
  const d = grade("ООО «Полевой автопарк»", [
    "Предприятие приобрело тракторный прицеп 2ПТС-6.",
    "Отдельный договор: ООО «Полевой автопарк» приобрело грузовой полуприцеп Kogel для автоперевозок."
  ]);
  assert.equal(d.grade, "A");
  assert.match(d.aEvidence, /Kogel/);
});

test("when evidence is positive the strongest buyer-side contract wins over earlier inference", () => {
  const d = grade("ООО «Карго Лайн Смоленск»", [
    "Международные грузоперевозки и водительская категория для тяжёлого транспорта указывают на регулярную сцепку тягач–полуприцеп.",
    "Судебный источник указывает ООО «Карго Лайн Смоленск» как лизингополучателя полуприцепа по договору.",
    "Позже суд подтвердил конкретное выполнение перевозки автопоездом с полуприцепом Krone."
  ]);
  assert.equal(d.grade, "A");
  assert.equal(d.aRule, "direct_financial_lease");
  assert.match(d.aEvidence, /Судебный источник/);
});

test("buyer-side Tonar financial lease is ranked over the traction-unit inference", () => {
  const d = grade("ИП Кучеренко Игорь", [
    "Источник прямо фиксирует роль ИП Кучеренко как лизингополучателя.",
    "Указан конкретный предмет финансовой аренды: прицеп-самосвал ТОНАР 85792.",
    "В источнике также указан лизинг седельного самосвала SCANIA P8X400, что подтверждает наличие тяговой единицы для эксплуатации прицепной техники."
  ]);
  assert.equal(d.grade, "A");
  assert.equal(d.aRule, "direct_financial_lease");
  assert.match(d.aEvidence, /ТОНАР 85792/);
});

test("a selected evidence note keeps exact source URL capitalization", () => {
  const source = "ООО «Покупатель» приобрело грузовой полуприцеп Schmitz по договору. ([Портал](https://example.org/CaseSensitivePath/XyZ))";
  const d = grade("ООО «Покупатель»", [source]);
  assert.equal(d.grade, "A");
  assert.equal(d.aEvidence, source);
});

test("genuine directly owned road trailer fleet remains A", () => {
  const d = grade("ООО «Перевозчик»", [
    "Компания эксплуатирует собственный парк тягачей и полуприцепов Schmitz Cargobull для регулярных грузоперевозок."
  ]);
  assert.equal(d.grade, "A");
});

test("genuine buyer of trailer for providing transport services is still A", () => {
  const d = grade("ООО «Доставка»", [
    "ООО «Доставка» приобрело полуприцеп Krone для оказания услуг по перевозке грузов."
  ]);
  assert.equal(d.grade, "A");
});
