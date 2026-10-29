#!/usr/bin/env node
// Offline only: creates new files, never updates the input database or XLSX.
// Requires Node 22+ and the project's installed "xlsx" dependency.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";
import { restoreAliasesOffline } from "../src/offlineIdentityRestoration.js";

const [, , databaseFile = "data/checkpoints.sqlite", ...args] = process.argv;
const outputArg = args.find((x) => x.startsWith("--out="))?.slice("--out=".length) || "exports";
const templateArg = args.find((x) => x.startsWith("--template="))?.slice("--template=".length) || "";
const checkpointArg = args.find((x) => x.startsWith("--checkpoint="))?.slice("--checkpoint=".length) || "";
const fullDbPath = path.resolve(databaseFile);
if (!fs.existsSync(fullDbPath)) {
  console.error("SQLite checkpoint not found: " + fullDbPath);
  process.exit(2);
}
const db = new DatabaseSync(fullDbPath, { readOnly: true });
let chosen;
try {
  if (checkpointArg) {
    chosen = db.prepare(
      "SELECT id, region, mode, status, payload FROM research_checkpoints WHERE id = ?"
    ).get(checkpointArg);
  } else {
    chosen = db.prepare(
      "SELECT id, region, mode, status, payload FROM research_checkpoints " +
        "WHERE mode = 'full' AND status = 'completed' ORDER BY updated_at DESC LIMIT 1"
    ).get();
  }
} finally {
  db.close();
}
if (!chosen || chosen.mode !== "full" || chosen.status !== "completed") {
  throw new Error("Completed full checkpoint not found. No output written.");
}

const input = JSON.parse(chosen.payload);
const { final_result: recovered, audit } = restoreAliasesOffline(input, { checkpointId: chosen.id });
const fmt = (v) => {
  if (v == null || typeof v === "object") return "";
  return String(v).replace(/^[=+\-@]/, (match) => "'" + match);
};
const columns = [
  "Организация", "Управляющая компания", "ИНН", "Город/район",
  "Техника/сегмент", "Основание", "Телефон", "Следующее действие",
  "Почему им нужно звонить / потенциальный интерес к САТ", "Руководитель / ЛПР",
  "Выручка последнего подтвержденного года", "Численность", "__comment"
];
const clean = (v, key) => {
  if (v === undefined || v === null) return "";
  if (typeof v === "number") return v;
  if (key === "ИНН") return String(v);
  return fmt(v);
};
const sheetNames = {
  direct_buyers: "Прямые покупатели",
  intermediaries: "Посредники",
  leasing: "Лизинг"
};
let workbook = templateArg ? XLSX.readFile(path.resolve(templateArg)) : XLSX.utils.book_new();
const sourceHeaders = new Map();
if (templateArg) {
  for (const s of ["Прямые покупатели", "Посредники", "Лизинг"]) {
    const tab = workbook.Sheets[s];
    if (!tab) throw new Error("Missing template sheet: " + s);
    const header = XLSX.utils.sheet_to_json(tab, { header: 1, defval: "" })[0] || [];
    sourceHeaders.set(s, header);
  }
}
for (const [key, name] of Object.entries(sheetNames)) {
  const selected = recovered[key];
  const header = sourceHeaders.get(name) || columns;
  // Header order mirrors the source workbook when a template is provided.
  // CRM-only fields not found in final_result remain empty in this derived copy;
  // source workbook and any external CRM notes are never overwritten.
  const cells = [header, ...selected.map((row) => header.map((field) => clean(row[field], field)))];
  const tab = XLSX.utils.aoa_to_sheet(cells);
  tab["!cols"] = header.map((h) => ({ wch: h === "Организация" ? 45 :
    h === "Основание" || h === "Техника/сегмент" ? 66 :
    h === "ИНН" ? 19 : h === "Телефон" ? 25 : 26 }));
  if (workbook.Sheets[name]) workbook.Sheets[name] = tab;
  else XLSX.utils.book_append_sheet(workbook, tab, name);
}
if (!workbook.Sheets["Статистика"] && Array.isArray(recovered.statistics)) {
  const stats = recovered.statistics;
  const h = [...new Set(stats.flatMap((r) => Object.keys(r)))];
  XLSX.utils.book_append_sheet(workbook,
    XLSX.utils.aoa_to_sheet([h, ...stats.map((r) => h.map((key) => clean(r[key], key)))]),
    "Статистика");
}
function addSheet(name, header, records) {
  if (workbook.Sheets[name]) throw new Error("Audit sheet already exists: " + name);
  const flat = records.map((row) => header.map((field) => {
    const value = row[field];
    return Array.isArray(value) ? fmt(value.join("\n")) :
      value && typeof value === "object" ? fmt(JSON.stringify(value)) : clean(value, field);
  }));
  const tab = XLSX.utils.aoa_to_sheet([header, ...flat]);
  tab["!cols"] = header.map((x) => ({ wch: /URL|Источники/.test(x) ? 65 : 35 }));
  XLSX.utils.book_append_sheet(workbook, tab, name);
}
addSheet("Офлайн восстановление", [
  "ИНН", "Основное наименование", "Объединённые алиасы", "Причина",
  "Исходные ID", "Сохранённый класс", "URL источников"
], audit.restored_groups.map((g) => ({
  "ИНН": g.inn, "Основное наименование": g.winner_name,
  "Объединённые алиасы": g.absorbed_names,
  "Причина": g.reason, "Исходные ID": g.original_canonical_ids,
  "Сохранённый класс": g.preserved_grade,
  "URL источников": g.source_urls
})));
addSheet("Ручная проверка ИНН", [
  "ИНН", "Статус", "Организации", "Обоснования", "ОГРН", "Источники"
], audit.unresolved.map((g) => ({
  "ИНН": g.inn, "Статус": g.status,
  "Организации": g.names,
  "Обоснования": g.decisions?.map((x) => x.reason) || g.outside_owners || [],
  "ОГРН": g.ogrns || [],
  "Источники": g.identity_sources || []
})));
addSheet("Подразделения", ["ИНН головного (кандидат)", "Подразделение",
  "Исходный ID", "Возможная головная организация", "Решение"],
  audit.divisions.map((r) => ({
    "ИНН головного (кандидат)": r.inn,
    "Подразделение": r.branch, "Исходный ID": r.branch_canonical_id,
    "Возможная головная организация": r.parent_candidate, "Решение": r.action
  })));
