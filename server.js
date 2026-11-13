import crypto from "node:crypto";
import { createBrowserSessionAuth, isSameRequestOrigin } from "./src/browserSessionAuth.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { runResearchPipeline } from "./src/pipeline.js";
import {validateSabyOnlySource,sabyOnlyConfigReady,
  runSabyOnlyContinuation} from "./src/sabyOnlyContinuation.js";
import { buildAuditWorkbookBuffer, safeFileName } from "./src/xlsx.js";
import { buildReferenceWorkbookBuffer } from "./src/referenceWorkbookExport.js";
import { createFullJobQueue, fullJobConcurrencyLimit } from "./src/fullJobQueue.js";
import { estimateResearchEta, historicalStageDurations } from "./src/researchEta.js";
import { STEPS } from "./src/constants.js";
import { launchResearchBrowser } from "./src/googleAiAgent.js";
import {
  fileLoggingStatus,
  initializeFileLogging,
  jobLogPublicInfo,
  runWithJobLog
} from "./src/fileLogger.js";
import {
  checkpointBackendStatus,
  checkpointSummary,
  findLatestCheckpoint,
  listRegionCheckpoints,
  loadCheckpoint,
  normalizeCheckpoint,
  PIPELINE_VERSION,
  saveCheckpoint,
  supersedeRegionCheckpoints
} from "./src/checkpointStore.js";

initializeFileLogging();

const app = express();
// Caddy connects from loopback; preserve the real client IP for login throttling.
app.set("trust proxy", "loopback");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 10000);
const jobs = new Map();
const MAX_ACTIVE_FULL_JOBS = fullJobConcurrencyLimit();
if (process.env.MAX_ACTIVE_FULL_JOBS && String(process.env.MAX_ACTIVE_FULL_JOBS) !== String(MAX_ACTIVE_FULL_JOBS)) {
  console.warn("[MAX_ACTIVE_FULL_JOBS_ADJUSTED] " + JSON.stringify({configured:process.env.MAX_ACTIVE_FULL_JOBS,effective:MAX_ACTIVE_FULL_JOBS}));
}

app.use(express.json({ limit: "32mb" }));

// One-browser-login mode is enabled only when WEB_LOGIN_PASSWORD_HASH is set.
// The browser receives a signed, HttpOnly cookie; API_ACCESS_TOKEN never leaves .env.
const failedWebLogins = new Map();
app.get("/login", (req, res) => {
  if (!browserAuth.enabled) return res.redirect("/");
  res.setHeader("Cache-Control", "no-store");
  if (browserAuth.validCookieHeader(String(req.get("cookie") || ""))) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/api/auth/login", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!browserAuth.enabled) return res.status(404).json({error:"Browser login is disabled"});
  if (!isSameRequestOrigin(req)) return res.status(403).json({error:"Недопустимый источник запроса"});

  const ip = String(req.ip || "unknown");
  const now = Date.now();
  const record = failedWebLogins.get(ip);
  const failures = record && now - record.started < 60_000 ? record : {started:now, count:0};
  if (failures.count >= 8) return res.status(429).json({error:"Слишком много попыток. Повторите через минуту."});

  if (!browserAuth.passwordMatches(req.body?.password)) {
    failures.count += 1;
    failedWebLogins.set(ip, failures);
    if (failedWebLogins.size > 2000) failedWebLogins.clear();
    return res.status(401).json({error:"Неверный пароль"});
  }

  failedWebLogins.delete(ip);
  res.setHeader("Set-Cookie", browserAuth.makeCookie());
  return res.json({ok:true});
});

app.post("/api/auth/logout", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!browserAuth.enabled) return res.status(404).json({error:"Browser login is disabled"});
  if (!isSameRequestOrigin(req)) return res.status(403).json({error:"Недопустимый источник запроса"});
  res.setHeader("Set-Cookie", browserAuth.clearCookie());
  return res.json({ok:true});
});

