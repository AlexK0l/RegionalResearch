import test from "node:test";
import assert from "node:assert/strict";

import {
  parseSabyMoneyRub,parseSabyFinancialSnapshot,
  validSabyFinancialEvidence,readSabyFinancials
} from "../src/sabyFinancials.js";
import {applySabyEnrichment,sabyStoredSectionCoverage}
  from "../src/sabyEnrichment.js";
import {runSabyStage12} from "../src/sabyStage12.js";
import { recoverSabyMissingSections } from "../src/sabyRecovery.js";

// These values and selector shapes are taken from the HTML sent on 2026-11-19;
// do not commit its private cookies, company identities or minified scripts.
const exampleSnapshot=()=>({
  years:["2016","2017","2018","2019","2020",
    "2021","2022","2023","2024","2025"],
  reportScale:"млн ₽",
  revenueRows:[["0.0","0.0","0.0","0.0","3.7",
    "31.7","48.8","160.4","279.4","460.3"]],
  banner:"Выручка: 460.3 млн ₽",
  employeeTexts:["8"]
});
const company=()=>({
  "Организация":"ООО «Тестовая компания»",
  "ИНН":"7707083893",
  "Основание":"B — целевой груз и подтвержденная автологистика",
  "Выручка последнего подтвержденного года":"",
  "Численность":"",
  "__comment":"Сайт/источник: https://company.example",
  "Телефон":""
});
const record=(financials,overrides={})=>({
  source:"SABY",source_url:"https://profile.saby.ru/page/contractor-info?id=company-1",
  collected_at:"2026-11-19T08:00:00.000Z",
  identity:{inn:"7707083893",name:"ООО «Тестовая компания»",verified:true},
  contacts:{status:"collected",phones:[],emails:[]},
  trucks:{status:"missing"},financials,errors:[],
  ...overrides
});

test("provided Saby revenue in millions becomes rubles; 8 employees is not the salary",()=>{
  const data=parseSabyFinancialSnapshot(exampleSnapshot(),{nowYear:2026});
  assert.deepEqual(data,{
    status:"collected",revenue_rub:460300000,revenue_year:2025,employees:8
  });
  assert.equal(parseSabyMoneyRub("460,3 млн ₽"),460300000);
  assert.equal(parseSabyMoneyRub("1 250 тыс ₽"),1250000);
  assert.equal(parseSabyMoneyRub("1,2 млрд ₽"),1200000000);
  assert.equal(parseSabyMoneyRub("35 000 ₽"),35000);
  assert.equal(parseSabyMoneyRub("рост +65%"),null);
  assert.equal(parseSabyMoneyRub("-100 млн ₽"),null);
  assert.equal(parseSabyMoneyRub("Стоимость: 607.8 млн ₽"),null);
});

test("year is mandatory; no future year, no mismatched banner, no fake zero",()=>{
  const source=exampleSnapshot();
  source.years=[];
  assert.deepEqual(parseSabyFinancialSnapshot(source,{nowYear:2026}),{
    status:"collected",revenue_rub:null,revenue_year:null,employees:8
  });
  source.years=exampleSnapshot().years;
  source.years[9]="2027";
  assert.equal(parseSabyFinancialSnapshot(source,{nowYear:2026}).revenue_rub,null);
  source.years=exampleSnapshot().years;
  source.banner="Выручка: 607.8 млн ₽";
  assert.equal(parseSabyFinancialSnapshot(source,{nowYear:2026}).revenue_rub,null);
  source.banner="Выручка: 460.3 млн ₽";
  source.revenueRows=[["0","0","0","0","0","0","0","0","0","0"]];
  assert.equal(parseSabyFinancialSnapshot(source,{nowYear:2026}).revenue_rub,null);
  source.revenueRows=[exampleSnapshot().revenueRows[0].slice(0,9)];
  assert.equal(parseSabyFinancialSnapshot(source,{nowYear:2026}).revenue_rub,null);
});

test("missing or ambiguous employee widget is not silently guessed",()=>{
  const source=exampleSnapshot();
  source.employeeTexts=["8","9"];
  assert.equal(parseSabyFinancialSnapshot(source).employees,null);
  source.employeeTexts=["~ 35 000 ₽"];
  assert.equal(parseSabyFinancialSnapshot(source).employees,null);
  source.employeeTexts=["8","8"];
  assert.equal(parseSabyFinancialSnapshot(source).employees,8);
  source.employeeTexts=["0"];
  assert.equal(parseSabyFinancialSnapshot(source).employees,0);
  source.employeeTexts=[];
  assert.equal(parseSabyFinancialSnapshot(source).employees,null);
  assert.equal(validSabyFinancialEvidence({status:"collected",employees:"8"}),null);
});

