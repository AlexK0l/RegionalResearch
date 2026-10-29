import test from "node:test";
import assert from "node:assert/strict";
import XLSX from "xlsx";
import { refreshColorStatistics } from "../src/offlineColorStatistics.js";

function sat() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    [" ", "Организация", "a", "b", "c", "d", "e", "f", "g", "h", "Цвет усл. форматирование"],
    ["", "АО «Первое»", "", "", "", "", "", "", "", "", null],
    ["", "АО «Второе»", "", "", "", "", "", "", "", "", 1],
    ["", "АО «Третье»", "", "", "", "", "", "", "", "", 2]
  ]), "Прямые покупатели");
  const stats = XLSX.utils.aoa_to_sheet([
    ["Показатель", "Код", "Описание", "Количество"],
    ["Всего компаний", "", "Все компании", 0],
    [],
    ["Белый", 0, "Не обработано", 0],
    ["Зеленый", 1, "Хороший", 0],
    ["Желтый", 2, "Хорошо, но не наш", 0],
    ["Красный", 3, "Не подходит", 0],
    ["Синий", 4, "Некорректный номер", 0],
    ["Серый", 5, "В обработке", 0]
  ]);
  stats.D2.f = 'COUNTIF(\'Прямые покупатели\'!B:B,"<>")-1';
  for (let code = 0; code <= 5; code++) {
    stats["D" + (code + 4)].f = "COUNTIF('Прямые покупатели'!K:K," + code + ")";
  }
  XLSX.utils.book_append_sheet(wb, stats, "Статистика по цветам");
  return wb;
}

test("refreshColorStatistics calculates company and color cache correctly from real data", () => {
  const wb = sat();
  const output = refreshColorStatistics(XLSX, wb);
  assert.equal(output.refreshed, true);
  assert.equal(output.total, 3);
  assert.deepEqual(output.codes, { 0: 1, 1: 1, 2: 1, 3: 0, 4: 0, 5: 0 });
  assert.equal(wb.Sheets["Статистика по цветам"].D2.v, 3);
  assert.equal(wb.Sheets["Статистика по цветам"].D4.v, 1);
  assert.equal(wb.Sheets["Статистика по цветам"].D5.v, 1);
  assert.equal(wb.Sheets["Статистика по цветам"].D6.v, 1);
  assert.match(wb.Sheets["Статистика по цветам"].D4.f, /SUMPRODUCT/);
  assert.match(wb.Sheets["Статистика по цветам"].D5.f, /COUNTIFS/);
  const roundTrip = XLSX.read(XLSX.write(wb, { bookType: "xlsx", type: "buffer" }), { type: "buffer" });
  assert.equal(roundTrip.Sheets["Статистика по цветам"].D2.v, 3);
  assert.equal(roundTrip.Sheets["Статистика по цветам"].D4.v, 1);
  assert.equal(roundTrip.Sheets["Статистика по цветам"].D5.v, 1);
  assert.equal(roundTrip.Sheets["Статистика по цветам"].D6.v, 1);
});

test("no color statistics tab means no-op rather than error", () => {
  const wb = sat();
  delete wb.Sheets["Статистика по цветам"];
  assert.equal(refreshColorStatistics(XLSX, wb).refreshed, false);
});

test("custom formula is not silently overwritten", () => {
  const wb = sat();
  wb.Sheets["Статистика по цветам"].D2.f = "SUM(A1:A5)";
  assert.throws(() => refreshColorStatistics(XLSX, wb),
    /Cannot safely refresh modified SAT formula/);
});
