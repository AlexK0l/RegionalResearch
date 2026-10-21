import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_DB_PATH = process.env.RENDER
  ? "/tmp/regionalresearch/checkpoints.sqlite"
  : path.resolve("data/checkpoints.sqlite");

const CHECKPOINT_DB_PATH = path.resolve(
  String(process.env.CHECKPOINT_DB_PATH || DEFAULT_DB_PATH)
);
const PIPELINE_VERSION = Math.max(
  1,
  Number(process.env.PIPELINE_VERSION || 1)
);

let db = null;

function cloneCheckpoint(value) {
  return JSON.parse(JSON.stringify(value));
}

function checkpointMode(checkpoint) {
  return String(checkpoint?.source_mode || checkpoint?.mode || "full").trim() || "full";
}

function checkpointStatus(checkpoint) {
  return String(checkpoint?.phase || "") === "completed" ? "completed" : "resumable";
}

function ensureDb() {
  if (db) return db;

  fs.mkdirSync(path.dirname(CHECKPOINT_DB_PATH), { recursive: true });
  db = new DatabaseSync(CHECKPOINT_DB_PATH);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=FULL;");
  db.exec("PRAGMA busy_timeout=5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_checkpoints (
      id TEXT PRIMARY KEY,
      region TEXT NOT NULL,
      mode TEXT NOT NULL,
      pipeline_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      phase TEXT NOT NULL,
      completed_stage INTEGER NOT NULL DEFAULT 0,
      completed_final_batches INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_research_checkpoints_region
      ON research_checkpoints(region, mode, status, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_research_checkpoints_updated
      ON research_checkpoints(updated_at DESC);
  `);
  return db;
}

function rowToCheckpoint(row) {
  if (!row?.payload) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

function metadataFromRow(row) {
  if (!row) return null;
  return {
    id: String(row.id || ""),
    region: String(row.region || ""),
    mode: String(row.mode || "full"),
    pipeline_version: Number(row.pipeline_version || 0),
    status: String(row.status || ""),
    phase: String(row.phase || ""),
    completed_stage: Number(row.completed_stage || 0),
    completed_final_batches: Number(row.completed_final_batches || 0),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    compatible: Number(row.pipeline_version || 0) === PIPELINE_VERSION
  };
}

export async function saveCheckpoint(jobId, checkpoint) {
  if (!jobId || !checkpoint) return { sqliteSaved: false };

  const normalized = normalizeCheckpoint(checkpoint);
  if (!normalized) throw new Error("Некорректный checkpoint");
  normalized.pipeline_version = PIPELINE_VERSION;

  const database = ensureDb();
  const now = new Date().toISOString();
  const id = String(jobId);
  const region = String(normalized.region).trim();
  const mode = checkpointMode(normalized);
  const status = checkpointStatus(normalized);
  const phase = String(normalized.phase || "starting");
  const createdAt = String(normalized.created_at || now);
  const payload = JSON.stringify(normalized);

  const statement = database.prepare(`
    INSERT INTO research_checkpoints (
      id, region, mode, pipeline_version, status, phase,
      completed_stage, completed_final_batches,
      payload, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      region = excluded.region,
      mode = excluded.mode,
      pipeline_version = excluded.pipeline_version,
      status = excluded.status,
      phase = excluded.phase,
      completed_stage = excluded.completed_stage,
      completed_final_batches = excluded.completed_final_batches,
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `);

  statement.run(
    id,
    region,
    mode,
    PIPELINE_VERSION,
    status,
    phase,
    Number(normalized.completed_stage || 0),
    Number(normalized.completed_final_batches || 0),
    payload,
    createdAt,
    now
  );

  return { sqliteSaved: true, path: CHECKPOINT_DB_PATH };
}

export async function loadCheckpoint(jobId) {
  if (!jobId) return null;
  const row = ensureDb()
    .prepare("SELECT payload FROM research_checkpoints WHERE id = ?")
    .get(String(jobId));
  return rowToCheckpoint(row);
}

export async function findLatestCheckpoint(region, mode = "full") {
  const normalizedRegion = String(region || "").trim();
  if (!normalizedRegion) return null;

  const row = ensureDb().prepare(`
    SELECT *
    FROM research_checkpoints
    WHERE region = ?
      AND mode = ?
      AND status = 'resumable'
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(normalizedRegion, String(mode || "full"));

  return metadataFromRow(row);
}

export async function listRegionCheckpoints(region, mode = "full", limit = 10) {
  const normalizedRegion = String(region || "").trim();
  if (!normalizedRegion) return [];

  return ensureDb().prepare(`
    SELECT id, region, mode, pipeline_version, status, phase,
           completed_stage, completed_final_batches, created_at, updated_at
    FROM research_checkpoints
    WHERE region = ? AND mode = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(
    normalizedRegion,
    String(mode || "full"),
    Math.max(1, Math.min(50, Number(limit || 10)))
  ).map(metadataFromRow);
}

export async function supersedeRegionCheckpoints(region, mode = "full", exceptId = "") {
  const normalizedRegion = String(region || "").trim();
  if (!normalizedRegion) return 0;

  const now = new Date().toISOString();
  let result;
  if (exceptId) {
    result = ensureDb().prepare(`
      UPDATE research_checkpoints
      SET status = 'superseded', updated_at = ?
      WHERE region = ? AND mode = ? AND status = 'resumable' AND id <> ?
    `).run(now, normalizedRegion, String(mode || "full"), String(exceptId));
  } else {
    result = ensureDb().prepare(`
      UPDATE research_checkpoints
      SET status = 'superseded', updated_at = ?
      WHERE region = ? AND mode = ? AND status = 'resumable'
    `).run(now, normalizedRegion, String(mode || "full"));
  }
  return Number(result?.changes || 0);
}

export async function markCheckpointStatus(jobId, status) {
  if (!jobId) return 0;
  const allowed = new Set(["resumable", "completed", "superseded"]);
  const value = allowed.has(String(status)) ? String(status) : "resumable";
  const result = ensureDb().prepare(`
    UPDATE research_checkpoints
    SET status = ?, updated_at = ?
    WHERE id = ?
  `).run(value, new Date().toISOString(), String(jobId));
  return Number(result?.changes || 0);
}

export async function deleteCheckpoint(jobId) {
  if (!jobId) return 0;
  const result = ensureDb()
    .prepare("DELETE FROM research_checkpoints WHERE id = ?")
    .run(String(jobId));
  return Number(result?.changes || 0);
}

export function normalizeCheckpoint(value) {
  if (!value || Number(value.version) !== 1) return null;
  if (!String(value.region || "").trim()) return null;
  return cloneCheckpoint(value);
}

export function checkpointSummary(value) {
  if (!value) return null;
  return {
    version: Number(value.version || 0),
    region: String(value.region || ""),
    phase: String(value.phase || ""),
    completed_stage: Number(value.completed_stage || 0),
    completed_final_batches: Number(value.completed_final_batches || 0),
    enrichment_completed: Array.isArray(value.enrichment_completed_ids)
      ? value.enrichment_completed_ids.length : 0,
    contacts_completed: Array.isArray(value.contact_completed_ids)
      ? value.contact_completed_ids.length : 0,
    pipeline_version: Number(value.pipeline_version || 0),
    updated_at: value.updated_at || null
  };
}

export async function checkpointBackendStatus() {
  try {
    const database = ensureDb();
    database.prepare("SELECT 1 AS ok").get();
    return {
      backend: "sqlite",
      ready: true,
      path: CHECKPOINT_DB_PATH,
      pipeline_version: PIPELINE_VERSION,
      ephemeral_storage: process.env.RENDER ? CHECKPOINT_DB_PATH.startsWith("/tmp/") : false
    };
  } catch (error) {
    return {
      backend: "sqlite",
      ready: false,
      path: CHECKPOINT_DB_PATH,
      pipeline_version: PIPELINE_VERSION,
      error: error?.message || String(error)
    };
  }
}

export { CHECKPOINT_DB_PATH, PIPELINE_VERSION };