test("browser collector reads precisely labelled DOM widgets from a verified card",async()=>{
  const old=globalThis.document;
  const node=(s,extra={})=>({
    textContent:s,isConnected:true,getClientRects:()=>[{}],...extra
  });
  const financialSection={
    querySelectorAll(selector){
      if(selector===".analytics-FinAnalysis__stickerHeader_right")
        return ["Строка",...exampleSnapshot().years].map(s=>node(s));
      if(selector==='[data-qa="row"]')
        return [
          node("",{querySelectorAll:()=>["Доходы","2110 + 2320",...exampleSnapshot().revenueRows[0]].map(s=>node(s))}),
          node("",{querySelectorAll:()=>["От основной","деятельности",...exampleSnapshot().revenueRows[0]].map(s=>node(s))}),
          node("",{querySelectorAll:()=>["Расходы","2120",...exampleSnapshot().revenueRows[0]].map(s=>node(s))})
        ];
      return [];
    },
    querySelector(selector){
      if(selector===".analytics-FinAnalysis__stickerHeader_left")return node("млн ₽");
      return null;
    }
  };
  const employee=node("8",{
    closest:()=>node("8 сотрудников")
  });
  const heading=node("Выручка / Финансы",{
    closest:()=>financialSection
  });
  globalThis.document={
    querySelectorAll(selector){
      if(selector==='[data-qa="ContractorCard_Employees"]')return [employee];
      if(selector==='[data-qa="contractorCard-CardRatingBanner__Revenue"]')
        return [node("Выручка: 460.3 млн ₽")];
      if(selector==='[data-qa="analytics-finanalysis"]')return [heading];
      return [];
    }
  };
  try {
    const collected=await readSabyFinancials({evaluate:fn=>fn()});
    assert.deepEqual(collected,{
      status:"collected",revenue_rub:460300000,revenue_year:2025,employees:8
    });
  } finally {
    if(old===undefined)delete globalThis.document;
    else globalThis.document=old;
  }
});

