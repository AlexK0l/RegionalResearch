import fs from "node:fs";
import XLSX from "xlsx";

const COMMERCIAL_SHEETS = ["Прямые покупатели", "Посредники", "Лизинг"];

function usage() {
  console.error("Usage: node scripts/benchmark-reference.js <current.xlsx> <reference.xlsx>");
  process.exit(2);
}

function normalizeInn(value) {
  if (value === null || value === undefined || value === "") return "";
  const raw = typeof value === "number" && Number.isFinite(value)
    ? String(Math.trunc(value))
    : String(value);
  const digits = raw.replace(/\D/g, "");
  return digits.length === 10 || digits.length === 12 ? digits : "";
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"'“”„]/g, " ")
    .replace(/\b(ооо|оао|ао|пао|зао|ип|нп|спк|кфх|гк|гуп|муп|фгуп)\b/g, " ")
    .replace(/[^a-zа-я0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePhone(value) {
  return String(value || "")
    .split(/[;\n,]+/)
    .map((item) => item.replace(/\D/g, ""))
    .filter((digits) => digits.length >= 10 && digits.length <= 11);
}

function isGovernmentName(value) {
  const name = normalizeName(value);
  return /(^|\s)(администраци|министерств|департамент|комитет|правительств)(\s|$)|совет.{0,20}депутат|городск.{0,20}дума|(^|\s)(фку|фгбу|гбу|гку|мбу|мку|гау|мау|согбу|огбу|огку|мбоу|гбоу)(\s|$)/.test(name);
}

function sheetRows(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

function commercialRows(workbook) {
  return COMMERCIAL_SHEETS.flatMap((sheet) =>
    sheetRows(workbook, sheet).map((row) => ({ ...row, __sheet: sheet }))
  );
}

function setIntersectionSize(a, b) {
  let count = 0;
  for (const value of a) if (b.has(value)) count++;
  return count;
}

function pct(numerator, denominator) {
  return denominator ? Number(((numerator / denominator) * 100).toFixed(1)) : 0;
}

function analyze(currentPath, referencePath) {
  const current = XLSX.readFile(currentPath, { cellDates: false });
  const reference = XLSX.readFile(referencePath, { cellDates: false });
  const currentRows = commercialRows(current);
  const referenceRows = commercialRows(reference);

  const currentInns = new Set(currentRows.map((row) => normalizeInn(row["ИНН"])).filter(Boolean));
  const referenceInns = new Set(referenceRows.map((row) => normalizeInn(row["ИНН"])).filter(Boolean));
  const currentNames = new Set(currentRows.map((row) => normalizeName(row["Организация"])).filter(Boolean));
  const referenceNames = new Set(referenceRows.map((row) => normalizeName(row["Организация"])).filter(Boolean));

  const innCounts = new Map();
  for (const row of currentRows) {
    const inn = normalizeInn(row["ИНН"]);
    if (!inn) continue;
    innCounts.set(inn, (innCounts.get(inn) || 0) + 1);
  }

  const direct = sheetRows(current, "Прямые покупатели");
  const withValue = (key) => direct.filter((row) => String(row[key] ?? "").trim() !== "").length;

  const exactInnOverlap = setIntersectionSize(currentInns, referenceInns);
  const exactNameOverlap = setIntersectionSize(currentNames, referenceNames);

  return {
    current_rows: currentRows.length,
    reference_rows: referenceRows.length,
    current_unique_inn: currentInns.size,
    reference_unique_inn: referenceInns.size,
    exact_inn_overlap: exactInnOverlap,
    reference_inn_recall_pct: pct(exactInnOverlap, referenceInns.size),
    current_unique_names: currentNames.size,
    reference_unique_names: referenceNames.size,
    exact_name_overlap: exactNameOverlap,
    reference_name_recall_pct: pct(exactNameOverlap, referenceNames.size),
    duplicate_inn_groups: [...innCounts.values()].filter((count) => count > 1).length,
    government_or_budget_rows: currentRows.filter((row) => isGovernmentName(row["Организация"])).length,
    direct_buyers: direct.length,
    direct_phone_rows: direct.filter((row) => normalizePhone(row["Телефон"]).length > 0).length,
    direct_leader_rows: withValue("Руководитель / ЛПР"),
    direct_revenue_rows: withValue("Выручка последнего подтвержденного года"),
    direct_headcount_rows: withValue("Численность")
  };
}

function threshold(name) {
  const value = process.env[name];
  return value === undefined || value === "" ? null : Number(value);
}

function validate(metrics) {
  const failures = [];
  const minInn = threshold("BENCHMARK_MIN_INN_RECALL");
  const minName = threshold("BENCHMARK_MIN_NAME_RECALL");
  const maxDupes = threshold("BENCHMARK_MAX_DUPLICATE_INN");
  const maxGovernment = threshold("BENCHMARK_MAX_GOVERNMENT");

  if (minInn !== null && metrics.reference_inn_recall_pct < minInn) {
    failures.push(`INN recall ${metrics.reference_inn_recall_pct}% < ${minInn}%`);
  }
  if (minName !== null && metrics.reference_name_recall_pct < minName) {
    failures.push(`name recall ${metrics.reference_name_recall_pct}% < ${minName}%`);
  }
  if (maxDupes !== null && metrics.duplicate_inn_groups > maxDupes) {
    failures.push(`duplicate INN groups ${metrics.duplicate_inn_groups} > ${maxDupes}`);
  }
  if (maxGovernment !== null && metrics.government_or_budget_rows > maxGovernment) {
    failures.push(`government/budget rows ${metrics.government_or_budget_rows} > ${maxGovernment}`);
  }
  return failures;
}

const [, , currentPath, referencePath] = process.argv;
if (!currentPath || !referencePath || !fs.existsSync(currentPath) || !fs.existsSync(referencePath)) usage();

const metrics = analyze(currentPath, referencePath);
console.log(JSON.stringify(metrics, null, 2));

const failures = validate(metrics);
if (failures.length) {
  console.error("Benchmark thresholds failed:");
  for (const failure of failures) console.error("- " + failure);
  process.exit(1);
}