// Set API_ACCESS_TOKEN in the deployment environment to protect paid jobs,
// logs, checkpoints and downloads. Local development remains compatible.
const API_ACCESS_TOKEN = String(process.env.API_ACCESS_TOKEN || "").trim();
const PROTECT_API = Boolean(API_ACCESS_TOKEN);
const browserAuth = createBrowserSessionAuth({
  passwordHash: process.env.WEB_LOGIN_PASSWORD_HASH || "",
  apiToken: API_ACCESS_TOKEN
});
// Local app defaults to loopback so a missing API_ACCESS_TOKEN never exposes
// paid job creation, logs or checkpoints to other devices on the network.
// Render keeps its existing external bind behavior. LAN mode is explicit.
const BIND_HOST = String(process.env.BIND_HOST ||
  (process.env.RENDER ? "0.0.0.0" : "127.0.0.1")).trim();
if (!process.env.RENDER && !PROTECT_API &&
    !["127.0.0.1", "::1", "localhost"].includes(BIND_HOST)) {
  throw new Error("BIND_HOST outside localhost requires API_ACCESS_TOKEN");
}
app.use("/api", (req, res, next) => {
  if (req.path === "/config") return next();
  if (!PROTECT_API) return next();
  const authorization = String(req.get("authorization") || "");
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (browserAuth.bearerMatches(provided)) return next();
  if (browserAuth.enabled &&
      browserAuth.validCookieHeader(String(req.get("cookie") || ""))) {
    // Cookies are automatic browser credentials: mutations require same Origin.
    if (!["GET", "HEAD"].includes(req.method) && !isSameRequestOrigin(req)) {
      return res.status(403).json({error:"Недопустимый источник запроса", code:"AUTH_ORIGIN"});
    }
    return next();
  }
  if (browserAuth.enabled) res.setHeader("X-Auth-Mode", "browser-session");
  return res.status(401).json({ error: "Требуется авторизация", code: "AUTH_REQUIRED" });
});

const allowedOrigins = new Set(
  [
    process.env.CLIENT_ORIGIN,
    "https://regionalresearch-ui.onrender.com",
    "http://localhost:3000",
    "http://localhost:10000",
    "http://127.0.0.1:10000"
  ].filter(Boolean)
);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", async (_req, res) => {
  const checkpoints = await checkpointBackendStatus().catch((error) => ({
    backend: "unknown",
    ready: false,
    error: error?.message || String(error)
  }));
  res.json({
    ok: true,
    service: "sat-region-research",
    checkpoints,
    logging: fileLoggingStatus(),
    runtime: process.env.RENDER ? "render" : "local"
  });
});

app.get("/api/config", (_req, res) => {
  res.json({ steps: STEPS, pipelineVersion: PIPELINE_VERSION, webSessionAuth: browserAuth.enabled });
});

// One region can have a finalized full-research checkpoint plus newer
// Saby-only child snapshots. Select the newest non-superseded source, not an
// older full run with more deferred companies that were already completed.
async function latestSabyCheckpointForRegion(region) {
  if (!String(region||"").trim()) return null;
  const [full,saby]=await Promise.all([
    listRegionCheckpoints(region,"full",10),
    listRegionCheckpoints(region,"saby",10)
  ]);
  const latest=[...full,...saby]
    .filter(c=>c.status!=="superseded")
    .sort((a,b)=>Date.parse(b.updated_at||"")-Date.parse(a.updated_at||""))[0];
  if (!latest) return null;
  const snapshot=await loadCheckpoint(latest.id);
  const validated=validateSabyOnlySource(snapshot);
  return validated.ok
    ? {...latest,...checkpointSummary(validated.checkpoint),
        id:latest.id,available:true,
        saby_deferred:validated.pending,
        saby_eligible:validated.eligible,
        saby_invalid:validated.invalid,
        saby_duplicate:validated.duplicates,
        saby_bootstrap:validated.bootstrap}
    : null;
}

