import test from "node:test";
import assert from "node:assert/strict";
import {
  FINANCE_REVENUE_FIELD as REV,
  FINANCE_EMPLOYEES_FIELD as STAFF,
  planSabyFinanceBackfill,applySabyFinanceBackfill,
  validateFinanceBackfillCheckpoint,runSabyFinanceBackfill
} from "../src/sabyFinanceBackfill.js";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import path from "node:path";
const UUID1="12345678-1234-4234-8234-123456789012";
const UUID2="12345678-1234-4234-8234-123456789013";
const UUID3="12345678-1234-4234-8234-123456789014";
const SABY="https://profile.saby.ru/page/contractor-info?id=valid-main-card";
const row=(inn="4718000935",name="Волховское, АО",revenue="",employees="")=>({
  "ИНН":inn,"Организация":name,[REV]:revenue,[STAFF]:employees,
  "Телефон":"78136349095","Наличие транспорта":"original fleet",
  "__comment":"Saved original comment",
  "__evidence":{
    source_urls:["https://evidence.example.org/source"],
    saby:{
      inn,source_url:SABY,kpp:"470201001",
      collection:{contacts:"collected",trucks:"verified",financials:"collected"},
      phones:["78136349095"],
      trucks:{source:"SABY",category:"Грузовые",status:"verified",count:1,
        vehicles:[{model:"КамАЗ 5490",year:2019}]},
      financials:{status:"collected",employees:119}
    }
  }
});
const record=(inn="4718000935",name="Волховское, АО",data={
  status:"collected",revenue_rub:440100000,revenue_year:2025,employees:119
})=>({identity:{verified:true,inn,name,kpp:"470201001"},
  source:"SABY",source_url:SABY,financials:data,
  collected_at:"2026-11-20T09:00:00.000Z"});
const result=rows=>({
  direct_buyers:rows,
  intermediaries:[],
  leasing:[],
  statistics:[],
  final_quality_gate:{ok:true}
});
const checkpoint=rows=>({
  version:1,pipeline_version:1,region:"Ленинградская область",
  source_mode:"full",phase:"completed",completed_stage:9,
  final_result:result(rows),
  saby_completed_inns:["4718000935"],
  saby_deferred_inns:[],
  contact_completed_ids:["old-contact-id"],
  contact_stats:{completed:1},priority_stats:{original:true}
});

test("candidate plan includes finished and phone-equipped firms missing only financial fields",()=>{
  const rows=[
    row(),row("7707083893","Сбербанк, ПАО",320000000,""),
    row("7812014560","Транспорт, ООО",15000000,37),
    row("5501000012","Повтор, ООО"),
    row("5501000012","Повтор филиал, ООО"),
    row("bad","Неизвестная, ООО")
  ];
  const plan=planSabyFinanceBackfill(result(rows));
  assert.equal(plan.total,6);
  assert.equal(plan.missingRevenue,4);
  assert.equal(plan.missingEmployees,5);
  assert.equal(plan.eligible.length,2);
  assert.deepEqual(plan.eligible.map(x=>x.inn),["4718000935","7707083893"]);
  assert.equal(plan.invalid,1);
  assert.equal(plan.duplicate,2);
  assert.equal(plan.alreadyComplete,1);
});

test("finance supplement adds verified integer facts without modifying contacts, fleet or pre-Saby values",()=>{
  const input=row();
  const old=structuredClone(input.__evidence.saby);
  const applied=applySabyFinanceBackfill(input,record());
  assert.equal(applied.status,"updated");
  assert.equal(applied.revenueAdded,true);
  assert.equal(applied.employeesAdded,true);
  assert.equal(input[REV],440100000);
  assert.equal(input[STAFF],119);
  assert.deepEqual(input.__evidence.saby,old);
  assert.equal(input["Телефон"],"78136349095");
  assert.equal(input["Наличие транспорта"],"original fleet");
  assert.match(input.__comment,/Saved original comment/);
  assert.match(input.__comment,/выручка 2025 г.: 440100000 руб./);
  assert.equal(input.__evidence.saby_finance_backfill.revenue_year,2025);
  assert.equal(input.__evidence.source_urls.length,2);
  const repeated=applySabyFinanceBackfill(input,record());
  assert.equal(repeated.status,"unchanged");
  assert.equal(input.__comment.split("Saby (дополнение финансов").length,2);

  const already=row("4718000935","Волховское, АО",9000000000,"");
  const staffOnly=applySabyFinanceBackfill(already,record());
  assert.equal(staffOnly.status,"updated");
  assert.equal(staffOnly.revenueAdded,false);
  assert.equal(staffOnly.employeesAdded,true);
  assert.equal(already[REV],9000000000);
  assert.equal(already[STAFF],119);
  assert.equal("revenue_rub" in already.__evidence.saby_finance_backfill,false);
});

