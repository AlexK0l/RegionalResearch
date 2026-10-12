import test from "node:test";
import assert from "node:assert/strict";
import { deterministicQualificationDecision } from "../src/pipeline.js";

function rec(sheet, organization, note, segment = "") {
  return {
    id: organization,
    sheet,
    row: {
      "Организация": organization,
      "Город/район": "Смоленская область",
      "Техника/сегмент": segment,
      "Основание": "",
      "ИНН": "",
      __evidence: { source_urls: [], notes: [note] }
    }
  };
}

test("negative service evidence cannot become A", () => {
  const d = deterministicQualificationDecision(rec(
    "intermediaries",
    "Автосервис «Супер-СТО»",
    "Источник подтверждает канал сервиса и снабжения, но не раскрывает конкретных клиентов или выполненных ремонтов полуприцепов.",
    "Грузовые прицепы и полуприцепы; запчасти Schmitz, BPW, SAF"
  ));
  assert.notEqual(d.grade, "A");
});

test("generic fleet monitoring without trailer proof cannot become A", () => {
  const d = deterministicQualificationDecision(rec(
    "direct_buyers",
    "ООО «ВиОл»",
    "Источник подтверждает эксплуатацию транспорта, но не раскрывает грузовой профиль, состав парка или наличие полуприцепов.",
    "Коммерческий автопарк под ГЛОНАСС-мониторингом"
  ));
  assert.notEqual(d.grade, "A");
});

test("warehouse operator is not promoted from a third-party trailer", () => {
  const d = deterministicQualificationDecision(rec(
    "intermediaries",
    "ООО «Вяземский терминал»",
    "На СВХ размещался автопоезд Volvo FH с полуприцепом Schmitz Cargobull; ООО выступало оператором СВХ, а не заявленным владельцем прицепа.",
    "Складской и таможенно-логистический комплекс"
  ));
  assert.notEqual(d.grade, "A");
});

test("product listing alone cannot become A", () => {
  const d = deterministicQualificationDecision(rec(
    "intermediaries",
    "ООО «М7»",
    "В объявлениях продавцом двух новых полуприцепов ТОНАР 95941 указано ООО «М7» из Смоленска.",
    "Новые полуприцепы-зерновозы ТОНАР 95941; продажа техники"
  ));
  assert.notEqual(d.grade, "A");
});

test("procurement of transport service is not trailer procurement", () => {
  const d = deterministicQualificationDecision(rec(
    "direct_buyers",
    "ООО «Префаб Технологии»",
    "Закупка: автотранспортные услуги по перевозке строительных материалов бортовыми полуприцепами.",
    "Бортовые и низкорамные полуприцепы; перевозка строительных материалов"
  ));
  assert.notEqual(d.grade, "A");
});

test("concrete trailer procurement remains A", () => {
  const d = deterministicQualificationDecision(rec(
    "direct_buyers",
    "АО «СмоленскРыбХоз»",
    "Опубликована коммерческая закупка: полуприцеп для перевозки живой рыбы в баках — 1 шт. для АО «СмоленскРыбХоз».",
    "Полуприцеп для перевозки живой рыбы"
  ));
  assert.equal(d.grade, "A");
  assert.equal(d.aRule, "direct_procurement");
});

test("confirmed own trailer fleet remains A", () => {
  const d = deterministicQualificationDecision(rec(
    "direct_buyers",
    "ООО «Карго Лайн Смоленск»",
    "Официальный сайт указывает собственный парк около 200 единиц и полуприцепы Schmitz Cargobull и Krone.",
    "Рефрижераторные полуприцепы Schmitz Cargobull и Krone"
  ));
  assert.equal(d.grade, "A");
  assert.equal(d.aRule, "direct_ownership_or_fleet");
});

test("named completed intermediary transaction remains A", () => {
  const d = deterministicQualificationDecision(rec(
    "intermediaries",
    "ООО «Агротехника»",
    "ООО «Агротехника» указано официальным дилером, через которого СПК «Рыбковское» приобрел полуприцеп ПС-25Б «Армата».",
    "Официальный дилер; полуприцеп ПС-25Б"
  ));
  assert.equal(d.grade, "A");
  assert.equal(d.aRule, "intermediary_completed_transaction");
});

