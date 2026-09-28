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

app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "sat-region-research" });
});

app.get("/api/config", (_req, res) => {
  res.json({ steps: STEPS });
});

app.post("/api/jobs", async (req, res) => {
  const region = String(req.body?.region || "").trim();
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();

  if (!region) return res.status(400).json({ error: "Регион обязателен" });
  if (!apiKey) return res.status(503).json({ error: "OPENAI_API_KEY не настроен на Render" });

  const id = crypto.randomUUID();
  const job = {
    id,
    region,
    state: "waiting",
    progress: {},
    result: null,
    error: null,
    cancelled: false,
    createdAt: Date.now(),
    async updateProgress(progress) {
      this.progress = progress;
    }
  };
  jobs.set(id, job);

  res.status(202).json({ id, region });

  queueMicrotask(async () => {
    job.state = "active";
    try {
      const output = await runResearchPipeline({ job, apiKey });
      if (job.cancelled) throw new Error("JOB_CANCELLED");
      job.result = output;
      job.state = "completed";
    } catch (error) {
      if (error?.message === "JOB_CANCELLED") {
        job.state = "cancelled";
        job.error = "Остановлено пользователем";
      } else {
        job.state = "failed";
        job.error = error?.message || "Ошибка выполнения";
        console.error(error);
      }
    }
  });
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
          contacts: job.result?.contacts
        }
      : null,
    error: ["failed", "cancelled"].includes(job.state) ? job.error : null
  });
});

app.post("/api/jobs/:id/cancel", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Задание не найдено" });

  job.cancelled = true;
  res.json({ ok: true });
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
