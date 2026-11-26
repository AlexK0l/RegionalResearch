import test from "node:test";
import assert from "node:assert/strict";
import {buildFnsLegalStatusEvidence,applyFnsLegalStatusEvidence,lookupFnsLegalStatus,
  planFnsLegalStatus,runFnsLegalStatusCheck} from "../src/fnsLegalStatus.js";
const now=Date.UTC(2026,10,26,10),inn="4706000909",ogrn="1024701329377",kpp="470601001",
  name='АО "ПРИМЕР"',full='АКЦИОНЕРНОЕ ОБЩЕСТВО "ПРИМЕР"',url="https://egrul.nalog.ru/index.html";
const row=(extra={})=>({__canonical_id:"a","Организация":name,"ИНН":inn,"Телефон":"74951234567",
  "Основание":"A — техника","Численность":7,__final_grade:"A",__comment:"Сохранённое описание",
  __evidence:{notes:["Исходное коммерческое доказательство"]},...extra});
const record=(active=true)=>({inn,ogrn,kpp,full_name:full,short_name:name,active});
const proof=(active=true,extra={})=>({kind:"fns_extract",url,record:record(active),
  extract:{date:"26.11.2026",number:"ЮЭ123456",sha256:"a".repeat(64),page_count:2,
    status_basis:active?"complete_extract_no_adverse_status":"current_adverse_status"},...extra});
const lookup=(p=proof())=>({pages:2,search:async()=>({state:"observed",complete:true,allCardsRead:true,
  records:[{provider:"fns",url,record:record(null)}]}),confirm:async()=>p});
const result=rows=>({direct_buyers:rows,intermediaries:[],leasing:[],statistics:[]});
test("exact current FNS extract status is independent evidence and never changes grade or business fields",async()=>{
  const r=row(),before=structuredClone(r);
  const observed=await lookupFnsLegalStatus(r,lookup(),{now});
  assert.equal(observed.reason,"no_adverse_status");
  assert.equal(applyFnsLegalStatusEvidence(r,observed.proof,{now}),true);
  assert.equal(r.__evidence.fns_legal_status.status,"no_adverse_status");
  assert.match(r.__comment,/в полной выписке не обнаружен неблагоприятный статус/);
  for(const field of ["Телефон","Основание","Численность","__final_grade"])assert.deepEqual(r[field],before[field]);
  assert.deepEqual(r.__evidence.notes,before.__evidence.notes);
  assert.equal(planFnsLegalStatus(result([r]),{now}).already_current,1);
  assert.equal(planFnsLegalStatus(result([r]),{now:now+3*86400000}).eligible,1);
});
test("adverse, dated ceased and ambiguous cessation are distinguished without deleting rows",async()=>{
  const r=row();
  const pending=buildFnsLegalStatusEvidence(r,proof(false),{now});
  assert.equal(pending.status,"adverse_status_review");
  const ceased=buildFnsLegalStatusEvidence(r,proof(false,{cessation:{status:"ceased",termination_date:"10.11.2026",
    method:"Ликвидация юридического лица"}}),{now});
  assert.equal(ceased.status,"ceased");
  assert.equal(applyFnsLegalStatusEvidence(r,ceased,{now}),true);
  assert.equal(r.__evidence.fns_legal_status.status,"ceased");
  assert.equal(r.__evidence.legal_status_verification,undefined);
  assert.match(r.__comment,/10\.11\.2026/);
  assert.equal(buildFnsLegalStatusEvidence(r,proof(false,{cessation:{...ceased.cessation,termination_date:"30.11.2026"}}),{now}).status,"adverse_status_review");
});
test("foreign identifiers, stale extract, contradictory current search and wrong source are not status evidence",async()=>{
  const r=row();
  assert.equal(buildFnsLegalStatusEvidence(r,proof(true,{record:{...record(),inn:"7707083893"}}),{now}),null);
  assert.equal(buildFnsLegalStatusEvidence(r,proof(true,{extract:{...proof().extract,date:"20.11.2026"}}),{now}),null);
  assert.equal(buildFnsLegalStatusEvidence(row({"ОГРН":"1167847075230"}),proof(),{now}),null);
  const conflict=lookup();
  conflict.search=async()=>({state:"observed",complete:true,allCardsRead:true,records:[{provider:"fns",url,record:record(false)}]});
  assert.equal((await lookupFnsLegalStatus(r,conflict,{now})).reason,"fns_status_conflict");
  assert.equal((await lookupFnsLegalStatus(r,{...lookup(),search:async()=>({state:"observed",complete:true,allCardsRead:true,
    records:[{provider:"fns",url:"https://example.org/",record:record(null)}]})},{now})).proof,null);
  assert.equal(planFnsLegalStatus(result([r,{...r,__canonical_id:"b"}]),{now}).duplicate_identity,2);
});
test("one bounded session persists outcomes per company and does not replay current extracts or swallow storage errors",async()=>{
  const r=row(),data=result([r]),calls=[];
  const state=await runFnsLegalStatusCheck({result:data,now:()=>now,limit:1,
    sessionRunner:async(task,options)=>{calls.push(options);return task(lookup());},
    onCheckpoint:async s=>calls.push(s.stats.processed)});
  assert.equal(state.stats.no_adverse_status,1);
  assert.equal(state.stats.openai_requests,0);
  assert.equal(state.stats.saby_requests,0);
  assert.equal(calls[0].provider,"fns");
  assert.equal(calls[0].maxPages,3);
  assert.equal(data.direct_buyers.length,1);
  assert.equal(planFnsLegalStatus(data,{now,priorOutcomes:state.outcomes}).eligible,0);
  await assert.rejects(runFnsLegalStatusCheck({result:result([row()]),now:()=>now,limit:1,
    sessionRunner:task=>task(lookup()),onCheckpoint:async()=>{throw Error("save failed");}}),/save failed/);
});
test("unavailable registry results are recorded as unconfirmed, not closure or active status",async()=>{
  const r=row(),data=result([r]);
  const state=await runFnsLegalStatusCheck({result:data,now:()=>now,limit:1,
    sessionRunner:task=>task({pages:1,search:async()=>{throw Object.assign(Error("captcha"),{code:"fns_captcha_required"});}})});
  assert.equal(state.stats.unconfirmed,1);
  assert.equal(state.stats.stop_reason,"source_unavailable");
  assert.equal(r.__evidence.fns_legal_status,undefined);
  assert.equal(planFnsLegalStatus(data,{priorOutcomes:state.outcomes,now}).previously_attempted,1);
  assert.equal(planFnsLegalStatus(data,{priorOutcomes:state.outcomes,now,retryUnavailable:true}).eligible,1);
});
