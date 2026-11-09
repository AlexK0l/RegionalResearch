import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const script = fileURLToPath(new URL("../deploy/time4vps/backup_sqlite.py", import.meta.url));

test("daily SQLite backup includes uncheckpointed WAL and leaves a standalone verified file", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rr-wal-backup-test-"));
  try {
    const code = String.raw`
import pathlib
import sqlite3
import subprocess
import sys

root = pathlib.Path(sys.argv[1])
source = root / "checkpoint.sqlite"
out = root / "backups"
out.mkdir()
db = sqlite3.connect(source)
assert db.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
db.execute("PRAGMA wal_autocheckpoint=0")
db.execute("CREATE TABLE checkpoint (id INTEGER PRIMARY KEY, payload TEXT)")
db.executemany("INSERT INTO checkpoint(payload) VALUES (?)", [(str(n),) for n in range(1000)])
db.commit()
wal = pathlib.Path(str(source) + "-wal")
assert wal.is_file() and wal.stat().st_size > 0
subprocess.run([sys.executable, sys.argv[2], "--source", str(source),
                "--directory", str(out), "--keep", "2"], check=True)
backups = list(out.glob("checkpoints-*.sqlite"))
assert len(backups) == 1, backups
assert sorted(p.name for p in out.iterdir()) == [backups[0].name]
with sqlite3.connect(backups[0]) as verify:
    assert verify.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
    assert verify.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert verify.execute("SELECT COUNT(*) FROM checkpoint").fetchone()[0] == 1000
db.close()
`;
    const run = spawnSync("python3", ["-c", code, root, script],
                          {encoding:"utf8", timeout:30000});
    assert.equal(run.status, 0, run.stderr + run.stdout);
  } finally {
    rmSync(root, {recursive:true, force:true});
  }
});
