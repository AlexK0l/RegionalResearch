import test from "node:test";
import assert from "node:assert/strict";
import {readSabyFinancials} from "../src/sabyFinancials.js";

const visible=(value,extra={})=>({
  textContent:value,isConnected:true,getClientRects:()=>[{}],...extra
});

function lazyFinanceCard({mountOnScroll=true,canScroll=true,primaryAvailable=true,
  employeeUnmountsAfterScroll=false,initialRestoreFails=false,
  scrollMoveFailures=0}={}){
  let financeMounted=false;
  let reads=0;
  let waits=0;
  let itemClicks=0,restoreFailures=initialRestoreFails?1:0;
  let moveFailures=scrollMoveFailures;
  const scrollPositions=[],lookedUp=[];
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
      if(selector==='[data-qa="ContractorCard_Employees"]')
        return employeeUnmountsAfterScroll&&financeMounted?[]:[employee];
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
      if(restoreFailures>0&&String(fn).includes("el.scrollTop=top")){
        restoreFailures--;
        throw new Error("scroll node detached");
      }
      if(moveFailures>0&&String(fn).includes("el.scrollTop=Math.round")){
        moveFailures--;
        throw new Error("scroll wrapper remounted");
      }
      return fn(scroller,arg);
    }
  };
  const missingLocator={
    first(){return this;},
    evaluate:async()=>{throw new Error("main scroll wrapper not mounted yet");}
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
      lookedUp.push(selector);
      if(selector==='[data-qa="contractorCard-dialog-Stack"] '+
         '.controls-SlidingPanel__scrollWrapper > '+
         '[data-qa="controls-Scroll__content"]')
        return primaryAvailable?scrollerLocator:missingLocator;
      if(selector==='[data-qa="contractorCard-dialog-Stack"] '+
         '[data-qa="controls-Scroll__content"]')
        return scrollerLocator;
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
    scrollTop:scroller.scrollTop,scrollPositions,itemClicks,lookedUp})};
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

test("Saby uses scoped fallback when the profile child scroll wrapper is not ready",async()=>{
  const {page,metrics}=lazyFinanceCard({primaryAvailable:false});
  const result=await readSabyFinancials(page);
  assert.equal(result.revenue_rub,440100000);
  assert.equal(result.revenue_year,2025);
  assert.equal(result.employees,119);
  assert.equal(metrics().scrollTop,0);
  assert.equal(metrics().scrollPositions.length,2);
  assert.ok(metrics().lookedUp.some(x=>
    x.includes('[data-qa="contractorCard-dialog-Stack"] [data-qa="controls-Scroll__content"]')));
});

test("Saby scoped scroll selectors do not depend on unmounted contractor-BaseInfoView",async()=>{
  const {page,metrics}=lazyFinanceCard();
  assert.equal((await readSabyFinancials(page)).revenue_rub,440100000);
  assert.equal(metrics().lookedUp.some(x=>x.includes(".contractor-BaseInfoView")),false);
  assert.equal(metrics().lookedUp.some(x=>x.includes('body')),false);
});

test("verified employees survive virtualization after scrolling to the financial table",async()=>{
  const {page,metrics}=lazyFinanceCard({employeeUnmountsAfterScroll:true});
  const result=await readSabyFinancials(page);
  assert.equal(result.revenue_rub,440100000);
  assert.equal(result.revenue_year,2025);
  assert.equal(result.employees,119);
  assert.equal(metrics().scrollTop,0);
});

test("detached Saby scroll node can be reacquired to restore the original position",async()=>{
  const {page,metrics}=lazyFinanceCard({initialRestoreFails:true});
  const original=console.warn;
  console.warn=()=>{};
  try{
    const result=await readSabyFinancials(page);
    assert.equal(result.revenue_rub,440100000);
    assert.equal(result.employees,119);
    assert.equal(metrics().scrollTop,0);
    assert.deepEqual(metrics().scrollPositions,[800,0]);
  }finally{console.warn=original;}
});

test("Wasaby finance scroll recovers one transient wrapper remount in same verified card",async()=>{
  const {page,metrics}=lazyFinanceCard({scrollMoveFailures:1});
  const original=console.warn;
  console.warn=()=>{};
  try{
    const facts=await readSabyFinancials(page);
    assert.equal(facts.revenue_rub,440100000);
    assert.equal(facts.revenue_year,2025);
    assert.equal(facts.employees,119);
    assert.equal(metrics().scrollTop,0);
    assert.deepEqual(metrics().scrollPositions,[800,0]);
    assert.equal(metrics().itemClicks,0);
    assert.ok(metrics().lookedUp.every(x=>
      x.includes('[data-qa="contractorCard-dialog-Stack"]')||
      x.includes('item-key="finance"')),
      "reacquisition remains inside the known contractor card");
  }finally{console.warn=original;}
});

test("two consecutive finance scroll failures remain safely missing, never invent revenue",async()=>{
  const {page,metrics}=lazyFinanceCard({scrollMoveFailures:3});
  const original=console.warn,diag=[];
  console.warn=x=>diag.push(x);
  try{
    const facts=await readSabyFinancials(page);
    assert.equal(facts.revenue_rub,null);
    assert.equal(facts.revenue_year,null);
    assert.equal(facts.employees,119);
    assert.equal(metrics().scrollTop,0);
    assert.equal(metrics().itemClicks,0);
    assert.equal(diag.length,1);
    assert.match(diag[0],/"scroll":"scroll_failed"/);
    assert.match(diag[0],/"scroll_retries":1/);
    assert.doesNotMatch(diag[0],/company-list-prof|4718000935|440\.1/);
  }finally{console.warn=original;}
});

test("fast finance read does not wait, scroll, guess a revenue or hide the full lazy read",async()=>{
  const {page,metrics}=lazyFinanceCard();
  const quick=await readSabyFinancials(page,{visibleOnly:true});
  assert.deepEqual(quick,{status:"collected",revenue_rub:null,revenue_year:null,employees:119});
  assert.equal(metrics().reads,1);
  assert.equal(metrics().waits,0);
  assert.deepEqual(metrics().scrollPositions,[]);
  const full=await readSabyFinancials(page);
  assert.equal(full.revenue_rub,440100000);
  assert.equal(full.employees,119);
});
test("when revenue is already known and staff is visible skip the unrelated finance scroll",async()=>{
  const {page,metrics}=lazyFinanceCard();
  const read=await readSabyFinancials(page,{needsRevenue:false});
  assert.equal(read.employees,119);
  assert.equal(metrics().reads,1);
  assert.equal(metrics().waits,0);
  assert.deepEqual(metrics().scrollPositions,[]);
});
