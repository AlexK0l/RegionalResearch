import * as XLSX from "xlsx";
import { COLS, STAT_COLS } from "./constants.js";

function pick(rows, cols) {
  return (rows || []).map((row) =>
    Object.fromEntries(cols.map((col) => [col, row?.[col] ?? ""]))
  );
}

export function buildWorkbookBuffer(result) {
  const wb = XLSX.utils.book_new();
  const sheets = [
    ["Прямые покупатели", result.direct_buyers || [], COLS],
    ["Посредники", result.intermediaries || [], COLS],
    ["Лизинг", result.leasing || [], COLS],
    ["Статистика", result.statistics || [], STAT_COLS]
  ];

  for (const [name, rows, headers] of sheets) {
    const ws = XLSX.utils.json_to_sheet(pick(rows, headers), {
      header: headers,
      skipHeader: false
    });
    ws["!cols"] = headers.map((h) => ({
      wch: Math.min(48, Math.max(14, h.length + 2))
    }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  }

  return XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
}

export function safeFileName(region) {
  return ("SAT_" + region)
    .replace(/[^a-zа-яё0-9_-]+/gi, "_")
    .replace(/^_+|_+$/g, "") + ".xlsx";
}