app.get("/api/checkpoints", async (req, res) => {
  try {
    const region = String(req.query.region || "").trim();
    const mode = String(req.query.mode || "full").trim() || "full";
    if (!region) return res.status(400).json({ error: "Регион обязателен" });

    const history = await listRegionCheckpoints(region, mode, 5);
    let checkpoint = await findLatestCheckpoint(region, mode);
    if (!checkpoint) {
      // A completed study may still contain genuinely unresearched contacts.
      // Offer continuation from SQLite even after a browser/app restart.
      const recent = history.find((item) => item.status === "completed");
      if (recent) {
        const saved = await loadCheckpoint(recent.id);
        if ((Array.isArray(saved?.contact_unsearched_ids) &&
             saved.contact_unsearched_ids.length > 0) ||
            (Array.isArray(saved?.saby_deferred_inns) &&
             saved.saby_deferred_inns.length > 0)) {
          checkpoint = { ...checkpointSummary(saved),
            id: recent.id, mode, status: "completed" };
        }
      }
    }
    // A newer Saby-only child can complete the deferred firms while the
    // immutable full-study checkpoint still says they were pending. Overlay
    // only summary counters from its matching root; NEVER rewrite the source.
    if (checkpoint?.id) {
      const [childMeta]=await listRegionCheckpoints(region,"saby",1);
      if (childMeta && childMeta.status!=="superseded" &&
          Date.parse(childMeta.updated_at||"")>
            Date.parse(checkpoint.updated_at||"")) {
        const child=await loadCheckpoint(childMeta.id);
        if (child?.saby_continuation_root_job_id===checkpoint.id &&
            child.source_mode==="saby" &&
            Number(child.pipeline_version||PIPELINE_VERSION)===PIPELINE_VERSION &&
            Array.isArray(child.saby_deferred_inns) &&
            Array.isArray(child.saby_completed_inns)) {
          const fullSnapshot=await loadCheckpoint(checkpoint.id);
          const fullSummary=checkpointSummary(fullSnapshot);
          const contactsDeferred=Number(
            fullSummary?.contacts_deferred??checkpoint.contacts_deferred??0);
          const sabyDeferred=child.saby_deferred_inns.length;
          checkpoint={
            ...checkpoint,
            contacts_deferred:contactsDeferred,
            saby_deferred:sabyDeferred,
            saby_completed:child.saby_completed_inns.length,
            continuation_available:contactsDeferred>0||sabyDeferred>0,
            updated_at:childMeta.updated_at
          };
        }
      }
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({
      exists: Boolean(checkpoint),
      checkpoint,
      history,
      saby_checkpoint:await latestSabyCheckpointForRegion(region)
    });
  } catch (error) {
    res.status(500).json({ error: error?.message || "Не удалось прочитать checkpoints" });
  }
});

function requireCourtArchiveAdmin(req, res, next) {
  const expected = String(process.env.COURT_ARCHIVE_ADMIN_TOKEN || "").trim();
  const provided = String(req.get("x-court-admin-token") || "").trim();
  if (!expected || !provided || provided !== expected) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

async function openAiAdminRequest(apiKey, apiPath, options = {}) {
  const response = await fetch("https://api.openai.com/v1" + apiPath, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `OpenAI API HTTP ${response.status}`);
  }
  return data;
}

app.post("/api/admin/court-vector-store", requireCourtArchiveAdmin, async (_req, res) => {
  try {
    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) return res.status(503).json({ error: "OPENAI_API_KEY not configured" });
    const store = await openAiAdminRequest(apiKey, "/vector_stores", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "RegionalResearch court archive" })
    });
    res.json({ id: store.id, name: store.name, status: store.status });
  } catch (error) {
    res.status(500).json({ error: error?.message || "Vector store creation failed" });
  }
});

app.post(
  "/api/admin/court-vector-store/:id/files",
  requireCourtArchiveAdmin,
  express.raw({ type: "text/plain", limit: "12mb" }),
  async (req, res) => {
    try {
      const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
      if (!apiKey) return res.status(503).json({ error: "OPENAI_API_KEY not configured" });
      const name = String(req.query.name || "court_archive.txt").replace(/[^a-zA-Z0-9._-]/g, "_");
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
      if (!bytes.length) return res.status(400).json({ error: "Empty file" });

      const form = new FormData();
      form.append("purpose", "assistants");
      form.append("file", new Blob([bytes], { type: "text/plain" }), name);

      const uploaded = await openAiAdminRequest(apiKey, "/files", {
        method: "POST",
        body: form
      });
      const attached = await openAiAdminRequest(
        apiKey,
        `/vector_stores/${encodeURIComponent(req.params.id)}/files`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_id: uploaded.id })
        }
      );
      res.json({
        file_id: uploaded.id,
        filename: uploaded.filename,
        bytes: uploaded.bytes,
        vector_store_file_status: attached.status
      });
    } catch (error) {
      res.status(500).json({ error: error?.message || "Court archive upload failed" });
    }
  }
);

