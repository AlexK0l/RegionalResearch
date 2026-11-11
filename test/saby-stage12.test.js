import test from "node:test";
import assert from "node:assert/strict";
import { applySabyEnrichment, sabyEligibleRows, sabySearchResultMatches,
  sabyNameMatches, sabyStoredSectionCoverage } from "../src/sabyEnrichment.js";
import { runSabyStage12 } from "../src/sabyStage12.js";
import { STEPS, DIRECT_BUYER_COLS } from "../src/constants.js";
import {readFileSync} from "node:fs";

function company(name="ООО Тест", inn="7707083893") {
  return {"Организация":name,"ИНН":inn,"Основание":"B — проверяемый грузопоток",
    "Телефон":"","__comment":"Результат собственного исследования"};
}
function payload({inn="7707083893",name="ООО Тест",
  sourceUrl="https://profile.saby.ru/page/company-list-prof",
  count=2,phones=["+7 (999) 123-45-67"]}={}) {
  return {identity:{inn,name,verified:true},source:"SABY",
    source_url:sourceUrl,collected_at:"2026-11-09T09:00:00Z",
    contacts:{status:"collected",phones,emails:["info@example.ru"]},
    trucks:{status:"verified",count,
      vehicles:count===2?
      [{model:"КамАЗ 5490",year:2020},{model:"КамАЗ 5490",year:2020}]:
      []},errors:[]};
}
const base = rows=>({direct_buyers:rows,intermediaries:[],leasing:[],statistics:[]});
const fakeSession = task=>task({page:{},settings:{}});

test("12 stages are shown; TORGBOX commercial header is renamed without changing its position",()=>{
  assert.equal(STEPS.length,12);
  assert.equal(DIRECT_BUYER_COLS[2],"Наличие транспорта");
  assert.ok(!DIRECT_BUYER_COLS.includes("TORGBOX"));
});

test("strict company identity rejects fuzzy names and wrong INN search results",()=>{
  assert.equal(sabyNameMatches("ООО Альфа","АО Альфа"),true);
  assert.equal(sabyNameMatches("ООО Альфа","ООО Альфа-Трейд"),false);
  assert.equal(sabySearchResultMatches("ООО Альфа",
    "ООО Альфа 7707083893 Москва","7707083893"),true);
  assert.equal(sabySearchResultMatches("ООО Альфа",
    "ООО Альфа-Трейд 7707083893 Москва","7707083893"),false);
  assert.equal(sabySearchResultMatches("ООО Альфа",
    "ООО Бета 7707083893 Альфа","7707083893"),false);
});

test("verified Saby trucks are NOT trailers; existing TORGBOX and A/B/C grades survive",()=>{
  const row=company();
  row["TORGBOX"]="TORGBOX: Krone — 1 шт.";
  row["Основание"]="C — грузопоток";
  row["Телефон"]="79001234567";
  const x=applySabyEnrichment(row,payload(),{transport:true});
  assert.equal(x.status,"ok");
  assert.equal(x.transportAdded,true);
  assert.equal(x.phoneAdded,false);
  assert.equal(row["Телефон"],"79001234567");
  assert.match(row["Наличие транспорта"],/TORGBOX: Krone — 1 шт./);
  assert.match(row["Наличие транспорта"],/Saby \(грузовые\): КамАЗ 5490 \(2020 г\.\) — 2 шт/);
  assert.equal(row["Основание"],"C — грузопоток");
  assert.equal(row.__evidence.saby.trucks.category,"Грузовые");
  assert.equal(row.__evidence.saby.trucks.source,"SABY");
  assert.match(row.__comment,/info@example\.ru/);
  applySabyEnrichment(row,payload(),{transport:true});
  assert.equal(row["Наличие транспорта"].split("Saby (грузовые):").length,2);
});

