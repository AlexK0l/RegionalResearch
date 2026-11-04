import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { summarizeResearchSnapshot,compareResearchSnapshots } from "../scripts/compare-research-runs-offline.js";

const empty=()=>({direct_buyers:[],intermediaries:[],leasing:[],
  qualification_review:[],qualification_excluded:[],manual_quality_archived_snapshots:[]});
const make=(id,inn,grade="C")=>({
  __canonical_id:id,"Организация":"ООО Компания "+id,"ИНН":inn,
  __final_grade:grade,__evidence:{selected_a_provenance:{
    source_url:"https://court.example.org/case",sources_rechecked:false}}
});
test("a REVIEW promotion is not a newly discovered INN identity",()=>{
  const old=empty(),current=empty();
  old.qualification_review.push(make("k1","6732114166"));
  current.direct_buyers.push(make("k1","6732114166","A"));
  const report=compareResearchSnapshots(old,current);
  assert.equal(report.delta.new_valid_inns_in_sales_not_in_any_previous_queue,0);
  assert.equal(report.delta.promoted_from_review_or_excluded_without_new_identity,1);
  assert.equal(report.after.A.selected_claim_url,1);
  assert.equal(report.after.A.source_rechecked,0);
});
test("only a genuinely absent previous INN is counted as a new legal identifier",()=>{
  const old=empty(),current=empty();
  old.direct_buyers.push(make("k1","6732114166","B"));
  current.direct_buyers.push(make("k1","6732114166","B"));
  current.direct_buyers.push(make("k2","6732132711","C"));
  const report=compareResearchSnapshots(old,current);
  assert.equal(report.delta.new_valid_inns_in_sales_not_in_any_previous_queue,1);
  assert.deepEqual(report.delta.new_valid_inns,["6732132711"]);
  assert.equal(report.delta.known_inn_identity_retention,1);
});
test("moving a legal identity to review is not presented as lost research",()=>{
  const old=empty(),current=empty();
  old.direct_buyers.push(make("k1","6732114166","A"));
  current.qualification_review.push(make("k1","6732114166"));
  const report=compareResearchSnapshots(old,current);
  assert.equal(report.delta.moved_from_sales_to_review_or_excluded,1);
  assert.equal(report.delta.new_valid_inns_in_sales_not_in_any_previous_queue,0);
});
test("missing or invalid INNs cannot inflate verified unique discovery",()=>{
  const old=empty(),current=empty();
  current.direct_buyers.push(make("k1","","B"));
  current.direct_buyers.push(make("k2","1111111111","C"));
  const report=summarizeResearchSnapshot(current);
  assert.equal(report.in_commercial.unique_valid_inns,0);
  assert.equal(report.in_commercial.missing_or_invalid_inn_rows,2);
});
test("comparison CLI writes source hashes and never overwrites existing evidence",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"rr-scorecard-"));
  try{
    const script=fileURLToPath(new URL("../scripts/compare-research-runs-offline.js",import.meta.url));
    const baseline=path.join(dir,"b.json"),candidate=path.join(dir,"c.json"),out=path.join(dir,"report.json");
    fs.writeFileSync(baseline,JSON.stringify({final_result:empty()}));
    fs.writeFileSync(candidate,JSON.stringify({final_result:empty()}));
    let run=spawnSync(process.execPath,[script,baseline,candidate,"--out="+out],{encoding:"utf8",timeout:15000});
    assert.equal(run.status,0,run.stderr);
    const stored=JSON.parse(fs.readFileSync(out));
    assert.equal(stored.inputs.length,2);
    assert.match(stored.inputs[0].sha256,/^[a-f0-9]{64}$/);
    run=spawnSync(process.execPath,[script,baseline,candidate,"--out="+out],{encoding:"utf8",timeout:15000});
    assert.notEqual(run.status,0,"CLI must refuse existing output path");
  }finally{fs.rmSync(dir,{force:true,recursive:true});}
});
