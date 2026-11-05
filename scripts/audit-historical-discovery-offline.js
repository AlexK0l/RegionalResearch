#!/usr/bin/env node
// Read-only continuity audit of previous completed SQLite studies.
// No OpenAI key, web calls or writes to the checkpoint database.
// Output is an audit artifact, NEVER an automatic company import.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildHistoricalCoverageLedger, buildHistoricalRecallPlan } from "../src/historicalRecall.js";

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!["--db", "--region", "--out", "--history-runs"].includes(key)) {
      throw new Error("Unknown argument: " + key);
    }
    if (!args[i + 1]) throw new Error("Missing value for " + key);
    parsed[key.slice(2)] = args[++i];
  }
  if (!parsed.region?.trim()) {
    throw new Error("Specify a region: --region \"Смоленская область\"");
  }
  return parsed;
}
const clamp = (value, fallback, max) => {
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(1, Math.min(max, Math.floor(num))) : fallback;
};
function safeCsv(value) {
  const string = String(value ?? "");
  // Guard against Excel/Calc CSV formula injection in model-discovered names.
  const neutral = /^[\s]*[=+\-@\t\r]/.test(string) ? "'" + string : string;
  return '"' + neutral.replace(/"/g, '""') + '"';
}
export function auditCompletedSnapshots(rows, region, maxOlderRuns = 20) {
  const usable = (Array.isArray(rows) ? rows : []).flatMap(row => {
    let checkpoint;
    try { checkpoint = typeof row.payload === "string"
      ? JSON.parse(row.payload) : row.payload; } catch { return []; }
    if (!checkpoint?.final_result) return [];
    return [{
      id: String(row.id),
      updated_at: String(row.updated_at),
      final_result: checkpoint.final_result,
      recall_attempted_inns: Array.isArray(checkpoint.historical_recall?.attempted_inns)
        ? checkpoint.historical_recall.attempted_inns : []
    }];
  });
  if (!usable.length) throw new Error("No completed studies found for " + region);
  const current = usable[0];
  const history = usable.slice(1, maxOlderRuns + 1);
  const ledger = buildHistoricalCoverageLedger(history, current.final_result);
  const plan = buildHistoricalRecallPlan(history, current.final_result,
    {maxCandidates: 24});
  return {
    version: 1,
    region,
    current_job_id: current.id,
    current_updated_at: current.updated_at,
    history_runs_consulted: history.map(run => ({
      job_id: run.id, updated_at: run.updated_at
    })),
    counts: ledger.counts,
    missing_or_conflicting: ledger.missing_or_conflicting,
    auto_promoted_records: 0,
    extra_web_calls: 0,
    qualification_and_identity_not_reverified: true,
    candidate_plan_offline_not_executed: {
      eligible_missing: plan.total_missing_candidates,
      older_history_eligible: plan.older_history_eligible,
      older_history_selected: plan.older_history_selected,
      planned_next_search_count: plan.candidates.length,
      historical_name_inn_conflicts: plan.ambiguous_history +
        plan.current_name_inn_conflicts,
      previously_attempted_recent: plan.recently_attempted_in_previous_runs
    },
    entries: ledger.entries
  };
}

export function outstandingCsv(report) {
  const columns = [
    ["historical_inn", "Исторический ИНН"],
    ["historical_name", "Наименование"],
    ["status", "Статус относительно последнего прогона"],
    ["previous_grade_priority_only", "Старая категория (только ориентир)"],
    ["observed_in_completed_runs", "В скольких завершённых исследованиях"],
    ["latest_historical_job_id", "Исторический checkpoint"],
    ["historical_identity_source_audit_only", "Исторический URL для проверки"]
  ];
  const rows = report.entries.filter(entry =>
    !["present_active_by_inn"].includes(entry.status));
  return "\uFEFF" + columns.map(item => safeCsv(item[1])).join(",") + "\r\n" +
    rows.map(row => columns.map(item => safeCsv(row[item[0]])).join(",")).join("\r\n") +
    (rows.length ? "\r\n" : "");
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const region = String(flags.region).trim();
  const dbPath = path.resolve(flags.db || process.env.CHECKPOINT_DB_PATH ||
    "data/checkpoints.sqlite");
  if (!fs.existsSync(dbPath)) throw new Error("Checkpoint SQLite not found: " + dbPath);
  const historyRuns = clamp(flags["history-runs"], 12, 20);
  // Need one additional latest completed snapshot to use as current result.
  const db = new DatabaseSync(dbPath, {readOnly: true});
  let rows;
  try {
    db.exec("PRAGMA query_only=ON;");
    rows = db.prepare(
      "SELECT id, updated_at, payload FROM research_checkpoints " +
      "WHERE region = ? AND mode = 'full' AND status = 'completed' " +
      "ORDER BY updated_at DESC LIMIT ?"
    ).all(region, historyRuns + 1);
  } finally { db.close(); }
  const report = auditCompletedSnapshots(rows, region, historyRuns);
  const slug = region.normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 48);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.resolve(flags.out || path.join("exports",
    "historical_coverage_" + slug + "_" + timestamp + ".json"));
  const csv = out.replace(/\.json$/i, "") + "_unresolved.csv";
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n", {flag:"wx"});
  fs.writeFileSync(csv, outstandingCsv(report), {flag:"wx"});
  console.log("[HISTORICAL_OFFLINE_AUDIT] " + JSON.stringify({
    region, current_job_id: report.current_job_id,
    historical_runs: report.history_runs_consulted.length,
    historic_source_linked_inn: report.counts.historic_source_linked_inn,
    missing_or_conflicting: report.missing_or_conflicting,
    archived_records_added_to_crm: 0, web_search_calls: 0,
    json: out, csv
  }));
}
if (process.argv[1] && path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname)) {
  main().catch(error => {
    console.error("[HISTORICAL_OFFLINE_AUDIT_ERROR] " +
      (error?.message || String(error)));
    process.exitCode = 1;
  });
}
