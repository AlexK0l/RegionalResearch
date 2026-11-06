import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

function isSqliteFile(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(16);
    return fs.readSync(fd, head, 0, 16, 0) === 16 &&
      head.equals(Buffer.from("SQLite format 3\0", "ascii"));
  } finally { fs.closeSync(fd); }
}

export function loadOfflineCheckpointInput(sourcePath, { jobId = "", region = "" } = {}) {
  const file = path.resolve(sourcePath);
  if (!isSqliteFile(file)) {
    if (jobId || region) throw Error("--job-id/--region require SQLite");
    const raw = fs.readFileSync(file);
    return { parsed: JSON.parse(raw.toString("utf8")), inputKind: "json",
      payloadSha256: createHash("sha256").update(raw).digest("hex") };
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON");
    let sql = "SELECT id, region, pipeline_version, payload FROM research_checkpoints " +
      "WHERE mode='full' AND status='completed' AND phase='completed'";
    const params = [];
    if (region) { sql += " AND region=?"; params.push(String(region)); }
    if (jobId) { sql += " AND id=?"; params.push(String(jobId)); }
    sql += " ORDER BY updated_at DESC LIMIT 1";
    const row = db.prepare(sql).get(...params);
    if (!row) throw Error("No completed full checkpoint matches region/job ID");
    const parsed = JSON.parse(row.payload);
    if (Number(parsed.version) !== 1 ||
        Number(parsed.pipeline_version) !== Number(row.pipeline_version) ||
        String(parsed.region || "") !== String(row.region || "") ||
        parsed.phase !== "completed" || !parsed.final_result) {
      throw Error("SQLite checkpoint has inconsistent metadata or incomplete result");
    }
    return { parsed: { ...parsed, checkpoint_id: String(row.id) }, inputKind: "sqlite",
      payloadSha256: createHash("sha256").update(row.payload).digest("hex") };
  } finally { db.close(); }
}
