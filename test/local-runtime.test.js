import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const checkpointStore = readFileSync(new URL("../src/checkpointStore.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const fileLogger = readFileSync(new URL("../src/fileLogger.js", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("production UI contains no test controls", () => {
  for (const id of [
    "smokeBtn",
    "qualityBtn",
    "testBtn",
    "stageSelect",
    "stageBtn",
    "replayBtn",
    "dedupeReplayBtn",
    "testCompanies"
  ]) {
    assert.doesNotMatch(index, new RegExp(id));
    assert.doesNotMatch(app, new RegExp(id));
  }
});

test("local UI uses same-origin backend outside the standalone Render UI", () => {
  assert.match(app, /regionalresearch-ui\.onrender\.com/);
  assert.match(app, /:\s*"";/);
});

test("local checkpoints default to a persistent SQLite file", () => {
  assert.match(checkpointStore, /data\/checkpoints\.sqlite/);
  assert.match(checkpointStore, /DatabaseSync/);
  assert.match(checkpointStore, /journal_mode=WAL/);
});

test("jobs are routed to separate log files", () => {
  assert.match(fileLogger, /AsyncLocalStorage/);
  assert.match(fileLogger, /JOB_LOG_DIR/);
  assert.match(fileLogger, /runWithJobLog/);
  assert.match(server, /runWithJobLog\(job/);
  assert.match(server, /\/api\/jobs\/:id\/log/);
});

test("local npm command loads .env", () => {
  assert.equal(pkg.scripts.local, "node --env-file=.env server.js");
});
