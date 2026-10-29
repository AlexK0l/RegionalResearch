import test from "node:test";
import assert from "node:assert/strict";
import {
  independentBSignals, verifiedInnFromEvidence,
  populateKnownEvidenceFields, populateCommercialActions, safeSearchPriority
} from "../src/researchQuality.js";

function row(notes = [], facts = []) {
  return {
    "Организация": "ООО Тест",
    "ИНН": "1234567890",
    "Техника/сегмент": "зерно",
    __evidence: { notes, source_urls: ["https://example.org/cargo"], facts }
  };
}

test("single generic note does not create independent B evidence", () => {
  assert.equal(independentBSignals(row(["Перевозка зерна автотранспортом"])).valid, false);
});

test("separate cargo and fleet evidence supports B", () => {
  const value = row(["Хозяйство выращивает зерно", "В собственности седельные тягачи для перевозок"]);
  assert.equal(independentBSignals(value).valid, true);
});

test("structured claims can establish independent B evidence", () => {
  const value = row([], [
    { fact_type: "cargo_process", source_url: "https://example.org/cargo", statement: "Производство и отгрузка зерна" },
    { fact_type: "heavy_transport", source_url: "https://example.org/fleet", statement: "Эксплуатируются седельные тягачи" }
  ]);
  assert.equal(independentBSignals(value).valid, true);
});

test("verified INN requires matching proof and source URL", () => {
  const value = row();
  const norm = (x) => String(x || "");
  assert.equal(verifiedInnFromEvidence(value, norm), "");
  value.__evidence.identity_verification = {
    inn: "1234567890", method: "identity_web", source_urls: ["https://example.org/inn"]
  };
  assert.equal(verifiedInnFromEvidence(value, norm), "1234567890");
  value.__evidence.identity_verification.inn = "9999999999";
  assert.equal(verifiedInnFromEvidence(value, norm), "");
});

test("local evidence reuse fills only unambiguous sourced numbers", () => {
  const value = row([], [
    { source_url: "https://example.org/fin", statement: "Выручка: 12000000 рублей" },
    { source_url: "https://example.org/fin", statement: "Численность: 31 сотрудников" }
  ]);
  assert.equal(populateKnownEvidenceFields(value), 2);
  assert.equal(value["Выручка последнего подтвержденного года"], 12000000);
  assert.equal(value["Численность"], 31);
});

test("commercial actions are populated without claiming an invented trigger", () => {
  const value = row(["Выращивание зерна подтверждено"]);
  populateCommercialActions(value, "direct_buyers", "C");
  assert.match(value["Следующее действие"], /перевозчика/);
  assert.match(value["Почему им нужно звонить \/ потенциальный интерес к САТ"], /зерна/);
  assert.equal(safeSearchPriority({ "Основание": "A — ..." }), 3);
});


test("Smolensk: СпецАТХ has independent waste flow and vehicle-use evidence", () => {
  const value = row([
    "Официальный сайт подтверждает регулярное транспортирование и захоронение ТКО и строительного мусора, а также наличие специализированной техники.",
    "Вакансия подтверждает эксплуатацию мусоровоза и набор водителей под регулярный отходный поток."
  ]);
  assert.equal(independentBSignals(value).valid, true);
});

test("Smolensk: bulk goods produced and delivered by own transport qualifies B", () => {
  const value = row([
    "Сайт указывает производство бетона, доставку песка и щебня собственным транспортом.",
    "Заявлена работа по Вяземскому и соседним районам."
  ]);
  assert.equal(independentBSignals(value).valid, true);
});

test("Smolensk: independent own dump-truck fleet and quarry shipments qualify B", () => {
  const value = row([
    "Сайт связывает НЕРУД-СМ с поставками песка, щебня, ПГС и грунта по Смоленску и области.",
    "Указаны собственный автопарк и доставка самосвалами."
  ]);
  assert.equal(independentBSignals(value).valid, true);
});

test("Smolensk: source caveat does not erase an affirmative fleet statement", () => {
  const value = row([
    "Организация производит щебень; эксплуатирует собственные самосвалы; конкретные полуприцепы не подтверждены."
  ]);
  assert.equal(independentBSignals(value).valid, true);
});

test("Smolensk: regular contracted TKO collection plus transport licence qualify B", () => {
  const value = row([
    "Официальный муниципальный договор подтверждает регулярный вывоз ТКО не реже одного раза в неделю.",
    "Лицензионные сведения подтверждают право на транспортирование отходов I–IV классов."
  ]);
  assert.equal(independentBSignals(value).valid, true);
});

test("Smolensk: crop area and grain harvesters alone are not heavy-road-logistics proof", () => {
  const value = row([
    "Описаны зернохранилище и комплекс приёмки, очистки и сушки зерна.",
    "Подтверждены посевные площади и намерение приобрести зерноуборочные комбайны."
  ]);
  assert.equal(independentBSignals(value).valid, false);
});

test("Smolensk: quarry and inferred transport need remain C", () => {
  const value = row([
    "Недропользователь осуществляет добычу песчано-гравийной смеси на карьере.",
    "Карьерная логистика экономически требует самосвалов; собственный парк техники не подтверждён."
  ]);
  assert.equal(independentBSignals(value).valid, false);
});

