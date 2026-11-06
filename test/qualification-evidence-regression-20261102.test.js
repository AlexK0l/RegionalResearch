import test from "node:test";
import assert from "node:assert/strict";
import { deterministicQualificationDecision, actionableUnqualifiedLead } from "../src/pipeline.js";
import { independentBSignals } from "../src/researchQuality.js";
import { commercialEligibility } from "../src/qualificationSafety.js";

const company = (name, notes, segment = "Древесина, отходы и тяжёлые грузы") => ({
  sheet: "direct_buyers",
  row: {
    "Организация": name, "Город/район": "Смоленская область",
    "Техника/сегмент": segment, "Основание": "",
    __evidence: { source_urls: ["https://example.org/source"], notes, facts: [] }
  }
});

test("producing pellets and recommending semitrailers cannot fabricate a heavy B signal", () => {
  const r = company("ООО Производитель брикетов", [
    "Предприятие перерабатывает древесные отходы в топливные брикеты.",
    "Есть регулярная отгрузка готовых изделий покупателям.",
    "Для перевозки сырья и готовой продукции подходят тентованные и специализированные полуприцепы."
  ]);
  assert.equal(independentBSignals(r.row).valid, false);
  assert.equal(deterministicQualificationDecision(r).grade, "C");
});

test("heavy road deliveries by explicitly named own forest fleet can support B, not A", () => {
  const r = company("ООО Лесопиление", [
    "Предприятие перерабатывает древесину и производит пиломатериалы.",
    "Собственный сайт прямо указывает доставку продукции лесовозом, собственным транспортом и транспортными компаниями."
  ]);
  assert.equal(independentBSignals(r.row).valid, true);
  assert.equal(deterministicQualificationDecision(r).grade, "B");
});

test("possible road movement by a third-party forest carrier is not B", () => {
  const r = company("ООО Лесопиление", [
    "Предприятие перерабатывает древесину и производит пиломатериалы.",
    "Предполагается доставка лесовозами сторонних транспортных компаний."
  ]);
  assert.equal(independentBSignals(r.row).valid, false);
  assert.notEqual(deterministicQualificationDecision(r).grade, "B");
});

test("containers and waste collection alone do not prove an attributable heavy fleet", () => {
  const r = company("ООО Переработка", [
    "Компания оказывает услуги сбора и транспортировки отходов.",
    "Указаны лицензия и контейнеры; тяжелый автопарк в источнике не раскрыт."
  ], "Отходы и контейнеры");
  assert.equal(independentBSignals(r.row).valid, false);
  assert.equal(deterministicQualificationDecision(r).grade, "C");
});

test("selling a trailer at insolvency auction is not current buyer evidence", () => {
  const r = company("МУП Транспортное предприятие", [
    "Предмет торгов — прицеп, ранее находившийся на балансе коммунальной организации; продажа связана с процедурой банкротства."
  ], "Вывоз отходов и коммунальный транспорт");
  assert.notEqual(deterministicQualificationDecision(r).grade, "A");
});

test("later separate active acquisition still supports A despite archived insolvency disposal", () => {
  const r = company("ООО Автопарк", [
    "Ранее прицеп продавался в рамках процедуры банкротства.",
    "В новом договоре ООО Автопарк приобрело грузовой полуприцеп Schmitz для собственного парка."
  ]);
  assert.equal(deterministicQualificationDecision(r).grade, "A");
});

test("an industry publication explicitly used as a source is not a direct buyer", () => {
  const r = company("Журнал «Отраслевые перевозки»", [
    "Публикация содержит справочник предприятий по перевозке древесины.",
    "Роль — информационный и профессиональный discovery-канал; покупатели — предприятия из списка."
  ]);
  assert.equal(commercialEligibility(r.row).kind, "source_channel");
  assert.equal(commercialEligibility(r.row).blocked, true);
  assert.equal(deterministicQualificationDecision(r).grade, "");
  assert.equal(actionableUnqualifiedLead(r), false);
});

test("a genuine heavy transporter is not excluded by publisher rule", () => {
  const r = company("ООО Грузовоз", [
    "Компания эксплуатирует собственный парк тягачей и полуприцепов Schmitz."
  ]);
  assert.equal(commercialEligibility(r.row).blocked, false);
  assert.equal(deterministicQualificationDecision(r).grade, "A");
});
