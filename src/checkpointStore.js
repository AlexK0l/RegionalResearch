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

    -- Only jobs which have not started are restored from this table.
    CREATE TABLE IF NOT EXISTS queued_research_jobs (
      id TEXT PRIMARY KEY,
      region TEXT NOT NULL,
      mode TEXT NOT NULL,
      pipeline_version INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      source_job_id TEXT NOT NULL DEFAULT '',
      checkpoint_ref TEXT NOT NULL DEFAULT '',
      checkpoint_payload TEXT,
      summary TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_maintenance (
      name TEXT PRIMARY KEY,
      last_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_paused_jobs (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      pause_count INTEGER NOT NULL,
      summary TEXT NOT NULL,
      percent REAL NOT NULL DEFAULT 0
    );
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

  // The caller already holds an immutable snapshot. A JSON stringify/parse
  // deep clone here would temporarily double a potentially large research
  // payload, and JSON.stringify below would allocate it yet again.
  // Validate first, then serialize a shallow top-level copy exactly once.
  if (Number(checkpoint.version) !== 1 ||
      !String(checkpoint.region || "").trim())
    throw new Error("Некорректный checkpoint");
  const normalized = { ...checkpoint, pipeline_version: PIPELINE_VERSION };

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

// On the legacy pipeline a newer resume child could overwrite the phase
// "contacts" with "statistics", even though its original parent had
// already finished Stage11. Resume children retain the parent's created_at:
// within that SAME source lineage, prefer the furthest committed phase.
// A fresh study has a different created_at and must remain the newest study.
const RESUME_PHASE_RANK=new Map([
  "starting","discovery","pre_identity","identity","final_batches",
  "dedupe","qualification","final_inn","enrichment","statistics",
  "contacts","saby","priority","completed"
].map((phase,index)=>[phase,index]));

export function preferLatestResumeCheckpoint(rows) {
  if(!Array.isArray(rows)||!rows.length)return null;
  const ordered=[...rows].sort((a,b)=>
    Date.parse(b.updated_at||0)-Date.parse(a.updated_at||0));
  const newest=ordered[0];
  const family=ordered.filter(item=>
    item.created_at && item.created_at===newest.created_at);
  if(!family.length)return newest;
  return family.sort((a,b)=>
    (RESUME_PHASE_RANK.get(b.phase)??-1)-
      (RESUME_PHASE_RANK.get(a.phase)??-1) ||
    Date.parse(b.updated_at||0)-Date.parse(a.updated_at||0))[0];
}

export async function findLatestCheckpoint(region, mode = "full") {
  const normalizedRegion = String(region || "").trim();
  if (!normalizedRegion) return null;

  const rows = ensureDb().prepare(`
    SELECT id,region,mode,pipeline_version,status,phase,
      completed_stage,completed_final_batches,created_at,updated_at
    FROM research_checkpoints
    WHERE region = ?
      AND mode = ?
      AND status = 'resumable'
    ORDER BY updated_at DESC
    LIMIT 50
  `).all(normalizedRegion,String(mode||"full"));

  return metadataFromRow(preferLatestResumeCheckpoint(rows));
}

// Read-only historical source for bounded, fresh-web recall. Completed results
// are never copied into a current CRM row. Reads do not mutate SQLite or
// change resumability of old checkpoints.
export async function loadRecentCompletedResearch(region, limit = 3) {
  const value = String(region || "").trim();
  if (!value) return [];
  const rows = ensureDb().prepare(
    "SELECT id, updated_at, payload FROM research_checkpoints " +
    "WHERE region = ? AND mode = 'full' AND status = 'completed' " +
    "ORDER BY updated_at DESC LIMIT ?"
  ).all(value, Math.max(1, Math.min(20, Math.floor(Number(limit) || 3))));
  return rows.flatMap(row => {
    const checkpoint = rowToCheckpoint(row);
    if (!checkpoint?.final_result) return [];
    return [{
      id: String(row.id), updated_at: String(row.updated_at),
      final_result: checkpoint.final_result,
      recall_attempted_inns: Array.isArray(checkpoint.historical_recall?.attempted_inns)
        ? checkpoint.historical_recall.attempted_inns : []
    }];
  });
}

// Existing contact cache remains separate from historical discovery hints.
export async function loadLatestCompletedResearch(region) {
  const value = String(region || "").trim();
  if (!value) return null;
  const row = ensureDb().prepare(`
    SELECT payload FROM research_checkpoints
    WHERE region = ? AND mode = 'full' AND status = 'completed'
    ORDER BY updated_at DESC LIMIT 1
  `).get(value);
  const checkpoint = rowToCheckpoint(row);
  return checkpoint?.final_result || null;
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
    // completed_stage is the number of 1-9 discovery passes, NOT the full
    // 13-stage workflow. Surface Stage11 completion separately for the UI.
    stage11_completed: value.stage11_completed===true ||
      ["saby","priority","completed"].includes(String(value.phase||"")),
    completed_stage: Number(value.completed_stage || 0),
    completed_final_batches: Number(value.completed_final_batches || 0),
    enrichment_completed: Array.isArray(value.enrichment_completed_ids)
      ? value.enrichment_completed_ids.length : 0,
    contacts_completed: Array.isArray(value.contact_completed_ids)
      ? value.contact_completed_ids.length : 0,
    contacts_deferred: Array.isArray(value.contact_unsearched_ids)
      ? value.contact_unsearched_ids.length : 0,
    saby_completed: Array.isArray(value.saby_completed_inns)
      ? value.saby_completed_inns.length : 0,
    saby_deferred: Array.isArray(value.saby_deferred_inns)
      ? value.saby_deferred_inns.length : 0,
    ...(value.phase==="saby"?{saby_browser_pending:
      value.public_contact_post_saby_ready!==true&&value.saby_stats?.fullSweepCompleted!==true&&
      (value.saby_pass_state?.phase_index??0)<4}:{}),
    continuation_available:
      (Array.isArray(value.contact_unsearched_ids) &&
       value.contact_unsearched_ids.length > 0) ||
      (Array.isArray(value.saby_deferred_inns) &&
       value.saby_deferred_inns.length > 0),
    pipeline_version: Number(value.pipeline_version || 0),
    updated_at: value.updated_at || null
  };
}

// Persist admission intent, not an API key or an executing paid job.
const queuedModes=new Set(["full","resume","saby_only"]);
const jobIdPattern=/^[a-f0-9-]{36}$/i;

export function saveQueuedResearchJob(job){
  const id=String(job?.id||""),mode=String(job?.mode||""),
    region=String(job?.region||"").trim();
  const createdAt=Number(job?.createdAt);
  if(!jobIdPattern.test(id)||!queuedModes.has(mode)||!region||
      !Number.isSafeInteger(createdAt)||createdAt<0)
    throw Error("QUEUED_RESEARCH_JOB_INVALID");
  const ref=String(job.data?.checkpointRef||"");
  const rawSource=String(job.data?.sourceJobId||"");
  const source=jobIdPattern.test(rawSource)?rawSource:ref;
  if(ref&&!jobIdPattern.test(ref))throw Error("QUEUED_CHECKPOINT_REF_INVALID");
  const inline=mode!=="full"&&!ref?job.data?.checkpoint:null;
  if(mode!=="full"&&!ref&&(!inline||Number(inline.version)!==1||
      Number(inline.pipeline_version||PIPELINE_VERSION)!==PIPELINE_VERSION||
      String(inline.region||"").trim()!==region))
    throw Error("QUEUED_CHECKPOINT_SOURCE_INVALID");
  if(mode==="saby_only"&&!ref)throw Error("QUEUED_SABY_SOURCE_REQUIRED");
  if(ref){
    const parent=ensureDb().prepare("SELECT region,pipeline_version,status FROM research_checkpoints WHERE id=?").get(ref);
    if(!parent||parent.region!==region||Number(parent.pipeline_version)!==PIPELINE_VERSION||
       parent.status==="superseded")throw Error("QUEUED_CHECKPOINT_SOURCE_INVALID");
  }
  const summary=JSON.stringify(job.latestCheckpointSummary||null);
  if(summary.length>8192)throw Error("QUEUED_CHECKPOINT_SUMMARY_LIMIT");
  ensureDb().prepare(
    "INSERT INTO queued_research_jobs(id,region,mode,pipeline_version,created_at_ms,"+
    "source_job_id,checkpoint_ref,checkpoint_payload,summary) VALUES(?,?,?,?,?,?,?,?,?)"
  ).run(id,region,mode,PIPELINE_VERSION,createdAt,source,ref,
    inline?JSON.stringify(inline):null,summary);
}

export function listQueuedResearchJobs(){
  // Do not hydrate large imported checkpoints while restoring the queue.
  return ensureDb().prepare(
    "SELECT id,region,mode,created_at_ms,source_job_id,checkpoint_ref,summary "+
    "FROM queued_research_jobs WHERE pipeline_version=? ORDER BY created_at_ms,id"
  ).all(PIPELINE_VERSION).flatMap(row=>{
    try{
      if(!queuedModes.has(row.mode)||!jobIdPattern.test(row.id))return [];
      return [{id:row.id,region:row.region,mode:row.mode,createdAt:row.created_at_ms,
        sourceJobId:row.source_job_id,checkpointRef:row.checkpoint_ref,
        summary:JSON.parse(row.summary)}];
    }catch{return [];}
  });
}

export function loadQueuedResearchSource(id){
  const row=ensureDb().prepare(
    "SELECT checkpoint_payload FROM queued_research_jobs WHERE id=? AND pipeline_version=?"
  ).get(String(id),PIPELINE_VERSION);
  return row?.checkpoint_payload?JSON.parse(row.checkpoint_payload):null;
}

export function takeQueuedResearchJob(id){
  // DELETE RETURNING atomically consumes admission intent BEFORE any paid
  // operation. A later hard crash therefore never auto-replays that job.
  const row=ensureDb().prepare(
    "DELETE FROM queued_research_jobs WHERE id=? AND pipeline_version=? RETURNING checkpoint_payload"
  ).get(String(id),PIPELINE_VERSION);
  if(!row)throw Error("QUEUED_RESEARCH_JOB_NOT_DURABLE");
  return row.checkpoint_payload?JSON.parse(row.checkpoint_payload):null;
}

export function clearQueuedResearchJob(id){
  ensureDb().prepare("DELETE FROM queued_research_jobs WHERE id=?").run(String(id));
}

// Only confirmed cooperative pauses are automatically recoverable.
// Never persist API keys or automatically replay an abruptly killed job.
export function saveMemoryPausedJob(job){
  const id=String(job?.id||""),mode=String(job?.mode||"");
  if(!/^[a-f0-9-]{36}$/i.test(id)||!["full","resume","saby_only"].includes(mode))
    throw Error("MEMORY_PAUSE_JOB_INVALID");
  const summary=JSON.stringify(job.latestCheckpointSummary||{});
  if(summary.length>8192)throw Error("MEMORY_PAUSE_SUMMARY_LIMIT");
  const out=ensureDb().prepare(
    "INSERT INTO memory_paused_jobs(id,mode,created_at_ms,pause_count,summary,percent) "+
    "SELECT id,?,?,?,?,? FROM research_checkpoints WHERE id=? AND status='resumable' "+
    "AND pipeline_version=? ON CONFLICT(id) DO UPDATE SET mode=excluded.mode,"+
    "created_at_ms=excluded.created_at_ms,pause_count=excluded.pause_count,"+
    "summary=excluded.summary,percent=excluded.percent"
  ).run(mode,Number(job.createdAt),Number(job.memoryPauseCount||1),summary,
    Math.max(0,Math.min(99,Number(job.progress?.percent||0))),id,PIPELINE_VERSION);
  if(Number(out.changes)!==1)throw Error("MEMORY_PAUSE_CHECKPOINT_NOT_DURABLE");
}
export function clearMemoryPausedJob(id){
  ensureDb().prepare("DELETE FROM memory_paused_jobs WHERE id=?").run(String(id));
}
export function listMemoryPausedJobs(){
  return ensureDb().prepare(
    "SELECT p.*,c.region,c.phase FROM memory_paused_jobs p "+
    "JOIN research_checkpoints c ON c.id=p.id WHERE c.status='resumable' "+
    "AND c.pipeline_version=? ORDER BY p.created_at_ms,p.id"
  ).all(PIPELINE_VERSION).flatMap(row=>{
    try{
      if(!["full","resume","saby_only"].includes(row.mode))return [];
      const summary=JSON.parse(row.summary);
      if(summary.region!==row.region||summary.phase!==row.phase)return [];
      return [{id:row.id,region:row.region,mode:row.mode,createdAt:row.created_at_ms,
        memoryPauseCount:row.pause_count,summary,percent:row.percent}];
    }catch{return [];}
  });
}

// Release SQLite's disposable page caches, never the live checkpoint data.
export function shrinkCheckpointMemory(){
  ensureDb().exec("PRAGMA shrink_memory;");
}

// Durable shared latch: a service restart is not evidence of new credits.
export function getOpenAIBillingHold(){
  return Number(ensureDb().prepare(
    "SELECT last_at_ms FROM runtime_maintenance WHERE name='openai_billing_hold'"
  ).get()?.last_at_ms||0);
}
export function setOpenAIBillingHold(now=Date.now()){
  if(!Number.isSafeInteger(now)||now<=0)throw Error("OPENAI_BILLING_BAD_CLOCK");
  ensureDb().prepare(
    "INSERT OR IGNORE INTO runtime_maintenance(name,last_at_ms) VALUES('openai_billing_hold',?)"
  ).run(now);
  return getOpenAIBillingHold();
}
export function clearOpenAIBillingHold(){
  ensureDb().prepare("DELETE FROM runtime_maintenance WHERE name='openai_billing_hold'").run();
}
// The cooldown survives process exit and prevents reboot loops even when
// the real bottleneck is outside Node. No payloads or secrets are loaded.
export function claimIdleMemoryRecycle(now,cooldownMs){
  if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(cooldownMs)||cooldownMs<60000)
    throw Error("IDLE_RECYCLE_BAD_CLOCK");
  const out=ensureDb().prepare(
    "INSERT INTO runtime_maintenance(name,last_at_ms) VALUES('idle_memory_recycle',?) "+
    "ON CONFLICT(name) DO UPDATE SET last_at_ms=excluded.last_at_ms "+
    "WHERE runtime_maintenance.last_at_ms<=?"
  ).run(now,now-cooldownMs);
  return Number(out.changes)===1;
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
