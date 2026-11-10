import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {findSabyCompanySearch,chooseSabyCompanyCandidate} from "../src/sabySearch.js";

function field(attributes={}, {visible=true,enabled=true,tagName="INPUT"}={}) {
  return {
    async isVisible(){return visible;},
    async isEnabled(){return enabled;},
    async evaluate(callback) {
      return callback({
        tagName,
        getAttribute(key){return attributes[key]??null;},
        isContentEditable:tagName==="DIV" && attributes.contenteditable==="true"
      });
    }
  };
}

function locator(items) {
  return {
    async count(){return items.length;},
    nth(index){return items[index];}
  };
}

function pageWith({search=[],generic=[]}) {
  return {
    locator(selector) {
      if(selector.includes('input[placeholder*="Поиск"')) {
        return locator(search);
      }
      if(selector.includes('input[type="text"]')) {
        return locator(generic);
      }
      throw Error("Unexpected selector");
    }
  };
}

test("Saby company search preserves original Python one-visible-input fallback",async()=>{
  const plain=field({type:"text",name:"ws-input_2042"});
  const page=pageWith({generic:[plain]});
  const result=await findSabyCompanySearch(page,{timeoutMs:0});
  assert.equal(result.field,plain);
  assert.equal(result.method,"single_visible_input");
});

test("Saby company search selects strong INN search among multiple text inputs",async()=>{
  const business=field({type:"text",placeholder:"Название, ИНН, ОГРН"});
  const filter=field({type:"text",placeholder:"Регион"});
  const page=pageWith({search:[business],generic:[filter,business]});
  const result=await findSabyCompanySearch(page,{timeoutMs:0});
  assert.equal(result.field,business);
  assert.equal(result.method,"search_selector");
});

test("Saby search ignores password/login and never enters INN into a sign-in field",async()=>{
  const credential=field({type:"text",placeholder:"Телефон или логин",autocomplete:"username"});
  const result=await findSabyCompanySearch(pageWith({generic:[credential]}),{
    timeoutMs:0
  });
  assert.equal(result.field,null);
  assert.equal(result.reason,"no_safe_visible_input");
});

test("Saby search rejects ambiguous generic fields rather than guessing",async()=>{
  const page=pageWith({generic:[
    field({type:"text",placeholder:"Регион"}),
    field({type:"text",placeholder:"Сотрудники"})
  ]});
  const result=await findSabyCompanySearch(page,{timeoutMs:0});
  assert.equal(result.field,null);
  assert.equal(result.reason,"ambiguous_visible_inputs");
  assert.deepEqual(Object.keys(result.diagnostic).sort(),
    ["code","hintedCount","urlCategory","visibleEditableCount"].sort());
});

test("hidden input and credential-only fields are ignored",async()=>{
  const search=field({type:"search",placeholder:"Поиск организаций"},{visible:false});
  const password=field({type:"password",autocomplete:"current-password"});
  const result=await findSabyCompanySearch(
    pageWith({search:[search],generic:[search,password]}),{timeoutMs:0});
  assert.equal(result.field,null);
  assert.equal(result.reason,"no_safe_visible_input");
});

test("search module logs only generic diagnostics and never collects field values",()=>{
  const source=fs.readFileSync(new URL("../src/sabySearch.js",import.meta.url),"utf8");
  assert.doesNotMatch(source,/\binputValue\b|\.inputValue\(|\.screenshot\(|\.content\(/);
  assert.doesNotMatch(source,/document\.body\.innerText|\.innerText/);
  const browser=fs.readFileSync(new URL("../src/sabyBrowser.js",import.meta.url),"utf8");
  assert.match(browser,/findSabyCompanySearch\(/);
  assert.match(browser,/\[SABY_SEARCH_DIAG\]/);
});

test("exact INN row with short Saby name is only a card candidate",()=>{
  const short={text:"Сапк, АО\n6700018766\nСмоленск",rect:{x:1,y:2,w:250,h:60}};
  const chosen=chooseSabyCompanyCandidate(
    [short],"АО Смоленская агропромышленная компания","6700018766");
  assert.equal(chosen.status,"unique_inn_only");
  assert.equal(chosen.candidate,short);
  assert.equal(chosen.exactNameCount,0);
  // This is NOT verified identity; verifySabyCard must still match legal
  // name AND exact INN on the detail page before Saby data is accepted.
});

test("strict legal name candidate is preferred even when multiple INN rows exist",()=>{
  const alias={text:"Сапк, АО\n6700018766",rect:{x:1}};
  const exact={text:"АО Смоленская агропромышленная компания\n6700018766",rect:{x:2}};
  const chosen=chooseSabyCompanyCandidate(
    [alias,exact],"АО Смоленская агропромышленная компания","6700018766");
  assert.equal(chosen.status,"exact_name");
  assert.equal(chosen.candidate,exact);
  assert.equal(chosen.candidateCount,2);
});

test("two INN-only candidates never produce a fallback selection",()=>{
  const rows=[
    {text:"Сапк, АО\n6700018766"},
    {text:"Компания, ООО\n6700018766"}
  ];
  const chosen=chooseSabyCompanyCandidate(
    rows,"АО Смоленская агропромышленная компания","6700018766");
  assert.equal(chosen.status,"ambiguous");
  assert.equal(chosen.candidate,null);
  assert.equal(chosen.candidateCount,2);
});

test("partial INN matches and missing INN never allow a candidate",()=>{
  for(const text of [
    "Сапк, АО 16700018766",
    "Сапк, АО 67000187660",
    "Сапк, АО 670001876",
    "Сапк, АО без реквизитов"
  ]) {
    const outcome=chooseSabyCompanyCandidate([{text}],
      "АО Смоленская агропромышленная компания","6700018766");
    assert.equal(outcome.candidate,null,text);
    assert.equal(outcome.status,"missing");
  }
});

test("result fallback is wired to strict detail identity verification",()=>{
  const code=fs.readFileSync(new URL("../src/sabyBrowser.js",import.meta.url),"utf8");
  assert.match(code,/chooseSabyCompanyCandidate\(await findResultRows\(page,inn\),name,inn\)/);
  assert.match(code,/const outcome=await verifySabyCard\(page,inn,name\)/);
  assert.match(code,/\[SABY_SEARCH_RESULT\] unique_inn_requires_card_verification/);
  assert.match(code,/\[SABY_RESULTS_DIAG\]/);
});
