import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {fileURLToPath} from "node:url";
const dir=fileURLToPath(new URL("../deploy/time4vps/",import.meta.url));
const read=name=>fs.readFileSync(dir+name,"utf8");
test("VPS service binds reverse proxy to loopback and runs as dedicated user",()=>{
  const service=read("regionalresearch.service"),proxy=read("Caddyfile.example");
  assert.match(service,/User=regionalresearch/);
  assert.match(service,/--env-file=\/opt\/regionalresearch\/.env/);
  assert.match(proxy,/reverse_proxy 127\.0\.0\.1:10000/);
  assert.doesNotMatch(proxy,/basic_auth/);
});
test("VPS preflight enforces strong credentials, template and local bind",()=>{
  const script=read("check-ready.sh");
  for(const value of ["OPENAI_API_KEY","API_ACCESS_TOKEN","BIND_HOST","127.0.0.1","SAT_reference_template.xlsx","openpyxl"])
    assert.ok(script.includes(value),value);
  const install=read("install.sh");
  assert.match(install,/openpyxl==3\.1\.5/);
  assert.match(install,/caddy/);
  assert.doesNotMatch(install,/systemctl (enable --now|start) regionalresearch/);
});
test("WAL-safe backup uses SQLite online backup and integrity check",()=>{
  const script=read("backup_sqlite.py");
  assert.match(script,/db\.backup\(dst/);
  assert.match(script,/PRAGMA integrity_check/);
  assert.match(script,/os\.umask\(0o077\)/);
  assert.match(read("regionalresearch-backup.timer"),/Persistent=true/);
});
