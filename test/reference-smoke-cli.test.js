import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {fixtureResult, unwrapResult} from "../scripts/smoke-reference-xlsx.js";
const file=fileURLToPath(new URL("../scripts/smoke-reference-xlsx.js",import.meta.url));

test("offline XLSX smoke fixture provides independent fake companies for all 3 commercial sheets",()=>{
  const a=fixtureResult("A"),b=fixtureResult("B");
  for(const section of ["direct_buyers","leasing","intermediaries","statistics"])
    assert.ok(a[section].length,section);
  assert.notEqual(a.direct_buyers[0]["Организация"],b.direct_buyers[0]["Организация"]);
  assert.ok(a.direct_buyers[0].__comment);
  assert.equal(unwrapResult({final_result:a}).direct_buyers[0]["Организация"],a.direct_buyers[0]["Организация"]);
  assert.throws(()=>unwrapResult({only_audit:true}),/full result/);
});

test("offline XLSX smoke test does not instantiate OpenAI or touch checkpoints",()=>{
  const source=fs.readFileSync(file,"utf8");
  assert.match(source,/buildReferenceWorkbookBuffer/);
  assert.doesNotMatch(source,/runResearchPipeline|new OpenAI\(|saveCheckpoint|fetch\(/);
  const result=spawnSync(process.execPath,["--check",file],{encoding:"utf8",timeout:10000});
  assert.equal(result.status,0,result.stderr);
});
