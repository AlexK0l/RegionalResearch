// Update inherited SAT "Статистика по цветам" after deduplication.
// The original workbook contains cached zeros even for "Всего компаний".
export function refreshColorStatistics(XLSX, workbook) {
  const sourceName = "Прямые покупатели";
  const statsName = "Статистика по цветам";
  const sheet = workbook?.Sheets?.[sourceName];
  const stats = workbook?.Sheets?.[statsName];
  if (!sheet || !stats) return { refreshed: false, reason: "no_color_statistics" };
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });
  const header = data[0] || [];
  const nameIndex = header.indexOf("Организация");
  const colorIndex = header.indexOf("Цвет усл. форматирование");
  if (nameIndex < 0 || colorIndex < 0) {
    throw new Error("Cannot recalculate SAT color statistics: missing organization/color columns");
  }
  const normalized = data.slice(1).filter((row) => String(row[nameIndex] ?? "").trim());
  const lastRow = Math.max(2, normalized.length + 1);
  const letter = (idx) => XLSX.utils.encode_col(idx);
  const tab = "'" + sourceName.replace(/'/g, "''") + "'";
  const names = tab + "!$" + letter(nameIndex) + "$2:$" + letter(nameIndex) + "$" + lastRow;
  const colors = tab + "!$" + letter(colorIndex) + "$2:$" + letter(colorIndex) + "$" + lastRow;
  const num = (value) => {
    if (value === "" || value == null) return 0;
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^[0-5]$/.test(value.trim())) return Number(value);
    return -1;
  };
  const counts = Object.fromEntries([0, 1, 2, 3, 4, 5].map((code) => [code, 0]));
  for (const row of normalized) {
    const code = num(row[colorIndex]);
    if (code >= 0 && code <= 5) counts[code]++;
  }
  const expectedCells = ["D2", "D4", "D5", "D6", "D7", "D8", "D9"];
  for (const cellName of expectedCells) {
    if (!stats[cellName] || typeof stats[cellName].f !== "string" ||
        !/COUNTIF|COUNTIFS|COUNTA|SUMPRODUCT/i.test(stats[cellName].f)) {
      throw new Error("Cannot safely refresh modified SAT formula: " + statsName + "!" + cellName);
    }
  }
  stats.D2.f = 'COUNTIF(' + names + ',"<>")';
  stats.D2.v = normalized.length;
  stats.D2.t = "n";
  for (let code = 0; code <= 5; code++) {
    const cell = stats["D" + (4 + code)];
    // White/unprocessed includes blank or explicit zero, counted only once.
    cell.f = code === 0
      ? 'SUMPRODUCT(--(' + names + '<>""),--(((' + colors + '="")+(' + colors + '=0))>0))'
      : 'COUNTIFS(' + names + ',"<>",' + colors + ',' + code + ')';
    cell.v = counts[code];
    cell.t = "n";
  }
  return { refreshed: true, total: normalized.length, codes: counts };
}
