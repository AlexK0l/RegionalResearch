import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSabyMoneyRub, parseSabyFinancialSnapshot, readSabyFinancials
} from "../src/sabyFinancials.js";

const years=["2023","2024","2025"];
const values=["160.4","279.4","460.3"];
const visible=(s,extra={})=>({
  textContent:s,isConnected:true,getClientRects:()=>[{}],...extra
});

function fakePage({hydrateAfter=0,includeRevenue=true,
  headingText="Выручка / Финансы 2023 2024 2025",
  nestedCells=true}={}){
  let hydrated=hydrateAfter===0;
  const yearHeaders=years.map(year=>visible(year));
  let readCount=0,waitCount=0;
  const rows=[];
  function tableRow(cells) {
    const row=visible("",{querySelectorAll(selector) {
      if(selector!=='[data-qa="cell"]')return [];
      return cells.map(cell=>visible(cell,nestedCells?{
        closest:q=>q==='[data-qa="row"]'?row:null
      }:{}));
    }});
    return row;
  }
  rows.push(tableRow(["Доходы","2110+2320",...values]));
  if(includeRevenue)rows.push(tableRow(["От основной","деятельности",...values]));
  rows.push(tableRow(["Расходы","2120",...values]));
  const report={
    querySelectorAll(selector) {
      if(selector===".analytics-FinAnalysis__stickerHeader_right")
        return yearHeaders;
      if(selector==='[data-qa="row"]')return hydrated?rows:[];
      return [];
    },
    querySelector(selector) {
      if(selector===".analytics-FinAnalysis__stickerHeader_left")
        return visible("млн ₽");
      return null;
    }
  };
  const heading=visible(headingText,{closest:selector=>
    selector===".analytics-FinAnalysis__margin"?report:null});
  const employee=visible("8",{closest:()=>visible("8 сотрудников")});
  const document={
    querySelectorAll(selector){
      if(selector==='[data-qa="ContractorCard_Employees"]')return [employee];
      if(selector==='[data-qa="contractorCard-CardRatingBanner__Revenue"]')
        return [visible("Выручка: 460.3 млн ₽")];
      if(selector==='[data-qa="analytics-finanalysis"]')return [heading];
      return [];
    }
  };
  return {
    page:{
      evaluate:fn=>{
        const old=globalThis.document;
        globalThis.document=document;
        try{readCount++;return fn();}
        finally{if(old===undefined)delete globalThis.document;
          else globalThis.document=old;}
      },
      waitForTimeout:async()=>{waitCount++;hydrated=true;}
    },
    stats:()=>({readCount,waitCount})
  };
}

test("Saby financial reader accepts header containing entire widget and nested data-qa cells",async()=>{
  const {page,stats}=fakePage();
  assert.deepEqual(await readSabyFinancials(page),{
    status:"collected",revenue_rub:460300000,revenue_year:2025,employees:8
  });
  assert.equal(stats().readCount,1);
});

test("bounded finance hydration retry re-reads current page without changing Saby card",async()=>{
  const {page,stats}=fakePage({hydrateAfter:1});
  assert.deepEqual(await readSabyFinancials(page),{
    status:"collected",revenue_rub:460300000,revenue_year:2025,employees:8
  });
  assert.equal(stats().waitCount,1);
  assert.equal(stats().readCount,2);
});

test("no verified 2110 row never substitutes aggregate income, costs or the banner",async()=>{
  const {page,stats}=fakePage({includeRevenue:false});
  const old=console.warn;
  console.warn=()=>{};
  try{
    const result=await readSabyFinancials(page);
    assert.deepEqual(result,{
      status:"collected",revenue_rub:null,revenue_year:null,employees:8
    });
    assert.equal(stats().waitCount,2);
  }finally{console.warn=old;}
});

test("upper-case scale and repeated identical 2110 rows keep exact integer rubles",()=>{
  assert.equal(parseSabyMoneyRub("460,3 МЛН ₽"),460300000);
  assert.equal(parseSabyMoneyRub("460.3","МЛН ₽"),460300000);
  assert.equal(parseSabyMoneyRub("1,2 МЛРД ₽"),1200000000);
  const one={years,reportScale:"МЛН ₽",
    revenueRows:[values.slice(),values.slice()],banner:"Выручка: 460,3 МЛН ₽",
    employeeTexts:["8"]};
  assert.equal(parseSabyFinancialSnapshot(one,{nowYear:2026}).revenue_rub,460300000);
  one.revenueRows=[values,["160.4","279.4","480.3"]];
  assert.equal(parseSabyFinancialSnapshot(one,{nowYear:2026}).revenue_rub,null);
});

test("bad financial banner with extra text cannot veto a matched, year-aligned financial row",()=>{
  assert.equal(parseSabyFinancialSnapshot({
    years,reportScale:"млн ₽",revenueRows:[values],
    banner:"Выручка: 460.3 млн ₽, рост за год +65%",employeeTexts:["8"]
  },{nowYear:2026}).revenue_rub,460300000);
});
