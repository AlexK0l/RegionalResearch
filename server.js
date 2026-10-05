import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { runResearchPipeline } from "./src/pipeline.js";
import { buildWorkbookBuffer, safeFileName } from "./src/xlsx.js";
import { STEPS } from "./src/constants.js";
import { launchResearchBrowser } from "./src/googleAiAgent.js";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 10000);
const jobs = new Map();

app.use(express.json({ limit: "8mb" }));

const allowedOrigins = new Set(
  [
    process.env.CLIENT_ORIGIN,
    "https://regionalresearch-ui.onrender.com",
    "http://localhost:3000"
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

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "sat-region-research" });
});

app.get("/api/config", (_req, res) => {
  res.json({ steps: STEPS });
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

const JOB_MODES = new Set(["full", "test12", "smoke", "quality", "replay"]);

function queueJob(job, apiKey) {
  queueMicrotask(async () => {
    job.state = "active";
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
    }
  });
}

app.post("/api/jobs", async (req, res) => {
  const requestedMode = String(req.body?.mode || "full");
  const mode = JOB_MODES.has(requestedMode) ? requestedMode : "full";
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  let region = String(req.body?.region || "").trim();
  let data = { region };

  if (!apiKey) return res.status(503).json({ error: "OPENAI_API_KEY не настроен на Render" });

  if (mode === "replay") {
    const sourceJobId = String(req.body?.sourceJobId || "").trim();
    let sourceJob = sourceJobId ? jobs.get(sourceJobId) : null;

    if (!sourceJob) {
      sourceJob = [...jobs.values()]
        .filter((item) =>
          item?.state === "completed" &&
          item?.result?.discovery_snapshot &&
          ["quality", "test12", "smoke", "replay"].includes(item?.mode)
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
        error: "Для Replay нужен завершённый тестовый job или сохранённый discovery snapshot"
      });
    }
    region = String(snapshot.region || sourceJob?.region || "").trim();
    data = { region, snapshot, sourceJobId: sourceJob?.id || sourceJobId || "" };
  }

  if (!region) return res.status(400).json({ error: "Регион обязателен" });

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
    async updateProgress(progress) {
      this.progress = progress;
    }
  };
  jobs.set(id, job);

  res.status(202).json({ id, region, mode });
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
          qualified_companies: job.result?.qualified_companies || [],
          replay_comparison: job.result?.replay_comparison || null,
          replay_available: Boolean(job.result?.discovery_snapshot)
        }
      : null,
    error: ["failed", "cancelled"].includes(job.state) ? job.error : null
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

  job.cancelled = true;
  job.state = "cancelling";
  if (!job.abortController?.signal?.aborted) {
    job.abortController?.abort(new Error("JOB_CANCELLED"));
  }
  res.json({ ok: true, state: "cancelling" });
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
