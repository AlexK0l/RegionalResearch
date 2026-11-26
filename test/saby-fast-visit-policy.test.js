import test from "node:test";
import assert from "node:assert/strict";
import {safeSabyNavigationUrl,rememberSabyNavigationHint,storedSabyNavigationHint,
  createSabyAdaptiveDelay,restoreSabyTiming,recordSabyVisitTiming} from "../src/sabyVisitPolicy.js";
import {quickSabyFleetFromPreview,savedSabyFinanceCardUrl,readSabyContactAncestorText,collectSabySections} from "../src/sabyBrowser.js";
import {sabyFinancialGaps} from "../src/sabyEnrichment.js";
const url="https://profile.saby.ru/page/contractor-info?id=12345678-1234-1234-1234-123456789abc";
const row=()=>({"ИНН":"7707083893","Организация":"ООО Альфа","Телефон":"",
  __evidence:{source_urls:["https://alpha.example/"]}});
const record=()=>({identity:{inn:"7707083893",name:"ООО Альфа",verified:true,kpp:"770101001"},
  source_url:url,collected_at:"2026-11-26T09:00:00Z"});
test("navigation hints are exact observed safe routes, not collection or legal identity evidence",()=>{
  const r=row(),rec=record();
  assert.equal(rememberSabyNavigationHint(r,rec),true);
  assert.equal(savedSabyFinanceCardUrl(r),url);
  assert.equal(storedSabyNavigationHint(r),url);
  assert.equal(r.__evidence.saby,undefined);
  assert.deepEqual(r.__evidence.source_urls,["https://alpha.example/"]);
  assert.equal(r["Телефон"],"");
  assert.equal(rememberSabyNavigationHint(row(),{...rec,identity:{...rec.identity,inn:"7702070139"}}),false);
  assert.equal(rememberSabyNavigationHint(row(),{...rec,identity:{...rec.identity,verified:false}}),false);
  assert.equal(rememberSabyNavigationHint(row(),{...rec,identity:{...rec.identity,name:"ООО Бета"}}),false);
  r["Организация"]="ООО Бета";assert.equal(storedSabyNavigationHint(r),null);
  for(const bad of [url+"&token=secret",url+"&id=22345678-1234-1234-1234-123456789abc",
    url.replace("https://","http://"),url.replace("profile.saby.ru","profile.saby.ru:8443"),
    url.replace("profile.saby.ru","login@profile.saby.ru"),url.replace("profile.saby.ru","profile.saby.ru.example"),
    url+"#private-token"])
    assert.equal(safeSabyNavigationUrl(bad),null,bad);
  assert.equal(safeSabyNavigationUrl(url+"&anchor=about&source=internal"),url+"&anchor=about&source=internal");
});
test("a new navigation hint cannot displace a different stored verified card",()=>{
  const r=row();r.__evidence.saby={inn:r["ИНН"],source_url:url.replace("12345678-","22345678-"),verified_at:"2026-11-25"};
  assert.equal(rememberSabyNavigationHint(r,record()),false);
});
test("quick fleet accepts only exact same-card complete preview, including explicit zero",()=>{
  const complete={status:"found",count:2,rows:[{model:"КАМАЗ 5490",year:2020},{model:"КАМАЗ 5490",year:2020}]};
  assert.deepEqual(quickSabyFleetFromPreview(complete,url,url),{status:"verified",count:2,vehicles:complete.rows});
  assert.equal(quickSabyFleetFromPreview({...complete,count:3},url,url).status,"missing");
  assert.equal(quickSabyFleetFromPreview({...complete,rows:[{model:"А",year:2020},{model:"КАМАЗ",year:2020}]},url,url).status,"missing");
  assert.equal(quickSabyFleetFromPreview({...complete,rows:[{model:"КАМАЗ",year:1800},{model:"КАМАЗ",year:2020}]},url,url).status,"missing");
  assert.equal(quickSabyFleetFromPreview({...complete,rows:[{model:"КАМАЗ..."},{model:"КАМАЗ"}]},url,url).status,"missing");
  assert.equal(quickSabyFleetFromPreview(complete,url,url.replace("12345678-","22345678-")).status,"missing");
  assert.equal(quickSabyFleetFromPreview(complete,url,url+"&unknown=changed").status,"missing");
  assert.equal(quickSabyFleetFromPreview({status:"found",count:0,rows:[]},url,url).count,0);
  assert.equal(quickSabyFleetFromPreview({status:"missing"},url,url).status,"missing");
});
test("one DOM ancestor read retains original bounded selection",()=>{
  const body={innerText:"x".repeat(1801)},outer={innerText:"Контакты\n+7 (495) 123-45-67\nsales@example.ru",parentElement:body},
    inner={innerText:"Контакты",parentElement:outer},heading={parentElement:inner};
  assert.equal(readSabyContactAncestorText(heading),outer.innerText);
  assert.equal(readSabyContactAncestorText({parentElement:{innerText:"Контакты",parentElement:body}}),"Контакты");
  assert.equal(readSabyContactAncestorText({parentElement:null}),"");
});
test("adaptive pacing is opt-in, bounded and resets on errors or slow visits",()=>{
  const fixed=createSabyAdaptiveDelay(1500,{});
  for(let i=0;i<6;i++)assert.equal(fixed.next({success:true,elapsedMs:10}),1500);
  const adaptive=createSabyAdaptiveDelay(1500,{SABY_ADAPTIVE_DELAY_ENABLED:"true",SABY_ADAPTIVE_DELAY_MIN_MS:"1000"});
  assert.deepEqual(Array.from({length:5},()=>adaptive.next({success:true,elapsedMs:1000})),[1500,1500,1500,1000,1000]);
  assert.equal(adaptive.next({systemic:true}),3000);
  assert.equal(adaptive.next({success:true,elapsedMs:10}),1500);
  assert.equal(adaptive.next({success:true,elapsedMs:13000}),1500);
});
test("timing restoration keeps only finite bounded counters and no raw browser data",()=>{
  const t=restoreSabyTiming({visits:2,visit_ms:100,search_ms:-1,secret:"private"});
  recordSabyVisitTiming(t,{timing:{full_search:true,search_ms:25,saved_card:"miss",url}},40);
  assert.equal(t.visits,3);assert.equal(t.visit_ms,140);assert.equal(t.search_ms,25);
  assert.equal(t.saved_card_misses,1);assert.equal(t.full_searches,1);
  assert.equal(Object.hasOwn(t,"secret"),false);assert.equal(Object.hasOwn(t,"url"),false);
});

