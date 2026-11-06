import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const app=fileURLToPath(new URL("../public/app.js",import.meta.url));
const html=fileURLToPath(new URL("../public/index.html",import.meta.url));
const source=fs.readFileSync(app,"utf8");
const markup=fs.readFileSync(html,"utf8");

test("parallel browser UI JavaScript parses and exposes separate job list",()=>{
  const parsed=spawnSync(process.execPath,["--check",app],{encoding:"utf8",timeout:10000});
  assert.equal(parsed.status,0,parsed.stderr);
  for(const id of ["jobsList","jobsSummary","selectedJob","refreshJobsBtn","etaCountdown","etaHint"]){
    assert.match(markup,new RegExp('id="'+id+'"'));
  }
  assert.match(source,/async function refreshJobs\(/);
  assert.match(source,/async function activateJob\(/);
  assert.match(source,/\/api\/jobs"/);
  assert.match(source,/setInterval\(refreshJobs,4000\)/);
  assert.match(source,/if\(requestedJobId!==currentJobId\)return/);
  assert.match(source,/e\.start\.disabled=!backendReady\|\|startRequestPending/);
  assert.match(source,/existingJobId/);
});

test("per-job stop and download refer only to selected job id",()=>{
  const cancel=source.slice(source.indexOf("async function cancel()"),source.indexOf("async function download(format"));
  const download=source.slice(source.indexOf("async function download(format"),source.indexOf("function setServiceStatus"));
  assert.match(cancel,/encodeURIComponent\(currentJobId\)/);
  assert.match(download,/encodeURIComponent\(currentJobId\)/);
});

test("ETA countdown updates once per second without triggering new API calls",()=>{
  assert.match(source,/function remainingEtaMs\(/);
  assert.match(source,/function updateEtaDisplay\(/);
  assert.match(source,/function updateJobEtaLabels\(/);
  assert.match(source,/selectedEta=d\.eta\|\|null/);
  assert.match(source,/timerTick=setInterval\(\(\)=>\{/);
  assert.match(source,/updateEtaDisplay\(\);\s*updateJobEtaLabels\(\);/);
  assert.match(source,/Пересчитываем прогноз/);
});
