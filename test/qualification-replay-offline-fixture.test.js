import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import XLSX from "xlsx";

const current = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(current, "../scripts/replay-checkpoint-qualification.js");

const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function fakeRow(name, notes, { inn = "", urls = ["https://example.org/transport"], lastGrade = "" } = {}) {
  return {
    "Организация": name,
    "Город/район": "Смоленская область",
    "ИНН": inn,
    "Техника/сегмент": "Автомобильный грузовой транспорт",
    "Основание": "",
    "__canonical_id": name,
    "__final_grade": lastGrade,
    "__full_field_probe": "intact_for_restoration",
    "__evidence": { source_urls: urls, notes }
  };
}

test("offline checkpoint replay preserves full unqualified leads, without sqlite writes or network", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "regionalresearch-qualification-replay-"));
  const dbPath = path.join(dir, "checkpoints.sqlite");
  const outDir = path.join(dir, "audit");
  const id = "d22c925b-dc87-40c7-9291-37bd2f42f688";
  const rows = {
    direct_buyers: [
      fakeRow("ООО «Русавлогистик»",
        ["Компания занимается автомобильными грузоперевозками; состав полуприцепов не установлен."],
        { inn: "6732040299", lastGrade: "C" }),
      fakeRow("ООО «Подтвержденный перевозчик»",
        ["Компания эксплуатирует собственный парк седельных тягачей с полуприцепами Schmitz."],
        { lastGrade: "A" }),
      fakeRow("ФГБУК «Хмелита»", ["Приобретен прицеп Тонар для перевозки щебня."],
        { lastGrade: "A" }),
      fakeRow("ООО «Неизвестное объявление»",
        ["Компания предлагает услуги грузоперевозок."],
        { urls: [], lastGrade: "C" })
    ],
    intermediaries: [], leasing: [], statistics: []
  };
  const sqlite = new DatabaseSync(dbPath);
  try {
    sqlite.exec("CREATE TABLE research_checkpoints (id TEXT PRIMARY KEY, region TEXT, mode TEXT, status TEXT, payload TEXT, updated_at TEXT)");
    sqlite.prepare("INSERT INTO research_checkpoints (id, region, mode, status, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      id, "Смоленская область", "full", "completed",
      JSON.stringify({ final_result: rows }), "2026-10-29T10:00:00Z"
    );
  } finally { sqlite.close(); }
  const before = hash(dbPath);
  try {
    const run = spawnSync(process.execPath,
      [script, dbPath, "--checkpoint=" + id, "--out=" + outDir],
      { encoding: "utf8", timeout: 45000, maxBuffer: 5_000_000 });
    assert.equal(run.status, 0, "Replay CLI failed: " + (run.stderr || run.stdout));
    assert.equal(hash(dbPath), before, "Source SQLite must not change");
    const prefix = "qualification_replay_" + id.slice(0, 8);
    const audit = JSON.parse(fs.readFileSync(path.join(outDir, prefix + ".json"), "utf8"));
    assert.equal(audit.openai_calls, 0);
    assert.equal(audit.counts.input, 4);
    assert.equal(audit.counts.review_queue_candidates, 1);
    assert.equal(audit.counts.excluded_without_review, 2);
    assert.equal(audit.review_queue.length, 1);
    assert.equal(audit.rows.find((r) => r.organization === "ООО «Русавлогистик»").qualification_status, "REVIEW");
    assert.equal(audit.rows.find((r) => r.organization === "ФГБУК «Хмелита»").qualification_status, "EXCLUDED");
    const original = audit.review_queue[0];
    assert.equal(original.row["Организация"], "ООО «Русавлогистик»");
    assert.equal(original.row["ИНН"], "6732040299");
    assert.equal(original.row.__full_field_probe, "intact_for_restoration");
    assert.ok(original.row.__evidence.notes[0].includes("грузоперевозками"));
    assert.equal(audit.rows.some((r) => r.organization.includes("Хмелита") && r.review_queue_candidate), false);
    assert.equal(audit.rows.some((r) => r.organization.includes("Неизвестное объявление") && r.review_queue_candidate), false);
    const workbook = XLSX.readFile(path.join(outDir, prefix + ".xlsx"));
    assert.ok(workbook.SheetNames.includes("Очередь сохранения"));
    const all = XLSX.utils.sheet_to_json(workbook.Sheets["Все компании"]);
    assert.equal(all.find((r) => r["Организация"] === "ООО «Русавлогистик»")["Новый класс"], "REVIEW");
    assert.equal(all.find((r) => r["Организация"] === "ФГБУК «Хмелита»")["Новый класс"], "ИСКЛЮЧЕНО");
    const saved = XLSX.utils.sheet_to_json(workbook.Sheets["Очередь сохранения"]);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]["Организация"], "ООО «Русавлогистик»");

    const repeated = spawnSync(process.execPath,
      [script, dbPath, "--checkpoint=" + id, "--out=" + outDir],
      { encoding: "utf8", timeout: 45000, maxBuffer: 5_000_000 });
    assert.notEqual(repeated.status, 0, "Replay must not overwrite an earlier report");
    assert.equal(hash(dbPath), before, "SQLite still unchanged after refused overwrite");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
