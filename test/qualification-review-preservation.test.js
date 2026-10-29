import test from "node:test";
import assert from "node:assert/strict";
import { postInnDedupe, deterministicQualificationDecision } from "../src/pipeline.js";

function rec(name, { inn = "", sheet = "direct_buyers", segment = "Автомобильные грузоперевозки",
  notes = ["Компания осуществляет автомобильные грузоперевозки."],
  url = "https://example.org/transport", canonical = "" } = {}) {
  return {
    sheet,
    row: {
      "Организация": name, "ИНН": inn, "Город/район": "Смоленская область",
      "Техника/сегмент": segment, "Основание": "",
      __canonical_id: canonical || name,
      __evidence: { source_urls: url ? [url] : [], notes }
    }
  };
}
function result(...records) {
  const x = { direct_buyers: [], intermediaries: [], leasing: [], statistics: [] };
  records.forEach(({ sheet, row }) => x[sheet].push(row));
  return x;
}
function commercialCount(r) {
  return r.direct_buyers.length + r.intermediaries.length + r.leasing.length;
}

test("qualified grade unavailable: keep transport company in checkpoint review, not commercial sheet", () => {
  const x = rec("ООО «Русавлогистик»", {
    inn: "6732040299",
    segment: "Автомобильный грузовой транспорт",
    notes: ["Компания перевозит грузы автомобильным транспортом, тип прицепов не установлен."]
  });
  const first = postInnDedupe(result(x), "Смоленская область").qualified.result;
  assert.equal(commercialCount(first), 0);
  assert.equal(first.qualification_review.length, 1);
  const q = first.qualification_review[0];
  assert.equal(q.__decision, "manual_review");
  assert.equal(q.__final_grade, "");
  assert.equal(q["ИНН"], "6732040299");
  assert.ok(q.__decision_reason);
  assert.equal(q.__qualification_origin_sheet, "direct_buyers");
  assert.deepEqual(q.__evidence.source_urls, ["https://example.org/transport"]);

  const afterSecondPass = postInnDedupe(first, "Смоленская область").qualified.result;
  assert.equal(commercialCount(afterSecondPass), 0);
  assert.equal(afterSecondPass.qualification_review.length, 1);
});

test("review queue retains all six Smolensk company types without granting fake C", () => {
  const records = [
    rec("ООО «ПТС ГРУПП»", { inn: "6679115482", segment: "Лизинг седельных тягачей",
      notes: ["Суд подтверждает лизинг седельных тягачей, полуприцеп не выявлен."] }),
    rec("ООО «Русавлогистик»", { inn: "6732040299", segment: "Автомобильные грузоперевозки" }),
    rec("ООО «ТК БЛ ГРУПП»", { segment: "Тягачи Volvo, DAF; водители категории CE" }),
    rec("ООО «Флариат Логистик»", { inn: "6724007668", segment: "Грузовой автопарк; мониторинг машин" }),
    rec("EastLines / Вязьма", { inn: "9726070029", segment: "Межрегиональные автомобильные грузоперевозки" }),
    rec("Ozon Фулфилмент", { inn: "5044122492", segment: "Фулфилмент и транспортная служба",
      notes: ["Вакансия механика по транспорту, состав автомобильного парка не установлен."] })
  ];
  const r = postInnDedupe(result(...records), "Смоленская область").qualified.result;
  assert.equal(r.qualification_review.length, 6);
  assert.equal(commercialCount(r), 0);
  assert.equal(new Set(r.qualification_review.map((row) => row["Организация"])).size, 6);
});

test("public institution and ceased legal entity are excluded, not in review", () => {
  const x = rec("Муниципальное бюджетное учреждение «Управление коммунального хозяйства»", {
    inn: "6726024549", segment: "Обслуживание спецтехники"
  });
  const y = rec("ООО «Смоленская транспортная компания»", { inn: "6731065653" });
  const r = postInnDedupe(result(x, y), "Смоленская область").qualified.result;
  assert.equal(r.qualification_review.length, 0);
  assert.equal(commercialCount(r), 0);
});

test("source-free unqualified claim cannot silently flood the review queue", () => {
  const x = rec("ООО «Неизвестная компания»", { url: "", notes: ["Компания предоставляет грузоперевозки."] });
  const r = postInnDedupe(result(x), "Смоленская область").qualified.result;
  assert.equal(r.qualification_review.length, 0);
});

test("real owned semitrailer stays in qualified A and not in review", () => {
  const x = rec("ООО «Грузоперевозчик»", {
    notes: ["Компания эксплуатирует собственный парк седельных тягачей с полуприцепами Krone."]
  });
  const r = postInnDedupe(result(x), "Смоленская область").qualified.result;
  assert.equal(r.direct_buyers.length, 1);
  assert.equal(r.direct_buyers[0].__final_grade, "A");
  assert.equal(r.qualification_review.length, 0);
});

test("small utility trailer tender alone cannot be A for direct buyer", () => {
  const r = rec("ПАО «МТС»", {
    notes: ["Компания закупила прицеп для передвижной дизель-генераторной установки (ДГУ), г. Смоленск."]
  });
  assert.notEqual(deterministicQualificationDecision(r).grade, "A");
});

test("preliminary repair quotation alone is not completed intermediary A", () => {
  const r = rec("ООО «ГарантТрейд»", { sheet: "intermediaries",
    notes: ["Предварительный заказ-наряд на ремонт полуприцепа KRONE SD и расчет стоимости ремонта."]
  });
  assert.notEqual(deterministicQualificationDecision(r).grade, "A");
});

test("completed repair documented in one note remains intermediary A", () => {
  const r = rec("ООО «ГарантТрейд»", { sheet: "intermediaries",
    notes: ["Выполнен ремонт полуприцепа KRONE SD, составлен акт выполненных работ по заказу перевозчика."]
  });
  assert.equal(deterministicQualificationDecision(r).grade, "A");
});

test("lease provider is not a direct buyer merely because it financed a semitrailer", () => {
  const r = rec("ООО «ФМФ»", {
    notes: ["Лизингодатель ООО «ФМФ» по договору лизинга полуприцепа Krone SD; лизингополучатель — перевозчик."]
  });
  assert.notEqual(deterministicQualificationDecision(r).grade, "A");
});

test("explicit verified same-company leasing contract remains leasing A", () => {
  const r = rec("ООО «ФМФ»", {
    sheet: "leasing",
    notes: ["Договор лизинга полуприцепа Krone SD; лизингодатель ООО «ФМФ», лизингополучатель ООО «Автоспецстрой»."]
  });
  assert.equal(deterministicQualificationDecision(r).grade, "A");
});