app.get("/api/admin/court-vector-store/:id/status", requireCourtArchiveAdmin, async (req, res) => {
  try {
    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) return res.status(503).json({ error: "OPENAI_API_KEY not configured" });
    const store = await openAiAdminRequest(
      apiKey,
      `/vector_stores/${encodeURIComponent(req.params.id)}`
    );
    res.json({
      id: store.id,
      status: store.status,
      file_counts: store.file_counts,
      usage_bytes: store.usage_bytes
    });
  } catch (error) {
    res.status(500).json({ error: error?.message || "Vector store status failed" });
  }
});

const JOB_MODES = new Set([
  "full", "test12", "smoke", "quality", "stage_test", "replay", "dedupe_replay", "resume", "saby_only"
]);

async function executeJob(job, apiKey) {
  return runWithJobLog(job, async () => {
    job.state = "active";
    console.log("[JOB_START] " + JSON.stringify({
      id: job.id,
      region: job.region,
      mode: job.mode,
      created_at: new Date(job.createdAt).toISOString()
    }));

    try {
      const output = job.mode === "saby_only"
        ? await runSabyOnlyContinuation({
            checkpoint:job.data.checkpoint,
            sourceJobId:job.data.sourceJobId,
            signal:job.abortController?.signal,
            onProgress:p=>job.updateProgress(p),
            persistCheckpoint:cp=>job.updateCheckpoint(cp)
          })
        : await runResearchPipeline({ job, apiKey });
      if (job.cancelled) throw new Error("JOB_CANCELLED");
      job.result = output;
      // Release safety: never invalidate an earlier resumable checkpoint when
      // a new full run is merely queued, cancelled, or fails before finishing.
      // Only retire older resume pointers AFTER the replacement is durably saved.
      if (job.mode === "full" || job.mode === "resume") {
        try {
          const persisted = await loadCheckpoint(job.id);
          if (persisted?.phase === "completed" && persisted?.final_result) {
            await supersedeRegionCheckpoints(job.region, "full", job.id);
          } else {
            console.warn("[CHECKPOINT_REPLACEMENT_DEFERRED] " +
              JSON.stringify({job_id:job.id,reason:"completed_snapshot_not_persisted"}));
          }
        } catch (checkpointError) {
          console.error("[CHECKPOINT_REPLACEMENT_ERROR] " +
            JSON.stringify({job_id:job.id,error:checkpointError?.message || String(checkpointError)}));
        }
      }
      job.state = "completed";
    } catch (error) {
      if (
        error?.message === "JOB_CANCELLED" ||
        error?.name === "AbortError" ||
        job.cancelled ||
        job.abortController?.signal?.aborted
      ) {
        job.state = "cancelled";
        job.error = "Остановлено пользователем";
      } else {
        job.state = "failed";
        job.error = error?.message || "Ошибка выполнения";
        console.error(error);
      }
    } finally {
      console.log("[JOB_FINISH] " + JSON.stringify({
        id: job.id,
        region: job.region,
        mode: job.mode,
        state: job.state,
        error: job.error || ""
      }));
    }
  });
}

const fullQueue = createFullJobQueue({
  limit: MAX_ACTIVE_FULL_JOBS,
  execute: executeJob
});

function queueJob(job, apiKey) {
  if (job.mode === "full" || job.mode === "resume" || job.mode === "saby_only") {
    return fullQueue.enqueue(job, apiKey);
  }
  queueMicrotask(() => executeJob(job, apiKey));
  return { accepted: true };
}

function activeRegionConflict(region, res) {
  const existing = fullQueue.conflict(region);
  if (!existing) return false;
  res.status(409).json({
    code: "REGION_JOB_ACTIVE",
    error: "Исследование этого региона уже выполняется или ожидает в очереди",
    existingJobId: existing.id,
    region: existing.region,
    state: existing.state
  });
  return true;
}

