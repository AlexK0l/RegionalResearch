#!/usr/bin/env node
// Offline only: creates new files, never updates the input database or XLSX.
// Requires Node 22+ and the project's installed "xlsx" dependency.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";
import { restoreAliasesOffline } from "../src/offlineIdentityRestoration.js";
import { projectRecoveredTemplateSheet } from "../src/offlineWorkbookTemplate.js";
import { refreshColorStatistics } from "../src/offlineColorStatistics.js";

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
const templateColumns = [];
let templateCommentsRemapped = 0;
audit.crm_field_transfers = [];
audit.crm_field_conflicts = [];
for (const [key, name] of Object.entries(sheetNames)) {
  const selected = recovered[key];
  let tab;
  if (templateArg) {
    const sourceTab = workbook.Sheets[name];
    if (!sourceTab) throw new Error("Missing template sheet: " + name);
    const original = input.final_result[key];
    const projected = projectRecoveredTemplateSheet(XLSX, sourceTab, original, selected, {
      sheetName: name
    });
    tab = projected.sheet;
    templateCommentsRemapped += projected.commentsRemapped;
    audit.crm_field_transfers.push(...projected.crmTransfers);
    audit.crm_field_conflicts.push(...projected.crmConflicts);
    templateColumns.push({
      sheet: name,
      source_columns: projected.original_columns,
      recovered_columns: projected.output_columns,
      recovered_rows: selected.length
    });
  } else {
    const header = columns;
    const cells = [header, ...selected.map((row) => header.map((field) => clean(row[field], field)))];
    tab = XLSX.utils.aoa_to_sheet(cells);
    tab["!cols"] = header.map((h) => ({ wch: h === "Организация" ? 45 :
      h === "Основание" || h === "Техника/сегмент" ? 66 :
      h === "ИНН" ? 19 : h === "Телефон" ? 25 : 26 }));
  }
  if (workbook.Sheets[name]) workbook.Sheets[name] = tab;
  else XLSX.utils.book_append_sheet(workbook, tab, name);
}
audit.template_projection = templateArg ? {
  source_workbook: path.resolve(templateArg),
  validation: "Source organization names and original checkpoint rows must match exactly by position",
  columns: templateColumns,
  company_comments_rebound_by_canonical_id: templateCommentsRemapped,
  note: "Source CRM cells are retained. Relative-reference formulas cannot be safely moved. Workbook style fidelity is not guaranteed by SheetJS."
} : null;
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
  "Исходные ID", "Сохранённый класс", "Проверка класса", "URL источников"
], audit.restored_groups.map((g) => ({
  "ИНН": g.inn, "Основное наименование": g.winner_name,
  "Объединённые алиасы": g.absorbed_names,
  "Причина": g.reason, "Исходные ID": g.original_canonical_ids,
  "Сохранённый класс": g.preserved_grade,
  "Проверка класса": g.qualification_review || "",
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
addSheet("Проверка A-B-C", [
  "ИНН", "Основное наименование", "Сохранённый класс", "Классы из исходных записей",
  "Основания исходных классов", "Статус"
], (audit.qualification_conflicts || []).map((r) => ({
  "ИНН": r.inn,
  "Основное наименование": r.winner_name,
  "Сохранённый класс": r.selected_grade,
  "Классы из исходных записей": r.source_grades.map((x) => x.organization + ": " + x.grade),
  "Основания исходных классов": r.source_grades.map((x) => x.organization + ": " + x.basis),
  "Статус": r.status
})));
addSheet("CRM перенос и расхождения", [
  "Организация", "Поле CRM", "Статус", "Значения", "Исходные ID"
], [
  ...audit.crm_field_transfers.map((r) => ({
    "Организация": r.organization, "Поле CRM": r.field, "Статус": "transferred",
    "Значения": r.value, "Исходные ID": r.original_ids
  })),
  ...audit.crm_field_conflicts.map((r) => ({
    "Организация": r.organization, "Поле CRM": r.field, "Статус": "manual_review_required",
    "Значения": r.values, "Исходные ID": r.original_ids
  }))
]);
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
  { Параметр: "A/B/C", Значение: "Выбранный класс не пересчитывался; расхождения исходных классов отдельно помечены на листе Проверка A-B-C." },
  { Параметр: "Проверить A/B/C", Значение: (audit.qualification_conflicts || []).length },
  { Параметр: "CRM-переносов", Значение: audit.crm_field_transfers.length },
  { Параметр: "CRM-конфликтов", Значение: audit.crm_field_conflicts.length },
  { Параметр: "CRM-данные", Значение: "Исходный Excel не модифицирован, аналитические вкладки — только для проверки." }
]);

audit.color_statistics = refreshColorStatistics(XLSX, workbook);
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
  qualification_conflicts: (audit.qualification_conflicts || []).length,
  template_mode: Boolean(templateArg), crm_field_conflicts: audit.crm_field_conflicts.length,
  template_comments_remapped: templateCommentsRemapped,
  color_statistics: audit.color_statistics,
  outputs: { xlsx: names[0], json: names[1], audit: names[2] },
  original_database_modified: false, openai_calls: 0
}, null, 2));
