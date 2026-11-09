import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { buildWorkbookBuffer, buildAuditWorkbookBuffer } from "../src/xlsx.js";

test("exports synchronized reference workbook layout", () => {
  const buffer = buildWorkbookBuffer({
    direct_buyers: [{
      "Организация": "ООО Тест",
      "Основание": "B — тест",
      "Наличие транспорта": "Saby (грузовые): КамАЗ — 2 шт.",
      "Телефон": "79990000000",
      "Руководитель / ЛПР": "Иванов И.И.",
      "Управляющая компания": "не подтверждена",
      "ИНН": "6732000000",
      "Выручка последнего подтвержденного года": "123456789",
      "Город/район": "Смоленск",
      "Техника/сегмент": "самосвальная",
      "Следующее действие": "Позвонить",
      "Почему им нужно звонить / потенциальный интерес к САТ": "тест",
      "Численность": "42"
    }],
    intermediaries: [{ "Организация": "ООО Посредник" }],
    leasing: [{ "Организация": "ООО Лизинг" }],
    statistics: [{
      "Показатель": "Население региона",
      "Значение": 1,
      "Единица измерения": "человек",
      "Период / дата актуальности": "2026",
      "Источник": "https://example.com",
      "Методика / примечание": "тест"
    }]
  });

  const wb = XLSX.read(buffer, { type: "buffer", cellFormula: true });
  assert.deepEqual(wb.SheetNames, [
    "Прямые покупатели",
    "Посредники",
    "Лизинг",
    "Статистика",
    "Статистика по цветам",
    "Легенда"
  ]);

  const direct = XLSX.utils.sheet_to_json(wb.Sheets["Прямые покупатели"], { header: 1, raw: true });
  const intermediary = XLSX.utils.sheet_to_json(wb.Sheets["Посредники"], { header: 1, raw: true });
  const leasing = XLSX.utils.sheet_to_json(wb.Sheets["Лизинг"], { header: 1, raw: true });
  const stats = XLSX.utils.sheet_to_json(wb.Sheets["Статистика"], { header: 1, raw: true });

  assert.equal(direct[0].length, 37);
  assert.equal(intermediary[0].length, 26);
  assert.equal(leasing[0].length, 27);
  assert.equal(stats[0].length, 6);
  assert.equal(direct[0][2], "Наличие транспорта");
  assert.equal(direct[1][2], "Saby (грузовые): КамАЗ — 2 шт.");
  assert.equal(direct[1][1], "ООО Тест");
  assert.equal(direct[1][16], 123456789);
  assert.equal(direct[1][21], 42);
  assert.equal(intermediary[1][2], "ООО Посредник");
  assert.equal(leasing[1][2], "ООО Лизинг");
  const colors = wb.Sheets["Статистика по цветам"];
  assert.match(colors.D2.f, /COUNTIF/);
  assert.equal(colors.D2.v, 1, "cached total must be correct without a formula engine");
  assert.equal(colors.D4.v, 1, "blank CRM color code is unprocessed/white");
  for (const cell of ["D5", "D6", "D7", "D8", "D9"]) {
    assert.equal(colors[cell].v, 0, cell + " counts only explicit CRM color values");
  }
  assert.match(colors.D4.f, /SUMPRODUCT/, "white formula counts blank and zero once");
});

test("main SAT stays six sheets when review queues exist; audit XLSX retains both queues", () => {
  const item = (name) => ({ "Организация": name, "ИНН": "6732114166",
    "__comment": "ИНН: 6732114166", "__canonical_id": name,
    "__evidence": {source_urls:["https://example.org/entity"],notes:["Проверка"]} });
  const data = {
    direct_buyers:[item("Active")], intermediaries:[], leasing:[], statistics:[],
    qualification_review:[{...item("Review"), "Телефон":"79999999999"}],
    qualification_excluded:[item("Excluded")]
  };
  const main = XLSX.read(buildWorkbookBuffer(data), {type:"buffer",cellComments:true});
  assert.deepEqual(main.SheetNames,[
    "Прямые покупатели","Посредники","Лизинг","Статистика",
    "Статистика по цветам","Легенда"
  ]);
  const qa = XLSX.read(buildAuditWorkbookBuffer(data), {type:"buffer",cellComments:true});
  assert.deepEqual(qa.SheetNames,["REVIEW","EXCLUDED"]);
  assert.equal(XLSX.utils.sheet_to_json(qa.Sheets.REVIEW).length,1);
  assert.equal(XLSX.utils.sheet_to_json(qa.Sheets.EXCLUDED).length,1);
  assert.equal(XLSX.utils.sheet_to_json(qa.Sheets.REVIEW)[0]["Телефон"],undefined);
  assert.match(qa.Sheets.A1?.v || "Организация",/Организация/);
  assert.equal(data.qualification_review[0]["Телефон"],"79999999999");
  assert.ok(qa.Sheets.REVIEW.A2.c);
});
