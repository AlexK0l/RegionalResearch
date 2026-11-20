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
  nestedCells=true,yearLabels=years,revenueAmounts=values,employeeCount="8",
  bannerAmount="460.3"}={}){
  let hydrated=hydrateAfter===0;
  const yearHeaders=yearLabels.map(year=>visible(year));
  let readCount=0,waitCount=0;
  const rows=[];
  function tableRow(cells) {
    // The supplied 2026-11-20 Saby GridReact HTML uses tw-contents, so
    // its [data-qa=row] does not own a bounding box despite visible cells.
    const row=visible("",{getClientRects:()=>[],querySelectorAll(selector) {
      if(selector!=='[data-qa="cell"]')return [];
      return cells.map(cell=>visible(cell,nestedCells?{
        closest:q=>q==='[data-qa="row"]'?row:null
      }:{}));
    }});
    return row;
  }
  rows.push(tableRow(["Доходы","2110+2320",...revenueAmounts]));
  if(includeRevenue)rows.push(tableRow(["От основной","деятельности",...revenueAmounts]));
  rows.push(tableRow(["Расходы","2120",...revenueAmounts]));
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
  const employee=visible(employeeCount,{closest:()=>visible(employeeCount+" сотрудников")});
  const document={
    querySelectorAll(selector){
      if(selector==='[data-qa="ContractorCard_Employees"]')return [employee];
      if(selector==='[data-qa="contractorCard-CardRatingBanner__Revenue"]')
        return [visible("Выручка: "+bannerAmount+" млн ₽")];
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

test("real Saby 2026-11-20 DOM structure: 22 years, display:contents rows, 2025 revenue and staff",async()=>{
  // Numeric annual series and CSS structure transcribed from supplied Saby
  // card; no private profile HTML, company identity or login metadata.
  const yearLabels=Array.from({length:22},(_,i)=>String(i+2004));
  const revenueAmounts=[
    "51.4","50.9","63.5","63.8","92.2","93.7","104.5","123.2",
    "126.8","118.6","153.9","208.0","232.3","270.3","294.7",
    "289.1","308.5","313.1","350.2","336.7","403.1","440.1"
  ];
  const {page,stats}=fakePage({
    yearLabels,revenueAmounts,employeeCount:"119",bannerAmount:"440.1",
    headingText:"Выручка / Финансы"
  });
  assert.deepEqual(await readSabyFinancials(page),{
    status:"collected",revenue_rub:440100000,revenue_year:2025,employees:119
  });
  assert.equal(stats().readCount,1,
    "Saby finance table is already hydrated; one DOM read suffices");
});