test("established sale and rental trailer channel remains A", () => {
  const d = deterministicQualificationDecision(rec(
    "intermediaries",
    "ООО «РЕНТАЛ СОЛЮШН»",
    "Компания заявляет продажу и аренду тягачей и полуприцепов.",
    "Продажа и аренда тягачей и полуприцепов"
  ));
  assert.equal(d.grade, "A");
  assert.equal(d.aRule, "intermediary_established_channel");
});

test("concrete trailer leasing contracts remain A", () => {
  const d = deterministicQualificationDecision(rec(
    "leasing",
    "Европлан",
    "Источник содержит сведения о клиенте и договорах лизинга на полуприцепы ТОНАР 9445.",
    "Лизинг полуприцепов-сортиментовозов ТОНАР 9445"
  ));
  assert.equal(d.grade, "A");
  assert.equal(d.aRule, "leasing_concrete_contract");
});


test("trailer plus category without driver or vacancy is not driver-operation A", () => {
  const d = deterministicQualificationDecision(rec(
    "direct_buyers",
    "Карточка техники",
    "Полуприцеп Schmitz, категория транспортного средства E.",
    "Полуприцеп Schmitz"
  ));
  assert.notEqual(d.aRule, "direct_driver_operation");
});

test("driver vacancy plus CE category plus trailer remains driver-operation A", () => {
  const d = deterministicQualificationDecision(rec(
    "direct_buyers",
    "ООО «Перевозчик»",
    "Вакансия водителя категории CE для работы на седельном тягаче с полуприцепом.",
    "Седельный тягач и полуприцеп"
  ));
  assert.equal(d.grade, "A");
  assert.equal(d.aRule, "direct_driver_operation");
});

test("trailer ownership should resolve to ownership rule, not driver operation", () => {
  const d = deterministicQualificationDecision(rec(
    "direct_buyers",
    "ООО «ЛК ФАБРИКА»",
    "В карточке имущества указан полуприцеп KRONE SD и собственник ООО «ЛК ФАБРИКА».",
    "Полуприцеп KRONE SD"
  ));
  assert.equal(d.grade, "A");
  assert.notEqual(d.aRule, "direct_driver_operation");
});


test("negative evidence saying insufficient trailer proof cannot become A", () => {
  const d = deterministicQualificationDecision(rec(
    "direct_buyers",
    "ООО «Смоленское карьероуправление»",
    "Доказательств собственного парка, тягачей, лизинга или конкретных полуприцепов в найденном источнике недостаточно.",
    "Карьер; тяжелая техника; потенциальная прицепная эксплуатация"
  ));
  assert.notEqual(d.grade, "A");
});

test("B-level estimate in evidence cannot become A", () => {
  const d = deterministicQualificationDecision(rec(
    "direct_buyers",
    "ООО «БизнесТрансСтрой»",
    "ИНН взят из карточки юридического лица; связь с текущей эксплуатацией прицепной техники является оценкой уровня B.",
    "Тяжелые перевозки"
  ));
  assert.notEqual(d.grade, "A");
});

test("transport service procurement with semitrailers cannot become A", () => {
  const d = deterministicQualificationDecision(rec(
    "direct_buyers",
    "ООО «Префаб Технологии»",
    "Закупочная запись содержит тип транспорта — бортовые полуприцепы — и период оказания услуг.",
    "Бортовые полуприцепы; услуги перевозки"
  ));
  assert.notEqual(d.grade, "A");
});

test("potential operator language cannot become A", () => {
  const d = deterministicQualificationDecision(rec(
    "direct_buyers",
    "ООО «ТЭК Смолтрансавто»",
    "B — автомобильный грузовой транспорт и транспортно-экспедиционные услуги; потенциальный эксплуатант тягачей и полуприцепов.",
    "Грузовая логистика"
  ));
  assert.notEqual(d.grade, "A");
});

test("negative VIN statement cannot become direct_vin_ownership", () => {
  const d = deterministicQualificationDecision(rec(
    "direct_buyers",
    "ОАО «Автоколонна-1134»",
    "Данных о марках, VIN, владельцах отдельных единиц и повторных дорогостоящих ремонтах нет.",
    "Ремзона; ремонт прицепов"
  ));
  assert.notEqual(d.grade, "A");
});

