import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { runResearchPipeline } from "./src/pipeline.js";
import { buildWorkbookBuffer, safeFileName } from "./src/xlsx.js";
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
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 10000);
const jobs = new Map();
const MAX_ACTIVE_FULL_JOBS = Math.max(
  1,
  Math.min(2, Number(process.env.MAX_ACTIVE_FULL_JOBS || 1))
);
const pendingFullJobs = [];
let activeFullJobs = 0;

app.use(express.json({ limit: "32mb" }));

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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
  res.json({ steps: STEPS, pipelineVersion: PIPELINE_VERSION });
});

app.get("/api/checkpoints", async (req, res) => {
  try {
    const region = String(req.query.region || "").trim();
    const mode = String(req.query.mode || "full").trim() || "full";
    if (!region) return res.status(400).json({ error: "Регион обязателен" });

    const checkpoint = await findLatestCheckpoint(region, mode);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      exists: Boolean(checkpoint),
      checkpoint,
      history: await listRegionCheckpoints(region, mode, 5)
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
  "full", "test12", "smoke", "quality", "stage_test", "replay", "dedupe_replay", "resume"
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
      const output = await runResearchPipeline({ job, apiKey });
      if (job.cancelled) throw new Error("JOB_CANCELLED");
      job.result = output;
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

function refreshFullQueuePositions() {
  for (let index = 0; index < pendingFullJobs.length; index++) {
    const queued = pendingFullJobs[index]?.job;
    if (!queued || queued.cancelled) continue;
    queued.progress = {
      ...(queued.progress || {}),
      phase: "queued",
      queuePosition: index + 1,
      activeFullJobs,
      maxActiveFullJobs: MAX_ACTIVE_FULL_JOBS
    };
  }
}

function pumpFullJobQueue() {
  while (activeFullJobs < MAX_ACTIVE_FULL_JOBS && pendingFullJobs.length) {
    const next = pendingFullJobs.shift();
    if (!next?.job || next.job.cancelled) continue;
    activeFullJobs++;
    refreshFullQueuePositions();
    queueMicrotask(async () => {
      try {
        await executeJob(next.job, next.apiKey);
      } finally {
        activeFullJobs = Math.max(0, activeFullJobs - 1);
        refreshFullQueuePositions();
        pumpFullJobQueue();
      }
    });
  }
}

function queueJob(job, apiKey) {
  const isFullResearch = job.mode === "full" || job.mode === "resume";
  if (!isFullResearch) {
    queueMicrotask(() => executeJob(job, apiKey));
    return;
  }

  pendingFullJobs.push({ job, apiKey });
  refreshFullQueuePositions();
  pumpFullJobQueue();
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

  if (!apiKey) return res.status(503).json({ error: "OPENAI_API_KEY не настроен" });

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

  if (mode === "full") {
    const existingCheckpoint = await findLatestCheckpoint(region, "full");
    if (existingCheckpoint && !req.body?.startFresh) {
      return res.status(409).json({
        code: "CHECKPOINT_EXISTS",
        error: "Для региона есть незавершённое исследование",
        checkpoint: existingCheckpoint
      });
    }
    if (req.body?.startFresh) {
      await supersedeRegionCheckpoints(region, "full");
    }
  }

  if (mode === "resume" && data.sourceJobId) {
    await supersedeRegionCheckpoints(region, "full", data.sourceJobId);
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
    latestCheckpoint: mode === "resume" ? normalizeCheckpoint(data.checkpoint) : null,
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
  jobs.set(id, job);

  res.status(202).json({
    id,
    region,
    mode,
    resumedFrom: mode === "resume" ? data.sourceJobId || "" : ""
  });
  queueJob(job, apiKey);
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Задание не найдено или сервис был перезапущен" });

  res.json({
    id: job.id,
    state: job.state,
    progress: job.progress || {},
    result: job.state === "completed"
      ? {
          region: job.result?.region,
          counts: job.result?.counts,
          contacts: job.result?.contacts,
          mode: job.result?.mode || job.mode || "full",
          stage: job.result?.stage || job.data?.stage || null,
          qualified_companies: job.result?.qualified_companies || [],
          replay_comparison: job.result?.replay_comparison || null,
          dedupe_comparison: job.result?.dedupe_comparison || null,
          replay_available: Boolean(job.result?.discovery_snapshot)
        }
      : null,
    checkpoint: checkpointSummary(job.latestCheckpoint),
    resume_available: Boolean(job.latestCheckpoint),
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
  await supersedeRegionCheckpoints(checkpoint.region, "full", req.params.id);

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
  jobs.set(id, job);
  res.status(202).json({
    id,
    region: checkpoint.region,
    mode: "resume",
    resumedFrom: req.params.id,
    checkpoint: checkpointSummary(checkpoint)
  });
  queueJob(job, apiKey);
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
  if (wasWaiting) refreshFullQueuePositions();
  res.json({ ok: true, state: job.state });
});

app.get("/api/jobs/:id/download", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Задание не найдено" });
  if (job.state !== "completed") {
    return res.status(409).json({ error: "Итоговый файл ещё не готов" });
  }

  const result = job.result?.result;
  if (!result) return res.status(500).json({ error: "Результат отсутствует" });

  const buffer = buildWorkbookBuffer(result);
  const filename = safeFileName(job.result?.region || "result");

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.send(buffer);
});

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (job.createdAt < cutoff && !["active", "waiting"].includes(job.state)) {
      jobs.delete(id);
    }
  }
}, 60 * 60 * 1000).unref();

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

app.listen(port, "0.0.0.0", () => {
  console.log(`SAT research web service listening on ${port}`);
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
