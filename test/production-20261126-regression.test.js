import test from "node:test";
import assert from "node:assert/strict";
import {createDiscoveryCallLedger,fatalDiscoveryError} from "../src/discoveryCallLedger.js";
import {isOpenAIBillingStop,guardOpenAIResponses,OpenAIBillingPauseError} from "../src/openaiBillingGuard.js";
import {createFullJobQueue} from "../src/fullJobQueue.js";
import {stagedRetentionReview} from "../src/stagedRetention.js";
import {applySabyEnrichment,reconcileStoredSabyPhones} from "../src/sabyEnrichment.js";
import {parsePhoneEntries} from "../src/phoneExport.js";
import {rejectUnsafeAEvidence} from "../src/qualificationSafety.js";

test("successful discovery response is durable before aggregation and replay is free",async()=>{
  let saved={},calls=0;
  const ledger=createDiscoveryCallLedger({},async()=>{saved=structuredClone(ledger.snapshot());});
  const response=await ledger.run("primary:0:0",async()=>{calls++;return {direct_buyers:[{name:"A"}]};});
  response.direct_buyers[0].name="mutated";
  const restored=createDiscoveryCallLedger(saved);
  const reused=await restored.run("primary:0:0",async()=>{calls++;throw Error("must not repeat");});
  assert.equal(reused.direct_buyers[0].name,"A");
  assert.equal(calls,1);
  await assert.rejects(restored.run("primary:0:1",async()=>{throw new OpenAIBillingPauseError();}),{code:"OPENAI_BILLING_STOP"});
  assert.equal(Object.hasOwn(restored.snapshot(),"primary:0:1"),false);
  assert.equal(fatalDiscoveryError(new OpenAIBillingPauseError()),true);
});
test("failed storage is fatal and is not treated as saved response",async()=>{
  const ledger=createDiscoveryCallLedger({},async()=>{throw Error("disk");});
  await assert.rejects(ledger.run("primary:0:0",async()=>({rows:[]})),{code:"DISCOVERY_CHECKPOINT_WRITE_FAILED"});
  assert.deepEqual(ledger.snapshot(),{});
});
test("account credit exhaustion blocks new paid calls across clients, not ordinary 429",async()=>{
  let blocked=false,calls=0;
  const client={responses:{create:async()=>{calls++;throw Object.assign(Error("quota"),{code:"insufficient_quota"});}}};
  const other={responses:{create:async()=>{calls++;return {status:"completed"};}}};
  const hooks={beforeRequest:()=>{if(blocked)throw new OpenAIBillingPauseError();},onBillingStop:()=>{blocked=true;}};
  guardOpenAIResponses(client,hooks);guardOpenAIResponses(other,hooks);
  assert.equal(isOpenAIBillingStop({status:429,code:"rate_limit_exceeded",message:"Rate limit reached"}),false);
  assert.equal(isOpenAIBillingStop(Error("You have no credits remaining")),true);
  await assert.rejects(client.responses.create({}),{code:"OPENAI_BILLING_STOP"});
  await assert.rejects(other.responses.create({}),{code:"OPENAI_BILLING_STOP"});
  assert.equal(calls,1);
  blocked=false;
  assert.equal((await other.responses.create({})).status,"completed");
});
test("billing-held paid jobs retain region reservation while a free job starts",async()=>{
  let blocked=true;
  const ran=[];
  const queue=createFullJobQueue({limit:1,autoPoll:false,canAdmitJob:j=>!blocked||j.mode==="saby_only",
    execute:async j=>{ran.push(j.id);j.state="done";}});
  const paid={id:"paid",region:"A",mode:"full",state:"waiting"},free={id:"free",region:"B",mode:"saby_only",state:"waiting"};
  queue.enqueue(paid,"test");queue.enqueue(free,"test");
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(ran,["free"]);
  assert.equal(paid.progress.phase,"billing_wait");
  assert.equal(queue.conflict("A"),paid);
  blocked=false;queue.poll();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(ran,["free","paid"]);
  queue.close();
});
test("explicit lineage covers missing-INN staged alias but not different confirmed INN",()=>{
  const original={__canonical_id:"alias","Организация":"ООО Тест","ИНН":"",__evidence:{source_urls:["https://example.org/"]}};
  const final={direct_buyers:[{__canonical_id:"main",__merged_canonical_ids:["alias"],"Организация":"ООО Тест","ИНН":"7707083893"}]};
  const opts={isActionable:()=>true,isExcluded:()=>false};
  assert.equal(stagedRetentionReview({direct_buyers:[original]},final,opts).rows.length,0);
  assert.equal(stagedRetentionReview({direct_buyers:[{...original,"ИНН":"7701234567"}]},final,opts).rows.length,1);
});
const url="https://profile.saby.ru/page/contractor-info?id=company";
const numbers=row=>parsePhoneEntries(row["Телефон"]).map(x=>x.phone);
test("append confirmed new Saby phone to an existing cell; retain competing phone only in evidence",()=>{
  const row={"Организация":"ООО Тест","ИНН":"7707083893","Телефон":"79001234567"};
  const other={"Организация":"ООО Другой"};
  const owners=new Map([["79001234567",new Set([row])],["79001234569",new Set([other])]]);
  const result=applySabyEnrichment(row,{source_url:url,identity:{verified:true,inn:row["ИНН"],name:row["Организация"]},
    contacts:{status:"collected",phones:["79001234568","79001234569"]}},{phoneOwners:owners});
  assert.deepEqual(numbers(row),["79001234567","79001234568"]);
  assert.equal(result.phonesAppended,1);
  assert.equal(result.phoneAdded,false);
  assert.equal(row.__evidence.saby.phone_conflicts[0].phone,"79001234569");
});
test("saved Saby phones can restore a blank cell but ambiguous ownership cannot",()=>{
  const row=(inn,phones)=>({"Организация":"ООО Тест","ИНН":inn,"Телефон":"",
    __evidence:{saby:{inn,source_url:url,collection:{contacts:"collected"},phones}}});
  const a=row("7707083893",["79001234567","79001234569"]);
  const b=row("7701234567",["79001234569"]);
  const c=row("7701234568",["79001234568"]);
  c.__evidence.saby.inn="7700000000";
  const result={direct_buyers:[a,b,c]};
  const stats=reconcileStoredSabyPhones(result);
  assert.deepEqual(numbers(a),["79001234567"]);
  assert.deepEqual(numbers(b),[]);
  assert.deepEqual(numbers(c),[]);
  assert.equal(stats.rowsFilled,1);
  assert.equal(stats.conflicts,2);
  assert.equal(reconcileStoredSabyPhones(result).numbersAppended,0);
});
test("explicit absence of proof cannot be positive A evidence",()=>{
  const row={"Организация":"ООО Тест",__evidence:{notes:[]}};
  const record={row,sheet:"direct_buyers"};
  assert.ok(rejectUnsafeAEvidence(record,"Нет свидетельств закупки или эксплуатации полуприцепа"));
  assert.ok(rejectUnsafeAEvidence(record,"Наличие собственных тягачей и полуприцепов требует проверки"));
  assert.ok(rejectUnsafeAEvidence(record,"Подтверждений конкретного парка недостаточно"));
});