test("Saby replaces stale 'Email: не найден' in original Excel comment without touching phone labels",()=>{
  const row=company();
  row.__comment="Сайт/источник: https://existing.example/\\nEmail: не найден".replace("\\n","\n");
  const record=payload();
  record.errors=["trucks: secret error detail not for persistence","contacts: private page text"];
  record.trucks={status:"review"};
  applySabyEnrichment(row,record);
  assert.match(row.__comment,/^Email: info@example\.ru$/m);
  assert.doesNotMatch(row.__comment,/Email: не найден/i);
  assert.equal(row["Телефон"],"79991234567");
  assert.equal(row.__evidence.saby.collection.trucks,"review");
  assert.deepEqual(row.__evidence.saby.collection.failed_sections,["contacts","trucks"]);
  assert.doesNotMatch(JSON.stringify(row.__evidence.saby.collection),/secret error|private page/);
  assert.ok(!("Email" in row));
  const before=row.__comment;
  applySabyEnrichment(row,record);
  assert.equal(row.__comment,before);
});

test("Saby email never overwrites an existing official email in notes",()=>{
  const row=company();
  row.__comment="Сайт/источник: https://existing.example/\nEmail: official@example.ru";
  const record=payload();
  applySabyEnrichment(row,record);
  assert.match(row.__comment,/^Email: official@example\.ru$/m);
  assert.match(row.__comment,/Saby:.*email info@example\.ru/);
  assert.equal((row.__comment.match(/^Email:/gm)||[]).length,1);
});

test("no Saby email leaves the original no-email marker unchanged",()=>{
  const row=company();
  row.__comment="Email: не найден";
  const record=payload();
  record.contacts.emails=[];
  applySabyEnrichment(row,record);
  assert.match(row.__comment,/^Email: не найден$/m);
});

test("bad identity or untrusted source never changes row",()=>{
  const row=company();
  const before=JSON.stringify(row);
  const x=applySabyEnrichment(row,payload({inn:"1234567890"}),{transport:true});
  assert.equal(x.status,"review");
  assert.equal(JSON.stringify(row),before);
  const y=applySabyEnrichment(row,payload({sourceUrl:"https://saby.ru.evil.example/"}),
    {transport:true});
  assert.equal(y.status,"review");
  assert.equal(JSON.stringify(row),before);
});

test("incomplete, cropped or mismatched truck lists are never written",()=>{
  const row=company();
  const invalid=payload({count:2});invalid.trucks.vehicles.pop();
  const outcome=applySabyEnrichment(row,invalid,{transport:true});
  assert.equal(outcome.status,"ok");
  assert.equal(outcome.transportAdded,false);
  assert.equal(outcome.phoneAdded,true);
  assert.equal(row["Наличие транспорта"],undefined);
  assert.equal(row["Телефон"],"79991234567");
});

test("a phone already attributed to another INN is not silently reused",()=>{
  const row=company(), other=company("ООО Другой","7702070139");
  const owners=new Map([["79991234567",new Set([other])]]);
  const x=applySabyEnrichment(row,payload(),{phoneOwners:owners,transport:true});
  assert.equal(x.phoneAdded,false);
  assert.equal(row["Телефон"],"");
  assert.equal(x.transportAdded,true);
});

test("duplicate INNs and missing identities are quarantined BEFORE browser work",()=>{
  const result=base([company(),company("ООО Чужой"),company("ООО Нет ИНН","")]);
  const plan=sabyEligibleRows(result);
  assert.equal(plan.eligible.length,0);
  assert.equal(plan.duplicates.length,2);
  assert.equal(plan.invalid.length,1);
});

test("stage 12 is opt-in, and a disabled run opens no browser",async()=>{
  const row=company();
  const output=await runSabyStage12({
    result:base([row]),env:{SABY_STAGE12_ENABLED:"false"},
    sessionRunner:()=>{throw Error("browser must not open");}
  });
  assert.equal(output.stats.enabled,false);
  assert.equal(output.stats.processed,0);
  assert.equal(row["Телефон"],"");
});

test("stage 12 checks one selected INN, checkpoints, and resumes without another browser launch",async()=>{
  const row=company(),result=base([row]),snapshots=[];
  const env={SABY_STAGE12_ENABLED:"true",SABY_MAX_COMPANIES:"1",
    SABY_CIRCUIT_AFTER:"3",SABY_CHECKPOINT_EVERY:"1",SABY_DELAY_MS:"250"};
  const first=await runSabyStage12({result,env,sessionRunner:fakeSession,
    collectCompany:async()=>payload(),
    onCheckpoint:async snapshot=>snapshots.push(snapshot)
  });
  assert.equal(first.stats.verified,1);
  assert.equal(first.stats.phonesAdded,1);
  assert.equal(first.stats.transportsAdded,1);
  assert.deepEqual(first.completedInns,["7707083893"]);
  assert.deepEqual(first.deferredInns,[]);
  assert.ok(snapshots.length>=1);
  const second=await runSabyStage12({result,env,completedInns:first.completedInns,
    sessionRunner:()=>{throw Error("second launch");}});
  assert.equal(second.stats.scheduled,0);
});

