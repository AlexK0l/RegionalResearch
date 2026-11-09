import test from "node:test";
import assert from "node:assert/strict";
import { applySabyEnrichment, sabyEligibleRows, sabySearchResultMatches,
  sabyNameMatches } from "../src/sabyEnrichment.js";
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
    contacts:{phones,emails:["info@example.ru"]},
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
  assert.match(row.__comment,/^Email: info@example\\.ru$/m);
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
  assert.match(row.__comment,/^Email: official@example\\.ru$/m);
  assert.match(row.__comment,/Saby:.*email info@example\\.ru/);
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
  assert.match(source,/runSabyStage12\(/);
  assert.ok(source.indexOf("finalizeProductionResearch(finalResult")<
    source.lastIndexOf("runSabyStage12("));
  assert.match(source,/saby_completed_inns/);
  assert.match(source,/stage12_duration_ms/);
});
