import test from "node:test";
import assert from "node:assert/strict";
import {
  FINANCE_REVENUE_FIELD as REV,
  FINANCE_EMPLOYEES_FIELD as STAFF,
  planSabyFinanceBackfill,applySabyFinanceBackfill,
  validateFinanceBackfillCheckpoint,runSabyFinanceBackfill,
  recoverLegacyFinanceReview,classifySabyFinanceFailure,
  verifiedSabyFinanceFromSmoke,
  selectSabyFinanceSearchCanary,verifySabyFinanceSearchCanary
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
  const seen=[],pauses=[];
  const versions=[];
  const outcome=await runSabyFinanceBackfill({
    checkpoint:parent,sourceJobId:UUID1,childJobId:UUID2,
    maxCompanies:2,env:{OPENAI_API_KEY:""},
    waitBetweenCompanies:async ms=>pauses.push(ms),
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
  assert.deepEqual(pauses,[1500]);
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

test("targeted Saby recovery selects a known eligible INN, not the first queue item",async()=>{
  const parent=checkpoint([
    row("7707083893","Сбербанк, ПАО"),
    row("4718000935","Волховское, АО","",119)
  ]);
  parent.saby_finance_backfill_attempted_inns=["7707083893"];
  const original=JSON.stringify(parent);
  let seen="";
  const out=await runSabyFinanceBackfill({
    checkpoint:parent,sourceJobId:UUID1,childJobId:UUID2,maxCompanies:1,
    targetInn:"4718000935",
    sessionRunner:async task=>task({page:{},settings:{}}),
    collectCompany:async(_page,source)=>{
      seen=source["ИНН"];
      return record();
    }
  });
  assert.equal(seen,"4718000935");
  assert.equal(out.stats.revenueAdded,1);
  assert.equal(out.stats.employeesAdded,0);
  assert.equal(out.snapshot.final_result.direct_buyers[1][REV],440100000);
  assert.equal(out.snapshot.final_result.direct_buyers[1][STAFF],119);
  assert.deepEqual(out.snapshot.saby_finance_backfill_attempted_inns,
    ["7707083893","4718000935"]);
  assert.equal(JSON.stringify(parent),original);
  await assert.rejects(
    runSabyFinanceBackfill({
      checkpoint:parent,sourceJobId:UUID1,childJobId:UUID2,
      maxCompanies:1,targetInn:"7707083893",
      sessionRunner:()=>{throw Error("Must not be called");}
    }),/TARGET_NOT_ELIGIBLE_OR_ALREADY_ATTEMPTED/);
});

test("CLI preview is explicit and error checks cannot create another DB file",()=>{
  const script=path.resolve(fileURLToPath(new URL("../scripts/saby-finance-backfill.js",import.meta.url)));
  const help=spawnSync(process.execPath,[script,"--help"],{
    encoding:"utf8",timeout:10000
  });
  assert.equal(help.status,0,help.stderr);
  assert.match(help.stdout,/READ-ONLY by default/);
  assert.match(help.stdout,/--run --limit=1/);
  assert.match(help.stdout,/--target-inn=4718000935/);
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

function safeSabyFailure(code,scope="company"){
  const error=new Error("Private Playwright error must never be logged");
  error.code=code;
  error.scope=scope;
  return error;
}

test("temporary Saby search miss is retried once, then verified finance is saved",async()=>{
  const parent=checkpoint([row("4718000935","Волховское, АО","",119)]);
  let calls=0;
  const pauses=[];
  const initial=JSON.stringify(parent);
  const out=await runSabyFinanceBackfill({
    checkpoint:parent,sourceJobId:UUID1,childJobId:UUID2,maxCompanies:1,
    waitBetweenCompanies:async ms=>pauses.push(ms),
    sessionRunner:async fn=>fn({page:{},settings:{delayMs:800}}),
    collectCompany:async()=>{
      if(++calls===1)throw safeSabyFailure("search_no_unique_result");
      return record();
    }
  });
  assert.equal(calls,2);
  assert.deepEqual(pauses,[800]);
  assert.equal(out.stats.retries,1);
  assert.equal(out.stats.processed,1);
  assert.equal(out.stats.review,0);
  assert.equal(out.stats.revenueAdded,1);
  assert.deepEqual(out.snapshot.saby_finance_backfill_attempted_inns,
    ["4718000935"]);
  assert.equal(out.snapshot.final_result.direct_buyers[0][REV],440100000);
  assert.equal(out.snapshot.phase,"completed");
  assert.equal(JSON.stringify(parent),initial);
});

test("two failed card verifications do not consume the INN; one later run remains possible",async()=>{
  const parent=checkpoint([row()]);
  const original=JSON.stringify(parent);
  let calls=0;
  const run={
    sessionRunner:async task=>task({page:{},settings:{delayMs:250}}),
    collectCompany:async()=>{
      calls++;
      throw safeSabyFailure("card_render_timeout");
    },
    waitBetweenCompanies:async()=>{}
  };
  const first=await runSabyFinanceBackfill({
    ...run,checkpoint:parent,sourceJobId:UUID1,childJobId:UUID2,
    maxCompanies:1
  });
  assert.equal(first.stats.retries,1);
  assert.equal(first.stats.review,1);
  assert.equal(first.stats.processed,1);
  assert.equal(first.stats.unvisited,1);
  assert.equal(first.stats.reviewRetryable,1);
  assert.equal(first.stats.reviewExhausted,0);
  assert.equal(first.snapshot.saby_finance_backfill_attempted_inns.length,0);
  assert.equal(first.snapshot.saby_finance_backfill_review_attempts["4718000935"],1);
  assert.equal(first.snapshot.saby_finance_backfill_outcomes["4718000935"].reason,
    "card_render_timeout");
  assert.equal(first.snapshot.phase,"saby");

  const second=await runSabyFinanceBackfill({
    ...run,checkpoint:first.snapshot,sourceJobId:UUID2,childJobId:UUID3,
    maxCompanies:1
  });
  assert.equal(second.stats.retries,1);
  assert.equal(second.stats.unvisited,0);
  assert.equal(second.stats.reviewExhausted,1);
  assert.equal(second.snapshot.saby_finance_backfill_review_attempts["4718000935"],2);
  assert.equal(second.snapshot.saby_finance_backfill_attempted_inns.length,0);
  assert.equal(second.snapshot.phase,"saby",
    "review exhaustion cannot be falsely labeled completed");
  assert.equal(calls,4);

  let unexpected=0;
  const third=await runSabyFinanceBackfill({
    ...run,checkpoint:second.snapshot,sourceJobId:UUID3,
    childJobId:"12345678-1234-4234-8234-123456789015",
    collectCompany:async()=>{unexpected++;throw Error("unexpected");}
  });
  assert.equal(third.stats.scheduled,0);
  assert.equal(unexpected,0);
  assert.equal(third.stats.reviewExhausted,1);
  assert.equal(third.snapshot.phase,"saby");
  assert.equal(JSON.stringify(parent),original);
});

test("fully rendered legal-name mismatch is not retried in the same Saby session",async()=>{
  const parent=checkpoint([
    row("4718000935","Волховское, АО"),
    row("7707083893","Сбербанк, ПАО")
  ]);
  const before=JSON.stringify(parent);
  const calls=[];
  const out=await runSabyFinanceBackfill({
    checkpoint:parent,sourceJobId:UUID1,childJobId:UUID2,
    maxCompanies:2,
    sessionRunner:async fn=>fn({page:{},settings:{delayMs:250}}),
    waitBetweenCompanies:async()=>{},
    collectCompany:async(_page,subject)=>{
      calls.push(subject["ИНН"]);
      if(subject["ИНН"]==="4718000935")
        throw safeSabyFailure("card_legal_name_unverified","company");
      return record(subject["ИНН"],subject["Организация"]);
    }
  });
  assert.deepEqual(calls,["4718000935","7707083893"],
    "no duplicate Saby search for an already rendered but unverified alias");
  assert.equal(out.stats.retries,0);
  assert.equal(out.stats.review,1);
  assert.equal(out.stats.reviewRetryable,1);
  assert.equal(out.stats.reviewExhausted,0);
  assert.equal(out.stats.processed,2);
  assert.equal(out.stats.revenueAdded,1);
  assert.equal(out.stats.employeesAdded,1);
  assert.equal(out.stats.unvisited,1);
  assert.equal(out.stats.browserError,"");
  assert.equal(out.snapshot.saby_finance_backfill_review_attempts["4718000935"],1);
  assert.equal(out.snapshot.saby_finance_backfill_outcomes["4718000935"].reason,
    "card_legal_name_unverified");
  assert.deepEqual(out.snapshot.saby_finance_backfill_attempted_inns,
    ["7707083893"]);
  assert.equal(out.snapshot.final_result.direct_buyers[0][REV],"");
  assert.equal(JSON.stringify(parent),before);
  assert.deepEqual(classifySabyFinanceFailure(
    safeSabyFailure("card_legal_name_unverified")),
    {code:"card_legal_name_unverified",retryable:false});
});

test("cross-card identity warning never triggers an automatic retry or claims success",async()=>{
  const parent=checkpoint([row()]);
  let count=0;
  const out=await runSabyFinanceBackfill({
    checkpoint:parent,sourceJobId:UUID1,childJobId:UUID2,
    sessionRunner:async fn=>fn({page:{},settings:{}}),
    collectCompany:async()=>{
      count++;
      throw safeSabyFailure("card_changed");
    }
  });
  assert.equal(count,1);
  assert.equal(out.stats.retries,0);
  assert.equal(out.stats.reviewExhausted,1);
  assert.deepEqual(out.snapshot.saby_finance_backfill_attempted_inns,[]);
  assert.equal(out.snapshot.saby_finance_backfill_outcomes["4718000935"].reason,
    "card_changed");
  assert.equal(out.snapshot.final_result.direct_buyers[0][REV],"");
});

test("systemic Saby search scanner failure pauses the batch, not mark other firms reviewed",async()=>{
  const parent=checkpoint([row(),row("7707083893","Сбербанк, ПАО")]);
  let count=0;
  const out=await runSabyFinanceBackfill({
    checkpoint:parent,sourceJobId:UUID1,childJobId:UUID2,maxCompanies:2,
    sessionRunner:async task=>task({page:{},settings:{}}),
    waitBetweenCompanies:async()=>{},
    collectCompany:async()=>{
      count++;
      throw safeSabyFailure("search_scan_error","systemic");
    }
  });
  assert.equal(count,2,"one bounded immediate retry only");
  assert.equal(out.stats.retries,1);
  assert.equal(out.stats.processed,0);
  assert.equal(out.stats.review,0);
  assert.equal(out.stats.browserError,"saby_search_unavailable");
  assert.equal(out.stats.unvisited,2);
  assert.deepEqual(out.snapshot.saby_finance_backfill_attempted_inns,[]);
  assert.equal(out.snapshot.phase,"saby");
});

test("three consecutive non-retryable identity failures stop a large finance batch",async()=>{
  const parent=checkpoint([
    row(),row("7707083893","Сбербанк, ПАО"),
    row("7801014560","Транспорт, ООО"),
    row("7812019999","Логистика, ООО")
  ]);
  let calls=0;
  const out=await runSabyFinanceBackfill({
    checkpoint:parent,sourceJobId:UUID1,childJobId:UUID2,maxCompanies:4,
    sessionRunner:async fn=>fn({page:{},settings:{}}),
    waitBetweenCompanies:async()=>{},
    collectCompany:async()=>{
      calls++;
      throw safeSabyFailure("search_ambiguous");
    }
  });
  assert.equal(calls,3);
  assert.equal(out.stats.browserError,"saby_consecutive_unverified_cards");
  assert.equal(out.stats.processed,3);
  assert.equal(out.stats.reviewExhausted,3);
  assert.equal(out.stats.unvisited,1);
  assert.equal(out.snapshot.phase,"saby");
  assert.deepEqual(out.snapshot.saby_finance_backfill_attempted_inns,[]);
});

test("legacy one-card review is recovered for another bounded pass without changing persisted source",()=>{
  const parent=checkpoint([row("4718000935","Волховское, АО","",119)]);
  const child={...structuredClone(parent),source_mode:"saby",phase:"saby",
    saby_finance_backfill_source_job_id:UUID1,
    saby_finance_backfill_attempted_inns:["4718000935"],
    saby_finance_backfill_stats:{processed:1,review:1,revenueAdded:0,
      employeesAdded:0,unavailable:0,verified:0}
  };
  const before=JSON.stringify(child);
  const restored=recoverLegacyFinanceReview(child,{...parent,id:UUID1});
  assert.equal(restored.recovered,1);
  assert.deepEqual(restored.checkpoint.saby_finance_backfill_attempted_inns,[]);
  assert.equal(restored.checkpoint.saby_finance_backfill_review_attempts["4718000935"],1);
  assert.equal(restored.checkpoint.saby_finance_backfill_outcomes["4718000935"].status,"review");
  assert.equal(restored.checkpoint.final_result.direct_buyers[0][REV],"");
  assert.equal(JSON.stringify(child),before);
  assert.equal(recoverLegacyFinanceReview(child,{...parent,id:UUID3}).recovered,0);
  assert.equal(recoverLegacyFinanceReview({...child,
    saby_finance_backfill_stats:{...child.saby_finance_backfill_stats,processed:2}},
    {...parent,id:UUID1}).recovered,0);
  const reviewed={...child,
    saby_finance_backfill_outcomes:{"4718000935":{
      status:"review",reason:"collector_unavailable"
    }}};
  const recoveredReview=recoverLegacyFinanceReview(reviewed,
    {...parent,id:UUID1});
  assert.equal(recoveredReview.recovered,1);
  assert.equal(recoveredReview.checkpoint.saby_finance_backfill_outcomes["4718000935"].reason,
    "collector_unavailable");
  assert.equal(recoverLegacyFinanceReview({...child,
    saby_finance_backfill_outcomes:{"4718000935":{status:"updated"}}},
    {...parent,id:UUID1}).recovered,0);
});

test("finance search errors are classified without leaking private error messages",()=>{
  assert.deepEqual(classifySabyFinanceFailure(
    safeSabyFailure("search_no_unique_result")),{code:"search_no_unique_result",retryable:true});
  assert.deepEqual(classifySabyFinanceFailure(
    safeSabyFailure("search_ambiguous")),{code:"search_ambiguous",retryable:false});
  assert.deepEqual(classifySabyFinanceFailure(
    Object.assign(new Error("Private URL embedded"),{name:"TimeoutError"})),
    {code:"browser_action_timeout",retryable:true});
  assert.deepEqual(classifySabyFinanceFailure(new Error("Private URL embedded")),
    {code:"collector_unavailable",retryable:false});
});

test("saved Saby finance card is a strict navigation hint, not accepted identity",async()=>{
  const {savedSabyFinanceCardUrl}=await import("../src/sabyBrowser.js");
  const approved="https://profile.saby.ru/page/contractor-info?anchor=about&"+
    "tab=all&page=public&local=false&id=7f794800-63b5-11e0-adec-00c30e012283";
  const allowed=row();
  allowed.__evidence.saby.source_url=approved;
  allowed.__evidence.saby.verified_at="2026-11-20T08:50:02.150Z";
  assert.equal(savedSabyFinanceCardUrl(allowed),approved);
  const wrongInn=structuredClone(allowed);
  wrongInn.__evidence.saby.inn="4718000936";
  assert.equal(savedSabyFinanceCardUrl(wrongInn),null);
  const oldUnverified=structuredClone(allowed);
  delete oldUnverified.__evidence.saby.verified_at;
  assert.equal(savedSabyFinanceCardUrl(oldUnverified),null);
  const badUrl=structuredClone(allowed);
  badUrl.__evidence.saby.source_url=
    "https://other.example.org/page/contractor-info?id=7f794800-63b5-11e0-adec-00c30e012283";
  assert.equal(savedSabyFinanceCardUrl(badUrl),null);
  badUrl.__evidence.saby.source_url=
    "http://profile.saby.ru/page/contractor-info?id=7f794800-63b5-11e0-adec-00c30e012283";
  assert.equal(savedSabyFinanceCardUrl(badUrl),null);
  badUrl.__evidence.saby.source_url=
    "https://profile.saby.ru/page/company-list-prof?id=7f794800-63b5-11e0-adec-00c30e012283";
  assert.equal(savedSabyFinanceCardUrl(badUrl),null);
  badUrl.__evidence.saby.source_url=
    "https://profile.saby.ru/page/contractor-info?id=not-a-uuid";
  assert.equal(savedSabyFinanceCardUrl(badUrl),null);
});

test("previously verified real Saby smoke can be imported without another browser visit",()=>{
  const source="https://profile.saby.ru/page/contractor-info?"+
    "id=7f794800-63b5-11e0-adec-00c30e012283&anchor=about";
  const smokeRow=row();
  smokeRow[REV]=440100000;
  smokeRow[STAFF]=119;
  smokeRow.__evidence.saby.source_url=source;
  smokeRow.__evidence.saby.verified_at="2026-11-20T08:50:02.150Z";
  smokeRow.__evidence.saby.collection.financials="collected";
  smokeRow.__evidence.saby.financials={
    status:"collected",revenue_rub:440100000,revenue_year:2025,employees:119
  };
  const smoke={source:"single_company",final_result:result([smokeRow]),
    saby_smoke_selection:{limit:1},saby_stage12:{
      verified:1,review:0,browserError:"",
      revenuesAdded:1,employeesAdded:1
    }};
  const existing=row("4718000935","Волховское, АО","",119);
  existing.__evidence.saby.source_url=source;
  const sourceBefore=JSON.stringify(existing.__evidence.saby);
  const imported=verifiedSabyFinanceFromSmoke(smoke,"4718000935");
  assert.equal(imported.identity.verified,true);
  assert.equal(imported.financials.revenue_rub,440100000);
  assert.equal(imported.financials.revenue_year,2025);
  assert.equal(imported.financials.employees,119);
  const applied=applySabyFinanceBackfill(existing,imported);
  assert.equal(applied.revenueAdded,true);
  assert.equal(applied.employeesAdded,false);
  assert.equal(existing[REV],440100000);
  assert.equal(existing[STAFF],119);
  assert.equal(JSON.stringify(existing.__evidence.saby),sourceBefore);

  const broken=[
    {...smoke,saby_stage12:{...smoke.saby_stage12,verified:0}},
    {...smoke,saby_smoke_selection:{limit:2}},
    {...smoke,final_result:{...smoke.final_result,direct_buyers:[smokeRow,smokeRow]}},
    {...smoke,final_result:{...smoke.final_result,
      direct_buyers:[{...smokeRow,[REV]:23}]}},
    {...smoke,final_result:{...smoke.final_result,direct_buyers:[{
      ...smokeRow,__evidence:{saby:{...smokeRow.__evidence.saby,
        source_url:"https://other.example.org/page/contractor-info?id=7f794800-63b5-11e0-adec-00c30e012283"}}
    }]}},
    {...smoke,final_result:{...smoke.final_result,direct_buyers:[{
      ...smokeRow,"ИНН":"4718000936"
    }]}}
  ];
  for(const sample of broken)
    assert.throws(()=>verifiedSabyFinanceFromSmoke(sample,"4718000935"),
      /FINANCE_BACKFILL_SMOKE_NOT_VERIFIED/);
});


test("only confirmed no-results searches count as unavailable and allow the next INN",async()=>{
  const parent=checkpoint([
    row("4718000935","Волховское, АО","",119),
    row("7707083893","Сбербанк, ПАО")
  ]);
  const original=JSON.stringify(parent);
  const seen=[],snapshots=[];
  const out=await runSabyFinanceBackfill({
    checkpoint:parent,sourceJobId:UUID1,childJobId:UUID2,
    maxCompanies:2,
    sessionRunner:async fn=>fn({page:{},settings:{}}),
    waitBetweenCompanies:async()=>{},
    collectCompany:async(_page,subject)=>{
      seen.push(subject["ИНН"]);
      if(subject["ИНН"]==="4718000935")
        throw safeSabyFailure("search_confirmed_empty");
      return record("7707083893","Сбербанк, ПАО");
    },
    onCheckpoint:async cp=>snapshots.push(cp)
  });
  assert.deepEqual(seen,["4718000935","7707083893"]);
  assert.equal(out.stats.processed,2);
  assert.equal(out.stats.unavailable,1);
  assert.equal(out.stats.verified,1);
  assert.equal(out.stats.revenueAdded,1);
  assert.equal(out.stats.review,0);
  assert.equal(out.stats.unvisited,0);
  assert.equal(out.stats.browserError,"");
  assert.equal(out.snapshot.phase,"completed");
  assert.deepEqual(out.snapshot.saby_finance_backfill_attempted_inns,
    ["4718000935","7707083893"]);
  assert.deepEqual(out.snapshot.saby_finance_backfill_outcomes["4718000935"],{
    status:"missing",reason:"saby_no_results",
    revenueStillMissing:true,employeesStillMissing:false
  });
  assert.equal(out.snapshot.final_result.direct_buyers[0][REV],"");
  assert.equal(out.snapshot.final_result.direct_buyers[0][STAFF],119);
  assert.equal(out.snapshot.final_result.direct_buyers[1][REV],440100000);
  assert.equal(JSON.stringify(parent),original);
  assert.equal(snapshots.length>=3,true);
});

test("Saby service unavailability pauses before consuming any further legal INN",async()=>{
  const parent=checkpoint([
    row(),row("7707083893","Сбербанк, ПАО")
  ]);
  const original=JSON.stringify(parent);
  let calls=0;
  const out=await runSabyFinanceBackfill({
    checkpoint:parent,sourceJobId:UUID1,childJobId:UUID2,
    maxCompanies:2,
    sessionRunner:async fn=>fn({page:{},settings:{}}),
    collectCompany:async()=>{
      calls++;
      throw safeSabyFailure("search_service_unavailable","systemic");
    }
  });
  assert.equal(calls,1,"site error cannot trigger a speculative second search");
  assert.equal(out.stats.processed,0);
  assert.equal(out.stats.review,0);
  assert.equal(out.stats.unavailable,0);
  assert.equal(out.stats.unvisited,2);
  assert.equal(out.stats.browserError,"saby_search_unavailable");
  assert.deepEqual(out.snapshot.saby_finance_backfill_attempted_inns,[]);
  assert.equal(out.snapshot.phase,"saby");
  assert.equal(JSON.stringify(parent),original);
});


test("one stalled Saby search is safely deferred while other firms add verified numbers",async()=>{
  const parent=checkpoint([
    row("4718000935","Волховское, АО"),
    row("7707083893","Сбербанк, ПАО"),
    row("7801014560","Транспорт, ООО")
  ]);
  const original=JSON.stringify(parent);
  const visits=[],saved=[];
  const out=await runSabyFinanceBackfill({
    checkpoint:parent,sourceJobId:UUID1,childJobId:UUID2,
    maxCompanies:3,
    sessionRunner:async fn=>fn({page:{},settings:{delayMs:250}}),
    waitBetweenCompanies:async()=>{},
    collectCompany:async(_page,subject)=>{
      visits.push(subject["ИНН"]);
      if(subject["ИНН"]==="4718000935")
        throw safeSabyFailure("search_loading_stalled","systemic");
      return record(subject["ИНН"],subject["Организация"]);
    },
    onCheckpoint:async cp=>saved.push(cp)
  });
  assert.deepEqual(visits,["4718000935","7707083893","7801014560"]);
  assert.equal(out.stats.processed,3);
  assert.equal(out.stats.loadingDeferred,1);
  assert.equal(out.stats.review,0);
  assert.equal(out.stats.reviewRetryable,0);
  assert.equal(out.stats.reviewExhausted,0);
  assert.equal(out.stats.retries,0);
  assert.equal(out.stats.verified,2);
  assert.equal(out.stats.revenueAdded,2);
  assert.equal(out.stats.employeesAdded,2);
  assert.equal(out.stats.unvisited,1);
  assert.equal(out.stats.browserError,"");
  assert.equal(out.snapshot.phase,"saby",
    "one still-pending INN cannot make backfill completed");
  assert.deepEqual(out.snapshot.saby_finance_backfill_attempted_inns,
    ["7707083893","7801014560"]);
  assert.deepEqual(out.snapshot.saby_finance_backfill_review_attempts,{});
  assert.deepEqual(out.snapshot.saby_finance_backfill_outcomes["4718000935"],{
    status:"deferred",reason:"search_loading_stalled",
    revenueStillMissing:true,employeesStillMissing:true
  });
  assert.equal(out.snapshot.final_result.direct_buyers[0][REV],"");
  assert.equal(out.snapshot.final_result.direct_buyers[1][REV],440100000);
  assert.ok(saved.length>=5,"after every visit an immutable child snapshot is saved");
  assert.equal(JSON.stringify(parent),original);
});

test("three consecutive Saby search stalls safely pause a large batch",async()=>{
  const parent=checkpoint([
    row("4718000935","Волховское, АО"),
    row("7707083893","Сбербанк, ПАО"),
    row("7801014560","Транспорт, ООО"),
    row("7812019999","Логистика, ООО")
  ]);
  const original=JSON.stringify(parent);
  let calls=0;
  const saved=[];
  const out=await runSabyFinanceBackfill({
    checkpoint:parent,sourceJobId:UUID1,childJobId:UUID2,
    maxCompanies:4,
    sessionRunner:async task=>task({page:{},settings:{delayMs:250}}),
    waitBetweenCompanies:async()=>{},
    collectCompany:async()=>{
      calls++;
      throw safeSabyFailure("search_loading_stalled","systemic");
    },
    onCheckpoint:async cp=>saved.push(cp)
  });
  assert.equal(calls,3,"site-wide issue pauses before four or hundreds of additional searches");
  assert.equal(out.stats.processed,3);
  assert.equal(out.stats.loadingDeferred,3);
  assert.equal(out.stats.retries,0);
  assert.equal(out.stats.review,0);
  assert.equal(out.stats.unavailable,0);
  assert.equal(out.stats.revenueAdded,0);
  assert.equal(out.stats.employeesAdded,0);
  assert.equal(out.stats.unvisited,4);
  assert.equal(out.stats.browserError,"saby_consecutive_loading_stalls");
  assert.equal(out.snapshot.phase,"saby");
  assert.deepEqual(out.snapshot.saby_finance_backfill_attempted_inns,[]);
  assert.deepEqual(out.snapshot.saby_finance_backfill_review_attempts,{});
  assert.equal(Object.keys(out.snapshot.saby_finance_backfill_outcomes).length,3);
  for(const entry of Object.values(out.snapshot.saby_finance_backfill_outcomes)){
    assert.equal(entry.status,"deferred");
    assert.equal(entry.reason,"search_loading_stalled");
  }
  assert.ok(saved.length>=5,"progress saves survive the controlled circuit breaker");
  assert.equal(JSON.stringify(parent),original);
});

test("saved Saby search stalls follow fresh INNs on continuation",async()=>{
  const parent=checkpoint([
    row("4718000935","Волховское, АО"),
    row("7707083893","Сбербанк, ПАО"),
    row("7801014560","Транспорт, ООО"),
    row("7812019999","Логистика, ООО")
  ]);
  parent.source_mode="saby";
  parent.phase="saby";
  parent.saby_finance_backfill_outcomes={
    "4718000935":{status:"deferred",reason:"search_loading_stalled"}
  };
  const original=JSON.stringify(parent);
  const visited=[];
  const out=await runSabyFinanceBackfill({
    checkpoint:parent,sourceJobId:UUID1,childJobId:UUID2,
    maxCompanies:2,
    sessionRunner:async fn=>fn({page:{},settings:{delayMs:250}}),
    collectCompany:async(_page,subject)=>{
      visited.push(subject["ИНН"]);
      return record(subject["ИНН"],subject["Организация"]);
    },
    waitBetweenCompanies:async()=>{}
  });
  assert.deepEqual(visited,["7707083893","7801014560"],
    "fresh companies take precedence over previously stalled search");
  assert.equal(out.stats.processed,2);
  assert.equal(out.stats.loadingDeferred,0);
  assert.equal(out.stats.unvisited,2);
  assert.equal(out.snapshot.saby_finance_backfill_outcomes["4718000935"].status,
    "deferred");
  assert.deepEqual(out.snapshot.saby_finance_backfill_attempted_inns,
    ["7707083893","7801014560"]);
  assert.equal(JSON.stringify(parent),original);
});

test("a stalled previously reviewed INN does not use another review allowance",async()=>{
  const parent=checkpoint([row()]);
  parent.saby_finance_backfill_review_attempts={"4718000935":1};
  const original=JSON.stringify(parent);
  const out=await runSabyFinanceBackfill({
    checkpoint:parent,sourceJobId:UUID1,childJobId:UUID2,
    maxCompanies:1,
    sessionRunner:async fn=>fn({page:{},settings:{delayMs:250}}),
    collectCompany:async()=>{throw safeSabyFailure("search_loading_stalled");}
  });
  assert.equal(out.stats.loadingDeferred,1);
  assert.equal(out.stats.review,0);
  assert.equal(out.stats.reviewRetryable,1);
  assert.equal(out.stats.reviewExhausted,0);
  assert.equal(out.stats.unvisited,1);
  assert.equal(out.snapshot.saby_finance_backfill_review_attempts["4718000935"],1);
  assert.deepEqual(out.snapshot.saby_finance_backfill_attempted_inns,[]);
  assert.equal(JSON.stringify(parent),original);
});

test("Saby loading stall classification is not company-specific or retryable",()=>{
  assert.deepEqual(classifySabyFinanceFailure(
    safeSabyFailure("search_loading_stalled","systemic")),
    {code:"search_loading_stalled",retryable:false});
});

test("finance watchdog uses verified attempted company only, forcing exact-INN search",()=>{
  const ok=row();
  const parent=checkpoint([ok,row("7707083893","Сбербанк, ПАО")]);
  assert.equal(selectSabyFinanceSearchCanary(parent),null,
    "no verified finance supplement cannot become a health canary");
  assert.equal(applySabyFinanceBackfill(ok,record()).status,"updated");
  parent.saby_finance_backfill_attempted_inns=["4718000935"];
  const before=JSON.stringify(parent);
  const canary=selectSabyFinanceSearchCanary(parent);
  assert.equal(canary.inn,"4718000935");
  assert.equal(canary.source_url,SABY);
  assert.equal(canary.row.__evidence.saby,undefined,
    "direct saved-card lookup must not bypass the search being tested");
  assert.equal(verifySabyFinanceSearchCanary(record(),canary),true);
  for(const bad of [
    record("7707083893","Сбербанк, ПАО"),
    {...record(),source_url:"https://profile.saby.ru/page/contractor-info?id=other"},
    {...record(),identity:{...record().identity,verified:false}},
    {...record(),source:"ANOTHER"},
    {...record(),source_url:"https://evil.test/contractor-info?id=valid-main-card"}
  ])assert.equal(verifySabyFinanceSearchCanary(bad,canary),false);
  assert.equal(JSON.stringify(parent),before,
    "canary selection does not mutate source or existing evidence");
  assert.equal(selectSabyFinanceSearchCanary({
    ...parent,saby_finance_backfill_attempted_inns:[]
  }),null);
});

test("three unconfirmed zero-row searches use one known-good canary, then continue",async()=>{
  const known=row();
  assert.equal(applySabyFinanceBackfill(known,record()).status,"updated");
  const pending=[
    row("7707083893","Сбербанк, ПАО"),
    row("7801014560","Транспорт, ООО"),
    row("7812019999","Логистика, ООО"),
    row("7707049999","Оператор, ООО")
  ];
  const parent=checkpoint([known,...pending]);
  parent.source_mode="saby";
  parent.phase="saby";
  parent.saby_finance_backfill_attempted_inns=["4718000935"];
  const initial=JSON.stringify(parent),visits=[],saves=[];
  const out=await runSabyFinanceBackfill({
    checkpoint:parent,sourceJobId:UUID1,childJobId:UUID2,
    maxCompanies:4,
    sessionRunner:async task=>task({page:{},settings:{delayMs:250}}),
    waitBetweenCompanies:async()=>{},
    collectCompany:async(_page,subject)=>{
      visits.push(subject["ИНН"]);
      if(subject["ИНН"]==="4718000935")return record();
      if(subject["ИНН"]==="7707049999")
        return record("7707049999","Оператор, ООО");
      throw safeSabyFailure("search_zero_unconfirmed","company");
    },
    onCheckpoint:async cp=>saves.push(cp)
  });
  assert.deepEqual(visits,[
    "7707083893","7801014560","7812019999",
    "4718000935","7707049999"
  ]);
  assert.equal(out.stats.processed,4);
  assert.equal(out.stats.unconfirmedSearches,3);
  assert.equal(out.stats.loadingDeferred,0);
  assert.equal(out.stats.canaryChecks,1);
  assert.equal(out.stats.canaryPassed,1);
  assert.equal(out.stats.review,0);
  assert.equal(out.stats.retries,0);
  assert.equal(out.stats.revenueAdded,1);
  assert.equal(out.stats.unvisited,3);
  assert.equal(out.stats.browserError,"");
  assert.deepEqual(out.snapshot.saby_finance_backfill_attempted_inns,
    ["4718000935","7707049999"]);
  assert.equal(Object.keys(
    out.snapshot.saby_finance_backfill_review_attempts).length,0);
  for(const inn of ["7707083893","7801014560","7812019999"]){
    assert.deepEqual(out.snapshot.saby_finance_backfill_outcomes[inn],{
      status:"deferred",reason:"search_zero_unconfirmed",
      revenueStillMissing:true,employeesStillMissing:true
    });
  }
  assert.equal(out.snapshot.final_result.direct_buyers[0][REV],440100000);
  assert.ok(saves.length>=6);
  assert.equal(JSON.stringify(parent),initial);
});

test("unconfirmed zero-row batch stops if known-good canary is unverified",async()=>{
  const known=row();
  assert.equal(applySabyFinanceBackfill(known,record()).status,"updated");
  const parent=checkpoint([
    known,row("7707083893","Сбербанк, ПАО"),
    row("7801014560","Транспорт, ООО"),
    row("7812019999","Логистика, ООО"),
    row("7707049999","Оператор, ООО")
  ]);
  parent.saby_finance_backfill_attempted_inns=["4718000935"];
  const visited=[];
  const out=await runSabyFinanceBackfill({
    checkpoint:parent,sourceJobId:UUID1,childJobId:UUID2,
    maxCompanies:4,
    sessionRunner:async task=>task({page:{},settings:{delayMs:250}}),
    waitBetweenCompanies:async()=>{},
    collectCompany:async(_page,subject)=>{
      visited.push(subject["ИНН"]);
      if(subject["ИНН"]==="4718000935")
        return record("7707083893","Сбербанк, ПАО");
      throw safeSabyFailure("search_zero_unconfirmed","company");
    }
  });
  assert.deepEqual(visited,[
    "7707083893","7801014560","7812019999","4718000935"
  ]);
  assert.equal(out.stats.processed,3);
  assert.equal(out.stats.unconfirmedSearches,3);
  assert.equal(out.stats.canaryChecks,1);
  assert.equal(out.stats.canaryPassed,0);
  assert.equal(out.stats.browserError,"saby_search_canary_unverified");
  assert.equal(out.stats.review,0);
  assert.equal(out.stats.retries,0);
  assert.equal(out.stats.unvisited,4);
  assert.deepEqual(out.snapshot.saby_finance_backfill_attempted_inns,
    ["4718000935"]);
});

test("unconfirmed zero-row batch without verified canary stops after three",async()=>{
  const parent=checkpoint([
    row(),row("7707083893","Сбербанк, ПАО"),
    row("7801014560","Транспорт, ООО"),
    row("7812019999","Логистика, ООО")
  ]);
  let calls=0;
  const out=await runSabyFinanceBackfill({
    checkpoint:parent,sourceJobId:UUID1,childJobId:UUID2,
    maxCompanies:4,
    sessionRunner:async task=>task({page:{},settings:{delayMs:250}}),
    waitBetweenCompanies:async()=>{},
    collectCompany:async()=>{
      calls++;
      throw safeSabyFailure("search_zero_unconfirmed","company");
    }
  });
  assert.equal(calls,3);
  assert.equal(out.stats.processed,3);
  assert.equal(out.stats.review,0);
  assert.equal(out.stats.unconfirmedSearches,3);
  assert.equal(out.stats.canaryChecks,0);
  assert.equal(out.stats.browserError,"saby_search_canary_unavailable");
  assert.equal(out.stats.unvisited,4);
  assert.deepEqual(out.snapshot.saby_finance_backfill_attempted_inns,[]);
});

test("uncertain Saby zero-row failure is nonretryable and not an identity review",()=>{
  assert.deepEqual(classifySabyFinanceFailure(
    safeSabyFailure("search_zero_unconfirmed","company")),
    {code:"search_zero_unconfirmed",retryable:false});
});
