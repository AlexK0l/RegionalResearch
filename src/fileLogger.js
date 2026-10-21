import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";

const LOG_DIR = path.resolve(String(process.env.LOG_DIR || "logs"));
const JOB_LOG_DIR = path.join(LOG_DIR, "jobs");
const logContext = new AsyncLocalStorage();

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console)
};

let initialized = false;

function fileDate(value = new Date()) {
  return value.toISOString().slice(0, 10);
}

function fileTimestamp(value = new Date()) {
  return value.toISOString().replace(/[:.]/g, "-");
}

function safeSegment(value, fallback = "job") {
  const normalized = String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

function serverLogPath() {
  return path.join(LOG_DIR, `server-${fileDate()}.log`);
}

function serializeArg(value) {
  if (value instanceof Error) return value.stack || value.message || String(value);
  if (typeof value === "string") return value;
  return util.inspect(value, {
    depth: 8,
    colors: false,
    breakLength: Infinity,
    maxArrayLength: 500,
    maxStringLength: 20000
  });
}

function appendLine(filePath, level, args) {
  const line =
    `${new Date().toISOString()} [${String(level || "log").toUpperCase()}] ` +
    args.map(serializeArg).join(" ");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, line + "\n", "utf8");
}

function writeRoutedLog(level, args) {
  const context = logContext.getStore();
  const target = context?.filePath || serverLogPath();
  appendLine(target, level, args);
}

export function initializeFileLogging() {
  if (initialized) return;
  fs.mkdirSync(JOB_LOG_DIR, { recursive: true });

  for (const level of ["log", "info", "warn", "error", "debug"]) {
    console[level] = (...args) => {
      originalConsole[level](...args);
      try {
        writeRoutedLog(level, args);
      } catch (error) {
        originalConsole.error(
          "File logging failed:",
          error?.message || error
        );
      }
    };
  }

  initialized = true;
  appendLine(serverLogPath(), "info", [
    "[FILE_LOGGING_READY]",
    JSON.stringify({ log_dir: LOG_DIR, job_log_dir: JOB_LOG_DIR })
  ]);
}

export function createJobLogPath(job) {
  const region = safeSegment(job?.region || "region", "region");
  const id = safeSegment(job?.id || "job", "job");
  return path.join(
    JOB_LOG_DIR,
    `${fileTimestamp()}_${region}_${id}.log`
  );
}

export async function runWithJobLog(job, task) {
  initializeFileLogging();
  if (!job.logFile) job.logFile = createJobLogPath(job);
  fs.mkdirSync(path.dirname(job.logFile), { recursive: true });

  return logContext.run(
    {
      filePath: job.logFile,
      jobId: String(job?.id || ""),
      region: String(job?.region || "")
    },
    async () => {
      console.log("[JOB_LOG_STARTED] " + JSON.stringify({
        id: job?.id || "",
        region: job?.region || "",
        mode: job?.mode || "",
        file: path.basename(job.logFile)
      }));
      try {
        return await task();
      } finally {
        console.log("[JOB_LOG_FINISHED] " + JSON.stringify({
          id: job?.id || "",
          state: job?.state || "unknown"
        }));
      }
    }
  );
}

export function fileLoggingStatus() {
  return {
    enabled: true,
    directory: LOG_DIR,
    job_directory: JOB_LOG_DIR,
    server_log: serverLogPath()
  };
}

export function jobLogPublicInfo(job) {
  if (!job?.logFile) return null;
  return {
    filename: path.basename(job.logFile),
    relative_path: path.relative(process.cwd(), job.logFile)
  };
}

export { LOG_DIR, JOB_LOG_DIR };
