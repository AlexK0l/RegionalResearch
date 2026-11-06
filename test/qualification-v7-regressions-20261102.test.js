import test from "node:test";
import assert from "node:assert/strict";
import { deterministicQualificationDecision } from "../src/pipeline.js";
import { rejectUnsafeAEvidence } from "../src/qualificationSafety.js";
import { attributedCarrierTrailerB, namedCargoHaulageCustomerC } from "../src/researchQuality.js";

const build = (name, notes, segment = "Грузоперевозки; полуприцепы и прицепная техника") => ({
  sheet: "direct_buyers",
  row: {
    "Организация": name, "Город/район": "Смоленская область",
    "Техника/сегмент": segment, "Основание": "",
    __evidence: {
      source_urls: ["https://xfirm.ru/company/6732176412", "https://sudact.ru/arbitral/doc/BbKecKuHOlmW/"],
      notes, facts: []
    }
  }
});

test("v7 regression: MEXKOLONNA67 has an independently documented lessee contract despite public offer of services", () => {
  const record = build("ООО «МЕХКОЛОННА67»", [
    "Договор от 26.09.2022: завершённый, предмет — специализированный полуприцеп-тяжеловоз ТВЕРЬСТРОЙМАШ 993931; всего найдено 53 договора лизинга, компания — лизингополучатель. ([xfirm.ru](https://xfirm.ru/company/6732176412?utm_source=openai))",
    "В реестре отражены 53 договора лизинга, роль организации по ним — лизингополучатель; конкретно указан полуприцеп-тяжеловоз ТВЕРЬСТРОЙМАШ TVERSTROYMASH 993931.",
    "Публичное предложение услуг включает аренду автомобиля-длинномера/низкорамного полуприцепа, перевозку спецтехники и выполнение дорожных работ в Смоленске и области."
  ]);
  assert.equal(rejectUnsafeAEvidence(record, record.row.__evidence.notes[0]), "");
  assert.equal(deterministicQualificationDecision(record).grade, "A");
});

test("public offer of lowbed transport SERVICES is not bankruptcy asset disposal", () => {
  const record = build("ООО «Тяжеловоз»", [
    "Публичное предложение услуг включает перевозку строительной техники на низкорамном полуприцепе.",
    "ООО «Тяжеловоз» эксплуатирует собственный парк полуприцепов Schmitz для перевозок."
  ]);
  assert.equal(rejectUnsafeAEvidence(record, record.row.__evidence.notes[1]), "");
  assert.equal(deterministicQualificationDecision(record).grade, "A");
});

test("independent currently operating fleet survives unrelated insolvency auction without special temporal keyword", () => {
  const record = build("ООО «Актуальный перевозчик»", [
    "Ранее должник продавал прицеп через конкурсные торги в деле о банкротстве.",
    "Официальный договор ООО «Актуальный перевозчик» фиксирует эксплуатацию собственного парка тягачей и полуприцепов Schmitz."
  ]);
  assert.equal(deterministicQualificationDecision(record).grade, "A");
});

test("historical auction plus inferred former fleet remains blocked without real current asset", () => {
  const record = build("ООО «АНИКС ОЙЛ»", [
    "В публикации по торгам прямо указаны должник ООО «АНИКС ОЙЛ» и четыре полуприцепа KOGEL SN24 2011 года.",
    "Пакет из нескольких однотипных полуприцепов — сильный сигнал ранее сформированного парка и регулярной тяжёлой автологистики.",
    "Карточка должника → ООО «АНИКС ОЙЛ», ИНН 6732068086 → несколько лотов KOGEL SN24 с конкретными VIN.",
    "Организация указана должником по делу о банкротстве, а KOGEL SN24 — отдельным лотом имущества должника."
  ]);
  assert.notEqual(deterministicQualificationDecision(record).grade, "A");
});

