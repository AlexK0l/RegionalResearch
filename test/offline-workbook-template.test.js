import test from "node:test";
import assert from "node:assert/strict";
import XLSX from "xlsx";
import { projectRecoveredTemplateSheet } from "../src/offlineWorkbookTemplate.js";

const headers = [
  " ", "Организация", "TORGBOX", "Основание", "Итоговый коэффициент",
  "Расчётный коэффициент", "Телефон (старые)", "Телефон", "🔎 Телефон",
  "Результат поиска", "Цвет усл. форматирование", "Руководитель / ЛПР",
  "Как прошел звонок", "Ответственный", "Управляющая компания", "ИНН",
  "Выручка последнего подтвержденного года", "Город/район",
  "Техника/сегмент", "Следующее действие",
  "Почему им нужно звонить / потенциальный интерес к САТ", "Численность",
  "Холодный звонок", "Ответственный", "Этап", "Срок выполнения",
  "Квалификация лида", "Передан ОМиС", "Дата передачи", "РЕЗУЛЬТАТ",
  "Комментарий ОМиС", "Column 10", "Column 11", "Column 12", "Column 13",
  "Column 14", "Обоснование коэффициента (Apps Script)"
];
const withFields = (fields) => headers.map((h) => fields[h] || "");
const source = [
  { __canonical_id: "k1", "Организация": "АО «СпецАТХ»" },
  { __canonical_id: "k2", "Организация": "АО «Спецавтохозяйство»" },
  { __canonical_id: "k3", "Организация": "ООО «Без изменения»" }
];
const corrected = [
  {
    "Организация": "АО «Спецавтохозяйство»", "ИНН": "6731069440",
    "Основание": "B — проверка", "__comment": "ИНН: 6731069440",
    "__canonical_id": "k2", "__merged_canonical_ids": ["k1", "k2"],
    __evidence: { qualification_review: { status: "manual_review_required" } }
  },
  {
    "Организация": "ООО «Без изменения»", "ИНН": "6706005273",
    "__canonical_id": "k3", "__comment": "ИНН: 6706005273"
  }
];
function sourceSheet() {
  const rows = [
    headers,
    withFields({ "Организация": "АО «СпецАТХ»",
      "Основание": "A — старый", "Ответственный": "Менеджер 1", "Как прошел звонок": "Позвонили", "Телефон (старые)": "74812620133" }),
    withFields({ "Организация": "АО «Спецавтохозяйство»",
      "Основание": "B — старый", "Как прошел звонок": "Написали" }),
    withFields({ "Организация": "ООО «Без изменения»", "Этап": "В работе" })
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["B2"].c = [{ a: "Pipeline", t: "ИНН: не подтверждено — СпецАТХ" }];
  sheet["B3"].c = [{ a: "Pipeline", t: "ИНН: не подтверждено — Спецавтохозяйство" }];
  sheet["B4"].c = [{ a: "Pipeline", t: "ИНН: 6706005273 — Без изменения" }];
  return sheet;
}

test("37 original CRM columns remain, including notes from absorbed alias", () => {
  const x = projectRecoveredTemplateSheet(XLSX, sourceSheet(), source, corrected, { sheetName: "Прямые покупатели" });
  const rows = XLSX.utils.sheet_to_json(x.sheet, { header: 1, defval: "" });
  const h = rows[0];
  assert.equal(x.original_columns, 37);
  assert.equal(x.output_columns, 39);
  assert.deepEqual(h.slice(0, 37), headers);
  assert.equal(rows.length, 3);
  assert.equal(rows[1][h.indexOf("Организация")], "АО «Спецавтохозяйство»");
  assert.equal(rows[1][h.indexOf("ИНН")], "6731069440");
  assert.equal(rows[1][h.indexOf("Основание")], "B — проверка");
  assert.equal(rows[1][h.indexOf("Как прошел звонок")], "Написали");
  assert.equal(rows[1][h.indexOf("Ответственный")], "Менеджер 1");
  assert.equal(rows[1][h.indexOf("Проверка A/B/C")], "ПРОВЕРИТЬ: разные классы у объединённых алиасов");
  assert.equal(rows[2][h.indexOf("Этап")], "В работе");
  assert.equal(x.crmTransfers.length, 3); // Телефон (старые) and two Ответственный columns
  assert.equal(x.crmConflicts.length, 1);
  assert.equal(x.crmConflicts[0].field, "Как прошел звонок");
  assert.equal(x.commentsRemapped, 2);
  assert.equal(x.sheet["B2"].c[0].t, corrected[0].__comment);
  assert.equal(x.sheet["B3"].c[0].t, corrected[1].__comment);
  assert.equal(x.sheet["B2"].c[0].a, "Pipeline");
});

test("template source row mismatch fails rather than misassigning CRM notes", () => {
  const swapped = structuredClone(source);
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  assert.throws(
    () => projectRecoveredTemplateSheet(XLSX, sourceSheet(), swapped, corrected,
      { sheetName: "Прямые покупатели" }),
    /Template organization mismatch/
  );
});

test("template row-count mismatch fails rather than dropping companies", () => {
  assert.throws(
    () => projectRecoveredTemplateSheet(XLSX, sourceSheet(), source.slice(1), corrected,
      { sheetName: "Прямые покупатели" }),
    /Template row count mismatch/
  );
});
