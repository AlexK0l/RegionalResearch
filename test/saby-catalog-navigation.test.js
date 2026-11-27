import test from "node:test";
import assert from "node:assert/strict";
import {SABY_CATALOG_URL,openSabyCatalog,rememberSabyCatalogOrigin,
  forgetSabyCatalogOrigin,rememberSabyEmptyCatalog,rememberSabySettledCatalog,noteSabyCatalogColdFallback} from "../src/sabyCatalogNavigation.js";

const detail="https://profile.saby.ru/page/contractor-info?id=11111111-1111-4111-8111-111111111111";
function fixture(initial=detail,{back=SABY_CATALOG_URL,fail=false}={}){
  let current=initial;
  const events=[];
  const page={url:()=>current,change:url=>{current=url;},
    goBack:async opts=>{events.push(["back",opts]);if(fail)throw Error("timeout");current=back;},
    goto:async(url,opts)=>{events.push(["goto",url,opts]);current=url;}};
  return {page,events};
}

test("catalog history is off by default and a remembered origin is one-use",async()=>{
  const {page,events}=fixture();
  assert.equal(rememberSabyCatalogOrigin(page,SABY_CATALOG_URL,detail),true);
  assert.deepEqual(await openSabyCatalog(page),{historyAttempted:false,historyHit:false});
  assert.equal(events[0][0],"goto");
  page.change(detail);
  await openSabyCatalog(page,{reuse:true});
  assert.deepEqual(events.map(e=>e[0]),["goto","goto"]);
});
test("reuse only exact verified detail route, then still return ordinary list for fresh search",async()=>{
  const {page,events}=fixture();
  assert.equal(rememberSabyCatalogOrigin(page,SABY_CATALOG_URL,detail),true);
  assert.deepEqual(await openSabyCatalog(page,{reuse:true}),{historyAttempted:true,historyHit:true});
  assert.equal(page.url(),SABY_CATALOG_URL);
  assert.equal(events.length,1);
  assert.equal(events[0][0],"back");
  assert.equal(events[0][1].waitUntil,"commit");
  assert.ok(events[0][1].timeout>0&&events[0][1].timeout<=2500);
  page.change(detail);
  await openSabyCatalog(page,{reuse:true});
  assert.equal(events.at(-1)[0],"goto");
});
test("changed detail, wrong history destination, timeouts and unsafe list origins fail to cold navigation",async()=>{
  for(const setup of [{back:"https://example.test/"},{fail:true},{back:detail}]){
    const {page,events}=fixture(detail,setup);
    rememberSabyCatalogOrigin(page,SABY_CATALOG_URL,detail);
    assert.deepEqual(await openSabyCatalog(page,{reuse:true}),{historyAttempted:true,historyHit:false});
    assert.deepEqual(events.map(e=>e[0]),["back","goto"]);
    assert.equal(page.url(),SABY_CATALOG_URL);
  }
  const {page,events}=fixture();
  assert.equal(rememberSabyCatalogOrigin(page,SABY_CATALOG_URL+"?other=1",detail),false);
  assert.equal(rememberSabyCatalogOrigin(page,"https://example.test/",detail),false);
  rememberSabyCatalogOrigin(page,SABY_CATALOG_URL,detail);
  page.change(detail+"&unknown=contacts");
  await openSabyCatalog(page,{reuse:true});
  assert.deepEqual(events.map(e=>e[0]),["goto"]);
  page.change(detail);
  rememberSabyCatalogOrigin(page,SABY_CATALOG_URL,detail);
  forgetSabyCatalogOrigin(page);
  await openSabyCatalog(page,{reuse:true});
  assert.deepEqual(events.map(e=>e[0]),["goto","goto"]);
});

test("known UI-only changes may return through at most two same-card history entries",async()=>{
  const {page,events}=fixture();
  const actual=detail+"&local=false";
  page.change(actual);
  assert.equal(rememberSabyCatalogOrigin(page,SABY_CATALOG_URL,actual),true);
  page.change(actual+"&tab=contacts");
  page.goBack=async opts=>{
    events.push(["back",opts]);
    page.change(events.length===1?actual:SABY_CATALOG_URL);
  };
  assert.deepEqual(await openSabyCatalog(page,{reuse:true}),{historyAttempted:true,historyHit:true});
  assert.equal(events.length,2);
  assert.ok(events.every(e=>e[1].timeout<=2500));
});
test("unsafe local values and different IDs never use history; three misses disable it per page",async()=>{
  const {page,events}=fixture();
  assert.equal(rememberSabyCatalogOrigin(page,SABY_CATALOG_URL,detail+"&local=true"),false);
  assert.equal(rememberSabyCatalogOrigin(page,SABY_CATALOG_URL,detail),true);
  page.change(detail.replace("11111111","22222222"));
  await openSabyCatalog(page,{reuse:true});
  assert.deepEqual(events.map(x=>x[0]),["goto"]);
  for(let i=0;i<3;i++)noteSabyCatalogColdFallback(page);
  page.change(detail);
  rememberSabyCatalogOrigin(page,SABY_CATALOG_URL,detail);
  assert.deepEqual(await openSabyCatalog(page,{reuse:true}),{historyAttempted:false,historyHit:false});
  assert.equal(events.at(-1)[0],"goto");
});

