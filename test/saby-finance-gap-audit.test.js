import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {DatabaseSync} from "node:sqlite";
import {auditSabyFinanceGaps} from "../src/sabyFinanceGapAudit.js";

const ID="20ab4c8a-d5f2-404e-aa3a-1b5209c5d084";
const GOOD_URL="https://profile.saby.ru/page/contractor-info?"+
  "id=7f794800-63b5-11e0-adec-00c30e012283";
const company=(inn,financial={},saby=null)=>({
  "ИНН":inn,"Организация":'ООО "Компания '+inn+'"',
  "Выручка последнего подтвержденного года":financial.revenue??"",
  "Численность":financial.staff??"",
  __evidence:saby?{saby}:undefined
});
const sample=()=>({
  version:1,source_mode:"saby",phase:"saby",region:"Тестовая область",
  final_result:{
    direct_buyers:[
      company("4703144282",{},{
        inn:"4703144282",kpp:"470401001",
        source_url:GOOD_URL
      }),
      company("7707083893"),
      company("7812019999"),
      company("7812001999"),
      company("7727015959",{revenue:100000,staff:10})
    ],
    intermediaries:[],leasing:[]
  },
  saby_finance_backfill_attempted_inns:["7812001999"],
  saby_finance_backfill_review_attempts:{
    "4703144282":1,"7812019999":2
  },
  saby_finance_backfill_outcomes:{
    "4703144282":{status:"deferred",reason:"search_zero_unconfirmed"},
    "7812019999":{status:"review",reason:"card_legal_name_unverified"},
    "7812001999":{status:"missing",reason:"financial_not_verified"}
  },
  saby_finance_backfill_stats:{
    processed:104,revenueAdded:12,employeesAdded:8,
    canaryChecks:8,canaryPassed:8,unconfirmedSearches:48
  }
});
test("offline gap audit categorizes pending, exhausted and attempted without company data",()=>{
  const cp=sample(),before=JSON.stringify(cp);
  const result=auditSabyFinanceGaps(cp,{checkpointId:ID});
  assert.equal(result.checkpoint,ID);
  assert.equal(result.commercial_rows,5);
  assert.equal(result.finance_gaps.eligible_unique_inn,4);
  assert.equal(result.finance_gaps.already_complete,1);
  assert.equal(result.attempted_missing_finance,1);
  assert.equal(result.pending.count,2);
  assert.equal(result.pending.prior_review_attempts,1);
  assert.equal(result.pending.saved_saby_card_hints,1);
  assert.equal(result.pending.saved_saby_card_with_kpp_hints,1);
  assert.deepEqual(result.pending.by_reason,[
    {reason:"deferred:search_zero_unconfirmed",count:1},
    {reason:"not_attempted:unspecified",count:1}
  ]);
  assert.equal(result.exhausted.count,1);
  assert.equal(result.exhausted.prior_review_attempts,1);
  assert.equal(result.exhausted.saved_saby_card_hints,0);
  assert.equal(result.pending_never_observed,1);
  assert.deepEqual(result.exhausted.by_reason,[
    {reason:"review:card_legal_name_unverified",count:1}
  ]);
  assert.equal(result.latest_pass.canary_checks,8);
  assert.equal(JSON.stringify(cp),before);
  const output=JSON.stringify(result);
  assert.doesNotMatch(output,/4703144282|7707083893|7812019999|profile\.saby\.ru|Компания 4703/);
});
test("arbitrary checkpoint reasons and browser errors are never printed",()=>{
  const cp=sample();
  cp.saby_finance_backfill_outcomes["4703144282"]={
    status:"PRIVATE_STATUS_TOKEN",
    reason:"SECRET_COMPANY_INN_URL"
  };
  cp.saby_finance_backfill_stats.browserError="PRIVATE_BROWSER_URL";
  const result=auditSabyFinanceGaps(cp);
  assert.equal(result.pending.by_reason[0].reason,"unknown:unclassified");
  assert.equal(result.latest_pass.browser_error,"unclassified");
  assert.doesNotMatch(JSON.stringify(result),
    /PRIVATE_STATUS_TOKEN|SECRET_COMPANY_INN_URL|PRIVATE_BROWSER_URL/);
});

test("card hint requires same INN and exact approved private profile URL",()=>{
  const cp=sample();
  for(const evidence of [
    {...cp.final_result.direct_buyers[0].__evidence.saby,inn:"7707083893"},
    {...cp.final_result.direct_buyers[0].__evidence.saby,
      source_url:"https://evil.test/page/contractor-info?id=7f794800-63b5-11e0-adec-00c30e012283"},
    {...cp.final_result.direct_buyers[0].__evidence.saby,
      source_url:"https://profile.saby.ru/page/contractor-info?id=bad"},
    {...cp.final_result.direct_buyers[0].__evidence.saby,
      source_url:"http://profile.saby.ru/page/contractor-info?id=7f794800-63b5-11e0-adec-00c30e012283"}
  ]){
    cp.final_result.direct_buyers[0].__evidence.saby=evidence;
    assert.equal(auditSabyFinanceGaps(cp).pending.saved_saby_card_hints,0);
  }
});

test("SQLite audit CLI reads existing database in read-only mode and never writes",()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"rr-finance-gap-audit-"));
  const file=path.join(folder,"audit.sqlite");
  let db;
  try{
    db=new DatabaseSync(file);
    db.exec("CREATE TABLE research_checkpoints (id TEXT PRIMARY KEY, payload TEXT)");
    const source=sample();
    db.prepare("INSERT INTO research_checkpoints(id,payload) VALUES(?,?)")
      .run(ID,JSON.stringify(source));
    db.close();db=null;
    const before=fs.readFileSync(file);
    const script=fileURLToPath(new URL(
      "../scripts/saby-finance-gap-audit.js",import.meta.url));
    const processResult=spawnSync(process.execPath,[
      script,"--db="+file,"--checkpoint="+ID
    ],{encoding:"utf8",timeout:30000});
    assert.equal(processResult.status,0,processResult.stderr);
    assert.match(processResult.stdout,/SABY_FINANCE_GAP_AUDIT/);
    assert.match(processResult.stdout,/"saved_saby_card_hints": 1/);
    assert.doesNotMatch(processResult.stdout,
      /4703144282|profile\.saby\.ru|Компания 4703/);
    assert.deepEqual(fs.readFileSync(file),before);
    const missing=spawnSync(process.execPath,[
      script,"--db="+file,"--checkpoint="+
      "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
    ],{encoding:"utf8",timeout:30000});
    assert.equal(missing.status,2);
    assert.match(missing.stderr,/CHECKPOINT_NOT_FOUND/);
    assert.deepEqual(fs.readFileSync(file),before);
  }finally{
    if(db)db.close();
    fs.rmSync(folder,{recursive:true,force:true});
  }
});
