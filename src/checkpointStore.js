import fs from "node:fs/promises";
import path from "node:path";
import { createClient } from "redis";

const CHECKPOINT_TTL_SECONDS = Math.max(
  3600,
  Number(process.env.CHECKPOINT_TTL_SECONDS || 7 * 24 * 60 * 60)
);
const CHECKPOINT_DIR = path.resolve(process.env.CHECKPOINT_DIR || ".checkpoints");

let redisClient = null;
let redisDisabled = false;

function checkpointKey(jobId) {
  return `regionalresearch:checkpoint:${String(jobId || "").trim()}`;
}

function checkpointPath(jobId) {
  const safe = String(jobId || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(CHECKPOINT_DIR, safe + ".json");
}

async function getRedisClient() {
  const url = String(process.env.CHECKPOINT_REDIS_URL || "").trim();
  if (!url || redisDisabled) return null;
  if (redisClient?.isReady) return redisClient;

  try {
    redisClient = createClient({
      url,
      socket: {
        connectTimeout: 3000,
        reconnectStrategy: false
      }
    });
    redisClient.on("error", (error) => {
      console.error("[CHECKPOINT_REDIS_ERROR] " + JSON.stringify({
        error: error?.message || String(error)
      }));
    });
    await redisClient.connect();
    return redisClient;
  } catch (error) {
    redisDisabled = true;
    console.error("[CHECKPOINT_REDIS_DISABLED] " + JSON.stringify({
      error: error?.message || String(error)
    }));
    return null;
  }
}

function cloneCheckpoint(checkpoint) {
  return JSON.parse(JSON.stringify(checkpoint));
}

export async function saveCheckpoint(jobId, checkpoint) {
  if (!jobId || !checkpoint) return { redisSaved: false, fileSaved: false };
  const value = JSON.stringify(checkpoint);
  let redisSaved = false;
  let fileSaved = false;

  const client = await getRedisClient();
  if (client) {
    try {
      await client.set(checkpointKey(jobId), value, { EX: CHECKPOINT_TTL_SECONDS });
      redisSaved = true;
    } catch (error) {
      console.error("[CHECKPOINT_REDIS_SAVE_ERROR] " + JSON.stringify({
        job_id: jobId,
        error: error?.message || String(error)
      }));
    }
  }

  try {
    await fs.mkdir(CHECKPOINT_DIR, { recursive: true });
    const target = checkpointPath(jobId);
    const temp = target + ".tmp";
    await fs.writeFile(temp, value, "utf8");
    await fs.rename(temp, target);
    fileSaved = true;
  } catch (error) {
    console.error("[CHECKPOINT_FILE_SAVE_ERROR] " + JSON.stringify({
      job_id: jobId,
      error: error?.message || String(error)
    }));
  }
  return { redisSaved, fileSaved };
}

export async function loadCheckpoint(jobId) {
  if (!jobId) return null;
  const client = await getRedisClient();
  if (client) {
    try {
      const value = await client.get(checkpointKey(jobId));
      if (value) return JSON.parse(value);
    } catch (error) {
      console.error("[CHECKPOINT_REDIS_LOAD_ERROR] " + JSON.stringify({
        job_id: jobId,
        error: error?.message || String(error)
      }));
    }
  }

  try {
    const value = await fs.readFile(checkpointPath(jobId), "utf8");
    return JSON.parse(value);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("[CHECKPOINT_FILE_LOAD_ERROR] " + JSON.stringify({
        job_id: jobId,
        error: error?.message || String(error)
      }));
    }
    return null;
  }
}

export async function deleteCheckpoint(jobId) {
  if (!jobId) return;
  const client = await getRedisClient();
  if (client) {
    try {
      await client.del(checkpointKey(jobId));
    } catch {}
  }
  await fs.rm(checkpointPath(jobId), { force: true }).catch(() => {});
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
    updated_at: value.updated_at || null
  };
}


export async function checkpointBackendStatus() {
  const redisConfigured = Boolean(String(process.env.CHECKPOINT_REDIS_URL || "").trim());
  if (redisConfigured) {
    const client = await getRedisClient();
    if (client) {
      try {
        const pong = await client.ping();
        return {
          backend: "redis",
          configured: true,
          ready: pong === "PONG",
          file_fallback: true
        };
      } catch (error) {
        return {
          backend: "file",
          configured: true,
          ready: true,
          redis_error: error?.message || String(error),
          file_fallback: true
        };
      }
    }
  }
  return {
    backend: "file",
    configured: redisConfigured,
    ready: true,
    file_fallback: true
  };
}
