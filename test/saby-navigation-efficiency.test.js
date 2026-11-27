import test from "node:test";
import assert from "node:assert/strict";
import {runSabyContactFirst} from "../src/sabyContactFirst.js";
import {rememberSabyNavigationHint,storedSabyNavigationHint} from "../src/sabyVisitPolicy.js";
import {scanSabyLegacyDOM,scanSabyResultDOM,consolidateSabyResultRows} from "../src/sabySearchRows.js";

const inn="1234567890",name="ООО Альфа";
const route="https://profile.saby.ru/page/contractor-info?id=11111111-1111-4111-8111-111111111111";
const other="https://profile.saby.ru/page/contractor-info?id=22222222-2222-4222-8222-222222222222";
const row=()=>({"ИНН":inn,"Организация":name,"Телефон":"",
  "Выручка последнего подтвержденного года":0,"Численность":0});
const record=(extra={})=>({identity:{inn,name,verified:true},source_url:route,
  collected_at:"2026-11-27T00:00:00Z",contacts:{status:"missing",phones:[],emails:[]},
  financials:{status:"missing"},trucks:{status:"missing"},...extra});

test("verified navigation observation survives changed widget route; unsafe or conflicting hint does not replace it",()=>{
  const r=row();
  assert.equal(rememberSabyNavigationHint(r,record({source_url:other,
    verified_navigation_url:route})),true);
  assert.equal(storedSabyNavigationHint(r),route);
  assert.equal(rememberSabyNavigationHint(r,record({verified_navigation_url:other})),false);
  assert.equal(rememberSabyNavigationHint(r,record({verified_navigation_url:route+"&secret=unexpected"})),false);
  assert.equal(rememberSabyNavigationHint(r,record({identity:{inn,name,verified:false}})),false);
  assert.equal(storedSabyNavigationHint(r),route);
  assert.equal(r.__evidence.saby,undefined);
  const invalid=row();
  assert.equal(rememberSabyNavigationHint(invalid,record({verified_navigation_url:null})),false);
  assert.equal(storedSabyNavigationHint(invalid),null);
});

test("legacy cursor remembers verified navigation even with absent widgets, without changing its attempts",async()=>{
  const r=row(),seen=[];
  const result={direct_buyers:[],leasing:[],intermediaries:[r],statistics:[]};
  const out=await runSabyContactFirst({result,
    env:{SABY_STAGE12_ENABLED:"true",SABY_FAST_PASS_ENABLED:"false",
      SABY_ALL_COMPANY_FLEETS_ENABLED:"false",SABY_DELAY_MS:"250"},
    passState:{version:1,strategy:"section_passes_v1",planned_inns:[inn],attempted:[],
      phase_index:0},
    sessionRunner:async fn=>fn({page:{},settings:{}}),
    collectSections:async(_page,company,settings,sections)=>{
      seen.push({hint:storedSabyNavigationHint(company),sections});
      return record();
    },
    collectGarbage:null
  });
  assert.deepEqual(seen.map(x=>x.hint),[null,route]);
  assert.ok(seen.every(x=>x.sections.contacts&&!x.sections.trucks&&!x.sections.financials));
  assert.deepEqual(out.passState.attempted,["contacts:"+inn,"contact_retry:"+inn]);
  assert.equal(out.passState.strategy,"section_passes_v1");
  assert.deepEqual(out.deferredInns,[inn]);
  assert.equal(out.stats.verified,0);
  assert.equal(r.__evidence.saby,undefined);
});

test("one scan retains exact token boundaries, distinct cards and visibility",()=>{
  const make=(text,rect,children=[],hidden=false)=>{
    const n={textContent:text,innerText:text,children,hidden,
      getBoundingClientRect:()=>rect};
    children.forEach(x=>{x.parentElement=n;});return n;
  };
  const mkCard=(y,token,hidden=false)=>{
    const leaf=make("ИНН\u00a0"+token,{x:20,y,width:110,height:18},[],hidden);
    const parent=make(name+"\nИНН\u00a0"+token,{x:10,y,width:420,height:65},[leaf],hidden);
    return [parent,leaf];
  };
  const a=mkCard(10,inn),b=mkCard(100,inn),wrong=mkCard(200,inn+"7"),hidden=mkCard(300,inn,true);
  const nodes=[...a,...b,...wrong,...hidden];
  const saved={document:globalThis.document,getComputedStyle:globalThis.getComputedStyle};
  try{
    globalThis.document={querySelectorAll:()=>nodes};
    globalThis.getComputedStyle=e=>({visibility:e.hidden?"hidden":"visible",display:"block"});
    const args={inn,branchSource:"филиал",includeInnOnly:true,includeBranches:true};
    const result=scanSabyResultDOM(args);
    assert.equal(result.rows.length,2);
    assert.equal(result.leafHits,2);
    assert.deepEqual(consolidateSabyResultRows(result,inn).map(r=>r.rect.y),[10,100]);
    assert.deepEqual(scanSabyLegacyDOM(args).map(r=>r.rect.y),[10,100]);
    // Cache lifetime is one synchronous read, never across DOM polls.
    a[1].textContent="ИНН "+inn+"7";a[0].textContent=a[0].innerText=name+"\n"+a[1].textContent;
    assert.deepEqual(scanSabyResultDOM(args).rows.map(r=>r.rect.y),[100]);
  }finally{
    if(saved.document===undefined)delete globalThis.document;else globalThis.document=saved.document;
    if(saved.getComputedStyle===undefined)delete globalThis.getComputedStyle;else globalThis.getComputedStyle=saved.getComputedStyle;
  }
});

test("layout and rendered text are cached only within one synchronous result scan",()=>{
  const reads=new Map();
  const make=(text,rect,children=[])=>{
    const n={textContent:text,children,hidden:false,
      get innerText(){const r=reads.get(n);r.text++;return this.textContent;},
      getBoundingClientRect(){const r=reads.get(n);r.layout++;return rect;}};
    reads.set(n,{layout:0,style:0,text:0});
    children.forEach(x=>{x.parentElement=n;});return n;
  };
  const leafA=make("ИНН "+inn,{x:10,y:5,width:110,height:15});
  const leafB=make("ИНН "+inn,{x:10,y:25,width:110,height:15});
  const parent=make(name+"\nИНН "+inn+"\nИНН "+inn,
    {x:5,y:0,width:420,height:60},[leafA,leafB]);
  const saved={document:globalThis.document,getComputedStyle:globalThis.getComputedStyle};
  try{
    globalThis.document={querySelectorAll:()=>[parent,leafA,leafB]};
    globalThis.getComputedStyle=e=>{reads.get(e).style++;
      return {visibility:e.hidden?"hidden":"visible",display:"block"};};
    const args={inn,branchSource:"филиал",includeInnOnly:true,includeBranches:true};
    assert.equal(scanSabyResultDOM(args).rows.length,2);
    assert.deepEqual(reads.get(parent),{layout:1,style:1,text:1});
    parent.hidden=true;
    assert.equal(scanSabyResultDOM(args).rows.length,0);
    assert.equal(reads.get(parent).layout,2,"fresh geometry on next poll");
    assert.equal(reads.get(parent).style,2,"fresh visibility on next poll");
  }finally{
    if(saved.document===undefined)delete globalThis.document;else globalThis.document=saved.document;
    if(saved.getComputedStyle===undefined)delete globalThis.getComputedStyle;else globalThis.getComputedStyle=saved.getComputedStyle;
  }
});
