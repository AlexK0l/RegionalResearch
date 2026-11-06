import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildReferenceWorkbookBuffer } from "../src/referenceWorkbookExport.js";

const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");

test("browser XLSX endpoint uses strict reference exporter; no silent SheetJS fallback",()=>{
  assert.match(server,/await buildReferenceWorkbookBuffer\(result\)/);
  assert.match(server,/REFERENCE_EXPORT_FAILED/);
  const route=server.slice(server.indexOf('app.get("/api/jobs/:id/download"'),
    server.indexOf('app.get("/api/jobs/:id/download-audit"'));
  assert.doesNotMatch(route,/buildWorkbookBuffer\(/);
  assert.match(route,/status\(503\)/);
  assert.match(route,/attachment; filename/);
});

test("missing reference template is rejected before starting Python or paid research",async()=>{
  const absent=path.join(os.tmpdir(),"nonexistent-sat-style-template-"+process.pid+".xlsx");
  await assert.rejects(buildReferenceWorkbookBuffer({
    direct_buyers:[{ "Организация":"Fixture" }],intermediaries:[],leasing:[],statistics:[]
  },{templatePath:absent}),/Reference XLSX template missing/);
});

test("research queue defaults to a single active full job, preserving parallel-region isolation",()=>{
  assert.match(server,/MAX_ACTIVE_FULL_JOBS\s*=\s*Math\.max\(/);
  assert.match(server,/process\.env\.MAX_ACTIVE_FULL_JOBS \|\| 1/);
  assert.match(server,/const jobs = new Map\(\)/);
  assert.match(server,/const pendingFullJobs = \[\]/);
  assert.match(server,/while \(activeFullJobs < MAX_ACTIVE_FULL_JOBS/);
  assert.match(server,/id,\s*region,\s*mode,\s*data/);
  assert.match(server,/saveCheckpoint\(this\.id, normalized\)/);
});