test("finance fast-skip uses exactly the same usable number policy as the full sweep",()=>{
  const r=row(),field="Выручка последнего подтвержденного года";
  for(const value of ["",null,"12 тыс",Number.MAX_SAFE_INTEGER+1,"99999999999999999999999999",-1]){
    r[field]=value;assert.equal(sabyFinancialGaps(r).revenue,true);
  }
  for(const value of [0,"0",123456,"123456"]){
    r[field]=value;assert.equal(sabyFinancialGaps(r).revenue,false);
  }
});

function cardFixture({partialFleet=false,contactFailure=false,routeDrift=false,wrongCard=false}={}){
  let current="https://profile.saby.ru/page/company-list-prof",contactLookups=0;
  const calls=[];
  const page={
    url:()=>current,
    async goto(target){
      calls.push(target===url?"saved_navigation":"full_search_navigation");
      if(target!==url)throw Error("full search fallback reached");
      current=wrongCard?url.replace("12345678-","22345678-"):url;
    },
    getByText(name){
      if(name==="Контакты"&&++contactLookups===2&&contactFailure)throw Error("detached contact widget");
      const loc={
        count:async()=>name==="Контакты и телефоны"?0:1,
        nth:()=>loc,isVisible:async()=>true,
        evaluate:async fn=>{
          calls.push("contacts");
          const result=fn({parentElement:{innerText:"Контакты\n+7 (495) 123-45-67\nsales@alpha.ru"}});
          if(routeDrift)current=url.replace("12345678-","22345678-");
          return result;
        }
      };
      return loc;
    },
    async evaluate(_fn,args){
      if(args?.inn){
        calls.push("fresh_identity");
        return {headings:["ООО Альфа"],introLines:[],scopedLabeledInn:true,detailContentPresent:true};
      }
      if(args?.nonVehiclePattern){
        calls.push("fleet_preview");
        return {status:"found",count:partialFleet?2:1,rows:[{model:"КАМАЗ 5490",year:2020}]};
      }
      calls.push("finance_dom");
      return {employeeTexts:["12"],years:["2025"],revenueRows:[["1000000"]],reportScale:"руб",
        banner:"",financeHeadings:1,reportFound:true};
    },
    keyboard:{press:async()=>calls.push("overlay_interaction")},
    mouse:{click:async()=>{throw Error("quick read must not click");}},
    locator:()=>{throw Error("quick read must not scroll or wait for finance");}
  };
  return {page,calls};
}
const quick={optimized:true,quickDetails:true,contacts:true,financials:true,trucks:true};
test("real section collector freshly verifies saved hint, reads contact first and never opens a quick fleet overlay",async()=>{
  const r=row();rememberSabyNavigationHint(r,record());
  const {page,calls}=cardFixture({partialFleet:true});
  const got=await collectSabySections(page,r,{timeoutMs:15000},quick);
  assert.deepEqual(calls,["saved_navigation","fresh_identity","contacts","finance_dom","fleet_preview"]);
  assert.deepEqual(got.contacts.phones,["74951234567"]);
  assert.deepEqual(got.contacts.emails,["sales@alpha.ru"]);
  assert.equal(got.financials.employees,12);
  assert.equal(got.financials.revenue_rub,1000000);
  assert.equal(got.trucks.status,"missing");
  assert.equal(got.timing.saved_card,"hit");
  assert.equal(got.timing.full_search,undefined);
  assert.equal(r["Телефон"],"","collector itself must not write the CRM");
});
test("contact widget exception does not erase independent finance or crash the combined collector",async()=>{
  const r=row();rememberSabyNavigationHint(r,record());
  const {page,calls}=cardFixture({contactFailure:true});
  const got=await collectSabySections(page,r,{timeoutMs:15000},quick);
  assert.equal(got.contacts.status,"missing");
  assert.equal(got.financials.employees,12);
  assert.equal(got.trucks.status,"verified");
  assert.deepEqual(got.errors,["contacts: unavailable"]);
  assert.ok(!calls.includes("overlay_interaction"));
});
test("a changed contractor during read cannot supply quick contacts or later sections",async()=>{
  const r=row();rememberSabyNavigationHint(r,record());
  const {page,calls}=cardFixture({routeDrift:true});
  const got=await collectSabySections(page,r,{timeoutMs:15000},quick);
  assert.equal(got.contacts.status,"missing");
  assert.equal(got.financials.status,"missing");
  assert.equal(got.trucks.status,"missing");
  assert.deepEqual(got.errors,["contacts: card_changed","financials: card_changed","trucks: card_changed"]);
  assert.deepEqual(calls,["saved_navigation","fresh_identity","contacts"]);
});
test("a navigation hint that opens a different opaque card falls back to exact company search",async()=>{
  const r=row();rememberSabyNavigationHint(r,record());
  const {page,calls}=cardFixture({wrongCard:true});
  await assert.rejects(collectSabySections(page,r,{timeoutMs:15000},quick),e=>{
    assert.equal(e.message,"full search fallback reached");
    assert.equal(e.sabyTiming.saved_card,"miss");
    assert.equal(e.sabyTiming.full_search,true);
    return true;
  });
  assert.deepEqual(calls,["saved_navigation","full_search_navigation"]);
});
