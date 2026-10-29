import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import XLSX from "xlsx";

const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const url = "https://e-disclosure.azipi.ru/messages/4495353/";
const inn = "6731069440";
function company(name, extraNote) {
  return {
    "Организация": name, "ИНН": "", "Город/район": "Смоленск",
    "Основание": "B — исходный вывод", "Телефон": "",
    __canonical_id: "k" + name.length,
    __evidence: {
      source_urls: [url],
      notes: [
        "Final INN conflict: ИНН " + inn + " встретился у несовместимых сущностей и очищен до однозначного подтверждения.",
        extraNote
      ].filter(Boolean),
      identity_verification: {
        inn, method: "final_inn_web", source_urls: [url]
      }
    }
  };
}
test("offline identity recovery exports copies and leaves SQLite untouched, with no overwrite", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "regionalresearch-restored-"));
  const dataFile = path.join(dir, "saved.sqlite");
  const outputDir = path.join(dir, "copies");
  mkdirSync(outputDir);
  const db = new DatabaseSync(dataFile);
  const payload = {
    final_result: {
      direct_buyers: [
        company("АО «СпецАТХ»",
          "Final INN: АО «СпецАТХ» является сокращённым наименованием АО «Спецавтохозяйство» с ИНН 6731069440."),
        company("АО «Спецавтохозяйство»")
      ],
      intermediaries: [],
      leasing: [],
      statistics: [{ Показатель: "Население региона", Значение: "100" }]
    }
  };
  try {
    db.exec("CREATE TABLE research_checkpoints (id TEXT, region TEXT, mode TEXT, status TEXT, updated_at TEXT, payload TEXT)");
    db.prepare("INSERT INTO research_checkpoints VALUES (?, ?, ?, ?, ?, ?)").run(
      "checkpoint-1", "Смоленская область", "full", "completed",
      "2026-10-28T15:40:00Z", JSON.stringify(payload)
    );
    db.close();
    const checksum = hash(dataFile);
    const script = fileURLToPath(new URL("../scripts/recover-identity-offline.js", import.meta.url));
    const args = [script, dataFile, "--out=" + outputDir];
    const run = JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8" }));
    assert.equal(run.alias_merges, 1);
    assert.equal(run.restored_unique_inns, 1);
    assert.equal(run.after_companies, 1);
    assert.equal(run.original_database_modified, false);
    assert.equal(run.openai_calls, 0);
    assert.equal(hash(dataFile), checksum);
    for (const file of Object.values(run.outputs)) assert.equal(existsSync(file), true);
    const recovered = JSON.parse(readFileSync(run.outputs.json, "utf8"));
    assert.equal(recovered.final_result.direct_buyers[0]["ИНН"], inn);
    assert.equal(recovered.final_result.direct_buyers[0].__evidence.legal_identity_merges.length, 1);
    const workbook = XLSX.readFile(run.outputs.xlsx);
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets["Прямые покупатели"]);
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0]["ИНН"]), inn);
    assert.ok(workbook.Sheets["Офлайн восстановление"]);
    assert.ok(workbook.Sheets["Ручная проверка ИНН"]);
    assert.throws(() => execFileSync(process.execPath, args, { encoding: "utf8" }));
    assert.equal(hash(dataFile), checksum);
  } finally {
    try { db.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