app.post("/api/jobs", async (req, res) => {
  const requestedMode = String(req.body?.mode || "full");
  const mode = JOB_MODES.has(requestedMode) ? requestedMode : "full";
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  let region = String(req.body?.region || "").trim();
  let data = { region };

  if (mode === "stage_test") {
    const stage = Number(req.body?.stage || 0);
    if (!Number.isInteger(stage) || stage < 1 || stage > 9) {
      return res.status(400).json({ error: "Для stage_test укажите этап от 1 до 9" });
    }
    data = { region, stage };
  }

  if (!apiKey && mode !== "saby_only") return res.status(503).json({ error: "OPENAI_API_KEY не настроен" });

  if (mode === "saby_only") {
    // Only a server-side persisted SQLite checkpoint may be used. Do not
    // accept user-posted final_result or arbitrary JSON for this no-paid path.
    const checkpointId=String(req.body?.checkpointId||"").trim();
    if (!/^[a-f0-9-]{36}$/i.test(checkpointId)) {
      return res.status(400).json({
        code:"SABY_SOURCE_JOB_REQUIRED",error:"Укажите ID сохранённого задания"
      });
    }
    if (!sabyOnlyConfigReady()) {
      return res.status(409).json({
        code:"SABY_BULK_NOT_ENABLED",error:"Массовый сбор Saby не включён"
      });
    }
    const persisted=await loadCheckpoint(checkpointId);
    if (!persisted) return res.status(404).json({
      code:"CHECKPOINT_NOT_FOUND",error:"Checkpoint не найден в SQLite"
    });
    const checked=validateSabyOnlySource(persisted);
    if (!checked.ok) return res.status(409).json({
      code:checked.code,
      error:"Этот checkpoint не готов для продолжения только Saby"
    });
    region=String(checked.checkpoint.region).trim();
    // A new Saby-only child checkpoint may have completed these companies.
    // Never let an older snapshot overwrite or replay newer verified records.
    const newest=await latestSabyCheckpointForRegion(region);
    if (!newest || newest.id!==checkpointId) {
      return res.status(409).json({
        code:"SABY_CHECKPOINT_STALE",
        error:"Для региона существует более новый checkpoint Saby"
      });
    }
    data={region,checkpoint:checked.checkpoint,sourceJobId:checkpointId};
  }

  if (mode === "replay" || mode === "dedupe_replay") {
    const sourceJobId = String(req.body?.sourceJobId || "").trim();
    let sourceJob = sourceJobId ? jobs.get(sourceJobId) : null;

    if (!sourceJob) {
      sourceJob = [...jobs.values()]
        .filter((item) =>
          item?.state === "completed" &&
          item?.result?.discovery_snapshot &&
          ["quality", "test12", "smoke", "replay", "dedupe_replay"].includes(item?.mode)
        )
        .sort((a, b) => Number(b?.createdAt || 0) - Number(a?.createdAt || 0))[0] || null;
    }

    const uploadedSnapshot =
      req.body?.snapshot &&
      [1, 2, 3, 4].includes(req.body.snapshot.version) &&
      Array.isArray(req.body.snapshot.parts)
        ? req.body.snapshot
        : null;
    const snapshot = sourceJob?.result?.discovery_snapshot || uploadedSnapshot;

    if (!snapshot) {
      return res.status(409).json({
        error: mode === "dedupe_replay"
          ? "Для Dedupe replay нужен завершённый тестовый job или сохранённый snapshot"
          : "Для Replay нужен завершённый тестовый job или сохранённый discovery snapshot"
      });
    }
    if (mode === "dedupe_replay" && !Array.isArray(snapshot.identity_checkpoint?.candidates)) {
      return res.status(409).json({
        error: "Для Dedupe replay нужен snapshot с identity checkpoint"
      });
    }
    region = String(snapshot.region || sourceJob?.region || "").trim();
    data = { region, snapshot, sourceJobId: sourceJob?.id || sourceJobId || "" };
  }

  if (mode === "resume") {
    const checkpointId = String(
      req.body?.checkpointId || req.body?.sourceJobId || ""
    ).trim();
    const sourceJob = checkpointId ? jobs.get(checkpointId) : null;
    const storedCheckpoint = checkpointId ? await loadCheckpoint(checkpointId) : null;
    const checkpoint = normalizeCheckpoint(
      sourceJob?.latestCheckpoint || storedCheckpoint || req.body?.checkpoint
    );
    if (!checkpoint) {
      return res.status(409).json({
        error: "Для Resume нужен checkpointId или сохранённый checkpoint в теле запроса"
      });
    }
    if (
      Number(checkpoint.pipeline_version || PIPELINE_VERSION) !== PIPELINE_VERSION
    ) {
      return res.status(409).json({
        code: "CHECKPOINT_VERSION_MISMATCH",
        error: "Checkpoint создан несовместимой версией pipeline",
        checkpointPipelineVersion: Number(checkpoint.pipeline_version || 0),
        currentPipelineVersion: PIPELINE_VERSION
      });
    }
    region = String(checkpoint.region || "").trim();
    data = {
      region,
      checkpoint,
      sourceJobId: checkpointId
    };
  }

  if (!region) return res.status(400).json({ error: "Регион обязателен" });
  if (["full", "resume", "saby_only"].includes(mode) &&
      activeRegionConflict(region, res)) return;

  if (mode === "full") {
    const existingCheckpoint = await findLatestCheckpoint(region, "full");
    if (existingCheckpoint && !req.body?.startFresh) {
      return res.status(409).json({
        code: "CHECKPOINT_EXISTS",
        error: "Для региона есть незавершённое исследование",
        checkpoint: existingCheckpoint
      });
    }
    // startFresh intentionally keeps the older resumable payload intact:
    // replacement happens only after successful completed checkpoint persistence.
  }

  const id = crypto.randomUUID();
  const job = {
    id,
    region,
    mode,
    data,
    state: "waiting",
    progress: {},
    result: null,
    error: null,
    cancelled: false,
    abortController: new AbortController(),
    createdAt: Date.now(),
    latestCheckpoint: ["resume","saby_only"].includes(mode)
      ? normalizeCheckpoint(data.checkpoint) : null,
    async updateProgress(progress) {
      this.progress = progress;
    },
    async updateCheckpoint(checkpoint) {
      const normalized = normalizeCheckpoint(checkpoint);
      if (!normalized) throw new Error("Некорректный checkpoint pipeline");
      this.latestCheckpoint = normalized;
      await saveCheckpoint(this.id, normalized);
    }
  };
  const queued = queueJob(job, apiKey);
  if (!queued.accepted) {
    return res.status(409).json({
      code: "REGION_JOB_ACTIVE",
      error: "Исследование этого региона уже выполняется или ожидает в очереди",
      existingJobId: queued.existing.id,
      region: queued.existing.region,
      state: queued.existing.state
    });
  }
  jobs.set(id, job);

  res.status(202).json({
    id,
    region,
    mode,
    resumedFrom: ["resume","saby_only"].includes(mode)
      ? data.sourceJobId || "" : ""
  });
});

