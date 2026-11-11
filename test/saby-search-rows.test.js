import test from "node:test";
import assert from "node:assert/strict";
import {
  sabySearchDisplayName,plausibleSabySearchName,
  overlappingSabyCard,consolidateSabyResultRows,scanSabyResultDOM
} from "../src/sabySearchRows.js";
import {findResultRows} from "../src/sabyBrowser.js";
import {selectSabyInnCandidate,SABY_BRANCH_MARKER_SOURCE} from
  "../src/sabyPublicIdentityFallback.js";

const inn="7725104641";
const full="АКЦИОНЕРНОЕ ОБЩЕСТВО ДОРОЖНО-СТРОИТЕЛЬНАЯ КОМПАНИЯ АВТОБАН";
const card=(name,y,extra="",x=10)=>({
  text:name+"\nИНН "+inn+(extra?"\n"+extra:""),
  rect:{x,y,w:400,h:82}
});

test("search title must be an organisation, not an INN label fragment",()=>{
  assert.equal(sabySearchDisplayName(
    "ДСК Автобан, АО\nИНН "+inn,inn),"ДСК Автобан, АО");
  for(const text of [
    "ИНН: "+inn,"ИНН\n"+inn,"Реквизиты\nИНН "+inn,
    "ООО\nИНН "+inn,"Контакты\n"+inn,
    "Загрузка\nИНН "+inn
  ])assert.equal(plausibleSabySearchName(text,inn),false,text);
  for(const text of [
    "ДСК Автобан, АО\nИНН "+inn,
    "Группа компаний Атолл\nИНН "+inn,
    "Филиал ДСК Автобан\nИНН "+inn
  ])assert.equal(plausibleSabySearchName(text,inn),true,text);
});

test("nested visible text duplicates collapse only when same title AND geometry",()=>{
  const one=card("ДСК Автобан, АО",100);
  const nested={text:one.text+"\nМосква",
    rect:{x:38,y:115,w:350,h:50}};
  const separate=card("ДСК Автобан, АО",280,"Смоленск");
  const competing=card("ДСК Автобан Регион, АО",100,"Другой город");
  assert.equal(overlappingSabyCard(one.rect,nested.rect),true);
  assert.equal(overlappingSabyCard(one.rect,separate.rect),false);
  const actual=consolidateSabyResultRows(
    {rows:[one,nested,separate,competing],leafHits:10},inn);
  assert.equal(actual.length,3);
  assert.equal(actual.meta.rawCandidates,4);
  assert.equal(actual.meta.geometryDuplicates,1);
  assert.equal(actual.meta.uniqueTitles,2);
  const selected=selectSabyInnCandidate(actual,inn,full);
  assert.equal(selected.row,null);
  assert.equal(selected.reason,"ambiguous");
});

test("20 nested highlighted fragments of one card are NOT 20 legal entities",()=>{
  const raw=Array.from({length:20},(_,i)=>({
    text:"ДСК Автобан, АО\nИНН "+inn+"\nМосква",
    rect:{x:10+i*0.5,y:100+i*0.2,w:390-i,h:80-i*.3}
  }));
  const rows=consolidateSabyResultRows({rows:raw,leafHits:20},inn);
  assert.equal(rows.length,1);
  assert.equal(rows.meta.geometryDuplicates,19);
  const choice=selectSabyInnCandidate(rows,inn,full);
  assert.equal(choice.reason,"unique_inn");
  assert.equal(choice.row!=null,true);
  // This is only a SEARCH CANDIDATE, not verified legal identity.
  assert.equal(choice.row.text.includes(inn),true);
});

test("same text at distinct screen positions remains two ambiguous entities",()=>{
  const rows=consolidateSabyResultRows({
    rows:[card("ДСК Автобан, АО",10),
      card("ДСК Автобан, АО",260)]
  },inn);
  assert.equal(rows.length,2);
  assert.equal(selectSabyInnCandidate(rows,inn,full).reason,"ambiguous");
});

