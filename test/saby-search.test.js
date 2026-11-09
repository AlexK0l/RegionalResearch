import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {findSabyCompanySearch} from "../src/sabySearch.js";

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
