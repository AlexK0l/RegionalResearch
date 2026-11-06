import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

test("identity checkpoint replay is read-only and recovers only source-attested aliases", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "regionalresearch-identity-"));
  const sqliteFile = path.join(dir, "checkpoint.sqlite");
  const db = new DatabaseSync(sqliteFile);
  const inn = "6731069440", shared = "https://e-disclosure.azipi.ru/messages/4495353/";
  const sample = (name, note) => ({
    row: {
      "Организация": name, "ИНН": "",
      __evidence: {
        notes: [note, "Final INN conflict: ИНН " + inn + " встретился у несовместимых сущностей и очищен до однозначного подтверждения."],
        source_urls: [shared],
        identity_verification: { inn, method: "final_inn_web", source_urls: [shared] }
      }
    }
  });
  const checkpoint = {
    deduped_records: [
      sample("АО «СпецАТХ»", "Final INN: АО «СпецАТХ» является сокращённым наименованием АО «Спецавтохозяйство» с подтверждённым ИНН 6731069440."),
      sample("АО «Спецавтохозяйство»", "Final INN: ИНН подтверждён для АО «Спецавтохозяйство».")
    ]
  };
  try {
    db.exec("CREATE TABLE research_checkpoints (id TEXT, region TEXT, mode TEXT, status TEXT, updated_at TEXT, payload TEXT)");
    db.prepare("INSERT INTO research_checkpoints VALUES (?, ?, ?, ?, ?, ?)").run(
      "test-checkpoint", "Смоленская область", "full", "completed", "2026-10-28T15:40:00.000Z", JSON.stringify(checkpoint)
    );
    db.close();
    const output = execFileSync(process.execPath, [
      fileURLToPath(new URL("../scripts/replay-identity-offline.js", import.meta.url)),
      sqliteFile
    ], { encoding: "utf8" });
    const report = JSON.parse(output);
    assert.equal(report.original_contested_inns, 1);
    assert.equal(report.potential_alias_merges, 1);
    assert.equal(report.groups_still_requiring_review, 0);
    assert.equal(report.details[0].status, "merge_candidate");
    const ro = new DatabaseSync(sqliteFile, { readOnly: true });
    try {
      const after = JSON.parse(ro.prepare("SELECT payload FROM research_checkpoints").get().payload);
      assert.equal(after.deduped_records[0].row["ИНН"], "");
      assert.equal(after.deduped_records[1].row["ИНН"], "");
    } finally {
      ro.close();
    }
  } finally {
    try { db.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
