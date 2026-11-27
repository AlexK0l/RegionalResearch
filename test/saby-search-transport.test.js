import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import fs from "node:fs";
import {
  firstPartySabySearchTransport,exactSabyInnTransportToken,
  observeSabySearchTransport,shouldRecoverSilentSabySearch,
  trackSabySessionSockets,hasSabySessionSocketTracker
} from "../src/sabySearchTransport.js";
import {waitForSabySearchHydration,submitSabyCompanySearch} from "../src/sabySearch.js";

const INN="4718000935";

test("hydration gate waits at least 1200ms and reacquires safe search after Wasaby mount",async()=>{
  const events=[];
  const first={id:"original",safe:true};
  const later={id:"new_mount",safe:true};
  const fields=[{field:first,method:"single_visible_input"},
    {field:later,method:"search_selector"}];
  const result=await waitForSabySearchHydration({},{
    isListRoute:()=>true,
    findSearch:async(_page,{timeoutMs})=>{
      events.push(["find",timeoutMs]);
      return fields.shift();
    },
    timeoutMs:7000,
    settleMs:100,
    wait:async ms=>{events.push(["wait",ms]);}
  });
  assert.deepEqual(result,{ok:true,method:"search_selector"});
  assert.deepEqual(events,[["find",7000],["wait",1200],
    ["find",3000]],"reacquire rather than typing into the old search element");
});

test("hydration gate fails safely if list route changed or field never mounted",async()=>{
  let onList=true,calls=0;
  const result=await waitForSabySearchHydration({},{
    isListRoute:()=>onList,
    findSearch:async()=>{
      calls++;
      return {field:{},method:"single_visible_input"};
    },
    wait:async()=>{onList=false;}
  });
  assert.deepEqual(result,{ok:false,reason:"route_changed"});
  assert.equal(calls,1);
  assert.deepEqual(await waitForSabySearchHydration({},{
    isListRoute:()=>true,
    findSearch:async()=>({field:null,reason:"no_safe_visible_input"}),
    wait:async()=>{throw Error("must never wait for unsafe field");}
  }),{ok:false,reason:"no_safe_visible_input"});
  assert.deepEqual(await waitForSabySearchHydration({},{
    isListRoute:()=>false,
    findSearch:async()=>{throw Error("must not search after redirect");}
  }),{ok:false,reason:"route_changed"});
});

test("the transport tracker only observes authenticated first-party HTTPS/WSS hostnames",()=>{
  for(const url of [
    "https://profile.saby.ru/page/company-list-prof",
    "https://online.sbis.ru/api",
    "wss://profile.saby.ru/ws"
  ])assert.equal(firstPartySabySearchTransport(url),true,url);
  for(const url of [
    "https://profile.saby.ru.attacker.example/path",
    "https://fake-saby.ru/path",
    "http://profile.saby.ru/path",
    "file:///etc/passwd"
  ])assert.equal(firstPartySabySearchTransport(url),false,url);
  assert.equal(exactSabyInnTransportToken('{"inn":"'+INN+'"}',INN),true);
  assert.equal(exactSabyInnTransportToken("q="+INN+"0",INN),false);
  assert.equal(exactSabyInnTransportToken("0"+INN,INN),false);
  assert.equal(exactSabyInnTransportToken(INN,"invalid"),false);
});