test("full scan remains fail-closed even when duplicated rows collapsed",()=>{
  const many=Array.from({length:130},(_,i)=>
    card("ДСК Автобан Подразделение "+i+", АО",10+i*120));
  const rows=consolidateSabyResultRows({rows:many},inn,{maxRows:120});
  assert.equal(rows.length,120);
  assert.equal(rows.meta.truncated,true);
  assert.equal(selectSabyInnCandidate(rows,inn,full).reason,
    "result_window_full");
  const capped=consolidateSabyResultRows({
    rows:[card("ДСК Автобан, АО",20)],rawCapped:true
  },inn);
  assert.equal(capped.meta.truncated,true);
  assert.equal(selectSabyInnCandidate(capped,inn,full).reason,
    "result_window_full");
});

test("scan crosses INN-only nodes to find their visible named parent card",()=>{
  const oldDoc=globalThis.document,oldStyle=globalThis.getComputedStyle;
  const els=[];
  function element(text,rect,children=[]) {
    const el={
      textContent:text,innerText:text,children,
      parentElement:null,
      getBoundingClientRect:()=>rect
    };
    for(const child of children)child.parentElement=el;
    els.push(el);
    return el;
  }
  const r=(x,y,w,h)=>({x,y,width:w,height:h});
  // Three independent INN leaves inside the SAME first card.
  const leaves=Array.from({length:3},(_,i)=>
    element("ИНН: "+inn,r(20+i*5,115+i*10,180,20)));
  const company=element(
    "ДСК Автобан, АО\nИНН "+inn+"\nМосква",
    r(10,100,430,130),leaves
  );
  // Second card is an actual branch and must remain distinct.
  const branchLeaf=element("ИНН "+inn,r(30,330,175,20));
  const branch=element("Филиал ДСК Автобан\nИНН "+inn,
    r(10,300,430,100),[branchLeaf]);
  try{
    globalThis.document={querySelectorAll:()=>els};
    globalThis.getComputedStyle=()=>({visibility:"visible",display:"block"});
    const scanned=scanSabyResultDOM({
      inn,includeInnOnly:true,includeBranches:true,
      branchSource:SABY_BRANCH_MARKER_SOURCE
    });
    assert.equal(scanned.rawCapped,false);
    assert.equal(scanned.leafHits,4);
    assert.equal(scanned.rows.length,4);
    assert.equal(scanned.rows.some(x=>x.text===company.innerText),true);
    assert.equal(scanned.rows.some(x=>x.text===branch.innerText),true);
    const result=consolidateSabyResultRows(scanned,inn);
    assert.equal(result.length,2);
    assert.equal(result.meta.geometryDuplicates,2);
    const selection=selectSabyInnCandidate(result,inn,full);
    assert.equal(selection.branches,1);
    assert.equal(selection.reason,"unique_primary_excluding_branches");
    assert.equal(selection.row.text,company.innerText);
  } finally {
    if(oldDoc===undefined)delete globalThis.document;
    else globalThis.document=oldDoc;
    if(oldStyle===undefined)delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle=oldStyle;
  }
});

test("browser reads all raw fragments and preserves nonenumerable safe counts",async()=>{
  const row=card("ДСК Автобан, АО",30);
  const mockPage={
    evaluate:async(fn,params)=>{
      assert.equal(fn,scanSabyResultDOM);
      assert.equal(params.inn,inn);
      assert.equal(params.includeInnOnly,true);
      assert.equal(params.includeBranches,true);
      return {rows:[row,{...row,rect:{...row.rect,x:25}}],
        leafHits:11,rawCapped:false};
    }
  };
  const out=await findResultRows(mockPage,inn,{
    includeInnOnly:true,includeBranches:true
  });
  assert.equal(out.length,1);
  assert.equal(out.meta.geometryDuplicates,1);
  assert.equal(out.meta.rawCandidates,2);
  assert.deepEqual(Object.keys(out),["0"]);
});
