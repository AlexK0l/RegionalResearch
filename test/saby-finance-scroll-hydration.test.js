import test from "node:test";
import assert from "node:assert/strict";
import {readSabyFinancials} from "../src/sabyFinancials.js";

const visible=(value,extra={})=>({
  textContent:value,isConnected:true,getClientRects:()=>[{}],...extra
});

function lazyFinanceCard({mountOnScroll=true,canScroll=true}={}){
  let financeMounted=false;
  let reads=0;
  let waits=0;
  let itemClicks=0;
  const scrollPositions=[];
  const scroller={
    position:0,clientHeight:800,scrollHeight:2400,
    get scrollTop(){return this.position;},
    set scrollTop(value){
      this.position=value;
      scrollPositions.push(value);
      if(mountOnScroll && value>=750)financeMounted=true;
    }
  };
  const years=["2024","2025"].map(visible);
  const row=visible("",{getClientRects:()=>[],querySelectorAll:selector=>
    selector==='[data-qa="cell"]'
      ? ["От основной","деятельности","403.1","440.1"].map(value=>
          visible(value,{closest:()=>row})):[]});
  const report={
    querySelectorAll(selector){
      if(selector===".analytics-FinAnalysis__stickerHeader_right")return years;
      if(selector==='[data-qa="row"]')return [row];
      return [];
    },
    querySelector(selector){
      if(selector===".analytics-FinAnalysis__stickerHeader_left")
        return visible("млн ₽");
      return null;
    }
  };
  const heading=visible("Выручка / Финансы",{closest:sel=>
    sel===".analytics-FinAnalysis__margin"?report:null});
  const employee=visible("119",{closest:()=>visible("119 сотрудников")});
  const document={
    querySelectorAll(selector){
      if(selector==='[data-qa="ContractorCard_Employees"]')return [employee];
      if(selector==='[data-qa="contractorCard-CardRatingBanner__Revenue"]')
        return [visible("Выручка: 440.1 млн ₽")];
      if(selector==='[data-qa="analytics-finanalysis"]')
        return financeMounted?[heading]:[];
      if(selector==='[data-qa="item"][item-key="finance"]')
        return financeMounted?[visible("")]:[];
      return [];
    }
  };
  const scrollerLocator={
    first(){return this;},
    evaluate:async(fn,arg)=>{
      if(!canScroll)throw new Error("scroller not attached");
      return fn(scroller,arg);
    }
  };
  const itemLocator={
    first(){return this;},
    count:async()=>financeMounted?1:0,
    scrollIntoViewIfNeeded:async()=>{
      itemClicks++;
      scroller.scrollTop=1300;
    }
  };
  const page={
    locator(selector){
      if(selector==='[data-qa="controls-Scroll__content"]')
        return {filter:()=>scrollerLocator};
      if(selector===".contractor-BaseInfoView")return {};
      if(selector==='[data-qa="item"][item-key="finance"]')
        return itemLocator;
      throw new Error("Unexpected selector: "+selector);
    },
    evaluate:async(fn)=>{
      const old=globalThis.document;
      globalThis.document=document;
      try{reads++;return fn();}
      finally{
        if(old===undefined)delete globalThis.document;
        else globalThis.document=old;
      }
    },
    waitForTimeout:async()=>{waits++;}
  };
  return {page,metrics:()=>({financeMounted,reads,waits,
    scrollTop:scroller.scrollTop,scrollPositions,itemClicks})};
}

test("Saby scrolls only inside detail viewer to mount missing finance and restores position",async()=>{
  const {page,metrics}=lazyFinanceCard();
  const actual=await readSabyFinancials(page);
  assert.deepEqual(actual,{status:"collected",
    revenue_rub:440100000,revenue_year:2025,employees:119});
  assert.equal(metrics().financeMounted,true);
  assert.equal(metrics().scrollTop,0,
    "card scroll position restored before contact/fleet readers");
  assert.deepEqual(metrics().scrollPositions,[800,0]);
  assert.equal(metrics().itemClicks,0,
    "no finance navigation/click for lazy mounted target");
  assert.equal(metrics().reads,4,
    "first read, two passive retries, one after finance scroll");
});

test("Saby cannot fabricate revenue from banner when finance section never mounts",async()=>{
  const {page,metrics}=lazyFinanceCard({mountOnScroll:false});
  const original=console.warn;
  const diagnostics=[];
  console.warn=line=>diagnostics.push(line);
  try{
    assert.deepEqual(await readSabyFinancials(page),{
      status:"collected",revenue_rub:null,revenue_year:null,employees:119
    });
  }finally{console.warn=original;}
  assert.equal(metrics().scrollTop,0);
  assert.equal(metrics().scrollPositions.length,5,
    "four bounded positions and one restore");
  assert.equal(metrics().itemClicks,0);
  assert.equal(diagnostics.length,1);
  assert.match(diagnostics[0],/"code":"no_heading"/);
  assert.match(diagnostics[0],/"scroll":"scrollable"/);
  assert.match(diagnostics[0],/"scroll_steps":4/);
  assert.doesNotMatch(diagnostics[0],/4718000935|private profile|440\.1/);
});

test("missing contractor scroll viewer leaves already verified employee count intact",async()=>{
  const {page,metrics}=lazyFinanceCard({canScroll:false});
  const warn=console.warn;
  console.warn=()=>{};
  try{
    assert.deepEqual(await readSabyFinancials(page),{
      status:"collected",revenue_rub:null,revenue_year:null,employees:119
    });
  }finally{console.warn=warn;}
  assert.equal(metrics().scrollPositions.length,0);
  assert.equal(metrics().itemClicks,0);
});