app.get("/api/jobs", (_req, res) => {
  const now = Date.now();
  const history = historicalStageDurations(jobs.values());
  res.setHeader("Cache-Control", "no-store");
  res.json({
    queue: fullQueue.snapshot(),
    jobs: [...jobs.values()]
      .sort((a,b)=>b.createdAt-a.createdAt)
      .slice(0,100)
      .map(job=>({
        id: job.id,
        region: job.region,
        mode: job.mode,
        state: job.state,
        phase: job.progress?.phase || "",
        percent: Number(job.progress?.percent || 0),
        queuePosition: Number(job.progress?.queuePosition || 0),
        createdAt: job.createdAt,
        hasResult: job.state === "completed" && Boolean(job.result?.result),
        eta: estimateResearchEta(job, { now, history })
      }))
  });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Задание не найдено или сервис был перезапущен" });

  const now = Date.now();
  const history = historicalStageDurations(jobs.values());
  res.setHeader("Cache-Control", "no-store");
  res.json({
    id: job.id,
    region: job.region,
    mode: job.mode,
    state: job.state,
    eta: estimateResearchEta(job, { now, history }),
    progress: job.progress || {},
    result: job.state === "completed"
      ? {
          region: job.result?.region,
          counts: job.result?.counts,
          contacts: job.result?.contacts,
          saby: job.result?.saby || null,
          mode: job.result?.mode || job.mode || "full",
          stage: job.result?.stage || job.data?.stage || null,
          qualified_companies: job.result?.qualified_companies || [],
          replay_comparison: job.result?.replay_comparison || null,
          dedupe_comparison: job.result?.dedupe_comparison || null,
          replay_available: Boolean(job.result?.discovery_snapshot),
          quality: job.result?.quality || null,
          full_json_available: Boolean(job.result?.result)
        }
      : null,
    checkpoint: checkpointSummary(job.latestCheckpoint),
    resume_available: Boolean(job.latestCheckpoint),
    continuation_available:
      (Array.isArray(job.latestCheckpoint?.contact_unsearched_ids) &&
       job.latestCheckpoint.contact_unsearched_ids.length > 0) ||
      (Array.isArray(job.latestCheckpoint?.saby_deferred_inns) &&
       job.latestCheckpoint.saby_deferred_inns.length > 0),
    log: jobLogPublicInfo(job),
    error: ["failed", "cancelled"].includes(job.state) ? job.error : null
  });
});