test("batch offset selects the next 10 identities without rescanning previous ten",async()=>{
  const rows=Array.from({length:25},(_,i)=>
    company("ООО Тест "+i,String(7700000000+i)));
  const visited=[];
  const out=await runSabyStage12({
    result:base(rows),offset:10,
    env:{SABY_STAGE12_ENABLED:"true",SABY_MAX_COMPANIES:"10",
      SABY_CIRCUIT_AFTER:"3",SABY_DELAY_MS:"250"},
    sessionRunner:fakeSession,
    collectCompany:async(_page,row)=>{
      visited.push(row["ИНН"]);
      return payload({inn:row["ИНН"],name:row["Организация"],count:0,phones:[]});
    }
  });
  assert.equal(out.stats.scheduled,10);
  assert.equal(out.stats.verified,10);
  assert.deepEqual(visited,rows.slice(10,20).map(r=>r["ИНН"]));
  assert.equal(out.stats.deferred,15);
});

test("batch offset zero preserves production stage 12 selection order",async()=>{
  const rows=Array.from({length:3},(_,i)=>
    company("ООО Тест "+i,String(7700000000+i)));
  const visited=[];
  await runSabyStage12({
    result:base(rows),env:{SABY_STAGE12_ENABLED:"true",
      SABY_MAX_COMPANIES:"1",SABY_DELAY_MS:"250"},
    sessionRunner:fakeSession,
    collectCompany:async(_page,row)=>{
      visited.push(row["ИНН"]);
      return payload({inn:row["ИНН"],name:row["Организация"],
        count:0,phones:[]});
    }
  });
  assert.deepEqual(visited,[rows[0]["ИНН"]]);
});

test("Saby identity with both detail sections missing stays deferred and cannot mutate CRM",async()=>{
  const row=company(), before=structuredClone(row), snapshots=[];
  const record=payload();
  record.contacts={status:"missing",phones:[],emails:[]};
  record.trucks={status:"missing"};
  const out=await runSabyStage12({
    result:base([row]),env:{SABY_STAGE12_ENABLED:"true",
      SABY_MAX_COMPANIES:"1",SABY_CHECKPOINT_EVERY:"1"},
    sessionRunner:fakeSession,
    collectCompany:async()=>record,
    onCheckpoint:async snap=>snapshots.push(snap)
  });
  assert.equal(out.stats.processed,1);
  assert.equal(out.stats.verified,0);
  assert.equal(out.stats.review,1);
  assert.equal(out.stats.phonesAdded,0);
  assert.equal(out.stats.transportsAdded,0);
  assert.deepEqual(out.completedInns,[]);
  assert.deepEqual(out.deferredInns,["7707083893"]);
  assert.deepEqual(snapshots.at(-1).deferredInns,["7707083893"]);
  assert.deepEqual(row,before);
});

test("intermediary is not completed from a truck section when required contacts are missing",async()=>{
  const row=company(),before=structuredClone(row);
  const record=payload();
  record.contacts={status:"missing",phones:[],emails:[]};
  const result={direct_buyers:[],intermediaries:[row],leasing:[],statistics:[]};
  const out=await runSabyStage12({
    result,env:{SABY_STAGE12_ENABLED:"true",SABY_MAX_COMPANIES:"1"},
    sessionRunner:fakeSession,collectCompany:async()=>record
  });
  assert.equal(out.stats.verified,0);
  assert.equal(out.stats.review,1);
  assert.deepEqual(out.deferredInns,["7707083893"]);
  assert.deepEqual(row,before);
});