test("v7 VAB TRANSPORT: specific company is a court-documented carrier and listed trailer -> B, not A", () => {
  const record = build("ООО «ВАБ ТРАНСПОРТ»", [
    "Источник прямо связывает ООО «ВАБ ТРАНСПОРТ» с тремя полуприцепами KOGEL S24-1.",
    "ООО «Ваб транспорт» указано исполнителем транспортно-экспедиционных услуг и перевозчиком партии бытовой техники массой 5 000 кг. При перевозке произошла авария, в результате которой была повреждена партия из 180 стиральных машин. ([sudact.ru](https://sudact.ru/arbitral/doc/BbKecKuHOlmW/))",
    "Связка «заказчик/экспедитор ООО «ИТЕКО Россия» — перевозчик ООО «Ваб транспорт» — груз ООО «Хайер электрикал эпплаенсис Рус»» подтверждает реальный тяжёлый автомобильный грузопоток, но найденный акт не устанавливает собственника конкретного полуприцепа.",
    "За ООО «ВАБ ТРАНСПОРТ» указан полуприцеп Kögel S24-1 2018 года выпуска.",
    "В открытых данных отражены договоры лизинга, где организация выступает лизингополучателем."
  ]);
  assert.equal(attributedCarrierTrailerB(record.row).valid, true);
  const result = deterministicQualificationDecision(record);
  assert.equal(result.grade, "B");
  assert.equal(result.aEvidence, "");
});

test("named carrier B must not pass with only third-party association", () => {
  const record = build("ООО «ИТЕКО Россия»", [
    "Источник прямо связывает ООО «ВАБ ТРАНСПОРТ» с тремя полуприцепами KOGEL S24-1.",
    "ООО «Ваб транспорт» указано исполнителем транспортно-экспедиционных услуг и перевозчиком партии бытовой техники массой 5 000 кг. ([sudact.ru](https://sudact.ru/arbitral/doc/BbKecKuHOlmW/))",
    "Связка «заказчик/экспедитор ООО «ИТЕКО Россия» — перевозчик ООО «Ваб транспорт» — груз ООО «Хайер»» не доказывает собственный парк."
  ]);
  assert.equal(attributedCarrierTrailerB(record.row).valid, false);
  assert.notEqual(deterministicQualificationDecision(record).grade, "B");
});

test("an employer's CE vacancy or unnamed trailer is not concrete B", () => {
  const record = build("ООО «Мяснойэксперт»", [
    "Вакансия «Водитель категории Е» у ООО «Мяснойэксперт».",
    "У организации есть перевозки мясной продукции, но конкретный полуприцеп не указан."
  ]);
  assert.equal(attributedCarrierTrailerB(record.row).valid, false);
  assert.notEqual(deterministicQualificationDecision(record).grade, "A");
});

test("v7 PREFAB: real construction-materials haulage SERVICE tender -> C, never A", () => {
  const record = build("ООО «Префаб Технологии»", [
    "В региональной подборке закупок указана закупка услуг по перевозке строительных материалов бортовыми полуприцепами для подразделений ООО «Префаб Технологии».",
    "В отдельной тендерной карточке перечислены полуприцепы, бортовые и низкорамные площадки, а ООО «Префаб Технологии» указано среди фактических грузовладельцев/заказчиков перевозки.",
    "Роль организации — заказчик перевозки строительных материалов, а не автоматически собственник техники."
  ]);
  assert.equal(namedCargoHaulageCustomerC(record.row), true);
  const result = deterministicQualificationDecision(record);
  assert.equal(result.grade, "C");
  assert.equal(result.aEvidence, "");
});

test("a hypothetical future purchase of haulage services is not cargo customer C", () => {
  const record = build("ООО «Пока не заказчик»", [
    "Компания потенциально планирует закупку услуг по перевозке строительных материалов, но тендера или договора пока нет."
  ]);
  assert.equal(namedCargoHaulageCustomerC(record.row), false);
});

test("v7 ENERGOMASTER debtor collateral is not resurrected as A", () => {
  const record = build("ООО «ЭНЕРГОМАСТЕР»", [
    "Источник → лот по продаже залогового имущества → собственник/должник ООО «ЭНЕРГОМАСТЕР» → конкретный прицеп 86122В и VIN X9H86122BB0000048.",
    "Прицеп находился в Смоленской области, Вяземский район, с. Андрейково."
  ]);
  assert.notEqual(deterministicQualificationDecision(record).grade, "A");
});

test("tractor feed implement is still not an A road-trailer", () => {
  const record = build("ООО «МП»", [
    "Договор №30205964 с АО «Росагролизинг»: предмет — полуприцеп для раздачи кормов тракторный ПРКТ-10-02."
  ]);
  assert.notEqual(deterministicQualificationDecision(record).grade, "A");
});