test("Saby fills existing monetary/staff columns and persists audited year",()=>{
  const row=company();
  const beforeGrade=row["Основание"];
  const outcome=applySabyEnrichment(row,record(parseSabyFinancialSnapshot(exampleSnapshot())),{
    transport:false
  });
  assert.equal(outcome.status,"ok");
  assert.equal(outcome.revenueAdded,true);
  assert.equal(outcome.employeesAdded,true);
  assert.equal(row["Выручка последнего подтвержденного года"],460300000);
  assert.equal(row["Численность"],8);
  assert.equal(row["Основание"],beforeGrade);
  assert.deepEqual(row.__evidence.saby.financials,{
    status:"collected",revenue_rub:460300000,revenue_year:2025,employees:8
  });
  assert.equal(row.__evidence.saby.collection.financials,"collected");
  assert.match(row.__comment,/выручка 2025 г. 460300000 ₽/);
  assert.match(row.__comment,/сотрудников 8/);
  assert.match(row.__comment,/https:\/\/profile\.saby\.ru\//);
  const preserved=JSON.stringify(row);
  const again=applySabyEnrichment(row,record(parseSabyFinancialSnapshot(exampleSnapshot())));
  assert.equal(again.revenueAdded,false);
  assert.equal(again.employeesAdded,false);
  assert.equal(JSON.stringify(row),preserved);
});

test("existing researched values never overwritten, even when different",()=>{
  const row=company();
  row["Выручка последнего подтвержденного года"]=500000000;
  row["Численность"]="14";
  const res=applySabyEnrichment(row,record(parseSabyFinancialSnapshot(exampleSnapshot())));
  assert.equal(res.status,"ok");
  assert.equal(res.revenueAdded,false);
  assert.equal(res.employeesAdded,false);
  assert.equal(row["Выручка последнего подтвержденного года"],500000000);
  assert.equal(row["Численность"],"14");
  assert.equal(row.__evidence.saby.financials.revenue_year,2025);
});

test("wrong identity or forged host never touches company financial data",()=>{
  const row=company();
  const a=record(parseSabyFinancialSnapshot(exampleSnapshot()),{
    identity:{inn:"1234567890",name:"ООО «Тестовая компания»",verified:true}
  });
  const before=JSON.stringify(row);
  assert.equal(applySabyEnrichment(row,a).status,"review");
  assert.equal(JSON.stringify(row),before);
  const b=record(parseSabyFinancialSnapshot(exampleSnapshot()),{
    source_url:"https://profile.saby.ru.evil.example/page/contractor-info"
  });
  assert.equal(applySabyEnrichment(row,b).status,"review");
  assert.equal(JSON.stringify(row),before);
});

test("fleet-only retry retains financial facts for the same verified card",()=>{
  const row=company();
  const first=record(parseSabyFinancialSnapshot(exampleSnapshot()));
  applySabyEnrichment(row,first);
  const second=record({status:"missing"},{contacts:{status:"missing"},
    trucks:{status:"missing"}});
  applySabyEnrichment(row,second);
  assert.equal(row.__evidence.saby.financials.revenue_rub,460300000);
  assert.equal(row.__evidence.saby.financials.employees,8);
  assert.equal(row.__evidence.saby.collection.financials,"collected");
});

test("finance-only Saby outcome saves both values but leaves missing contacts deferred",async()=>{
  const row=company();
  const financials=parseSabyFinancialSnapshot(exampleSnapshot());
  const out=await runSabyStage12({
    result:{direct_buyers:[],intermediaries:[row],leasing:[],statistics:[]},
    env:{SABY_STAGE12_ENABLED:"true",SABY_MAX_COMPANIES:"0",
      STAGE12_MAX_MS:"60000",SABY_DELAY_MS:"0"},
    sessionRunner:async task=>task({page:{},settings:{}}),
    collectCompany:async()=>record(financials,{
      contacts:{status:"missing",phones:[],emails:[]},
      trucks:{status:"missing"}
    })
  });
  assert.equal(out.stats.processed,1);
  assert.equal(out.stats.verified,1);
  assert.equal(out.stats.revenuesAdded,1);
  assert.equal(out.stats.employeesAdded,1);
  assert.equal(out.stats.deferred,1,"financials do not mark unfinished contacts complete");
  assert.equal(row["Выручка последнего подтвержденного года"],460300000);
  assert.equal(row["Численность"],8);
  assert.equal(sabyStoredSectionCoverage(row).complete,false);
});

test("old already completed company stays complete without financial recollection",async()=>{
  const row=company();
  const first=record(parseSabyFinancialSnapshot(exampleSnapshot()));
  applySabyEnrichment(row,first);
  delete row["Выручка последнего подтвержденного года"];
  delete row["Численность"];
  delete row.__evidence.saby.financials;
  delete row.__evidence.saby.collection.financials;
  const out=await runSabyStage12({
    result:{direct_buyers:[],intermediaries:[row],leasing:[],statistics:[]},
    completedInns:["7707083893"],
    env:{SABY_STAGE12_ENABLED:"true"},
    sessionRunner:()=>{throw Error("must not rerun completed Saby");}
  });
  assert.equal(out.stats.processed,0);
  assert.equal(out.stats.previouslyCompleted,1);
});


test("one bounded hydration retry keeps source-bound financials without any new Saby search",async()=>{
  const first=record(parseSabyFinancialSnapshot(exampleSnapshot()),{
    contacts:{status:"missing"},trucks:{status:"missing"}
  });
  const retry=record({status:"missing"},{
    contacts:{status:"collected",phones:[],emails:[]},
    trucks:{status:"missing"}
  });
  let times=0;
  const result=await recoverSabyMissingSections(async()=>{
    times++;return times===1?first:retry;
  },{});
  assert.equal(times,2);
  assert.equal(result.contacts.status,"collected");
  assert.deepEqual(result.financials,{
    status:"collected",revenue_rub:460300000,revenue_year:2025,employees:8
  });
  const other=record({status:"missing"},{
    source_url:"https://profile.saby.ru/page/contractor-info?id=different-branch",
    contacts:{status:"collected"},trucks:{status:"missing"}
  });
  times=0;
  const rejected=await recoverSabyMissingSections(async()=>{
    times++;return times===1?first:other;
  },{});
  assert.equal(rejected.financials.status,"missing",
    "same INN on a different private company card cannot inherit revenue");

  times=0;
  const employeesOnly=record({status:"collected",employees:9},{
    contacts:{status:"collected"},trucks:{status:"missing"}
  });
  const combined=await recoverSabyMissingSections(async()=>{
    times++;return times===1?first:employeesOnly;
  },{});
  assert.deepEqual(combined.financials,{
    status:"collected",revenue_rub:460300000,revenue_year:2025,
    employees:9
  },"new headcount may update while first-attempt revenue is retained");
});