test("wrong INN, legal name, different Saby card or invalid finance are rejected without mutation",()=>{
  const bad=[
    record("4718000936"),
    record("4718000935","Другая компания, АО"),
    {...record(),source_url:"https://evil.example.org/company?id=1"},
    {...record(),source_url:"https://profile.saby.ru/page/contractor-info?id=different-card"},
    record("4718000935","Волховское, АО",
      {status:"collected",revenue_rub:440100000,revenue_year:null,employees:null})
  ];
  for(const fact of bad){
    const input=row();
    const before=structuredClone(input);
    const response=applySabyFinanceBackfill(input,fact);
    assert.notEqual(response.status,"updated");
    assert.deepEqual(input,before);
  }
});

test("child Saby checkpoint persists after each verified company; parent remains byte-identical",async()=>{
  const parent=checkpoint([row()]);
  const before=JSON.stringify(parent);
  const versions=[];
  let collectorCalls=0,sessions=0;
  const run=await runSabyFinanceBackfill({
    checkpoint:parent,sourceJobId:UUID1,childJobId:UUID2,
    maxCompanies:1,env:{OPENAI_API_KEY:"",SABY_SMOKE_ONLY:"false"},
    sessionRunner:async task=>{sessions++;return task({page:{},settings:{}});},
    collectCompany:async (_page,target)=>{
      collectorCalls++;
      assert.equal(target["ИНН"],"4718000935");
      return record();
    },
    onCheckpoint:snapshot=>{versions.push(snapshot);}
  });
  assert.equal(collectorCalls,1);
  assert.equal(sessions,1);
  assert.equal(JSON.stringify(parent),before);
  assert.equal(versions[0].source_mode,"saby");
  assert.equal(versions[0].phase,"saby");
  assert.equal(versions.at(-1).phase,"completed");
  assert.equal(run.stats.revenueAdded,1);
  assert.equal(run.stats.employeesAdded,1);
  assert.equal(run.stats.processed,1);
  assert.equal(run.stats.unvisited,0);
  assert.equal(run.snapshot.final_result.direct_buyers[0][REV],440100000);
  assert.equal(run.snapshot.final_result.direct_buyers[0][STAFF],119);
  assert.deepEqual(run.snapshot.contact_stats,parent.contact_stats);
  assert.deepEqual(run.snapshot.saby_completed_inns,parent.saby_completed_inns);
  assert.deepEqual(run.snapshot.saby_deferred_inns,parent.saby_deferred_inns);
  assert.equal(run.snapshot.saby_finance_backfill_source_job_id,UUID1);
  assert.equal(run.snapshot.saby_finance_backfill_root_job_id,UUID1);
});

test("limited passes advance to unvisited unique INNs without re-checking already attempted firm",async()=>{
  const parent=checkpoint([
    row(),row("7707083893","Сбербанк, ПАО")
  ]);
  const calls=[];
  const options={
    checkpoint:parent,sourceJobId:UUID1,childJobId:UUID2,maxCompanies:1,
    sessionRunner:async task=>task({page:{},settings:{}}),
    collectCompany:async(_page,target)=>{
      calls.push(target["ИНН"]);
      return record(target["ИНН"],target["Организация"]);
    }
  };
  const first=await runSabyFinanceBackfill(options);
  assert.equal(first.snapshot.phase,"saby");
  assert.equal(first.stats.unvisited,1);
  const second=await runSabyFinanceBackfill({
    ...options,checkpoint:first.snapshot,sourceJobId:UUID2,childJobId:UUID3
  });
  assert.deepEqual(calls,["4718000935","7707083893"]);
  assert.equal(second.stats.unvisited,0);
  assert.equal(second.snapshot.phase,"completed");
  assert.equal(second.snapshot.saby_finance_backfill_attempted_inns.length,2);
  assert.equal(second.snapshot.saby_finance_backfill_root_job_id,UUID1);
  assert.deepEqual(parent.final_result.direct_buyers.map(x=>x[REV]),["",""]);
});

