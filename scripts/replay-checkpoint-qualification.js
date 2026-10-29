#!/usr/bin/env node
// Exact offline replay of the current deterministic qualification policy.
// Read-only source SQLite, no OpenAI/web/browser calls, never updates checkpoint.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";
import { deterministicQualificationDecision, actionableUnqualifiedLead } from "../src/pipeline.js";
import { commercialEligibility } from "../src/qualificationSafety.js";

const args = process.argv.slice(2);
const databaseFile = args.find((x) => !x.startsWith("--")) || "data/checkpoints.sqlite";
const checkpointId = args.find((x) => x.startsWith("--checkpoint="))?.slice(13) || "";
const outputDir = args.find((x) => x.startsWith("--out="))?.slice(6) || "exports/offline-qualification";
const full = path.resolve(databaseFile);
if (!fs.existsSync(full)) throw new Error("SQLite not found: " + full);

const db = new DatabaseSync(full, { readOnly: true });
let saved;
try {
  const query = checkpointId
    ? "SELECT id, region, mode, status, payload FROM research_checkpoints WHERE id = ?"
    : "SELECT id, region, mode, status, payload FROM research_checkpoints WHERE mode = 'full' AND status = 'completed' ORDER BY updated_at DESC LIMIT 1";
  saved = checkpointId ? db.prepare(query).get(checkpointId) : db.prepare(query).get();
} finally {
  db.close();
}
if (!saved || saved.mode !== "full" || saved.status !== "completed") {
  throw new Error("A completed full checkpoint was not found: source database unchanged.");
}
const payload = JSON.parse(saved.payload);
const result = payload.final_result;
if (!result || !Array.isArray(result.direct_buyers) ||
    !Array.isArray(result.intermediaries) || !Array.isArray(result.leasing)) {
  throw new Error("Missing final_result commercial arrays.");
}
const roleSheets = ["direct_buyers", "intermediaries", "leasing"];
const records = roleSheets.flatMap((sheet) =>
  result[sheet].map((row, idx) => ({
    sheet, id: sheet + ":" + idx,
    canonical_id: String(row?.__canonical_id || ""),
    row
  }))
);
const rows = [];
const reviewCandidates = [];
const counts = {
  input: records.length, archived: { A: 0, B: 0, C: 0, excluded: 0 },
  replay: { A: 0, B: 0, C: 0, excluded: 0 },
  legal_exclusions: 0, changed_grades: 0, a_demotions: 0,
  review_queue_candidates: 0,
  kept_without_inn: 0, missing_source_urls: 0
};
for (const record of records) {
  const row = record.row || {};
  const previous = String(row.__final_grade || "").trim();
  const decision = deterministicQualificationDecision(record);
  const eligibility = commercialEligibility(row);
  const current = decision.grade || "";
  const reviewCandidate = !current && actionableUnqualifiedLead(record);
  if (reviewCandidate) {
    counts.review_queue_candidates++;
    // Preserve the full untouched source row, not just CRM summary fields.
    // The original SQLite remains read-only; this is a standalone report.
    reviewCandidates.push({
      sheet: record.sheet,
      canonical_id: record.canonical_id,
      qualification_reason: decision.reason,
      row: structuredClone(row)
    });
  }
  counts.archived[previous || "excluded"] = (counts.archived[previous || "excluded"] || 0) + 1;
  counts.replay[current || "excluded"] = (counts.replay[current || "excluded"] || 0) + 1;
  if (previous !== current) counts.changed_grades++;
  if (previous === "A" && current !== "A") counts.a_demotions++;
  if (eligibility.blocked) counts.legal_exclusions++;
  if (!String(row["ИНН"] || "").trim()) counts.kept_without_inn++;
  const urls = (Array.isArray(row.__evidence?.source_urls) ? row.__evidence.source_urls : [])
    .map(String).filter(Boolean);
  if (!urls.length) counts.missing_source_urls++;
  rows.push({
    canonical_id: record.canonical_id,
    organization: String(row["Организация"] || ""),
    sheet: record.sheet,
    inn: String(row["ИНН"] || ""),
    archived_grade: previous,
    replay_grade: current,
    changed: previous !== current,
    review_queue_candidate: reviewCandidate,
    a_rule: decision.aRule || "",
    a_evidence: decision.aEvidence || "",
    archived_a_evidence: String(row.__a_evidence || ""),
    why: String(decision.reason || ""),
    legal_blocked: eligibility.blocked,
    legal_kind: eligibility.kind,
    legal_method: eligibility.method,
    legal_reason: eligibility.reason,
    legal_url: eligibility.source_url || "",
    source_urls: urls,
    evidence_notes: (Array.isArray(row.__evidence?.notes) ? row.__evidence.notes : []).map(String),
    fact_count: (Array.isArray(row.__evidence?.facts) ? row.__evidence.facts : []).length
  });
}
const report = {
  checkpoint: saved.id, region: saved.region,
  mode: "offline_exact_imported_pipeline_qualification",
  source_sqlite_readonly: true,
  openai_calls: 0, web_search_calls: 0,
  caution: "Re-evaluation on completed final_result, not a full research rerun; post-enrichment evidence may differ from original qualification-time evidence.",
  counts, rows,
  review_queue: reviewCandidates
};
const safePath = path.resolve(outputDir);
fs.mkdirSync(safePath, { recursive: true });
const prefix = "qualification_replay_" + saved.id.slice(0, 8);
const paths = {
  xlsx: path.join(safePath, prefix + ".xlsx"),
  json: path.join(safePath, prefix + ".json")
};
if (Object.values(paths).some(fs.existsSync)) {
  throw new Error("Output already exists; choose a different --out directory.");
}
const table = (headers, records, mapper) =>
  XLSX.utils.aoa_to_sheet([headers, ...records.map(mapper)]);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, table(["Показатель", "Значение"], [
  ["Checkpoint", saved.id], ["Регион", saved.region], ["Всего", counts.input],
  ["Архив A", counts.archived.A], ["Архив B", counts.archived.B],
  ["Архив C", counts.archived.C], ["Пересчёт A", counts.replay.A],
  ["Пересчёт B", counts.replay.B], ["Пересчёт C", counts.replay.C],
  ["Исключено", counts.replay.excluded], ["Изменено классов", counts.changed_grades],
  ["Снято A", counts.a_demotions], ["Исключено по юридической форме/статусу", counts.legal_exclusions],
  ["Сохранено в очереди проверки", counts.review_queue_candidates],
  ["OpenAI", 0], ["Web search", 0],
  ["Метод", report.caution]
], (x) => x), "Итоги");
const headers = [
  "ID", "Организация", "Лист", "ИНН", "Архивный класс", "Новый класс",
  "Причина", "Критерий A", "Сохранённое A-доказательство",
  "Новая A-цитата", "Юридическое исключение", "Роль/статус",
  "Причина исключения", "URL источника статуса", "URL прочих источников",
  "Число структурированных фактов", "Очередь проверки"
];
const map = (r) => [
  r.canonical_id, r.organization, r.sheet, r.inn, r.archived_grade,
  r.replay_grade || "ИСКЛЮЧЕНО", r.why, r.a_rule,
  r.archived_a_evidence, r.a_evidence, r.legal_blocked ? "ДА" : "",
  r.legal_kind, r.legal_reason, r.legal_url, r.source_urls.join("\n"), r.fact_count,
  r.review_queue_candidate ? "ДА" : ""
];
XLSX.utils.book_append_sheet(wb, table(headers, rows, map), "Все компании");
XLSX.utils.book_append_sheet(wb, table(headers, rows.filter((r) => r.changed), map), "Изменения");
XLSX.utils.book_append_sheet(wb, table(headers, rows.filter((r) => r.archived_grade === "A"), map), "Проверка A");
XLSX.utils.book_append_sheet(wb, table(headers, rows.filter((r) => r.legal_blocked), map), "Юридические исключения");
XLSX.utils.book_append_sheet(wb, table(headers,
  rows.filter((r) => !r.replay_grade && !r.legal_blocked), map), "Не исключать без проверки");
XLSX.utils.book_append_sheet(wb, table(headers,
  rows.filter((r) => r.review_queue_candidate), map), "Очередь сохранения");
for (const name of wb.SheetNames) {
  wb.Sheets[name]["!cols"] = name === "Итоги"
    ? [{ wch: 42 }, { wch: 75 }]
    : headers.map((h, i) => ({ wch: i === 1 ? 43 : i >= 6 && i <= 9 ? 67 : i === 14 ? 75 : 24 }));
}
const created = [];
try {
  fs.writeFileSync(paths.json, JSON.stringify(report, null, 2), { flag: "wx" });
  created.push(paths.json);
  fs.writeFileSync(paths.xlsx, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), { flag: "wx" });
  created.push(paths.xlsx);
} catch (error) {
  for (const f of created) try { fs.unlinkSync(f); } catch {}
  throw error;
}
console.log(JSON.stringify({
  checkpoint: saved.id, ...counts, output: paths,
  source_sqlite_modified: false, openai_calls: 0
}, null, 2));