addSheet("Конфликты полей", ["ИНН", "Организация", "Поле", "Сохранённые значения"],
  audit.conflicting_field_values.map((r) => ({
    "ИНН": r.inn, "Организация": r.company, "Поле": r.field,
    "Сохранённые значения": r.values
  })));
addSheet("Методика офлайн", ["Параметр", "Значение"], [
  { Параметр: "Исходный checkpoint", Значение: chosen.id },
  { Параметр: "Регион", Значение: chosen.region },
  { Параметр: "Исходных компаний", Значение: audit.input_rows },
  { Параметр: "В копии компаний", Значение: audit.output_rows },
  { Параметр: "Восстановлено уникальных ИНН", Значение: audit.restored_inns },
  { Параметр: "Исключено строк-алиасов", Значение: audit.merged_away_rows },
  { Параметр: "Источник", Значение: fullDbPath },
  { Параметр: "Проверка", Значение: "Только сохранённые свидетельства. Без сетевого доступа, OpenAI и новых API-запросов." },
  { Параметр: "Статус", Значение: "Отдельная производная копия. Не обновляет checkpoint и не заменяет первичный исследовательский отчёт." },
  { Параметр: "Подразделения", Значение: "Не объединяются с головным юрлицом, ИНН в строке подразделения не восстанавливается." },
  { Параметр: "A/B/C", Значение: "Квалификация сохранена из исходной строки; новый класс не рассчитывался." },
  { Параметр: "CRM-данные", Значение: "Исходный Excel не модифицирован, аналитические вкладки — только для проверки." }
]);

const outfile = path.resolve(outputArg);
fs.mkdirSync(outfile, { recursive: true });
const prefix = "identity_recovery_" + chosen.id.slice(0, 8);
const names = [
  path.join(outfile, prefix + "_result.xlsx"),
  path.join(outfile, prefix + "_result.json"),
  path.join(outfile, prefix + "_audit.json")
];
if (names.some((name) => fs.existsSync(name))) {
  throw new Error("Output already exists: choose --out=another-directory; original files are untouched.");
}
const created = [];
try {
  // Open with exclusive creation ("wx") so a repeated run never overwrites.
  for (const name of names) {
    const bytes = name.endsWith(".xlsx") ?
      XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) :
      Buffer.from(JSON.stringify(
        name.endsWith("_audit.json") ? audit : {
          checkpoint_id: chosen.id, region: chosen.region, final_result: recovered, audit
        }, null, 2), "utf8");
    fs.writeFileSync(name, bytes, { flag: "wx" });
    created.push(name);
  }
} catch (err) {
  for (const name of created) {
    try { fs.unlinkSync(name); } catch {}
  }
  throw err;
}
console.log(JSON.stringify({
  source_checkpoint: chosen.id, source_sqlite: fullDbPath,
  before_companies: audit.input_rows, after_companies: audit.output_rows,
  alias_merges: audit.merged_away_rows, restored_unique_inns: audit.restored_inns,
  unresolved: audit.unresolved.length, divisions_preserved: audit.divisions.length,
  outputs: { xlsx: names[0], json: names[1], audit: names[2] },
  original_database_modified: false, openai_calls: 0
}, null, 2));