app.get("/api/jobs/:id/log", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Задание не найдено" });
  if (!job.logFile) return res.status(404).json({ error: "Лог задания ещё не создан" });

  res.setHeader("Cache-Control", "no-store");
  res.download(
    job.logFile,
    path.basename(job.logFile),
    (error) => {
      if (error && !res.headersSent) {
        res.status(404).json({ error: "Файл лога недоступен" });
      }
    }
  );
});

app.get("/api/jobs/:id/checkpoint", async (req, res) => {
  const job = jobs.get(req.params.id);
  const checkpoint = normalizeCheckpoint(
    job?.latestCheckpoint || await loadCheckpoint(req.params.id)
  );
  if (!checkpoint) {
    return res.status(404).json({ error: "Checkpoint для этого задания не найден" });
  }
  res.setHeader("Cache-Control", "no-store");
  res.json(checkpoint);
});

app.post("/api/jobs/:id/resume", async (req, res) => {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) return res.status(503).json({ error: "OPENAI_API_KEY не настроен" });

  const sourceJob = jobs.get(req.params.id);
  const checkpoint = normalizeCheckpoint(
    sourceJob?.latestCheckpoint || await loadCheckpoint(req.params.id)
  );
  if (!checkpoint) {
    return res.status(404).json({ error: "Checkpoint для возобновления не найден" });
  }
  if (Number(checkpoint.pipeline_version || PIPELINE_VERSION) !== PIPELINE_VERSION) {
    return res.status(409).json({
      code: "CHECKPOINT_VERSION_MISMATCH",
      error: "Checkpoint создан несовместимой версией pipeline"
    });
  }
  // The original remains available if the new attempt fails or is cancelled.
  if (activeRegionConflict(checkpoint.region, res)) return;
  const id = crypto.randomUUID();
  const job = {
    id,
    region: checkpoint.region,
    mode: "resume",
    data: { region: checkpoint.region, checkpoint, sourceJobId: req.params.id },
    state: "waiting",
    progress: {},
    result: null,
    error: null,
    cancelled: false,
    abortController: new AbortController(),
    createdAt: Date.now(),
    latestCheckpoint: checkpoint,
    async updateProgress(progress) {
      this.progress = progress;
    },
    async updateCheckpoint(nextCheckpoint) {
      const normalized = normalizeCheckpoint(nextCheckpoint);
      if (!normalized) throw new Error("Некорректный checkpoint pipeline");
      this.latestCheckpoint = normalized;
      await saveCheckpoint(this.id, normalized);
    }
  };
  const queued = queueJob(job, apiKey);
  if (!queued.accepted) {
    return res.status(409).json({
      code: "REGION_JOB_ACTIVE",
      error: "Исследование этого региона уже выполняется или ожидает в очереди",
      existingJobId: queued.existing.id,
      region: queued.existing.region
    });
  }
  jobs.set(id, job);
  res.status(202).json({
    id,
    region: checkpoint.region,
    mode: "resume",
    resumedFrom: req.params.id,
    checkpoint: checkpointSummary(checkpoint)
  });
});

app.get("/api/jobs/:id/snapshot", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Задание не найдено" });
  if (job.state !== "completed" || !job.result?.discovery_snapshot) {
    return res.status(409).json({ error: "Discovery snapshot для этого задания недоступен" });
  }

  res.setHeader("Cache-Control", "no-store");
  res.json(job.result.discovery_snapshot);
});