test("exact INN XHR traffic is counted without ever exporting URL, INN or body",()=>{
  const page=new EventEmitter();
  const probe=observeSabySearchTransport(page,INN);
  const request={
    url:()=>"https://profile.saby.ru/service/?secret=PRIVATE_API_TOKEN",
    resourceType:()=>"fetch",
    postData:()=>JSON.stringify({inn:INN,access:"SENSITIVE_COOKIE_VALUE"})
  };
  page.emit("request",request);
  page.emit("response",{request:()=>request,status:()=>200});
  page.emit("requestfinished",request);
  assert.equal(probe.hasExactInnEvidence(),true);
  assert.equal(probe.summary().exact_inn_async_requests,1);
  assert.equal(probe.summary().async_responses,1);
  assert.equal(probe.summary().failed_requests,0);
  assert.doesNotMatch(JSON.stringify(probe.summary()),
    /4718000935|PRIVATE_API_TOKEN|SENSITIVE_COOKIE_VALUE|https?:\/\//);
  probe.stop();
  assert.equal(page.listenerCount("request"),0);
  assert.equal(page.listenerCount("response"),0);
});

test("unrelated and non-async traffic never authorizes a search-query conclusion",()=>{
  const page=new EventEmitter();
  const probe=observeSabySearchTransport(page,INN);
  const notFirst={
    url:()=>"https://evil.example/?inn="+INN,
    resourceType:()=>"xhr",
    postData:()=>INN
  };
  const notAjax={
    url:()=>"https://profile.saby.ru/assets/main.js?inn="+INN,
    resourceType:()=>"script",
    postData:()=>INN
  };
  page.emit("request",notFirst);
  page.emit("request",notAjax);
  assert.equal(probe.hasExactInnEvidence(),false);
  assert.equal(probe.summary().first_party_async_requests,0);
  const searchNoInn={
    url:()=>"https://profile.saby.ru/service/request",
    resourceType:()=>"xhr",
    postData:()=>JSON.stringify({type:"currentUser"})
  };
  page.emit("request",searchNoInn);
  page.emit("response",{request:()=>searchNoInn,status:()=>429});
  page.emit("requestfailed",searchNoInn);
  assert.equal(probe.summary().first_party_async_requests,1);
  assert.equal(probe.summary().exact_inn_async_requests,0);
  assert.equal(probe.summary().http_429,1);
  assert.equal(probe.summary().failed_requests,1);
  probe.stop();
});

test("WebSocket frames may establish safe exact-INN transport evidence",()=>{
  const page=new EventEmitter(),ws=new EventEmitter();
  ws.url=()=>"wss://online.saby.ru/ws";
  const probe=observeSabySearchTransport(page,INN);
  page.emit("websocket",ws);
  ws.emit("framesent",{payload:"query="+INN+"1"});
  assert.equal(probe.hasExactInnEvidence(),false);
  ws.emit("framesent",{payload:JSON.stringify({q:INN})});
  assert.equal(probe.hasExactInnEvidence(),true);
  assert.equal(probe.summary().exact_inn_ws_frames,1);
  probe.stop();
  assert.equal(ws.listenerCount("framesent"),0);
});

test("a new tracker replaces the previous one without accumulating listeners",()=>{
  const page=new EventEmitter();
  const old=observeSabySearchTransport(page,INN);
  assert.equal(page.listenerCount("request"),1);
  const current=observeSabySearchTransport(page,"7707083893");
  assert.equal(page.listenerCount("request"),1);
  old.stop();
  assert.equal(page.listenerCount("request"),1);
  current.stop();
  assert.equal(page.listenerCount("request"),0);
});

test("one safe reload is allowed only after an unobserved exact-INN submission",()=>{
  const safe={
    route:"list",reason:"not_found",observed:0,
    elapsedMs:6500,alreadyRecovered:false,exactTransportEvidence:false
  };
  assert.equal(shouldRecoverSilentSabySearch(safe),true);
  const unsafe=[
    {route:"detail"},{route:"other_profile"},
    {reason:"ambiguous_exact"},{reason:"no_primary"},
    {observed:1},{elapsedMs:6499},
    {alreadyRecovered:true},
    {exactTransportEvidence:true},{exactTransportEvidence:null}
  ];
  for(const value of unsafe)
    assert.equal(shouldRecoverSilentSabySearch({...safe,...value}),false,
      "must never re-dispatch when observed query, ambiguous row, or changed route");
});

test("production search uses hydration and read-only transport only in opted-in fallback",()=>{
  const source=fs.readFileSync(new URL("../src/sabyBrowser.js",import.meta.url),"utf8");
  assert.match(source,/const publicFallback=settings\.publicIdentityFallback===true;/);
  assert.match(source,/if\(!publicFallback\)return;/);
  assert.equal([...source.matchAll(/await measure\("hydration_ms",settleSearch\);/g)].length,2);
  assert.match(source,/observeSabySearchTransport\(page,inn,\{armed:false\}\)/);
  assert.match(source,/transport\?\.arm\(\);/);
  assert.match(source,/shouldRecoverSilentSabySearch\(/);
  assert.match(source,/action:"reload_and_submit_once"/);
  assert.match(source,/transportRecoveryUsed=true/);
  assert.match(source,/sameSabyDetailId\(/);
  assert.doesNotMatch(source,/console\.\w+\([^)]*postData\(|console\.\w+\([^)]*request\.url\(/);
});


test("observer sees a socket opened during navigation but counts only armed query traffic",()=>{
  const page=new EventEmitter(),ws=new EventEmitter();
  ws.url=()=>"wss://profile.saby.ru/ws";
  const probe=observeSabySearchTransport(page,INN,{armed:false});
  page.emit("websocket",ws);
  ws.emit("framesent",{payload:INN});
  assert.equal(probe.hasExactInnEvidence(),false);
  const request={url:()=>"https://profile.saby.ru/api",resourceType:()=>"xhr",postData:()=>INN};
  page.emit("request",request);
  probe.arm();
  page.emit("response",{request:()=>request,status:()=>429});
  assert.equal(probe.summary().http_429,0);
  ws.emit("framesent",{payload:INN});
  assert.equal(probe.hasExactInnEvidence(),true);
  assert.equal(probe.summary().exact_inn_ws_frames,1);
  assert.equal(shouldRecoverSilentSabySearch({route:"list",reason:"not_found",
    observed:0,elapsedMs:6500,exactTransportEvidence:probe.hasExactInnEvidence()}),false);
  probe.stop();
  assert.equal(ws.listenerCount("framesent"),0);
  assert.equal(page.listenerCount("request"),0);
});
test("silent recovery must not reload after observed first-party service blocking",()=>{
  const base={route:"list",reason:"not_found",observed:0,elapsedMs:6500,
    exactTransportEvidence:false,alreadyRecovered:false};
  assert.equal(shouldRecoverSilentSabySearch(base),true);
  assert.equal(shouldRecoverSilentSabySearch({...base,serviceBlocked:true}),false);
});

test("fused hydration and submission preserve the settle, fresh lookup and bounded action retry",async()=>{
  const events=[];
  const stale={fill:async()=>{throw Error("stale input must never be used");}};
  const fresh={fill:async(inn)=>events.push(["fill",inn]),press:async(key)=>events.push(["press",key])};
  const timing=[];
  const state=await waitForSabySearchHydration({},{
    isListRoute:()=>true,settleMs:100,
    findSearch:async(_p,{timeoutMs})=>{events.push(["find",timeoutMs]);return {field:stale};},
    wait:async ms=>events.push(["settle",ms]),
    deferReacquireToSubmission:true,onTiming:(k,v)=>timing.push([k,v])
  });
  assert.deepEqual(state,{ok:true,reacquireTimeoutMs:3000});
  events.push(["baseline"]);
  const result=await submitSabyCompanySearch({},INN,{
    isListRoute:()=>true,firstFindTimeoutMs:state.reacquireTimeoutMs,
    findSearch:async(_p,{timeoutMs})=>{events.push(["find",timeoutMs]);return {field:fresh,method:"search_selector"};},
    onTiming:(k,v)=>timing.push([k,v])
  });
  assert.equal(result.ok,true);
  assert.deepEqual(events,[["find",7000],["settle",1200],["baseline"],
    ["find",3000],["fill",INN],["press","Enter"]]);
  assert.deepEqual(timing.map(x=>x[0]),["initial_field_ms","field_settle_ms",
    "field_find_ms","field_fill_ms","field_press_ms"]);
  let onList=true;
  const redirected=await submitSabyCompanySearch({},INN,{
    isListRoute:()=>onList,
    findSearch:async()=>{onList=false;return {field:{fill:async()=>assert.fail("unsafe fill")}};}
  });
  assert.equal(redirected.reason,"route_changed");
  const noField=await submitSabyCompanySearch({},INN,{isListRoute:()=>true,
    firstFindTimeoutMs:3000,findSearch:async(_p,{timeoutMs})=>{
      assert.equal(timeoutMs,3000);return {field:null,reason:"not_rendered"};
    }});
  assert.equal(noField.ok,false);
});
test("warm history search observes a pre-existing first-party socket across independent INNs",()=>{
  const page=new EventEmitter(),ws=new EventEmitter(),foreign=new EventEmitter();
  ws.url=()=>"wss://profile.saby.ru/ws";
  foreign.url=()=>"wss://example.test/ws";
  const stop=trackSabySessionSockets(page);
  assert.equal(hasSabySessionSocketTracker(page),true);
  page.emit("websocket",ws);page.emit("websocket",foreign);
  const first=observeSabySearchTransport(page,INN,{armed:false});
  ws.emit("framesent",{payload:INN});assert.equal(first.hasExactInnEvidence(),false);
  first.arm();ws.emit("framesent",{payload:INN});assert.equal(first.summary().exact_inn_ws_frames,1);
  first.stop();
  const other=observeSabySearchTransport(page,"7707083893");
  page.emit("websocket",ws); // never double-subscribe
  ws.emit("framesent",{payload:INN});assert.equal(other.hasExactInnEvidence(),false);
  foreign.emit("framesent",{payload:"7707083893"});assert.equal(other.hasExactInnEvidence(),false);
  ws.emit("framesent",{payload:"7707083893"});assert.equal(other.summary().exact_inn_ws_frames,1);
  other.stop();ws.emit("close");
  const third=observeSabySearchTransport(page,INN);
  ws.emit("framesent",{payload:INN});assert.equal(third.hasExactInnEvidence(),false);
  third.stop();stop();
  assert.equal(hasSabySessionSocketTracker(page),false);
  assert.equal(page.listenerCount("websocket"),0);
  assert.equal(ws.listenerCount("framesent"),0);
  assert.equal(ws.listenerCount("close"),0);
});
