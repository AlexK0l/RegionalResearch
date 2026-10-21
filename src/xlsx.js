import * as XLSX from "xlsx";
import {
  DIRECT_BUYER_COLS,
  INTERMEDIARY_COLS,
  LEASING_COLS,
  STAT_COLS,
  COLOR_STAT_COLS,
  LEGEND_COLS
} from "./constants.js";

const DIRECT_MAP = [
  null,
  "Организация",
  null,
  "Основание",
  null,
  null,
  null,
  "Телефон",
  null,
  null,
  null,
  "Руководитель / ЛПР",
  null,
  null,
  "Управляющая компания",
  "ИНН",
  "Выручка последнего подтвержденного года",
  "Город/район",
  "Техника/сегмент",
  "Следующее действие",
  "Почему им нужно звонить / потенциальный интерес к САТ",
  "Численность",
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null
];

const INTERMEDIARY_MAP = [
  null,
  null,
  "Организация",
  "Управляющая компания",
  "ИНН",
  "Город/район",
  "Техника/сегмент",
  "Основание",
  "Телефон",
  null,
  null,
  "Следующее действие",
  "Почему им нужно звонить / потенциальный интерес к САТ",
  "Руководитель / ЛПР",
  "Выручка последнего подтвержденного года",
  "Численность",
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null
];

const LEASING_MAP = [
  null,
  null,
  "Организация",
  "Управляющая компания",
  "ИНН",
  "Город/район",
  "Техника/сегмент",
  "Основание",
  "Телефон",
  null,
  null,
  null,
  "Следующее действие",
  "Почему им нужно звонить / потенциальный интерес к САТ",
  "Руководитель / ЛПР",
  "Выручка последнего подтвержденного года",
  "Численность",
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null
];

function strictNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  const text = String(value ?? "").trim().replace(/\s+/g, "");
  if (!/^-?\d+(?:[.,]\d+)?$/.test(text)) return "";
  const parsed = Number(text.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : "";
}

function mappedValue(row, field) {
  if (!field) return "";
  if (field === "Выручка последнего подтвержденного года") {
    const value = strictNumber(row?.[field]);
    return value === "" ? "" : Math.round(value);
  }
  if (field === "Численность") {
    const value = strictNumber(row?.[field]);
    return value === "" ? "" : Math.round(value);
  }
  return row?.[field] ?? "";
}

function buildCommercialSheet(rows, headers, mapping, organizationColumnIndex) {
  const aoa = [
    headers,
    ...(rows || []).map((row) => mapping.map((field) => mappedValue(row, field)))
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = headers.map((header) => ({
    wch: Math.min(48, Math.max(12, String(header || "").length + 2))
  }));

  for (let index = 0; index < (rows || []).length; index++) {
    const comment = String(rows[index]?.__comment || "").trim();
    if (!comment) continue;
    const ref = XLSX.utils.encode_cell({ r: index + 1, c: organizationColumnIndex });
    if (!ws[ref]) ws[ref] = { t: "s", v: String(rows[index]?.["Организация"] || "") };
    ws[ref].c = [{ a: "RegionalResearch", t: comment }];
  }
  return ws;
}

function buildStatisticsSheet(rows) {
  const aoa = [
    STAT_COLS,
    ...(rows || []).map((row) => STAT_COLS.map((field) => row?.[field] ?? ""))
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = STAT_COLS.map((header) => ({
    wch: Math.min(64, Math.max(16, header.length + 2))
  }));
  return ws;
}

function buildColorStatisticsSheet() {
  const rows = [
    COLOR_STAT_COLS,
    ["Всего компаний", "", "Все компании на листе «Прямые покупатели»", ""],
    ["", "", "", ""],
    ["Белый", 0, "Не обработано", ""],
    ["Зеленый", 1, "Хороший", ""],
    ["Желтый", 2, "Хорошо, но не наш", ""],
    ["Красный", 3, "Не подходит", ""],
    ["Синий", 4, "некорректный номер", ""],
    ["Серый", 5, "В обработке", ""]
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  // SheetJS omits formula-only numeric cells when writing XLSX unless a cached
  // value is present. Keep v=0 so formulas survive the write/read round-trip;
  // Excel/LibreOffice will recalculate them when the workbook is opened.
  ws.D2 = { t: "n", v: 0, f: "COUNTIF('Прямые покупатели'!B:B,\"<>\")-1" };
  for (let row = 4; row <= 9; row++) {
    ws[`D${row}`] = {
      t: "n",
      v: 0,
      f: `COUNTIF('Прямые покупатели'!K:K,${row - 4})`
    };
  }
  ws["!cols"] = [{ wch: 22 }, { wch: 10 }, { wch: 44 }, { wch: 16 }];
  return ws;
}

function buildLegendSheet() {
  const rows = [
    LEGEND_COLS,
    [0, "Белый", "Не обработано"],
    [1, "Зеленый", "Хороший"],
    [2, "Желтый", "Хорошо, но не наш"],
    [3, "Красный", "Не подходит"],
    [4, "Синий", "На поиск номеров"],
    [5, "Серый", "в обработке"]
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 10 }, { wch: 14 }, { wch: 28 }];
  return ws;
}

export function buildWorkbookBuffer(result) {
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    wb,
    buildCommercialSheet(result.direct_buyers || [], DIRECT_BUYER_COLS, DIRECT_MAP, 1),
    "Прямые покупатели"
  );
  XLSX.utils.book_append_sheet(
    wb,
    buildCommercialSheet(result.intermediaries || [], INTERMEDIARY_COLS, INTERMEDIARY_MAP, 2),
    "Посредники"
  );
  XLSX.utils.book_append_sheet(
    wb,
    buildCommercialSheet(result.leasing || [], LEASING_COLS, LEASING_MAP, 2),
    "Лизинг"
  );
  XLSX.utils.book_append_sheet(wb, buildStatisticsSheet(result.statistics || []), "Статистика");
  XLSX.utils.book_append_sheet(wb, buildColorStatisticsSheet(), "Статистика по цветам");
  XLSX.utils.book_append_sheet(wb, buildLegendSheet(), "Легенда");

  return XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
}

export function safeFileName(region) {
  return ("SAT_" + region)
    .replace(/[^a-zа-яё0-9_-]+/gi, "_")
    .replace(/^_+|_+$/g, "") + ".xlsx";
}