test("verified empty contact section is distinct from a missing section",async()=>{
  const row=company();
  const record=payload();
  record.contacts={status:"collected",phones:[],emails:[]};
  record.trucks={status:"missing"};
  const out=await runSabyStage12({
    result:base([row]),env:{SABY_STAGE12_ENABLED:"true",SABY_MAX_COMPANIES:"1"},
    sessionRunner:fakeSession,collectCompany:async()=>record
  });
  assert.equal(out.stats.verified,1);
  assert.equal(out.stats.review,0);
  assert.equal(out.stats.partialResults,1);
  assert.deepEqual(out.completedInns,[]);
  assert.deepEqual(out.deferredInns,["7707083893"]);
  assert.equal(row.__evidence.saby.collection.contacts,"collected");
  assert.equal(row.__evidence.saby.collection.trucks,"missing");
});

test("browser failure leaves source data intact, safely defers the work",async()=>{
  const row=company(),result=base([row]);
  const out=await runSabyStage12({result,env:{SABY_STAGE12_ENABLED:"true"},
    sessionRunner:async()=>{throw Error("not signed in");}});
  assert.match(out.stats.browserError,/not signed in/);
  assert.equal(out.stats.deferred,1);
  assert.deepEqual(out.deferredInns,["7707083893"]);
  assert.equal(row["Телефон"],"");
});

