import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  sabyNeedsSectionRetry,recoverSabyMissingSections
} from "../src/sabyRecovery.js";

const missing=()=>({identity:{verified:true},
  contacts:{status:"missing",phones:[],emails:[]},
  trucks:{status:"missing"},errors:[]});
const success=()=>({identity:{verified:true},
  contacts:{status:"collected",phones:["79991234567"],emails:[]},
  trucks:{status:"verified",count:31,vehicles:[]},errors:[]});

test("Saby missing both widgets is retried exactly once",async()=>{
  let calls=0,waits=0,signals=0;
  const second=success();
  const result=await recoverSabyMissingSections(
    async()=>++calls===1?missing():second,
    {wait:async()=>{waits++;},onRetry:()=>{signals++;}}
  );
  assert.equal(calls,2);
  assert.equal(waits,1);
  assert.equal(signals,1);
  assert.equal(result,second);
});

test("Saby complete card is never retried",async()=>{
  let calls=0;
  const first=success();
  const result=await recoverSabyMissingSections(
    async()=>{calls++;return first;},
    {onRetry:()=>{throw Error("retry must not occur");}}
  );
  assert.equal(calls,1);
  assert.equal(result,first);
});

test("Saby missing just one section is not retried unnecessarily",async()=>{
  for(const testCase of [
    {contacts:{status:"collected"},trucks:{status:"missing"}},
    {contacts:{status:"missing"},trucks:{status:"verified"}},
    {contacts:{status:"review"},trucks:{status:"missing"}}
  ]) {
    let calls=0;
    assert.equal(sabyNeedsSectionRetry(testCase),false);
    await recoverSabyMissingSections(async()=>{calls++;return testCase;});
    assert.equal(calls,1);
  }
});

test("Saby still missing after one reopening stays incomplete",async()=>{
  let calls=0;
  const result=await recoverSabyMissingSections(async()=>{calls++;return missing();});
  assert.equal(calls,2);
  assert.equal(sabyNeedsSectionRetry(result),true);
  // Stage 12 is responsible for deferring and never mutating this result.
});

test("Saby reopening failure retains incomplete evidence for Stage 12 defer",async()=>{
  const first=missing();
  let calls=0,errors=0;
  const result=await recoverSabyMissingSections(async()=>{
    if(++calls===1)return first;
    throw Error("an untrusted page error with identifiers");
  },{onRetryError:()=>{errors++;}});
  assert.equal(calls,2);
  assert.equal(errors,1);
  assert.equal(result,first);
  assert.equal(sabyNeedsSectionRetry(result),true);
});

test("collector uses bounded same-identity reopen and sanitized diagnostics",()=>{
  const file=readFileSync(new URL("../src/sabyBrowser.js",import.meta.url),"utf8");
  assert.match(file,/recoverSabyMissingSections\(/);
  assert.match(file,/collectSabyCompanyAttempt\(page,row,settings\)/);
  assert.match(file,/\[SABY_RETRY\] both_detail_sections_missing_reopen_once/);
  assert.match(file,/\[SABY_RETRY\] reopen_failed_deferred/);
  assert.match(file,/wait:\(\)=>delay\(650\)/);
});
