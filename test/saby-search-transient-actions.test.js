import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {submitSabyCompanySearch} from "../src/sabySearch.js";

test("transient detached input is reacquired once, never typed to a fallback",async()=>{
  let finds=0,presses=0;
  const retry=[];
  const result=await submitSabyCompanySearch({}, "7707083893",{
    isListRoute:()=>true,
    findSearch:async()=>{
      finds++;
      if(finds===1)return {method:"single_visible_input",field:{
        fill:async()=>{throw new Error("detached");},
        press:async()=>assert.fail("must not press failed input")
      }};
      return {method:"search_selector",field:{
        fill:async(v)=>assert.equal(v,"7707083893"),
        press:async(key)=>{assert.equal(key,"Enter");presses++;}
      }};
    },
    wait:async()=>{},onRetry:x=>retry.push(x)
  });
  assert.equal(result.ok,true);
  assert.equal(result.method,"search_selector");
  assert.equal(result.attempts,2);
  assert.equal(finds,2);
  assert.equal(presses,1);
  assert.deepEqual(retry,[{stage:"fill",attempt:1}]);
});

test("transient press timeout reacquires a newly checked field once",async()=>{
  let attempts=0,completed=0;
  const done=await submitSabyCompanySearch({},"7702070139",{
    isListRoute:()=>true,wait:async()=>{},
    findSearch:async()=>({
      method:"search_hint",
      field:{
        fill:async()=>{},
        press:async()=>{
          attempts++;
          if(attempts===1)throw Error("stale element");
          completed++;
        }
      }
    })
  });
  assert.equal(done.ok,true);
  assert.equal(done.attempts,2);
  assert.equal(completed,1);
});

test("repeat failure is bounded; no unscoped keyboard fallback or third attempt",async()=>{
  let fields=0;
  const done=await submitSabyCompanySearch({},"7707083893",{
    isListRoute:()=>true,wait:async()=>{},maxAttempts:100,
    findSearch:async()=>{fields++;return {field:{
      fill:async()=>{throw Error("Playwright timeout");}
    }};}
  });
  assert.equal(done.ok,false);
  assert.equal(done.reason,"search_action_timeout");
  assert.equal(done.stage,"fill");
  assert.equal(done.attempts,2);
  assert.equal(fields,2);
  assert.doesNotMatch(JSON.stringify(done),/Playwright timeout/);
});

test("route/identity guard blocks search before input and between fill and Enter",async()=>{
  let findCalled=0,pressed=0,route="list";
  const findSearch=async()=>{findCalled++;return {field:{
    fill:async()=>{route="other";},
    press:async()=>pressed++
  }};};
  const bad=await submitSabyCompanySearch({},"not-an-inn",{
    isListRoute:()=>true,findSearch
  });
  assert.equal(bad.reason,"unsafe_identity_or_route");
  const wrong=await submitSabyCompanySearch({},"7707083893",{
    isListRoute:()=>false,findSearch
  });
  assert.equal(wrong.reason,"unsafe_identity_or_route");
  assert.equal(findCalled,0);
  const changed=await submitSabyCompanySearch({},"7707083893",{
    isListRoute:()=>route==="list",findSearch
  });
  assert.equal(changed.reason,"route_changed");
  assert.equal(findCalled,1);
  assert.equal(pressed,0);
});

test("ambiguous or credential-only search is never retried or submitted",async()=>{
  let called=0;
  const done=await submitSabyCompanySearch({},"7707083893",{
    isListRoute:()=>true,
    findSearch:async()=>{called++;return {
      field:null,reason:"ambiguous_visible_inputs",
      diagnostic:{code:"ambiguous_visible_inputs"}
    };}
  });
  assert.equal(called,1);
  assert.equal(done.ok,false);
  assert.equal(done.reason,"ambiguous_visible_inputs");
  assert.equal(done.attempts,1);
});

test("search implementation does not type via unscoped keyboard or log private DOM",()=>{
  const source=fs.readFileSync(new URL("../src/sabySearch.js",import.meta.url),"utf8");
  const browser=fs.readFileSync(new URL("../src/sabyBrowser.js",import.meta.url),"utf8");
  assert.match(browser,/\[SABY_SEARCH_RETRY\]/);
  assert.match(browser,/waitUntil:"commit"/);
  assert.doesNotMatch(source,/page\.keyboard\.(?:type|insertText)/);
  assert.doesNotMatch(source,/\.screenshot\(|\.inputValue\(/);
});
