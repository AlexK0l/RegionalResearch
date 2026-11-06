import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/benchmark-reference.js");
function workbookAt(file, rows) {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(book, sheet, "Прямые покупатели");
  XLSX.writeFile(book, file);
}
test("offline priority benchmark: Cyrillic aliases, INN conflicts and reversed initials", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "regionalresearch-benchmark-safety-"));
  try {
    const reference = path.join(dir, "reference.xlsx"), current = path.join(dir, "current.xlsx");
    workbookAt(reference, [
      { "Организация": "ООО «Альфа Полуприцеп»", "ИНН": "6732123456", "Цвет усл. форматирование": 1 },
      { "Организация": "ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ «Альфа Полуприцеп»", "ИНН": "6732123456", "Цвет усл. форматирование": 1 },
      { "Организация": "ООО «Промлес»", "ИНН": "7733850330", "Цвет усл. форматирование": 2 },
      { "Организация": "ИП глава КФХ Сумарин А.С.", "ИНН": "", "Цвет усл. форматирование": 2 },
      { "Организация": "ООО «Покупатель без ИНН»", "ИНН": "", "Цвет усл. форматирование": 2 }
    ]);
    workbookAt(current, [
      { "Организация": "ООО «Альфа Полуприцеп»", "ИНН": "6732123456" },
      { "Организация": "ООО «Промлес»", "ИНН": "6723011580" },
      { "Организация": "ИП глава КФХ Сумарин С.А.", "ИНН": "" },
      { "Организация": "Общество с ограниченной ответственностью «Покупатель без ИНН»", "ИНН": "" }
    ]);
    const result = spawnSync(process.execPath, [script, current, reference], { encoding: "utf8", timeout: 40000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const metrics = JSON.parse(result.stdout);
    assert.equal(metrics.reference_rows, 5);
    assert.equal(metrics.reference_priority_rows, 5);
    assert.equal(metrics.reference_priority_unique, 4);
    assert.equal(metrics.reference_priority_green_total, 1);
    assert.equal(metrics.reference_priority_yellow_total, 3);
    assert.equal(metrics.reference_priority_overlap, 2);
    assert.equal(metrics.reference_priority_matched_by_inn, 1);
    assert.equal(metrics.reference_priority_matched_by_name, 1);
    assert.equal(metrics.reference_priority_identity_conflicts, 1);
    assert.equal(metrics.reference_priority_missing, 1);
    assert.equal(metrics.reference_priority_green_found, 1);
    assert.equal(metrics.reference_priority_yellow_found, 1);
    assert.equal(metrics.reference_priority_recall_pct, 50);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("exact same-name collision with two other INNs cannot fake benchmark recall", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "regionalresearch-benchmark-multiinn-"));
  try {
    const reference = path.join(dir, "reference.xlsx"), current = path.join(dir, "current.xlsx");
    workbookAt(reference, [{ "Организация": "ООО «Промлес»", "ИНН": "7733850330", "Цвет усл. форматирование": 1 }]);
    workbookAt(current, [
      { "Организация": "ООО «Промлес»", "ИНН": "6723011580" },
      { "Организация": "ООО «Промлес»", "ИНН": "6701004981" }
    ]);
    const result = spawnSync(process.execPath, [script, current, reference], { encoding: "utf8", timeout: 40000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const metrics = JSON.parse(result.stdout);
    assert.equal(metrics.reference_priority_overlap, 0);
    assert.equal(metrics.reference_priority_identity_conflicts, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
