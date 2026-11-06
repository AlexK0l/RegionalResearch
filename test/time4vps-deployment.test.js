import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {fileURLToPath} from "node:url";
const dir=fileURLToPath(new URL("../deploy/time4vps/",import.meta.url));
const read=name=>fs.readFileSync(dir+name,"utf8");
test("VPS service uses dedicated user; Caddy keeps backend on loopback",()=>{
  const service=read("regionalresearch.service");
  assert.match(service,/User=regionalresearch/);
  assert.match(service,/--env-file=\/opt\/regionalresearch\/.env/);
  assert.match(read("Caddyfile.example"),/reverse_proxy 127\.0\.0\.1:10000/);
});
test("VPS preflight requires secure API and Excel settings",()=>{
  const s=read("check-ready.sh");
  for(const key of ["OPENAI_API_KEY","API_ACCESS_TOKEN","BIND_HOST","127.0.0.1","SAT_reference_template.xlsx","openpyxl"])
    assert.ok(s.includes(key),key);
  assert.match(read("install.sh"),/openpyxl==3\.1\.5/);
});
test("SQLite WAL backups are consistent and integrity-checked",()=>{
  const s=read("backup_sqlite.py");
  assert.match(s,/db\.backup\(dst/);
  assert.match(s,/PRAGMA integrity_check/);
  assert.match(s,/os\.umask\(0o077\)/);
  assert.match(read("regionalresearch-backup.timer"),/Persistent=true/);
});
