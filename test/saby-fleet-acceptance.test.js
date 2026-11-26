import test from "node:test";
import assert from "node:assert/strict";
import {auditSavedFleetCoverage,buildFleetCohort,cohortResult,
  summarizeFleetAcceptance,compareFleetAcceptance,validateFleetCohort} from "../src/sabyFleetAcceptance.js";
import {applySabyEnrichment} from "../src/sabyEnrichment.js";
const row=(inn,name)=>({"ИНН":inn,"Организация":name,"Телефон":"74951234567",
  "Электронная почта":"office@example.ru","Выручка последнего подтвержденного года":1000000,
  "Численность":12,__evidence:{notes:[],source_urls:[]}});
const a=()=>row("7707083893","ООО Альфа"),b=()=>row("7702070139","ООО Бета"),
  c=()=>row("7710140679","ООО Гамма");
const fleet=(r,vehicles)=>applySabyEnrichment(r,{
  source:"SABY",source_url:"https://profile.saby.ru/page/contractor-info?id=12345678-1234-1234-1234-123456789abc",
  identity:{verified:true,inn:r["ИНН"],name:r["Организация"],kpp:"770101001"},
  collected_at:"2026-11-26T12:00:00Z",
  trucks:{status:"verified",count:vehicles.length,vehicles}
},{transport:true});
const truck={model:"КАМАЗ 5490",year:2020};
const cp=(rows,others=[])=>({version:1,source_mode:"full",phase:"completed",region:"Карелия",
  final_result:{direct_buyers:rows,intermediaries:others,leasing:[],statistics:[]}});
const plan=(source,limit=12)=>buildFleetCohort(source,{limit,sourceId:"fixture"});
const summarize=(cohort,result,opts={})=>summarizeFleetAcceptance({cohort,result,
  outcome:{stats:{fullSweepCompleted:true,totalAttempts:3,timing:{full_searches:3}}},
  elapsedMs:10000,commit:"a".repeat(40),cohortSha:"c".repeat(64),policy:{delay:1500},...opts});
test("offline audit counts all three groups, missing/invalid separately from zero",()=>{
  const x=a(),y=b(),z=c();
  fleet(x,[truck,truck]);fleet(y,[]);
  const source=cp([x,z,row("","ООО Без ИНН")],[y]),before=structuredClone(source);
  const out=auditSavedFleetCoverage(source);
  assert.equal(out.coverage.target,4);
  assert.equal(out.coverage.positive,1);assert.equal(out.coverage.zero,1);
  assert.equal(out.coverage.unknown,2);assert.equal(out.coverage.vehicles,2);
  assert.equal(out.coverage.by_sheet.intermediaries.zero,1);
  assert.equal(out.previous_sweep.timing,null);
  assert.deepEqual(source,before);
});
test("same deterministic bounded sample includes positive controls and unresolved cases without mutating source",()=>{
  const x=a(),y=b(),z=c();
  fleet(x,[truck,truck]);fleet(y,[]);
  const source=cp([z,y,x]),before=structuredClone(source);
  const cohort=plan(source);
  assert.deepEqual(plan(source),cohort);
  assert.deepEqual(cohort.selected.map(e=>e.stratum),["positive_control","no_trusted_card","zero_control"]);
  assert.equal(cohort.selected[0].prior.count,2);
  assert.equal(cohortResult(cohort).direct_buyers[0].__evidence.saby.trucks,undefined);
  assert.equal(cohortResult(cohort).direct_buyers[0]["Наличие транспорта"],"");
  assert.deepEqual(source,before);
  assert.equal(plan(source,2).selected.length,2);
});
test("cohort refuses shared INNs across sheets, checksum errors and disputed identities",()=>{
  const x=a(),y=b(),z=c();
  const source=cp([x,y,z,row("7707083894","ООО Ошибка")],[structuredClone(y)]);
  z.__evidence.legal_identity_conflicts=[{}];
  const cohort=plan(source);
  assert.equal(cohort.selected.length,1);
  const tampered=structuredClone(cohort);tampered.selected[0].row["Организация"]="ООО Другая";
  assert.throws(()=>validateFleetCohort(tampered),/BAD_COHORT/);
});
test("paired comparison requires same cohort and settings and recognizes true coverage plus speed gains",()=>{
  const cohort=plan(cp([a(),b(),c()]));
  const old=cohortResult(cohort),next=cohortResult(cohort);
  fleet(old.direct_buyers[0],[truck,truck]);
  fleet(next.direct_buyers[0],[truck,truck]);fleet(next.direct_buyers[1],[truck]);
  const x=summarize(cohort,old),y=summarize(cohort,next,{commit:"b".repeat(40),elapsedMs:8000});
  const out=compareFleetAcceptance(x,y);
  assert.equal(out.status,"both_improved");
  assert.equal(out.gained_verified_fleets,1);assert.equal(out.speed_change_pct,20);
  assert.equal(out.candidate.vehicles,3);
  assert.throws(()=>compareFleetAcceptance(x,{...y,cohort_sha256:"d".repeat(64)}),/UNMATCHED_RUNS/);
  assert.throws(()=>compareFleetAcceptance(x,{...y,policy_sha256:"d".repeat(64)}),/UNMATCHED_RUNS/);
  assert.throws(()=>compareFleetAcceptance(x,{...y,rows:y.rows.slice(1)}),/BAD_REPORT/);
  assert.equal(compareFleetAcceptance(x,{...y,full_sweep_completed:false}).status,"incomplete_comparison");
  assert.equal(compareFleetAcceptance(x,{...y,elapsed_ms:12000}).status,"speed_not_improved");
});
test("inventory comparison preserves duplicate vehicles, is order-independent and flags model/year changes",()=>{
  const cohort=plan(cp([a()]));
  const old=cohortResult(cohort),next=cohortResult(cohort);
  const second={model:"МАЗ 5440",year:2019};
  fleet(old.direct_buyers[0],[truck,second,truck]);
  fleet(next.direct_buyers[0],[truck,truck,second]);
  const x=summarize(cohort,old),y=summarize(cohort,next,{elapsedMs:8000});
  assert.equal(compareFleetAcceptance(x,y).status,"faster_equal_verified_coverage");
  const changed=cohortResult(cohort);
  fleet(changed.direct_buyers[0],[truck,second,{...truck,year:2021}]);
  const r=compareFleetAcceptance(x,summarize(cohort,changed,{elapsedMs:7000}));
  assert.equal(r.status,"coverage_or_fact_review_required");
  assert.equal(r.inventory_changed,1);
  const missing=compareFleetAcceptance(x,summarize(cohort,cohortResult(cohort),{elapsedMs:1000}));
  assert.equal(missing.lost_verified_fleets,1);
  assert.equal(missing.status,"coverage_or_fact_review_required");
});
test("a faster fleet test cannot conceal lost contact or finance facts",()=>{
  const cohort=plan(cp([a()]));
  const old=cohortResult(cohort),next=cohortResult(cohort);
  fleet(old.direct_buyers[0],[truck]);fleet(next.direct_buyers[0],[truck]);
  next.direct_buyers[0]["Телефон"]="";next.direct_buyers[0]["Численность"]=null;
  const r=compareFleetAcceptance(summarize(cohort,old),summarize(cohort,next,{elapsedMs:2000}));
  assert.equal(r.status,"coverage_or_fact_review_required");
  assert.equal(r.contact_or_finance_loss,1);
});
