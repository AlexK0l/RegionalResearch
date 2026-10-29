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
  // JS word boundaries (\\b) do not treat Cyrillic letters as word characters.
  // Strip legal-form prefixes explicitly, keeping initials/other words intact.
  let name = String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const legalPrefix = /^(?:(?:общество с ограниченной ответственностью|публичное акционерное общество|открытое акционерное общество|закрытое акционерное общество|акционерное общество|индивидуальный предприниматель)|(?:ооо|оао|ао|пао|зао|ип))(?=\s|$)\s*/u;
  let prior = "";
  while (name && prior !== name) {
    prior = name;
    name = name.replace(legalPrefix, "").trim();
  }
  return name;
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


// Benchmark reference is an offline evaluation set, NEVER a production search
// seed. Identical names with DIFFERENT verified INNs are NOT the same entity.
function priorityRecallDetails(currentRows, referenceRows) {
  const byInn = new Map(), byName = new Map();
  for (const row of currentRows) {
    const inn = normalizeInn(row["ИНН"]), name = normalizeName(row["Организация"]);
    if (inn) { if (!byInn.has(inn)) byInn.set(inn, []); byInn.get(inn).push(row); }
    if (name) { if (!byName.has(name)) byName.set(name, []); byName.get(name).push(row); }
  }
  const priority = referenceRows.filter((row) =>
    [1, 2].includes(Number(row["Цвет усл. форматирование"])));
  const unique = new Map();
  for (const row of priority) {
    const inn = normalizeInn(row["ИНН"]), name = normalizeName(row["Организация"]);
    const key = inn ? "inn:" + inn : "name:" + name;
    if (!name || key === "name:") continue;
    if (!unique.has(key)) unique.set(key, { inn, name, color: Number(row["Цвет усл. форматирование"]) });
  }
  const summary = {
    matched: 0, matched_inn: 0, matched_name: 0, identity_conflicts: 0,
    unmatched: 0, legal_name_ambiguities: 0,
    green_total: 0, yellow_total: 0, green_found: 0, yellow_found: 0
  };
  for (const item of unique.values()) {
    const color = item.color;
    if (color === 1) summary.green_total++; else summary.yellow_total++;
    let status = "missing";
    const innMatches = item.inn ? (byInn.get(item.inn) || []) : [];
    if (innMatches.length) status = "inn";
    else {
      const nameMatches = byName.get(item.name) || [];
      const distinct = new Set(nameMatches.map((row) => normalizeInn(row["ИНН"])).filter(Boolean));
      const conflicting = [...distinct].some((inn) => item.inn && item.inn !== inn);
      if (conflicting || distinct.size > 1) status = "conflict";
      else if (nameMatches.length) {
        status = "name";
        if (nameMatches.length > 1) summary.legal_name_ambiguities++;
      }
    }
    if (status === "inn" || status === "name") {
      summary.matched++;
      summary["matched_" + status]++;
      if (color === 1) summary.green_found++; else summary.yellow_found++;
    } else if (status === "conflict") summary.identity_conflicts++;
    else summary.unmatched++;
  }
  return { priority_rows: priority.length, unique: unique.size, ...summary };
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
  const priority = priorityRecallDetails(currentRows, referenceRows);
  const priorityMatched = priority.matched;

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
    reference_priority_rows: priority.priority_rows,
    reference_priority_unique: priority.unique,
    reference_priority_overlap: priorityMatched,
    reference_priority_recall_pct: pct(priorityMatched, priority.unique),
    reference_priority_matched_by_inn: priority.matched_inn,
    reference_priority_matched_by_name: priority.matched_name,
    reference_priority_identity_conflicts: priority.identity_conflicts,
    reference_priority_missing: priority.unmatched,
    reference_priority_legal_name_ambiguities: priority.legal_name_ambiguities,
    reference_priority_green_total: priority.green_total,
    reference_priority_yellow_total: priority.yellow_total,
    reference_priority_green_found: priority.green_found,
    reference_priority_yellow_found: priority.yellow_found,
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
  const priorityRecall = threshold("BENCHMARK_MIN_PRIORITY_RECALL");
  const maxGovernment = threshold("BENCHMARK_MAX_GOVERNMENT");

  if (minInn !== null && metrics.reference_inn_recall_pct < minInn) {
    failures.push(`INN recall ${metrics.reference_inn_recall_pct}% < ${minInn}%`);
  }
  if (minName !== null && metrics.reference_name_recall_pct < minName) {
    failures.push(`name recall ${metrics.reference_name_recall_pct}% < ${minName}%`);
  }
  if (priorityRecall !== null && metrics.reference_priority_recall_pct < priorityRecall) {
    failures.push(`priority recall ${metrics.reference_priority_recall_pct}% < ${priorityRecall}%`);
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
