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
