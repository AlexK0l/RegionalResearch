import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {fileURLToPath} from "node:url";
import {
  safeSabySearchTitle,summarizeSabySearchLayout,
  inspectSabySearchLayout
} from "../src/sabySearchStructureDiagnostics.js";

const inn="7725104641";
const source="АКЦИОНЕРНОЕ ОБЩЕСТВО ДОРОЖНО-СТРОИТЕЛЬНАЯ КОМПАНИЯ АВТОБАН";
const card=(name,x,y)=>({
  text:name+"\nИНН "+inn+"\nКонтакты: 8 (900) 123-45-67",
  rect:{x,y,w:370,h:80}
});

test("search structure report exports only truncated masked business label",()=>{
  const dangerous="ДСК Автобан 8 (900) 123-45-67 " +
    "manager@example.test\nИНН "+inn;
  const t=safeSabySearchTitle(dangerous,inn);
  assert.match(t,/ДСК Автобан/);
  assert.doesNotMatch(t,/123-45-67|manager@example|7725104641/);
  assert.match(t,/\[PHONE\]/);
  assert.match(t,/\[EMAIL\]/);
  const bad="ООО "+("ОченьДлинноеНазвание".repeat(30))+"\nИНН "+inn;
  assert.ok(safeSabySearchTitle(bad,inn).length<=140);
});

test("summary indicates whether many titles correspond to user's source",()=>{
  const rows=[
    card("ДСК Автобан, АО",10,100),
    card("Неизвестная организация, ООО",10,230)
  ];
  const summary=summarizeSabySearchLayout(rows,inn,source,[
    {matched:true,semantic_row:true,clickable:true,viewport_visible:true},
    {matched:true,semantic_row:false,clickable:false,viewport_visible:false}
  ]);
  assert.equal(summary.candidate_rows,2);
  assert.equal(summary.distinct_titles,2);
  assert.equal(summary.titles_with_source_token,1);
  assert.equal(summary.inside_viewport,1);
  assert.equal(summary.has_row_context,1);
  assert.equal(summary.with_clickability,1);
  assert.equal(summary.items[0].title,"ДСК Автобан, АО");
  assert.equal(summary.items[0].y,100);
  assert.ok(!JSON.stringify(summary).includes("123-45-67"));
});

test("DOM structural inspector exports grouping/role/flags but never DOM text",async()=>{
  const oldDoc=globalThis.document;
  const oldStyle=globalThis.getComputedStyle;
  const oldHeight=globalThis.innerHeight;
  const oldWidth=globalThis.innerWidth;
  const r=(x,y,w,h)=>({x,y,width:w,height:h,
    top:y,bottom:y+h,left:x,right:x+w});
  const parent={
    tagName:"DIV",className:"SabySearch-results",
    children:[{},{}],
    scrollHeight:1300,clientHeight:700,
    getBoundingClientRect:()=>r(10,30,480,700),
    getAttribute:()=>null,hasAttribute:()=>false,
    parentElement:null
  };
  const row={
    tagName:"LI",className:"CompanyRow_item",
    innerText:"ДСК Автобан, АО\nИНН "+inn+
      "\nmanager@example.com",
    textContent:"ДСК Автобан, АО\nИНН "+inn+
      "\nmanager@example.com",
    children:[],scrollHeight:80,clientHeight:80,
    getBoundingClientRect:()=>r(20,120,370,80),
    getAttribute:n=>n==="role"?"listitem":null,
    hasAttribute:()=>false,parentElement:parent
  };
  const unrelated={
    tagName:"DIV",className:"OtherBlock",
    innerText:"Contact token=SECRET_123456",
    textContent:"Contact token=SECRET_123456",
    getBoundingClientRect:()=>r(20,320,370,80),
    getAttribute:()=>null,hasAttribute:()=>false,
    parentElement:parent
  };
  try {
    globalThis.document={querySelectorAll:()=>[row,parent,unrelated]};
    globalThis.getComputedStyle=el=>({visibility:"visible",
      display:"block",cursor:el===row?"pointer":"default"});
    globalThis.innerHeight=920;
    globalThis.innerWidth=1440;
    const results=await inspectSabySearchLayout({
      evaluate:async(callback,args)=>callback(args)
    },[card("ДСК Автобан, АО",20,120)],inn);
    assert.equal(results.length,1);
    const entry=results[0];
    assert.equal(entry.matched,true);
    assert.equal(entry.tag,"li");
    assert.equal(entry.role,"listitem");
    assert.equal(entry.semantic_row,true);
    assert.equal(entry.clickable,true);
    assert.equal(entry.viewport_visible,true);
    assert.equal(entry.parent_siblings,2);
    assert.equal(entry.scroll_container,true);
    assert.equal(entry.has_explicit_inn_label,true);
    assert.deepEqual(entry.class_hints,["company","row","item"]);
    const text=JSON.stringify(entry);
    assert.doesNotMatch(text,/SECRET_123456|manager@example|ДСК Автобан|7725104641/);
  } finally {
    if(oldDoc===undefined)delete globalThis.document;
    else globalThis.document=oldDoc;
    if(oldStyle===undefined)delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle=oldStyle;
    if(oldHeight===undefined)delete globalThis.innerHeight;
    else globalThis.innerHeight=oldHeight;
    if(oldWidth===undefined)delete globalThis.innerWidth;
    else globalThis.innerWidth=oldWidth;
  }
});

test("standalone search-structure CLI is read only and requires explicit profile",()=>{
  const cli=fs.readFileSync(fileURLToPath(new URL(
    "../scripts/saby-search-structure.js",import.meta.url)),"utf8");
  assert.match(cli,/saby:search-structure|search structure:/);
  assert.match(cli,/--inn/);
  assert.match(cli,/--profile/);
  assert.match(cli,/inspectSabySearchLayout/);
  assert.match(cli,/withSabyBrowser/);
  assert.match(cli,/openai_requests:0/);
  assert.match(cli,/source_file_unchanged:true/);
  assert.doesNotMatch(cli,/runSabyStage12|applySabyEnrichment|collectSabyCompany/);
});
