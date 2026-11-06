import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadOfflineCheckpointInput } from "../src/offlineCheckpointInput.js";

test("read-only SQLite selects completed full checkpoint by ID and region", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"rr-sqlite-replay-"));
  try {
    const file=path.join(dir,"checkpoints.sqlite");
    const db=new DatabaseSync(file);
    db.exec("CREATE TABLE research_checkpoints (id TEXT PRIMARY KEY, region TEXT, mode TEXT, status TEXT, phase TEXT, pipeline_version INTEGER, payload TEXT, updated_at TEXT)");
    const insert=db.prepare("INSERT INTO research_checkpoints VALUES (?,?,?,?,?,?,?,?)");
    const payload=name=>JSON.stringify({version:1,pipeline_version:1,region:"Test region",phase:"completed",final_result:{direct_buyers:[{"Организация":name}],intermediaries:[],leasing:[]}});
    insert.run("first","Test region","full","completed","completed",1,payload("Old"),"2026-11-04");
    insert.run("second","Test region","full","completed","completed",1,payload("New"),"2026-11-05");
    insert.run("superseded","Test region","full","superseded","completed",1,payload("Discarded"),"2026-11-06");
    db.close();
    const output=loadOfflineCheckpointInput(file);
    assert.equal(output.parsed.checkpoint_id,"second");
    assert.equal(output.parsed.final_result.direct_buyers[0]["Организация"],"New");
    assert.match(output.payloadSha256,/^[a-f0-9]{64}$/);
    assert.equal(loadOfflineCheckpointInput(file,{jobId:"first",region:"Test region"}).parsed.checkpoint_id,"first");
    assert.throws(()=>loadOfflineCheckpointInput(file,{jobId:"superseded"}),/No completed/);
    assert.throws(()=>loadOfflineCheckpointInput(file,{region:"Other"}),/No completed/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test("standalone JSON remains supported", () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"rr-json-replay-"));
  try {
    const file=path.join(dir,"checkpoint.json");
    fs.writeFileSync(file,JSON.stringify({final_result:{direct_buyers:[]}}));
    assert.equal(loadOfflineCheckpointInput(file).inputKind,"json");
    assert.throws(()=>loadOfflineCheckpointInput(file,{jobId:"old"}),/require SQLite/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