test("pipeline stage 12 is after final QA and has no own paid web calls",()=>{
  const source=readFileSync(new URL("../src/pipeline.js",import.meta.url),"utf8");
  assert.match(source,/runCheckpointedSabyStage12\(/);
  assert.ok(source.indexOf("finalizeProductionResearch(finalResult")<
    source.lastIndexOf("runCheckpointedSabyStage12("));
  assert.match(source,/saby_completed_inns/);
  assert.match(source,/stage12_duration_ms/);
});

test("one verified Saby phone is saved while unverified direct-buyer fleet stays deferred",async()=>{
  const row=company(),result=base([row]),snapshots=[];
  const record=payload({sourceUrl:
    "https://profile.saby.ru/page/contractor-info?anchor=about&id=CARD_A"});
  record.identity.kpp="770701001";
  record.trucks={status:"review"};
  record.errors=["trucks: private website detail, never save into evidence"];
  const out=await runSabyStage12({
    result,env:{SABY_STAGE12_ENABLED:"true",SABY_MAX_COMPANIES:"1",
      SABY_CHECKPOINT_EVERY:"1"},
    sessionRunner:fakeSession,collectCompany:async()=>record,
    onCheckpoint:async x=>snapshots.push(x)
  });
  assert.equal(out.stats.verified,1,"identity and phone were verified");
  assert.equal(out.stats.partialResults,1);
  assert.equal(out.stats.phonesAdded,1);
  assert.equal(out.stats.transportsAdded,0);
  assert.equal(out.stats.deferred,1);
  assert.deepEqual(out.completedInns,[]);
  assert.deepEqual(out.deferredInns,["7707083893"]);
  assert.deepEqual(snapshots.at(-1).completedInns,[]);
  assert.deepEqual(snapshots.at(-1).deferredInns,["7707083893"]);
  assert.equal(row["Телефон"],"79991234567");
  assert.equal(row.__evidence.saby.collection.contacts,"collected");
  assert.equal(row.__evidence.saby.collection.trucks,"review");
  assert.equal(row.__evidence.saby.kpp,"770701001");
  assert.equal(row.__evidence.saby.trucks,undefined);
  assert.doesNotMatch(JSON.stringify(row.__evidence.saby.collection),
    /private website detail/);
});

test("later fleet-only retry completes a buyer while preserving old verified phone and email",async()=>{
  const row=company(),result=base([row]);
  const detailUrl="https://profile.saby.ru/page/contractor-info?id=CARD_A";
  const first=payload({sourceUrl:detailUrl});
  first.identity.kpp="770701001";
  first.trucks={status:"review"};
  const firstOut=await runSabyStage12({
    result,env:{SABY_STAGE12_ENABLED:"true",SABY_MAX_COMPANIES:"1"},
    sessionRunner:fakeSession,collectCompany:async()=>first
  });
  assert.equal(firstOut.stats.deferred,1);
  assert.equal(row["Телефон"],"79991234567");
  const next=payload({sourceUrl:detailUrl});
  next.identity.kpp="770701001";
  next.contacts={status:"missing",phones:[],emails:[]};
  const secondOut=await runSabyStage12({
    result,completedInns:firstOut.completedInns,
    env:{SABY_STAGE12_ENABLED:"true",SABY_MAX_COMPANIES:"1"},
    sessionRunner:fakeSession,collectCompany:async()=>next
  });
  assert.equal(secondOut.stats.verified,1);
  assert.equal(secondOut.stats.deferred,0);
  assert.equal(secondOut.stats.partialResults,0);
  assert.deepEqual(secondOut.completedInns,["7707083893"]);
  assert.equal(row["Телефон"],"79991234567");
  assert.deepEqual(row.__evidence.saby.phones,["79991234567"]);
  assert.deepEqual(row.__evidence.saby.emails,["info@example.ru"]);
  assert.equal(row.__evidence.saby.collection.contacts,"collected");
  assert.equal(row.__evidence.saby.collection.trucks,"verified");
  assert.match(row["Наличие транспорта"],/Saby \(грузовые\):/);
  assert.equal(sabyStoredSectionCoverage(row,{transport:true}).complete,true);
});

test("legacy completed checkpoint with explicit missing trucks is requeued for recovery",async()=>{
  const row=company(),result=base([row]);
  const detailUrl="https://profile.saby.ru/page/contractor-info?id=LEGACY";
  const first=payload({sourceUrl:detailUrl});
  first.trucks={status:"review"};
  applySabyEnrichment(row,first,{transport:true});
  // v11 did not store KPP in the evidence, so recover by the same card ID.
  assert.equal(row.__evidence.saby.kpp,undefined);
  const next=payload({sourceUrl:detailUrl});
  next.contacts={status:"missing",phones:[],emails:[]};
  const calls=[];
  const out=await runSabyStage12({
    result,completedInns:["7707083893"],
    env:{SABY_STAGE12_ENABLED:"true",SABY_MAX_COMPANIES:"1"},
    sessionRunner:fakeSession,collectCompany:async()=>{calls.push(1);return next;}
  });
  assert.equal(calls.length,1,"old partial completion must be retried");
  assert.equal(out.stats.previouslyCompleted,0);
  assert.equal(out.stats.verified,1);
  assert.equal(out.stats.deferred,0);
  assert.deepEqual(out.completedInns,["7707083893"]);
  assert.deepEqual(row.__evidence.saby.phones,["79991234567"]);
  assert.equal(row.__evidence.saby.collection.trucks,"verified");
});

test("different Saby card or changed KPP must not merge previously verified sections",()=>{
  for(const newUrl of [
    "https://profile.saby.ru/page/contractor-info?id=CARD_B",
    "https://profile.saby.ru/page/contractor-info?id=CARD_A"
  ]) {
    const row=company();
    const first=payload({sourceUrl:
      "https://profile.saby.ru/page/contractor-info?id=CARD_A"});
    first.identity.kpp="770701001";
    first.trucks={status:"review"};
    applySabyEnrichment(row,first,{transport:true});
    const next=payload({sourceUrl:newUrl});
    next.identity.kpp=newUrl.endsWith("CARD_A")?"770701002":"770701001";
    next.contacts={status:"missing",phones:[],emails:[]};
    applySabyEnrichment(row,next,{transport:true});
    const saved=row.__evidence.saby;
    assert.equal(saved.collection.contacts,"missing");
    assert.equal(saved.collection.trucks,"verified");
    assert.deepEqual(saved.phones,[]);
    assert.deepEqual(saved.emails,[]);
    assert.equal(sabyStoredSectionCoverage(row,{transport:true}).complete,false);
    // Old displayed phone is never deleted, but is not newly attributed to
    // a different company's fleet and does not certify completion.
    assert.equal(row["Телефон"],"79991234567");
  }
});

test("intermediary completes from verified contacts, no vehicle section required",async()=>{
  const row=company();
  const record=payload();
  record.trucks={status:"review"};
  const result={direct_buyers:[],intermediaries:[row],leasing:[],statistics:[]};
  const out=await runSabyStage12({
    result,env:{SABY_STAGE12_ENABLED:"true",SABY_MAX_COMPANIES:"1"},
    sessionRunner:fakeSession,collectCompany:async()=>record
  });
  assert.equal(out.stats.verified,1);
  assert.equal(out.stats.deferred,0);
  assert.deepEqual(out.completedInns,["7707083893"]);
  assert.equal(sabyStoredSectionCoverage(row,{transport:false}).complete,true);
});