app.post("/api/jobs/:id/cancel", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Задание не найдено" });

  const wasWaiting = job.state === "waiting";
  job.cancelled = true;
  job.state = wasWaiting ? "cancelled" : "cancelling";
  job.error = wasWaiting ? "Остановлено пользователем" : job.error;
  if (!job.abortController?.signal?.aborted) {
    job.abortController?.abort(new Error("JOB_CANCELLED"));
  }
  if (wasWaiting) fullQueue.cancelQueued(job.id);
  res.json({ ok: true, state: job.state });
});

app.get("/api/jobs/:id/download", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Задание не найдено" });
  if (job.state !== "completed") {
    return res.status(409).json({ error: "Итоговый файл ещё не готов" });
  }

  const result = job.result?.result;
  if (!result) return res.status(500).json({ error: "Результат отсутствует" });

  try {
    // The browser receives the sanitized reference's exact five-sheet layout.
    // No silent fallback to the old 37-column approximation.
    const buffer = await buildReferenceWorkbookBuffer(result);
    const filename = safeFileName(job.result?.region || "result");
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  } catch (error) {
    console.error("[REFERENCE_EXPORT_FAILED]", error?.message || String(error));
    res.status(503).json({ error:
      "Не удалось сформировать Excel по строгому шаблону: " +
      String(error?.message || error) });
  }
});


// REVIEW/EXCLUDED remain in a separate audit workbook, not the reference.
app.get("/api/jobs/:id/download-audit", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Задание не найдено" });
  if (job.state !== "completed") return res.status(409).json({ error: "Аудит ещё не готов" });
  const result = job.result?.result;
  if (!result) return res.status(500).json({ error: "Результат отсутствует" });
  const buffer = buildAuditWorkbookBuffer(result);
  const filename = safeFileName(job.result?.region || "result").replace(/\.xlsx$/i, "_audit.xlsx");
  res.setHeader("Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader("Cache-Control", "no-store");
  res.send(buffer);
});

app.get("/api/jobs/:id/quality", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Задание не найдено" });
  if (job.state !== "completed") return res.status(409).json({ error: "Итоговый аудит ещё не готов" });
  const output = job.result?.result;
  if (!output) return res.status(500).json({ error: "Результат отсутствует" });
  return res.json({
    region: job.result?.region || "",
    final_quality_gate: job.result?.quality || output.final_quality_gate || null,
    review: output.qualification_review || [],
    excluded: output.qualification_excluded || []
  });
});

app.get("/api/jobs/:id/download-json", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Задание не найдено" });
  if (job.state !== "completed") return res.status(409).json({ error: "Итоговый JSON ещё не готов" });
  const output = job.result?.result;
  if (!output) return res.status(500).json({ error: "Результат отсутствует" });
  const filename = safeFileName(job.result?.region || "result").replace(/\.xlsx$/i, ".json");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader("Cache-Control", "no-store");
  return res.send(JSON.stringify({
    region: job.result.region,
    final_quality_gate: job.result?.quality || output.final_quality_gate || null,
    final_result: output
  }, null, 2));
});

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (job.createdAt < cutoff && !["active", "waiting"].includes(job.state)) {
      jobs.delete(id);
    }
  }
}, 60 * 60 * 1000).unref();

if (browserAuth.enabled) {
  app.use((req, res, next) => {
    if (browserAuth.validCookieHeader(String(req.get("cookie") || ""))) return next();
    if (req.method !== "GET" && req.method !== "HEAD") return res.sendStatus(401);
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, "/login");
  });
}

app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"],
  maxAge: process.env.NODE_ENV === "production" ? "5m" : 0
}));

app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error?.message || "Внутренняя ошибка" });
});

const httpServer = app.listen(port, BIND_HOST, () => {
  const boundPort = httpServer.address()?.port || port;
  console.log(`SAT research web service listening on ${BIND_HOST}:${boundPort}`);
  // The launch smoke-test exercises HTTP and SQLite without downloading or
  // opening Chromium. Normal local launches still perform the self-test.
  if (process.env.SKIP_CHROMIUM_SELF_TEST === "true") return;
  setTimeout(async () => {
    let browser;
    try {
      browser = await launchResearchBrowser();
      console.log("Chromium self-test passed");
    } catch (error) {
      console.error("Chromium self-test failed:", error?.message || error);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }, 1000).unref();
});
