import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import {scanSabyMarkupSnapshotDOM,readSabyMarkupSnapshot} from "../src/sabyMarkupSnapshot.js";
import {scanSabyMarkupOwnerDOM} from "../src/sabyMarkupOwnerDOM.js";
import {verifySabyCard} from "../src/sabyCard.js";
import {SABY_LEGAL_NAME_WORDS,sabyNameTokens} from "../src/sabyEnrichment.js";
import {recordSabyVisitTiming,restoreSabyTiming} from "../src/sabyVisitPolicy.js";
import {sabyBrowserSettings} from "../src/sabyBrowser.js";

const INN="7707083893",NAME="ООО «Альфа»";
const URL="https://profile.saby.ru/page/contractor-info?id=12345678-1234-1234-1234-123456789abc";
const row=()=>({"ИНН":INN,"Организация":NAME,"Телефон":"","Электронная почта":"",
  "Выручка последнего подтвержденного года":"","Численность":""});
const identity={inn:INN,name:"Альфа, ООО",verified:true};
const sections={contacts:true,financials:true,trucks:true};
const args={inn:INN,nameTokens:sabyNameTokens(NAME),legalWords:SABY_LEGAL_NAME_WORDS,
  sections:{contacts:true,financials:true,fleet:true}};

function fixture(){
  // Reduced selector structure from the 2026-11-27 rendered card:
  // compact+expanded legal H1, explicitly labelled INN, own-contact block,
  // "Еще N", employee interval, rounded banner, no year table/nav total.
  // Synthetic values only; never commit the original authenticated HTML.
  const node=(text="",attrs={},children={})=>({
    isConnected:true,textContent:text,innerText:text,hidden:false,
    getAttribute:k=>attrs[k]??null,querySelectorAll:s=>children[s]||[],
    getClientRects:()=>[{}],getBoundingClientRect:()=>({width:100,height:25})
  });
  const title=node("Альфа, ООО",{title:"Альфа, ООО"});
  const copy=node("Альфа, ООО",{title:"Альфа, ООО"});
  const label=node("ИНН"),value=node(INN);
  const innRow=node("ИНН "+INN,{},{
    ".contractor-Dialog_About-publicINN_label":[label],
    ".contractor-Dialog_INNKPP-pointer":[value]});
  const block=node("Контакты\n+7 (495) 123-45-67\nsales@example.test\nЕще 59",{},{
    '[data-qa="ContractorCard_Person"]':[node("Контакты")],
    '[data-qa="ContractorCard-Contacts__more"]':[node("Еще 59")]});
  const staff=node("10 000 — 50 000",{});
  staff.closest=()=>node("10 000 — 50 000 сотрудников");
  const widget=node("Автопарк компании",{},{
    '[data-qa="contractorCard-transport__header"]':[node("Автопарк компании")]});
  const scope={
    '[data-qa="headersNew-Content"] h1':[title,copy],
    '[data-qa="ContractorCard-About-ИНН"]':[innRow],
    '.contractorDialog-Contacts__Block-mainContacts':[block],
    '[data-qa="ContractorCard_Employees"]':[staff],
    '[data-qa="contractorCard-CardRatingBanner__Revenue"]':[node("Выручка: 5.8 трлн ₽")],
    '[data-qa="contractorCard-transport"]':[widget]
  };
  const root=node("",{},scope);
  const doc={querySelectorAll:s=>s==='[data-qa="contractorCard-dialog-Stack"]'?[root]:[],
    get body(){throw Error("broad body read not allowed on exact fast path");}};
  const context={document:doc,getComputedStyle:e=>({display:e.hidden?"none":"block",visibility:"visible",opacity:"1"})};
  const evaluate=(fn,input)=>vm.runInNewContext("("+fn.toString()+")(input)",{...context,input});
  return {title,copy,label,value,innRow,block,scope,root,doc,context,evaluate};
}
test("exact owner and all requested widget projections are read in one serialized browser function",()=>{
  const x=fixture();
  const out=x.evaluate(scanSabyMarkupSnapshotDOM,args);
  assert.equal(out.status,"observed");
  assert.match(out.contactText,/sales@example\.test/);
  assert.equal(out.moreContacts,true);
  assert.deepEqual(Array.from(out.financial.employeeTexts),["10 000 — 50 000"]);
  assert.equal(out.financial.banner,"Выручка: 5.8 трлн ₽");
  assert.equal(out.financial.years.length,0);
  assert.equal(out.fleet.reason,"navigation_not_unique");
  assert.doesNotMatch(JSON.stringify(out),/contractorCard-dialog-Stack|receivedStates|<html/);
});
test("exact scoped proof avoids broad identity scan, but rejects aliases or conflicting labels",async()=>{
  const x=fixture();
  let reads=0;
  const page={url:()=>URL,evaluate:async(fn,input)=>{reads++;return x.evaluate(fn,input);}};
  const out=await verifySabyCard(page,INN,NAME,{markupFirst:true});
  assert.equal(out.ok,true);assert.equal(out.proof,"scoped_markup");assert.equal(reads,1);
  assert.equal(x.evaluate(scanSabyMarkupOwnerDOM,args).name,"Альфа, ООО");
  x.copy.innerText="Бета, ООО";
  assert.equal(x.evaluate(scanSabyMarkupOwnerDOM,args),null);
  x.copy.innerText="Альфа, ООО";
  x.value.textContent="7700000000";
  assert.equal(x.evaluate(scanSabyMarkupOwnerDOM,args),null);
  x.value.textContent=INN;x.value.hidden=true;
  assert.equal(x.evaluate(scanSabyMarkupOwnerDOM,args),null);
  x.value.hidden=false;x.scope['[data-qa="ContractorCard-About-ИНН"]'].push(x.innRow);
  assert.equal(x.evaluate(scanSabyMarkupOwnerDOM,args),null);
});
const complete=()=>({
  status:"observed",contactText:"Контакты\n+7 (495) 123-45-67\nsales@example.test",
  financial:{employeeTexts:["8"],years:["2024","2025"],reportScale:"млн ₽",
    revenueRows:[["10","12"]],banner:"Выручка: 12 млн ₽"},
  fleet:{status:"observed",total:2,groups:[
    {key:"1",category:"Грузовые",count:1,labels:["КАМАЗ 5490, 2020"]},
    {key:"2",category:"Коммерческие",count:1,labels:["ГАЗ 3302, 2019"]}]}
});
const options=()=>({row:row(),identity,originalUrl:URL,sections,allVehicles:true});
test("validated complete fields and full inventory need only one snapshot; no browser interaction",async()=>{
  let reads=0;
  const r=await readSabyMarkupSnapshot({url:()=>URL,
    evaluate:async(fn,input)=>{reads++;assert.equal(fn,scanSabyMarkupSnapshotDOM);
      assert.equal(input.sections.fleet,true);return complete();}},options());
  assert.equal(reads,1);assert.equal(r.contacts.status,"collected");
  assert.deepEqual(r.contacts.phones,["74951234567"]);
  assert.equal(r.financials.revenue_rub,12000000);
  assert.equal(r.financials.revenue_year,2025);assert.equal(r.financials.employees,8);
  assert.equal(r.fleet.count,2);assert.equal(r.trucks.count,1);
});
test("partial Gazprom-style snapshot cannot invent staff, fiscal year, or full vehicle list",async()=>{
  const x=fixture(),p={url:()=>URL,evaluate:async(fn,input)=>x.evaluate(fn,input)};
  const r=await readSabyMarkupSnapshot(p,options());
  assert.equal(r.moreContacts,true);assert.equal(r.contacts.status,"collected");
  assert.equal(r.financials,null);assert.equal(r.fleet,null);
  const a=complete();a.contactText="Контакты\n+7 (495) 123-45-67";
  a.fleet.groups[0].count=2;a.fleet.total=3;
  const incomplete=await readSabyMarkupSnapshot({url:()=>URL,evaluate:async()=>a},options());
  assert.equal(incomplete.contacts,null);assert.equal(incomplete.fleet,null);
  assert.equal(incomplete.financials.revenue_year,2025);
});
test("requested field gaps, not already-known finance columns, control fast completion",async()=>{
  const opt=options();opt.row["Телефон"]="74951234567";
  opt.row["Выручка последнего подтвержденного года"]=1000000;
  const a=complete();a.contactText="Контакты\nsales@example.test";
  a.financial={employeeTexts:["0"],years:[],revenueRows:[]};
  const r=await readSabyMarkupSnapshot({url:()=>URL,evaluate:async()=>a},opt);
  assert.deepEqual(r.contacts.emails,["sales@example.test"]);
  assert.equal(r.financials.employees,0);
  assert.equal(r.financials.revenue_rub,null);
});
test("a foreign, changed, ambiguous or unverified card cannot supply a snapshot",async()=>{
  let route=URL;
  const p={url:()=>route,evaluate:async()=>{route=URL.replace("12345678-","22345678-");return complete();}};
  assert.equal(await readSabyMarkupSnapshot(p,options()),null);
  const unverified=options();unverified.identity={...identity,verified:false};
  assert.equal(await readSabyMarkupSnapshot({url:()=>URL,evaluate:()=>assert.fail("unverified DOM")},unverified),null);
  assert.equal(await readSabyMarkupSnapshot({url:()=>URL,evaluate:async()=>({status:"scope_unavailable"})},options()),null);
  const x=fixture();
  const proof=await verifySabyCard({url:()=>route,evaluate:async(fn,input)=>{
    const raw=x.evaluate(fn,input);route=URL;return raw;
  }},INN,NAME,{markupFirst:true});
  assert.equal(proof.ok,false);
});
test("snapshot counters survive checkpoints, legacy/full fallback remains and opt-out is explicit",()=>{
  assert.equal(sabyBrowserSettings({}).markupFastPath,true);
  assert.equal(sabyBrowserSettings({SABY_MARKUP_FAST_PATH_ENABLED:"false"}).markupFastPath,false);
  const t=restoreSabyTiming({markup_scans:2,markup_ms:120});
  recordSabyVisitTiming(t,{timing:{markup_scans:1,markup_scope_hits:1,markup_contacts_hits:1,
    markup_fleet_hits:0,markup_ms:30}},100);
  assert.equal(t.markup_scans,3);assert.equal(t.markup_ms,150);
  assert.equal(t.markup_contacts_hits,1);assert.equal(t.markup_fleet_hits,0);
  assert.equal(restoreSabyTiming(t).markup_scope_hits,1);
  const source=fs.readFileSync(new globalThis.URL("../src/sabyBrowser.js",import.meta.url),"utf8");
  assert.match(source,/if\(fullCard&&settings\.markupFastPath!==false&&sameCard\(\)\)/);
  assert.match(source,/readSabyMarkupSnapshot\(page,/);
  assert.match(source,/return ownContacts\(page\)/);
  assert.match(source,/return readSabyFinancials\(page,/);
  assert.match(source,/if\(fullCard&&allVehicles&&markup\?\.fleet&&sameCard\(\)&&/);
  assert.match(source,/await ownTrucks\(page,settings,fleetProgress/);
});