test("unidentified service customer cannot become completed service A", () => {
  const d = deterministicQualificationDecision(rec(
    "intermediaries",
    "Tracstop67",
    "В открытой карточке нет достоверной идентификации клиента или модели полуприцепа.",
    "Ремонт полуприцепов"
  ));
  assert.notEqual(d.grade, "A");
});

test("former use wording does not prove intermediary own operation", () => {
  const d = deterministicQualificationDecision(rec(
    "intermediaries",
    "ООО «Литекс»",
    "Описана переделка и восстановление бывших в эксплуатации шторных полуприцепов, включая TIR-конструкции.",
    "Ремонт тентов и полуприцепов"
  ));
  assert.notEqual(d.aRule, "intermediary_own_operation");
});


test("explicit negative note blocks own-fleet A", () => {
  const d = deterministicQualificationDecision(rec(
    "direct_buyers",
    "АО «Смоленский авиационный завод»",
    "Прямое подтверждение ремонта именно прицепной техники или собственного парка тягачей/полуприцепов не обнаружено; кандидат оставлен на уровне C.",
    "Тяжелая техника"
  ));
  assert.notEqual(d.grade, "A");
});

test("terminal operator not owner cannot become intermediary own-operation A", () => {
  const d = deterministicQualificationDecision(rec(
    "intermediaries",
    "ООО «Вяземский терминал»",
    "Организация выступает оператором складской/терминальной услуги, а не собственником полуприцепа.",
    "Терминал; полуприцепы"
  ));
  assert.notEqual(d.grade, "A");
});

test("no published clients or trailer models blocks completed-service A", () => {
  const d = deterministicQualificationDecision(rec(
    "intermediaries",
    "ООО «МОССТРОЙСНАБ»",
    "Конкретные клиенты, модели гидроцилиндров или полуприцепов не опубликованы; уровень C.",
    "Ремонт гидравлики и полуприцепов"
  ));
  assert.notEqual(d.grade, "A");
});

test("economic-rationality inference cannot prove own fleet A", () => {
  const d = deterministicQualificationDecision(rec(
    "direct_buyers",
    "ООО «Флариат Логистик»",
    "Количество оснащенных автомобилей подтверждает наличие собственного или контролируемого автопарка; для такого профиля экономически рациональны шторные, бортовые и иные магистральные полуприцепы.",
    "Грузовые автомобили; потенциальные полуприцепы"
  ));
  assert.notEqual(d.grade, "A");
});

test("rail hopper evidence cannot become road trailer A", () => {
  const d = deterministicQualificationDecision(rec(
    "direct_buyers",
    "ООО «Транзит Сервис»",
    "Смоленская страница посвящена перевозке зерна в вагонах-хопперах; это подтверждает грузопоток, но не дает основания утверждать наличие собственных автоприцепов.",
    "Железнодорожные хопперы; зерно"
  ));
  assert.notEqual(d.grade, "A");
});

test("sale listing explicitly not own fleet cannot become intermediary own-operation A", () => {
  const d = deterministicQualificationDecision(rec(
    "intermediaries",
    "ООО «БЕЛСЕЛЬХОЗСНАБ 67»",
    "Организация размещает предложение по продаже самосвального прицепа ПСТ-3,5; это прямой канал к покупателям прицепной техники, но не доказательство собственного парка.",
    "Самосвальный прицеп ПСТ-3,5"
  ));
  assert.notEqual(d.aRule, "intermediary_own_operation");
});

test("confirmed identity region mismatch excludes otherwise strong company", () => {
  const d = deterministicQualificationDecision(rec(
    "direct_buyers",
    "ООО «Новотранс»",
    "Identity: региональный конфликт: юридическое лицо относится к Вологодской области, исходная привязка к запрошенному региону ошибочна.",
    "Собственный парк тягачей и полуприцепов"
  ));
  assert.equal(d.decision, "exclude");
  assert.equal(d.grade, "");
  assert.equal(d.signals.identityRegionMismatch, true);
});
