import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  auditCompletedSnapshots, outstandingCsv
} from "../scripts/audit-historical-discovery-offline.js";

const region = "Смоленская область";
const inn = "6732114166";
const verified = {
  "Организация": "ООО «Перевозчик»",
  "ИНН": inn,
  "Основание": "A — прежняя сделка",
  "__evidence": {
    identity_verification: {
      inn, source_urls: ["https://registry.example.org/" + inn]
    },
    source_urls: ["https://carrier.example.org/park"]
  }
};
const result = rows => ({
  direct_buyers: rows, intermediaries: [], leasing: [],
  qualification_review: [], qualification_excluded: []
});
const checkpoint = rows => ({
  version: 1, region, final_result: result(rows)
});

test("offline continuity audit compares latest completed snapshot against earlier runs without merging", () => {
  const snapshots = [
    {id:"new",updated_at:"2026-11-05",payload:JSON.stringify(checkpoint([]))},
    {id:"prior",updated_at:"2026-11-04",payload:JSON.stringify(checkpoint([verified]))}
  ];
  const report = auditCompletedSnapshots(snapshots,region);
  assert.equal(report.current_job_id,"new");
  assert.equal(report.history_runs_consulted.length,1);
  assert.equal(report.counts.historic_source_linked_inn,1);
  assert.equal(report.counts.not_found_in_current,1);
  assert.equal(report.entries[0].historical_inn,inn);
  assert.equal(report.extra_web_calls,0);
  assert.equal(report.auto_promoted_records,0);
  assert.equal(report.candidate_plan_offline_not_executed.planned_next_search_count,1);
});

test("CSV escapes formula injection and stores historical information as text", () => {
  const csv = outstandingCsv({entries:[
    {historical_inn:"6732114166",historical_name:"=CMD('unsafe')",
      status:"not_found_in_current",previous_grade_priority_only:"C",
      observed_in_completed_runs:1,latest_historical_job_id:"old",
      historical_identity_source_audit_only:"https://registry.example.org/item"}
  ]});
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes("\"'=CMD('unsafe')\""));
  assert.ok(csv.includes("\"6732114166\""));
});

test("CLI reads SQLite in read-only mode and emits standalone full JSON and unresolved CSV", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"coverage-offline-"));
  try {
    const database = path.join(dir,"checkpoints Russian.sqlite");
    const out = path.join(dir,"результат.json");
    const db = new DatabaseSync(database);
    db.exec("CREATE TABLE research_checkpoints (id TEXT, region TEXT, mode TEXT, status TEXT, updated_at TEXT, payload TEXT)");
    const statement = db.prepare("INSERT INTO research_checkpoints VALUES (?,?,?,?,?,?)");
    statement.run("prior",region,"full","completed","2026-11-04",JSON.stringify(checkpoint([verified])));
    statement.run("other-region","Тульская область","full","completed","2026-11-04",JSON.stringify(checkpoint([verified])));
    statement.run("new",region,"full","completed","2026-11-05",JSON.stringify(checkpoint([])));
    statement.run("unfinished",region,"full","resumable","2026-11-06",JSON.stringify(checkpoint([verified])));
    db.close();
    const output = execFileSync(process.execPath,[
      path.resolve("scripts/audit-historical-discovery-offline.js"),
      "--db",database,"--region",region,"--out",out
    ],{cwd:process.cwd(),encoding:"utf8"});
    assert.match(output,/HISTORICAL_OFFLINE_AUDIT/);
    assert.equal(fs.existsSync(out),true);
    assert.equal(fs.existsSync(out.replace(/\.json$/,"")+"_unresolved.csv"),true);
    assert.equal(fs.existsSync(out.replace(/\.json$/,"")+"_not_in_active.csv"),true);
    const report=JSON.parse(fs.readFileSync(out,"utf8"));
    assert.equal(report.current_job_id,"new");
    assert.deepEqual(report.history_runs_consulted.map(x=>x.job_id),["prior"]);
    assert.equal(report.counts.not_found_in_current,1);
    assert.equal(report.extra_web_calls,0);
    assert.equal(report.entries[0].automatically_promoted_to_crm,false);
    // Existing audit outputs are protected from silent overwrites.
    assert.throws(()=>execFileSync(process.execPath,[
      path.resolve("scripts/audit-historical-discovery-offline.js"),
      "--db",database,"--region",region,"--out",out
    ],{cwd:process.cwd(),stdio:"pipe"}));
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test("unresolved CSV excludes REVIEW and EXCLUDED; nonactive CSV retains both", () => {
  const entries = [
    {historical_inn:"6732114166",historical_name:"Активная",status:"present_active_by_inn"},
    {historical_inn:"6714048954",historical_name:"На проверке",status:"present_review_by_inn"},
    {historical_inn:"6730050615",historical_name:"Исключено",status:"present_excluded_by_inn"},
    {historical_inn:"6732056186",historical_name:"Пропущено",status:"not_found_in_current"},
    {historical_inn:"6730051753",historical_name:"Конфликт",status:"current_same_name_different_inn"}
  ];
  const unresolved = outstandingCsv({entries});
  const nonactive = outstandingCsv({entries}, "not_in_active");
  assert.equal(unresolved.split("\r\n").filter(Boolean).length, 3);
  assert.equal(nonactive.split("\r\n").filter(Boolean).length, 5);
  assert.doesNotMatch(unresolved,/На проверке|Исключено|Активная/);
  assert.match(nonactive,/На проверке|Исключено/);
  assert.throws(() => outstandingCsv({entries},"all"),/Invalid historical CSV filter/);
});
