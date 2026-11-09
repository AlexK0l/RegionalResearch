import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../deploy/time4vps/backup_artifacts.py", import.meta.url));
const unit = fs.readFileSync(new URL("../deploy/time4vps/regionalresearch-artifacts-backup.service", import.meta.url), "utf8");
const timer = fs.readFileSync(new URL("../deploy/time4vps/regionalresearch-artifacts-backup.timer", import.meta.url), "utf8");

test("artifact backup service isolates files and uses a persistent timer", () => {
  assert.match(unit, /User=regionalresearch/);
  assert.match(unit, /UMask=0077/);
  assert.match(unit, /ProtectSystem=strict/);
  assert.match(unit, /ReadWritePaths=\/var\/lib\/regionalresearch\/backups/);
  assert.match(timer, /Persistent=true/);
  assert.match(timer, /OnCalendar=/);
});

test("artifact backup archives useful files, excludes live SQLite and rotates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-archive-test-"));
  try {
    const root = path.join(dir, "app");
    const dest = path.join(dir, "private-backups");
    for (const name of ["data", "exports", "logs"])
      fs.mkdirSync(path.join(root, name), {recursive:true});
    fs.writeFileSync(path.join(root, ".env"), "API_ACCESS_TOKEN=PRIVATE_SECRET\n");
    fs.writeFileSync(path.join(root, "data", "SAT_reference_template.xlsx"), "excel");
    fs.writeFileSync(path.join(root, "data", "checkpoints.sqlite"), "live db");
    fs.writeFileSync(path.join(root, "data", "checkpoints.sqlite-wal"), "live wal");
    fs.writeFileSync(path.join(root, "exports", "report.xlsx"), "report");
    fs.writeFileSync(path.join(root, "logs", "server.log"), "log");
    fs.writeFileSync(path.join(root, "SAT_Example.json"), '{"ok":true}');

    for (let i = 0; i < 3; i++) {
      const run = spawnSync("python3", [script, "--root", root,
        "--directory", dest, "--keep", "2"], {encoding:"utf8"});
      assert.equal(run.status, 0, run.stderr + run.stdout);
    }
    const archives = fs.readdirSync(dest).filter(n => n.endsWith(".tar.gz"));
    assert.equal(archives.length, 2, "old daily copies must be rotated");
    // POSIX mode bits are not portable: Windows reports synthetic permissions.
    if (process.platform !== "win32")
      assert.equal(fs.statSync(dest).mode & 0o077, 0, "backup directory must be private");
    const output = spawnSync("python3", ["-c",
      "import json,sys,tarfile; a=tarfile.open(sys.argv[1]); print(json.dumps(sorted(a.getnames())))",
      path.join(dest, archives[0])], {encoding:"utf8"});
    assert.equal(output.status, 0, output.stderr);
    const files = JSON.parse(output.stdout);
    for (const name of [".env", "data/SAT_reference_template.xlsx",
      "exports/report.xlsx", "logs/server.log", "SAT_Example.json"])
      assert.ok(files.includes(name), name);
    assert.ok(!files.includes("data/checkpoints.sqlite"));
    assert.ok(!files.includes("data/checkpoints.sqlite-wal"));
  } finally {
    fs.rmSync(dir, {recursive:true, force:true});
  }
});