test("Smolensk: source-confirmed cargo with missing fleet evidence remains C", () => {
  const value = row([
    "ООО ГЛАВМЕТ указано как оператор пунктов приёма металлолома.",
    "Для уровня B требуется дополнительное подтверждение контрактов на вывоз или тяжёлого парка."
  ]);
  assert.equal(independentBSignals(value).valid, false);
});

test("A single claim 'transporting grain by truck' is not two independent facts", () => {
  assert.equal(independentBSignals(row(["Компания перевозит зерно на КамАЗ"])).valid, false);
});

test("Explicitly negative fleet evidence cannot be used as a positive signal", () => {
  assert.equal(independentBSignals(row([
    "Компания добывает щебень.",
    "Собственные грузовые самосвалы отсутствуют."
  ])).valid, false);
});

test("Same independence_group does not count as two independent structured facts", () => {
  const value = row([], [
    { fact_type: "cargo_process", independence_group: "one", source_url: "https://example.org/a", statement: "Компания производит бетон" },
    { fact_type: "heavy_transport", independence_group: "one", source_url: "https://example.org/b", statement: "Компания эксплуатирует самосвалы" }
  ]);
  assert.equal(independentBSignals(value).valid, false);
});


test("positive transport assertion survives comma + negative trailer caveat", () => {
  const value = row([
    "Предприятие перерабатывает щебень.",
    "В собственности предприятия самосвалы, конкретная марка полуприцепа не подтверждена."
  ]);
  assert.equal(independentBSignals(value).valid, true);
});

test("quoted source notes alone cannot promote B without any URL", () => {
  const value = row([
    "Компания производит зерно.",
    "Предприятие эксплуатирует самосвалы."
  ]);
  value.__evidence.source_urls = [];
  assert.equal(independentBSignals(value).valid, false);
});


test("Smolensk: hypothetical delivery requirements cannot independently justify B", () => {
  const value = row([
    "Официальный сайт подтверждает производство бетона, строительных растворов, ЖБИ и кирпича.",
    "Это регулярный поток тяжелых строительных грузов, требующий автомобильной доставки."
  ]);
  assert.equal(independentBSignals(value).valid, false);
});

test("Smolensk: bulk supply contract plus inferred haulage demand remains C", () => {
  const value = row([
    "ООО АБЗ Мастер выполняло добычные работы на карьере и сортировало ПГС на песок и щебень.",
    "Подтвержден крупный договор поставки ПГС объемом 8 490 м³, что создает устойчивую потребность в вывозной логистике."
  ]);
  assert.equal(independentBSignals(value).valid, false);
});

test("Smolensk: supply catalog does not prove operator owns trailers", () => {
  const value = row([
    "В описаниях указана перевозка строительных и сельскохозяйственных грузов, зерна и органических удобрений.",
    "В каталоге по Смоленску поставщиком нескольких моделей полуприцепов указан АгроТехЛизинг."
  ]);
  assert.equal(independentBSignals(value).valid, false);
});

test("Smolensk: explicit need for further transport proof is not an operating signal", () => {
  const value = row([
    "Экологический документ указывает ГЛАВМЕТ как лицензиата по сбору и транспортированию отходов III–IV классов.",
    "Для уровня B требуется дополнительное подтверждение транспортирования, парка или контрактов на вывоз."
  ]);
  assert.equal(independentBSignals(value).valid, false);
});

test("Smolensk checkpoint: negated shared fleet list never proves B", () => {
  const value = row([
    "АО НПП Измеритель включено в перечень предприятий, утилизирующих отходы I–V классов.",
    "Собственные тягачи, полуприцепы либо конкретные транспортные события не найдены."
  ]);
  assert.equal(independentBSignals(value).valid, false);
});

test("Smolensk checkpoint: фуражное зерно cannot be recognized as a фура", () => {
  const value = row([
    "ООО Агритек перерабатывает масличные культуры и отгружает шрот.",
    "Региональный департамент сообщал о планах закупать продовольственное и фуражное зерно."
  ]);
  assert.equal(independentBSignals(value).valid, false);
});

test("Smolensk checkpoint: economically relevant scrap-haulage idea is not fleet proof", () => {
  const value = row([
    "Компания занимается торговлей ломом и отходами.",
    "Для вывоза лома экономически релевантны ломовозы и бункеровозы; собственный парк не подтверждён."
  ]);
  assert.equal(independentBSignals(value).valid, false);
});

test("Smolensk checkpoint: explicit owned dump trucks still count despite unconfirmed trailer model", () => {
  const value = row([
    "Организация производит щебень.",
    "В собственности предприятия самосвалы, конкретная марка полуприцепа не подтверждена."
  ]);
  assert.equal(independentBSignals(value).valid, true);
});

test("Smolensk checkpoint: projected trailer demand is not evidence of own road fleet", () => {
  const value = row([
    "ООО Агритек производит рапсовое масло и шрот и отгружает сырьё.",
    "Потребность в зерновозах/самосвальных полуприцепах вытекает из входящего потока масличного сырья и вывоза продуктов переработки; собственный парк не подтверждён."
  ]);
  assert.equal(independentBSignals(value).valid, false);
});
