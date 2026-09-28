import * as XLSX from "xlsx";
import { COLS, STAT_COLS } from "./constants.js";

function pick(rows, cols) {
  return (rows || []).map((row) =>
    Object.fromEntries(cols.map((col) => [col, row?.[col] ?? ""]))
  );
}

function addOrganizationComments(ws, rows) {
  for (let index = 0; index < (rows || []).length; index++) {
    const comment = String(rows[index]?.__comment || "").trim();
    if (!comment) continue;

    const ref = `A${index + 2}`;
    if (!ws[ref]) {
      ws[ref] = { t: "s", v: String(rows[index]?.["Организация"] || "") };
    }
    ws[ref].c = [{ a: "RegionalResearch", t: comment }];
  }
}

export function buildWorkbookBuffer(result) {
  const wb = XLSX.utils.book_new();
  const sheets = [
    ["Прямые покупатели", result.direct_buyers || [], COLS, true],
    ["Посредники", result.intermediaries || [], COLS, true],
    ["Лизинг", result.leasing || [], COLS, true],
    ["Статистика", result.statistics || [], STAT_COLS, false]
  ];

  for (const [name, rows, headers, withComments] of sheets) {
    const ws = XLSX.utils.json_to_sheet(pick(rows, headers), {
      header: headers,
      skipHeader: false
    });
    ws["!cols"] = headers.map((h) => ({
      wch: Math.min(48, Math.max(14, h.length + 2))
    }));
    if (withComments) addOrganizationComments(ws, rows);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }

  return XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
}

export function safeFileName(region) {
  return ("SAT_" + region)
    .replace(/[^a-zа-яё0-9_-]+/gi, "_")
    .replace(/^_+|_+$/g, "") + ".xlsx";
}
