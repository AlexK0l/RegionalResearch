import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {preparePersistedCheckpointExport}
  from "../src/persistedCheckpointExport.js";

const row=(name,inn)=>({
  "Организация":name,"ИНН":inn,"Основание":"C — целевой грузопоток",
  "Наличие транспорта":"","Телефон":"","Электронная почта":"",
  __evidence:{source_urls:[],notes:[]},__final_grade:"C"
});
const base=()=>({
  region:"Ленинградская область",
  final_result:{
    direct_buyers:[row("АО Тест","7707083893")],
    intermediaries:[],leasing:[],statistics:[],
    final_quality_gate:{active_commercial_records:1,grades:{A:0,B:0,C:1}}
  },
  final_quality_gate:{active_commercial_records:1,grades:{A:0,B:0,C:1}}
});

test("full completed checkpoint exports read-only, identical commercial records",()=>{
  const cp={...base(),source_mode:"full",phase:"completed"};
  const snapshot=structuredClone(cp);
  const out=preparePersistedCheckpointExport(cp);
  assert.equal(out.region,"Ленинградская область");
  assert.equal(out.checkpoint_phase,"completed");
  assert.equal(out.partial_saby,false);
  assert.deepEqual(out.final_result,cp.final_result);
  assert.notStrictEqual(out.final_result,cp.final_result);
  assert.deepEqual(cp,snapshot);
});

test("paused Saby child produces current rescored result, leaves SQLite source untouched",()=>{
  const cp={...base(),source_mode:"saby",phase:"saby",
    saby_stats:{processed:2,deferred:1,circuitOpen:true}};
  cp.final_result.direct_buyers[0]["Наличие транспорта"]=
    "Saby (грузовые): KAMAZ 5490 (2020 г.) — 1 шт.";
  const snapshot=structuredClone(cp);
  const out=preparePersistedCheckpointExport(cp);
  assert.equal(out.partial_saby,true);
  assert.equal(out.checkpoint_phase,"saby");
  assert.deepEqual(out.saby_stats,cp.saby_stats);
  assert.equal(out.final_result.direct_buyers.length,1);
  assert.equal(typeof out.final_result.direct_buyers[0]["Итоговый коэффициент"],"number");
  assert.deepEqual(cp,snapshot);
});

test("crashed-after-priority full checkpoint is strictly reconstructed without writes",()=>{
  const cp={...base(),source_mode:"full",phase:"priority",
    version:1,pipeline_version:1,
    contact_stats:{total:1,ok:0},
    saby_stats:{enabled:true,processed:1},
    priority_ai_stats:{calls:0,classified:0,cached:0,deferred:0,
      stopped_reason:""}};
  const snapshot=structuredClone(cp);
  const out=preparePersistedCheckpointExport(cp);
  assert.equal(out.checkpoint_phase,"priority");
  assert.equal(out.partial_saby,false);
  assert.equal(out.final_result.direct_buyers.length,1);
  assert.equal(typeof out.final_result.direct_buyers[0]["Итоговый коэффициент"],"number");
  assert.deepEqual(out.final_quality_gate,cp.final_quality_gate);
  assert.deepEqual(cp,snapshot);
});

test("incomplete or early full checkpoints cannot be advertised as downloadable",()=>{
  for(const phase of ["research","final_inn","contacts","saby"]){
    assert.throws(()=>preparePersistedCheckpointExport({
      ...base(),phase,source_mode:"full"
    }),/CHECKPOINT_NOT_READY_FOR_EXPORT/);
  }
  assert.throws(()=>preparePersistedCheckpointExport({
    ...base(),source_mode:"saby",phase:"priority"
  }),/CHECKPOINT_NOT_READY_FOR_EXPORT/);
  assert.throws(()=>preparePersistedCheckpointExport({
    ...base(),source_mode:"saby",phase:"completed",
    final_result:{direct_buyers:[],intermediaries:[]}
  }),/CHECKPOINT_RESULT_INCOMPLETE/);
});

test("public browser UI compiles and offers saved results from authorized SQLite APIs",()=>{
  const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
  const ui=fs.readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
  const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
  execFileSync(process.execPath,["--check",
    fileURLToPath(new URL("../public/app.js",import.meta.url))],{stdio:"pipe"});
  assert.ok(server.indexOf('app.use("/api",')<
    server.indexOf('app.get("/api/checkpoints/:id/download"'));
  assert.match(server,/preparePersistedCheckpointExport\(checkpoint\)/);
  assert.match(server,/await loadCheckpoint\(id\)/);
  assert.match(server,/app\.get\("\/api\/checkpoints\/:id\/download-json"/);
  assert.match(ui,/savedCheckpointDownloadId\(\)/);
  assert.match(ui,/downloadSaved\("xlsx"\)/);
  assert.match(ui,/downloadSaved\("json"\)/);
  assert.match(ui,/saby_paused/);
  assert.match(html,/id="savedXlsxBtn"/);
  assert.match(html,/id="savedJsonBtn"/);
  assert.match(html,/id="resultTitle"/);
});