test("Saby missing report is recorded, source stays unchanged, next legal INN proceeds",async()=>{
  const first=row();
  first[STAFF]=119; // The exact case in the 2026-11-20 VPS smoke.
  const second=row("7707083893","Сбербанк, ПАО");
  const parent=checkpoint([first,second]);
  const original=JSON.stringify(parent);
  const seen=[];
  const versions=[];
  const outcome=await runSabyFinanceBackfill({
    checkpoint:parent,sourceJobId:UUID1,childJobId:UUID2,
    maxCompanies:2,env:{OPENAI_API_KEY:""},
    sessionRunner:async task=>task({page:{},settings:{}}),
    collectCompany:async (_page,target)=>{
      seen.push(target["ИНН"]);
      if(target["ИНН"]==="4718000935")
        return record(target["ИНН"],target["Организация"],
          {status:"collected",revenue_rub:null,revenue_year:null,employees:119});
      return record(target["ИНН"],target["Организация"]);
    },
    onCheckpoint:cp=>versions.push(cp)
  });
  assert.deepEqual(seen,["4718000935","7707083893"]);
  assert.equal(outcome.stats.processed,2);
  assert.equal(outcome.stats.unchanged,1);
  assert.equal(outcome.stats.unavailable,0);
  assert.equal(outcome.stats.verified,1);
  assert.equal(outcome.stats.revenueAdded,1);
  assert.equal(outcome.snapshot.saby_finance_backfill_outcomes["4718000935"].status,"unchanged");
  assert.equal(outcome.snapshot.saby_finance_backfill_outcomes["4718000935"].revenueStillMissing,true);
  assert.equal(outcome.snapshot.saby_finance_backfill_outcomes["7707083893"].status,"updated");
  assert.equal(outcome.snapshot.final_result.direct_buyers[0][REV],"");
  assert.equal(outcome.snapshot.final_result.direct_buyers[0][STAFF],119);
  assert.equal(outcome.snapshot.final_result.direct_buyers[1][REV],440100000);
  assert.equal(outcome.snapshot.phase,"completed");
  assert.equal(versions.at(-1).saby_finance_backfill_attempted_inns.length,2);
  assert.equal(JSON.stringify(parent),original);
});

test("Saby no finance widget is not mistaken for zero revenue or a hard failure",async()=>{
  const parent=checkpoint([row()]);
  const outcome=await runSabyFinanceBackfill({
    checkpoint:parent,sourceJobId:UUID1,childJobId:UUID2,
    maxCompanies:1,
    sessionRunner:async fn=>fn({page:{},settings:{}}),
    collectCompany:async()=>record("4718000935","Волховское, АО",
      {status:"missing",revenue_rub:null,revenue_year:null,employees:null})
  });
  assert.equal(outcome.stats.unavailable,1);
  assert.equal(outcome.stats.review,0);
  assert.equal(outcome.stats.browserError,"");
  assert.equal(outcome.stats.unvisited,0);
  assert.equal(outcome.snapshot.final_result.direct_buyers[0][REV],"");
  assert.equal(outcome.snapshot.saby_finance_backfill_outcomes["4718000935"].status,"missing");
  assert.equal(outcome.snapshot.saby_finance_backfill_outcomes["4718000935"].reason,"financial_not_verified");
});

test("CLI preview is explicit and error checks cannot create another DB file",()=>{
  const script=path.resolve(fileURLToPath(new URL("../scripts/saby-finance-backfill.js",import.meta.url)));
  const help=spawnSync(process.execPath,[script,"--help"],{
    encoding:"utf8",timeout:10000
  });
  assert.equal(help.status,0,help.stderr);
  assert.match(help.stdout,/READ-ONLY by default/);
  assert.match(help.stdout,/--run --limit=1/);
  const missing=spawnSync(process.execPath,[script,
    "--db=/definitely/missing/checkpoints.sqlite",
    "--region=Ленинградская область"],{
    encoding:"utf8",timeout:10000
  });
  assert.equal(missing.status,1);
  assert.match(missing.stderr,/абсолютный путь --db/);
});

test("finance-only Saby collector must stay on the verified private card ID",async()=>{
  const {sameSabyDetailId}=await import("../src/sabyBrowser.js");
  const a="https://profile.saby.ru/page/contractor-info?id=valid-id&anchor=about&local=false";
  assert.equal(sameSabyDetailId(a,
    "https://profile.saby.ru/page/contractor-info?tab=all&id=valid-id"),true);
  assert.equal(sameSabyDetailId(a,
    "https://profile.saby.ru/page/contractor-info?id=another-id"),false);
  assert.equal(sameSabyDetailId(a,
    "https://profile.saby.ru/page/company-list-prof?id=valid-id"),false);
  assert.equal(sameSabyDetailId(a,
    "https://other.example.org/page/contractor-info?id=valid-id"),false);
  assert.equal(sameSabyDetailId(a,
    "http://profile.saby.ru/page/contractor-info?id=valid-id"),false);
});

test("incomplete paid source is rejected before any Saby or SQLite side effect",()=>{
  const cp=checkpoint([]);
  cp.phase="contacts";
  assert.deepEqual(validateFinanceBackfillCheckpoint(cp),{
    ok:false,code:"FINANCE_BACKFILL_FINAL_CHECKPOINT_REQUIRED"
  });
});