test("confirmed empty list can stay mounted for only the next query, then requires fresh observation",async()=>{
  const {page,events}=fixture(SABY_CATALOG_URL);
  assert.equal(rememberSabyEmptyCatalog(page),true);
  assert.deepEqual(await openSabyCatalog(page,{reuse:true}),{historyAttempted:true,historyHit:true});
  assert.equal(events.length,0);
  assert.deepEqual(await openSabyCatalog(page,{reuse:true}),{historyAttempted:false,historyHit:false});
  assert.deepEqual(events.map(x=>x[0]),["goto"]);
  page.change(detail);
  assert.equal(rememberSabyEmptyCatalog(page),false);
});


const previousInn="1659029846",nextInn="1650123604";
const settledBefore={inputExact:false,serviceError:false,spinnerVisible:true,explicitEmpty:false};
const settledAfter={inputExact:true,serviceError:false,spinnerVisible:true,explicitEmpty:false};
function settledFixture(){
  const f=fixture(SABY_CATALOG_URL);
  let stamp=123456;
  f.page.evaluate=async()=>stamp;
  return {...f,remount:()=>{stamp++;},remember:opts=>rememberSabySettledCatalog(f.page,{
    inn:previousInn,observed:0,selection:"not_found",beforeSearch:settledBefore,
    first:settledAfter,last:settledAfter,isSettled:()=>true,...opts
  }),open:opts=>openSabyCatalog(f.page,{reuse:true,inn:nextInn,
    readSearchState:async(_page,inn)=>{assert.equal(inn,previousInn);return settledAfter;},...opts})};
}
test("idle unresolved exact query permits one fresh different-INN mounted search, not an absence fact",async()=>{
  const f=settledFixture();
  assert.equal(await f.remember(),true);
  assert.deepEqual(await f.open(),{historyAttempted:true,historyHit:true,mountedAttempted:true,
    mountedReuse:true,mountedPreviousInn:previousInn});
  assert.equal(f.events.length,0);
  assert.deepEqual(await f.open(),{historyAttempted:false,historyHit:false});
  assert.deepEqual(f.events.map(e=>e[0]),["goto"]);
});
test("mounted catalog fails closed on unstable evidence, new spinner, nonzero rows or unfinished transport",async()=>{
  for(const opts of [
    {observed:1},{observed:undefined},{selection:"ambiguous"},
    {beforeSearch:null},{beforeSearch:{...settledBefore,inputExact:true}},
    {beforeSearch:{...settledBefore,spinnerVisible:false}},
    {first:{...settledAfter,inputExact:false}},{last:{...settledAfter,serviceError:true}},
    {last:{...settledAfter,explicitEmpty:true}},{last:{...settledAfter,spinnerVisible:false}},
    {isSettled:()=>false},{isSettled:()=>{throw Error("private");}}
  ]){
    const f=settledFixture();
    assert.equal(await f.remember(opts),false);
    assert.deepEqual(await f.open(),{historyAttempted:false,historyHit:false});
    assert.equal(f.events[0][0],"goto");
  }
  const f=settledFixture();let calls=0;
  assert.equal(await f.remember({isSettled:()=>++calls===1}),false);
});
test("same URL is insufficient: document, prior exact query and stable UI must still match",async()=>{
  for(const kind of ["remount","same_inn","changed_input","service_error","busy_changed","route","probe_error","during_probe"]){
    const f=settledFixture();
    assert.equal(await f.remember(),true);
    if(kind==="remount")f.remount();
    if(kind==="route")f.page.change(detail);
    const opts=kind==="same_inn"?{inn:previousInn}:
      {readSearchState:async()=>{
        if(kind==="changed_input")return {...settledAfter,inputExact:false};
        if(kind==="service_error")return {...settledAfter,serviceError:true};
        if(kind==="busy_changed")return {...settledAfter,spinnerVisible:false};
        if(kind==="probe_error")throw Error("private");
        if(kind==="during_probe")f.remount();
        return settledAfter;
      }};
    assert.deepEqual(await f.open(opts),{historyAttempted:true,historyHit:false,mountedAttempted:true},kind);
    assert.deepEqual(f.events.map(e=>e[0]),["goto"],kind);
  }
  const f=settledFixture();await f.remember();forgetSabyCatalogOrigin(f.page);
  assert.deepEqual(await f.open(),{historyAttempted:false,historyHit:false});
});
