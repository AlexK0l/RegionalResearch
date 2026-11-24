import test from "node:test";
import assert from "node:assert/strict";
import {parseFnsSearchResult,fnsSourceUrl,isFnsFormRoute,lookupFnsViaBrowser,fnsRegionLabelMatches}
  from "../src/independentInnFns.js";
import {chooseIndependentInnCandidate,verifyIndependentInnCandidate,
  planIndependentInnBackfill,runIndependentInnBackfill,checkFnsRegistryCanary,
  preciseLocalityMatch,hydrateFnsSearchAddresses} from "../src/independentInnBackfill.js";
import {extractVbrGeneralIdentity} from "../src/sabyIndependentVbrBridge.js";
import {extractRegistryVbrRecord,extractRegistryTbankRecord,createPublicRegistryLookup,registrySearchUrl,nextFnsExtractFailureCount} from "../src/independentInnRegistryBrowser.js";
import {extractIndependentRegistryIdentity} from "../src/sabyIndependentNameBridge.js";
import {parseOfficialFnsExtract,isOfficialExtractProof} from "../src/independentInnFnsExtract.js";

const inn="4706000909",ogrn="1024701329377",kpp="470601001";
const short='АО "ПРИМЕР"',full='АКЦИОНЕРНОЕ ОБЩЕСТВО "ПРИМЕР"';
const address="187300, ОБЛАСТЬ ЛЕНИНГРАДСКАЯ, Г.КИРОВСК, УЛ. ЖЕЛЕЗНОДОРОЖНАЯ, Д.59";
const source="https://www.tbank.ru/business/contractor/legal/"+ogrn+"/";
const raw={k:"ul",i:inn,o:ogrn,p:kpp,n:full,c:short,a:address,tot:"1",pg:"1"};
const official=()=>parseFnsSearchResult({rows:[raw]},{query:inn});
const bankRecord={inn,ogrn,kpp,full_name:full,short_name:short,address,active:true};
const target={organization:short,decision:"external_registry_search_required",candidates:[]};
const row=(id="a",organization=short,extra={})=>({
  __canonical_id:id,"Организация":organization,"ИНН":"","Город/район":"Кировск",...extra
});
const cp=rows=>({version:1,source_mode:"saby",phase:"saby",region:"Ленинградская область",
  final_result:{direct_buyers:rows,intermediaries:[],leasing:[],statistics:[]}});

test("FNS records preserve all identifiers and unknown activity; only proven complete exact-name result is complete",()=>{
  const out=official();
  assert.equal(out.state,"observed");
  assert.equal(out.complete,true);
  assert.equal(out.records.length,1);
  assert.equal(out.records[0].provider,"fns");
  assert.equal(out.records[0].url,fnsSourceUrl(inn));
  assert.equal(out.records[0].record.active,null);
  assert.equal(out.records[0].record.inn,inn);
  assert.equal(preciseLocalityMatch("Кировск",address),true);
  assert.equal(parseFnsSearchResult({rows:[raw]},{query:short,exactName:false}).complete,false);
  assert.equal(parseFnsSearchResult({rows:[raw]},{query:short,exactName:true}).complete,true);
  assert.equal(parseFnsSearchResult({rows:[{...raw,tot:"8"}]},{query:short,exactName:true}).complete,false);
  assert.equal(parseFnsSearchResult({rows:[{...raw,pg:"2"}]},{query:short,exactName:true}).complete,false);
  assert.equal(parseFnsSearchResult({rows:[raw]},{query:"7707083893"}).records.length,0);
  assert.equal(parseFnsSearchResult({rows:[{...raw,i:"4706000908"}]},{query:short,exactName:true}).allCardsRead,false);
  assert.equal(parseFnsSearchResult({rows:[{...raw,k:"ip"}]},{query:short,exactName:true}).records.length,0);
  assert.equal(parseFnsSearchResult({rows:[{...raw,c:"ПРИМЕР АО"}]},{query:inn}).records[0].record.short_name,"ПРИМЕР, АО");
  assert.equal(parseFnsSearchResult({rows:[{...raw,e:"01.01.2025"}]},{query:inn}).records[0].record.active,false);
  assert.throws(()=>parseFnsSearchResult({captchaRequired:true},{query:inn}),e=>e.code==="fns_captcha_required");
});
test("FNS candidate needs exact identifiers and independent explicit active status, not a generic source URL",()=>{
  const observed=parseFnsSearchResult({rows:[raw]},{query:short,exactName:true});
  const selection=chooseIndependentInnCandidate({row:row(),target,
    region:"Ленинградская область",search:observed});
  assert.equal(chooseIndependentInnCandidate({row:row(),target,
    region:"Мурманская область",search:observed}).status,"review");
  assert.equal(selection.status,"candidate");
  assert.equal(selection.provider,"fns");
  const verified=verifyIndependentInnCandidate(selection,{record:bankRecord,url:source},target);
  assert.equal(verified.status,"verified");
  assert.equal(verified.source_provider,"fns");
  for(const bad of [
    {...bankRecord,active:false},{...bankRecord,kpp:"470601002"},
    {...bankRecord,short_name:"ООО ПРИМЕР"}
  ])assert.equal(verifyIndependentInnCandidate(selection,{record:bad,url:source},target).status,"review");
  assert.equal(verifyIndependentInnCandidate({...selection,url:"https://fake.test/index.html?inn="+inn},
    {record:bankRecord,url:source},target).status,"review");
  const ceased=parseFnsSearchResult({rows:[{...raw,e:"01.01.2025"}]},{query:short,exactName:true});
  assert.equal(chooseIndependentInnCandidate({row:row(),target,search:ceased}).status,"review");
});
test("FNS only reopens prior VBR discovery failures once, preserving permanent reviews",async()=>{
  const checkpoint=cp([row("a"),row("b","АО Другой"),row("c","АО Третий"),
    row("d","АО Четвертый"),row("e","АО Пятый")]);
  checkpoint.independent_inn_backfill_outcomes={
    a:{status:"review",reason:"registry_search_unconfirmed"},
    b:{status:"review",reason:"source_link_not_proven",provider:"vbr"},
    c:{status:"review",reason:"source_identity_conflict"},
    d:{status:"review",reason:"registry_no_exact_legal_name",provider:"fns"}
  };
  const plan=planIndependentInnBackfill(checkpoint,{provider:"fns"});
  assert.equal(plan.pending,3);
  assert.equal(plan.reopened_from_vbr,2);
  const before=JSON.stringify(checkpoint);
  const result=await runIndependentInnBackfill({checkpoint,sourceId:"p",childId:"c",
    provider:"fns",limit:10,lookup:{
      search:async t=>t.original_canonical_id==="a"?official():{state:"observed",records:[]},
      confirm:async()=>({record:bankRecord,url:source})
    },onCheckpoint:async()=>{}});
  assert.equal(result.stats.added,1);
  assert.equal(result.stats.processed,3);
  assert.equal(result.snapshot.independent_inn_backfill_outcomes.b.provider,"fns");
  assert.equal(result.snapshot.independent_inn_backfill_outcomes.c.reason,"source_identity_conflict");
  assert.equal(planIndependentInnBackfill(result.snapshot,{provider:"fns"}).pending,0);
  assert.equal(JSON.stringify(checkpoint),before);
});
test("FNS live preflight exercises exact INN, independent card and exact registered name",async()=>{
  const checkpoint=cp([row("a",short,{"ИНН":inn,__evidence:{
    identity_verification:{inn,source_urls:[source]}}})]);
  const before=JSON.stringify(checkpoint),calls=[];
  const lookup={search:async(t,hint)=>{
    calls.push(hint?.inn||t.organization);return official();
  },confirm:async value=>{
    calls.push(value);return {record:bankRecord,url:source};
  }};
  assert.deepEqual(await checkFnsRegistryCanary(checkpoint,lookup),{verified:true,reason:"verified"});
  assert.deepEqual(calls,[inn,ogrn,full]);
  assert.equal(JSON.stringify(checkpoint),before);
  assert.deepEqual(await checkFnsRegistryCanary(checkpoint,{...lookup,
    search:async(t,hint)=>hint?official():{state:"observed",records:[]}
  }),{verified:false,reason:"fns_canary_name_unverified"});
  assert.deepEqual(await checkFnsRegistryCanary(checkpoint,{...lookup,
    confirm:async()=>null
  }),{verified:false,reason:"fns_canary_confirmation_unverified"});
  assert.deepEqual(await checkFnsRegistryCanary(checkpoint,{...lookup,
    search:async(t,hint)=>hint?official():{...official(),complete:false}
  }),{verified:false,reason:"fns_canary_name_incomplete"});
});
function browser({challenge=false,wrongQuery=false,staleOnly=false,
  hiddenCheckbox=true,missingButton=false,missingLabel=false,
  ineffectiveLabel=false,missingAssociatedLabel=false,
  regionWidget=false,wrongRegion=false,wrongSelectedRegion=false}={}){
  const token="0123456789ABCDEF",old="0000000000000000";
  const listeners=new Set(),visits=[],actions=[];
  let value="",checked=false,regionValue="";
  const input={count:async()=>1,isEnabled:async()=>true,waitFor:async()=>{},
    fill:async v=>{value=v;actions.push("fill");},inputValue:async()=>value};
  const checkbox={count:async()=>1,isEnabled:async()=>true,
    isVisible:async()=>!hiddenCheckbox,
    check:async()=>{assert.equal(hiddenCheckbox,false,"must not check hidden input");checked=true;actions.push("check");},
    isChecked:async()=>checked};
  const labelClick=async()=>{actions.push("label_click");if(!ineffectiveLabel)checked=true;};
  const label={count:async()=>missingLabel||missingAssociatedLabel?0:1,
    filter:options=>{assert.deepEqual(options,{visible:true});return label;},
    click:labelClick};
  const labelText={count:async()=>missingLabel?0:1,isVisible:async()=>!missingLabel,
    click:labelClick};
  const response=(url,method,payload,post="")=>({
    url:()=>url,status:()=>200,json:async()=>payload,
    request:()=>({method:()=>method,postData:()=>post})
  });
  const emit=async response=>{for(const fn of [...listeners])await fn(response);};
  const host="https://egrul.nalog.ru";
  const submit={count:async()=>missingButton?0:1,isEnabled:async()=>!missingButton,
    waitFor:async()=>{if(missingButton)throw Error("button missing");},click:async()=>{
    actions.push("submit");
    const post=new URLSearchParams({query:wrongQuery?"ДРУГОЙ":value,nameEq:checked?"on":"",
      region:wrongRegion?"99":regionValue}).toString();
    if(challenge){
      await emit(response(host+"/","POST",{captchaRequired:true},post));return;
    }
    // Responses may finish out of order. The old token is never accepted.
    await emit(response(host+"/search-result/"+old,"GET",{rows:[{...raw,a:"STALE"}]}));
    if(!staleOnly)await emit(response(host+"/search-result/"+token+"?r=1","GET",{rows:[raw]}));
    await emit(response(host+"/","POST",{t:token},post));
  }};
  const regionInput={count:async()=>regionWidget?1:0,isVisible:async()=>true,
    click:async()=>actions.push("region_open")};
  const regionForm={count:async()=>1,evaluate:async()=>[regionValue]};
  const regionOption={filter:()=>regionOption,first:()=>regionOption,
    waitFor:async()=>{},count:async()=>1,innerText:async()=>"47 - Ленинградская область",
    click:async()=>{regionValue=wrongSelectedRegion?"99":"47";actions.push("region_select");}};
  const regionField={filter:()=>regionField,locator:()=>regionInput};
  const page={
    url:()=>host+"/index.html",
    locator:selector=>{
      if(selector==='input#query[name="query"][type="text"]')return input;
      if(selector==='button#btnSearch[type="submit"]')return submit;
      if(selector==='input#nameEq[name="nameEq"][type="checkbox"]')return checkbox;
      if(selector==='label[for="nameEq"], label:has(input#nameEq)')return label;
      if(selector==='input#region[name="region"][data-dict="REGIONS"][data-kind="SET"]')return regionInput;
      if(selector==="form#frmSearch")return regionForm;
      if(selector==="div.form-field")return regionField;
      throw Error("unexpected selector: "+selector);
    },
    getByText:(text,opts)=>{
      if(text instanceof RegExp){assert.ok(text.test("47 - Ленинградская область"));return regionOption;}
      assert.equal(text,"Искать по точному соответствию наименования юридического лица или фамилии, имени и отчеству");
      assert.equal(opts.exact,true);return labelText;
    },
    on:(_event,fn)=>listeners.add(fn),
    off:(_event,fn)=>listeners.delete(fn),waitForTimeout:async()=>{}
  };
  return {page,visits,listeners,actions,navigate:async(u,check)=>{
    visits.push(u);assert.equal(check(page.url()),true);return true;
  },readBody:async()=>"Результаты поиска"};
}
test("official form observer accepts only matching submitted query and correlated response; no direct endpoint requests",async()=>{
  const b=browser();
  const found=await lookupFnsViaBrowser(b.page,{query:short,navigate:b.navigate,readBody:b.readBody});
  assert.equal(found.records[0].record.address,address);
  assert.equal(found.complete,true);
  assert.deepEqual(b.actions,["fill","label_click","submit"]);
  // Do not start at the root, which can downgrade HTTPS to HTTP.
  assert.deepEqual(b.visits,["https://egrul.nalog.ru/index.html"]);
  assert.equal(b.listeners.size,0);
  for(const [options,code] of [
    [{challenge:true},"fns_captcha_required"],
    [{wrongQuery:true},"fns_submit_unobserved"],
    [{staleOnly:true},"fns_result_unavailable"]
  ]){
    const x=browser(options);
    await assert.rejects(lookupFnsViaBrowser(x.page,{query:short,navigate:x.navigate,
      readBody:x.readBody}),e=>e.code===code);
    assert.equal(x.listeners.size,0);
  }
  assert.equal(isFnsFormRoute("https://egrul.nalog.ru/index.html"),true);
  assert.equal(isFnsFormRoute("http://egrul.nalog.ru/index.html"),false);
  assert.equal(isFnsFormRoute("https://egrul.nalog.ru.evil.test/index.html"),false);
});
test("observed FNS controls handle hidden and visible checkboxes and fail before an unproven exact-name submit",async()=>{
  for(const [options,query,expected] of [
    [{},inn,["fill","submit"]],
    [{hiddenCheckbox:false},short,["fill","check","submit"]],
    [{missingAssociatedLabel:true},short,["fill","label_click","submit"]]
  ]){
    const b=browser(options);
    const result=await lookupFnsViaBrowser(b.page,{query,navigate:b.navigate,readBody:b.readBody});
    assert.equal(result.records.length,1);
    assert.deepEqual(b.actions,expected);
  }
  for(const [options,code] of [
    [{missingButton:true},"fns_submit_button_unavailable"],
    [{missingLabel:true},"fns_exact_checkbox_not_selected"],
    [{ineffectiveLabel:true},"fns_exact_checkbox_not_selected"]
  ]){
    const b=browser(options);
    await assert.rejects(lookupFnsViaBrowser(b.page,{query:short,
      navigate:b.navigate,readBody:b.readBody}),e=>e.code===code);
    assert.ok(!b.actions.includes("submit"));
    assert.equal(b.listeners.size,0);
  }
});
test("VBR spaced duplicate identifiers and address remain exact, different copies never match",()=>{
  const text=[short,"Действующая организация","Общая информация",
    "Полное наименование",full+" "+full,"Краткое наименование",short+" "+short,
    "ИНН",inn+" "+inn,"КПП",kpp+" "+kpp,"ОГРН",ogrn+" "+ogrn,
    "Юридический адрес",address+" "+address,"Сведения об организации"].join("\n");
  assert.deepEqual(extractVbrGeneralIdentity(text),{
    inn,kpp,ogrn,full_name:full,short_name:short});
  assert.equal(extractRegistryVbrRecord(text).address,address);
  assert.equal(extractVbrGeneralIdentity(text.replace(inn+" "+inn,inn+" 7707083893")),null);
});

// Real search-result fixture captured on the VPS (FNS UI 1.9.2).
// The identity is present, but the list response has no legal address.
const observedVpsRow={
  k:"ul",i:"4712028540",o:"1184704015363",p:"471201001",
  n:'МУНИЦИПАЛЬНОЕ УНИТАРНОЕ ПРЕДПРИЯТИЕ "ТЕПЛОСЕТЬ ПЛОДОВОЕ" МУНИЦИПАЛЬНОГО ОБРАЗОВАНИЯ ПЛОДОВСКОЕ СЕЛЬСКОЕ ПОСЕЛЕНИЕ МУНИЦИПАЛЬНОГО ОБРАЗОВАНИЯ ПРИОЗЕРСКИЙ МУНИЦИПАЛЬНЫЙ РАЙОН ЛЕНИНГРАДСКОЙ ОБЛАСТИ',
  c:'МУП "ТЕПЛОСЕТЬ ПЛОДОВОЕ"',a:null,e:null,status:null,cnt:"1",pg:"1",tot:"1"
};
test("actual VPS FNS row without address retains verified identifiers and completeness, not geography",()=>{
  for(const r of [observedVpsRow,{...observedVpsRow,a:undefined}]){
    const result=parseFnsSearchResult({rows:[r]},{query:r.i});
    assert.equal(result.complete,true);
    assert.equal(result.allCardsRead,true);
    assert.equal(result.records.length,1);
    assert.deepEqual(result.records[0].record,{
      inn:r.i,ogrn:r.o,kpp:r.p,full_name:r.n,short_name:r.c,address:"",active:null
    });
    const selected=chooseIndependentInnCandidate({
      row:row("vps",r.c,{"Город/район":"Плодовое"}),
      target:{...target,organization:r.c},region:"Ленинградская область",search:result
    });
    assert.equal(selected.status,"review");
    assert.equal(selected.reason,"registry_address_unavailable");
    assert.equal(selected.candidates[0].inn,r.i);
  }
});

test("T-Bank address is read only from the same complete requisites panel",()=>{
  const card=[short,"Действующая организация","Реквизиты",
    "Полное название",full,"Краткое название",short,
    "Юридический адрес",address,"ИНН",inn,"КПП",kpp,"ОГРН",ogrn,
    "Регистрация ФНС"].join("\n");
  const expected={...bankRecord};
  assert.deepEqual(extractRegistryTbankRecord(card),expected);
  assert.equal(Object.hasOwn(extractIndependentRegistryIdentity(card),"address"),false);
  assert.equal(extractRegistryTbankRecord(card.replace("Юридический адрес\n"+address+"\n","")+
    "\nЮридический адрес\n"+address).address,undefined);
  assert.equal(extractRegistryTbankRecord(card.replace("ИНН\n"+inn,
    "Юридический адрес\n183000, Мурманская область, г Мурманск, ул Пример, д 1\nИНН\n"+inn)).address,undefined);
});

test("addressless FNS candidates hydrate only from exact independent identifiers and keep address provenance",async()=>{
  const data=parseFnsSearchResult({rows:[{...raw,a:null}]},{query:short,exactName:true});
  const addressFromBank="187300, Ленинградская обл., г Кировск, ул Железнодорожная, д 59";
  const second={record:{...bankRecord,address:addressFromBank},url:source};
  const lookup={confirm:async id=>{assert.equal(id,ogrn);return second;}};
  const resolved=await hydrateFnsSearchAddresses(data,target,lookup);
  assert.equal(data.records[0].record.address,"");
  assert.equal(resolved.confirmations.get(ogrn),second);
  const candidate=chooseIndependentInnCandidate({row:row(),target,
    region:"Ленинградская область",search:resolved.search});
  assert.equal(candidate.status,"candidate");
  assert.equal(candidate.address_source_url,source);
  const proof=verifyIndependentInnCandidate(candidate,second,target);
  assert.equal(proof.status,"verified");
  assert.equal(proof.legal_address,addressFromBank);
  assert.equal(proof.legal_address_source_url,source);
  assert.equal(verifyIndependentInnCandidate(candidate,
    {record:{...second.record,address:"Другой адрес, ул. Пример, д. 12"},url:source},target).status,"review");
  for(const bad of [
    null,{record:{...second.record,kpp:"470601002"},url:source},
    {record:{...second.record,short_name:"АО Другое"},url:source},
    {...second,url:"https://fake.test/business/contractor/legal/"+ogrn+"/"}
  ]){
    const x=await hydrateFnsSearchAddresses(data,target,{confirm:async()=>bad});
    assert.equal(x.search.records[0].record.address,"");
    assert.equal(chooseIndependentInnCandidate({row:row(),target,
      region:"Ленинградская область",search:x.search}).status,"review");
  }
});

test("unread competing address prevents geography-only assignment even for an inactive namesake",async()=>{
  const other={...raw,i:"7810165652",o:"1024701479571",p:"472701001",
    a:null,e:"01.01.2020",tot:"2"};
  const data=parseFnsSearchResult({rows:[{...raw,a:null,tot:"2"},other]},
    {query:short,exactName:true});
  assert.equal(data.complete,true);
  assert.equal(data.records.length,2);
  const lookup={confirm:async id=>id===ogrn?{record:bankRecord,url:source}:null};
  const partial=await hydrateFnsSearchAddresses(data,target,lookup);
  assert.equal(chooseIndependentInnCandidate({row:row(),target,
    region:"Ленинградская область",search:partial.search}).reason,"registry_address_unavailable");
  const fullRead=await hydrateFnsSearchAddresses(data,target,{confirm:async id=>
    id===ogrn?{record:bankRecord,url:source}:{
      record:{...bankRecord,inn:other.i,kpp:other.p,ogrn:other.o,
        active:false,address:"183000, Мурманская обл., г Кировск, ул Пример, д 1"},
      url:"https://www.tbank.ru/business/contractor/legal/"+other.o+"/"
    }});
  const candidate=chooseIndependentInnCandidate({row:row(),target,
    region:"Ленинградская область",search:fullRead.search});
  assert.equal(candidate.status,"candidate");
  assert.equal(candidate.record.inn,inn);
});

test("preflight skips a known inactive company but confirms a second complete live search with an independently read address",async()=>{
  const known=cp([
    row("inactive",short,{"ИНН":inn,__evidence:{identity_verification:{inn,source_urls:[source]}}}),
    row("active",'АО "ВТОРОЙ ПРИМЕР"',{"ИНН":"7810165652",__evidence:{
      identity_verification:{inn:"7810165652",source_urls:[source]}}})
  ]);
  const other={...raw,i:"7810165652",o:"1024701479571",p:"472701001",
    n:'АКЦИОНЕРНОЕ ОБЩЕСТВО "ВТОРОЙ ПРИМЕР"',c:'АО "ВТОРОЙ ПРИМЕР"',a:null};
  const calls=[];
  const lookup={
    search:async(t,hint)=>{
      calls.push(hint?.inn||t.organization);
      return parseFnsSearchResult({rows:[hint?.inn===inn?{...raw,a:null}:other]},
        {query:hint?.inn||t.organization,exactName:!hint});
    },
    confirm:async id=>{
      calls.push(id);
      return id===ogrn?{record:{...bankRecord,active:false},url:source}:{
        record:{...bankRecord,inn:other.i,ogrn:other.o,kpp:other.p,
          full_name:other.n,short_name:other.c},
        url:"https://www.tbank.ru/business/contractor/legal/"+other.o+"/"
      };
    }
  };
  assert.deepEqual(await checkFnsRegistryCanary(known,lookup),{verified:true,reason:"verified"});
  assert.deepEqual(calls,[inn,ogrn,other.i,other.o,other.n]);
});

test("run reuses address confirmation without a second request and preserves original checkpoint",async()=>{
  const checkpoint=cp([row()]);
  const before=JSON.stringify(checkpoint),calls=[];
  const output=await runIndependentInnBackfill({checkpoint,sourceId:"p",childId:"c",
    provider:"fns",limit:1,lookup:{
      search:async()=>parseFnsSearchResult({rows:[{...raw,a:null}]},{query:short,exactName:true}),
      confirm:async id=>{calls.push(id);return {record:bankRecord,url:source};}
    },onCheckpoint:async()=>{}});
  assert.equal(output.stats.added,1);
  assert.deepEqual(calls,[ogrn]);
  assert.equal(output.snapshot.final_result.direct_buyers[0]["ИНН"],inn);
  assert.equal(output.snapshot.final_result.direct_buyers[0].__evidence.identity_verification.legal_address_source_url,source);
  assert.equal(JSON.stringify(checkpoint),before);
});


// Actual adapter contract: first try the independent T-Bank card, then
// resolve a single observed VBR card by the exact official OGRN.
const vbrCardUrl="https://kontragent.vbr.ru/company/ao-primer-"+ogrn+"/";
const vbrCardText=[short,"Действующая организация. Проверено: 20.11.2026",
  "Общая информация","Полное наименование",full,"Краткое наименование",short,
  "ОГРН",ogrn,"ИНН",inn,"КПП",kpp,"Юридический адрес",address,
  "Сведения об организации"].join("\n");
const bankCardText=[short,"Действующая организация","Реквизиты",
  "Полное название",full,"Краткое название",short,"ИНН",inn,
  "КПП",kpp,"ОГРН",ogrn,"Юридический адрес",address,"Регистрация ФНС"].join("\n");
function confirmationPage({bankError="",bankStatus=200,vbrStatus=200,
  bankBody=bankCardText,vbrBody=vbrCardText,links=[vbrCardUrl]}={}){
  const visits=[],diagnostics=[],waits=[];
  const page={current:"",
    async goto(url,options){
      visits.push({url,waitUntil:options.waitUntil});
      if(url===source&&bankError){
        const error=Error(bankError);
        if(bankError==="timeout")error.name="TimeoutError";
        throw error;
      }
      this.current=url;
      return {status:()=>url===source?bankStatus:
        url===registrySearchUrl(ogrn)?vbrStatus:200};
    },
    url(){return this.current;},
    isClosed:()=>false,
    waitForTimeout:async ms=>{waits.push(ms);},
    async evaluate(){
      if(this.current===source)return bankBody;
      if(this.current===registrySearchUrl(ogrn))return {
        text:"Найдено 1 организация",links:links.map(url=>({url,title:short})),
        inputs:[ogrn],hasMore:false,truncated:false};
      if(this.current===vbrCardUrl)return vbrBody;
      throw Error("unexpected route");
    }
  };
  return {page,visits,diagnostics,waits,onDiagnostic:d=>diagnostics.push(d)};
}
test("T-Bank connection failure falls back to observed VBR OGRN and permits addressless FNS recovery",async()=>{
  const f=confirmationPage({bankError:"net::ERR_CONNECTION_RESET"});
  const lookup=await createPublicRegistryLookup(f.page,{provider:"fns",maxPages:3,onDiagnostic:f.onDiagnostic});
  const data=parseFnsSearchResult({rows:[{...raw,a:null}]},{query:short,exactName:true});
  const hydrated=await hydrateFnsSearchAddresses(data,target,lookup);
  const selection=chooseIndependentInnCandidate({row:row(),target,region:"Ленинградская область",search:hydrated.search});
  assert.equal(selection.status,"candidate");
  assert.equal(selection.address_source_url,vbrCardUrl);
  const proof=verifyIndependentInnCandidate(selection,hydrated.confirmations.get(ogrn),target);
  assert.equal(proof.status,"verified");
  assert.deepEqual(proof.source_urls,[fnsSourceUrl(inn),vbrCardUrl]);
  assert.deepEqual(f.visits.map(v=>v.url),[source,registrySearchUrl(ogrn),vbrCardUrl]);
  assert.ok(f.visits.every(v=>v.waitUntil==="commit"));
  assert.ok(f.diagnostics.some(d=>d.provider==="tbank"&&d.stage==="card_navigation"&&d.transport==="connection"));
  assert.equal(lookup.pages,3);
});
test("ordinary complete T-Bank card needs no fallback; explicit contradiction is not overridden",async()=>{
  for(const [body,expectedStatus] of [
    [bankCardText,"verified"],
    [bankCardText.replace(kpp,"470601002"),"review"],
    [bankCardText.replace("Действующая организация","Организация в процессе ликвидации"),"review"]
  ]){
    const f=confirmationPage({bankBody:body});
    const lookup=await createPublicRegistryLookup(f.page,{provider:"fns",maxPages:4,onDiagnostic:f.onDiagnostic});
    const confirmation=await lookup.confirm(ogrn,bankRecord);
    const data=official();
    const selection=chooseIndependentInnCandidate({row:row(),target,region:"Ленинградская область",search:data});
    assert.equal(verifyIndependentInnCandidate(selection,confirmation,target).status,expectedStatus);
    assert.deepEqual(f.visits.map(v=>v.url),[source]);
  }
});
test("VBR exact OGRN proof is accepted only for an FNS primary record; incorrect cards and ambiguity fail closed",async()=>{
  const data=official();
  const selection=chooseIndependentInnCandidate({row:row(),target,region:"Ленинградская область",search:data});
  const confirmation={url:vbrCardUrl,record:bankRecord};
  assert.equal(verifyIndependentInnCandidate(selection,confirmation,target).status,"verified");
  assert.equal(verifyIndependentInnCandidate({...selection,provider:"vbr",url:vbrCardUrl},confirmation,target).status,"review");
  assert.equal(verifyIndependentInnCandidate(selection,{...confirmation,record:{...bankRecord,inn:"7707083893"}},target).status,"review");
  const f=confirmationPage({bankError:"timeout",links:[vbrCardUrl,"https://kontragent.vbr.ru/company/drugaya-"+ogrn+"/"]});
  const lookup=await createPublicRegistryLookup(f.page,{provider:"fns",maxPages:5,onDiagnostic:f.onDiagnostic});
  assert.equal(await lookup.confirm(ogrn,bankRecord),null);
  assert.deepEqual(f.visits.map(v=>v.url),[source,registrySearchUrl(ogrn)]);
});
test("technical failure of one provider is bounded, and denied access is not retried",async()=>{
  const f=confirmationPage({bankError:"timeout"});
  const lookup=await createPublicRegistryLookup(f.page,{provider:"fns",maxPages:9,onDiagnostic:f.onDiagnostic});
  for(let i=0;i<3;i++)assert.equal((await lookup.confirm(ogrn,bankRecord)).url,vbrCardUrl);
  assert.equal(f.visits.filter(v=>v.url===source).length,2);
  assert.ok(f.diagnostics.some(d=>d.provider==="tbank"&&d.disabled===true));
  const blocked=confirmationPage({bankStatus:403,vbrStatus:429});
  const denied=await createPublicRegistryLookup(blocked.page,{provider:"fns",maxPages:5,onDiagnostic:blocked.onDiagnostic});
  await assert.rejects(denied.confirm(ogrn,bankRecord),e=>e.code==="registry_confirmation_unavailable");
  await assert.rejects(denied.confirm(ogrn,bankRecord),e=>e.code==="registry_confirmation_unavailable");
  assert.equal(denied.pages,2);
  assert.ok(blocked.diagnostics.some(d=>d.provider==="tbank"&&d.http_status===403));
  assert.ok(blocked.diagnostics.some(d=>d.provider==="vbr"&&d.http_status===429));
});
test("navigation budget is not swallowed by confirmation fallback",async()=>{
  const f=confirmationPage({bankError:"timeout"});
  const lookup=await createPublicRegistryLookup(f.page,{provider:"fns",maxPages:1});
  await assert.rejects(lookup.confirm(ogrn,bankRecord),e=>e.code==="navigation_budget");
  assert.equal(lookup.pages,1);
});


// The first-page fixture uses the actual 2026-11-24 VPS layout.
// The second page is a synthetic minimal continuation to exercise the
// scoped tax fields and full-document checks, NOT another live extract.
const extractInn="7811285487",extractOgrn="1167847075230",extractKpp="781101001";
const extractFull='ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "СТРОЙОРИЕНТ"';
const extractShort='ООО "СТРОЙОРИЕНТ"';
const extractAddress="193318, Г.САНКТ-ПЕТЕРБУРГ, ВН.ТЕР.Г. МУНИЦИПАЛЬНЫЙ ОКРУГ ПРАВОБЕРЕЖНЫЙ, УЛ. ВОРОШИЛОВА, Д. 2 ЛИТЕРА АБ, ПОМЕЩ. 7-Н";
const today=Date.UTC(2026,10,24,10,42);
const firstExtractPage=[
  "                                             ВЫПИСКА",
  "                        из Единого государственного реестра юридических лиц",
  "",
  "         24.11.2026                                                               №   ЮЭ9965-26-",
  "                                                                                      254581820",
  " дата формирования выписки",
  "",
  "Настоящая выписка содержит сведения о юридическом лице",
  "           "+extractFull,
  "                                          полное наименование юридического лица",
  "",
  "                               ОГРН "+extractOgrn.split("").join(" "),
  "                                ИНН "+extractInn.split("").join(" "),
  "включенные в Единый государственный реестр юридических лиц по состоянию на",
  "« 24 »          ноября             2026 г.",
  " число        месяц прописью        год",
  "",
  "№ п/п             Наименование показателя                   Значение показателя",
  " 1                            2                                      3",
  "                                        Наименование",
  "   1      Полное наименование на русском языке   ОБЩЕСТВО С ОГРАНИЧЕННОЙ",
  "                                                 ОТВЕТСТВЕННОСТЬЮ",
  '                                                 "СТРОЙОРИЕНТ"',
  "   2      ГРН и дата внесения в ЕГРЮЛ записи,    1167847075230",
  "          содержащей указанные сведения          02.02.2016",
  "",
  '   3      Сокращенное наименование на русском                    ООО "СТРОЙОРИЕНТ"',
  "          языке",
  "   4      ГРН и дата внесения в ЕГРЮЛ записи,                    1167847075230",
  "          содержащей указанные сведения                          02.02.2016",
  "",
  "                               Место нахождения и адрес юридического лица",
  "",
  "   5      Адрес юридического лица                                193318,",
  "                                                                 Г.САНКТ-ПЕТЕРБУРГ,",
  "                                                                 ВН.ТЕР.Г. МУНИЦИПАЛЬНЫЙ ОКРУГ",
  "                                                                 ПРАВОБЕРЕЖНЫЙ,",
  "                                                                 УЛ. ВОРОШИЛОВА,",
  "                                                                 Д. 2 ЛИТЕРА АБ,",
  "                                                                 ПОМЕЩ. 7-Н",
  "   6      ГРН и дата внесения в ЕГРЮЛ записи,                    2267802102291",
  "          содержащей указанные сведения                          21.07.2026",
  "",
  "                                           Сведения о регистрации",
  "   7      Способ образования                              Создание юридического лица",
  "   8      ОГРН                                            1167847075230",
  "   9      Дата регистрации                                02.02.2016",
  "",
  "",
  "Выписка из ЕГРЮЛ",
  "24.11.2026 13:42                                  ОГРН 1167847075230                      Страница 1 из 2"
].join("\n");
const lastExtractPage=[
  "  10    ГРН и дата внесения в ЕГРЮЛ записи,        1167847075230",
  "        содержащей указанные сведения             02.02.2016",
  "",
  "     Сведения о регистрирующем органе по месту нахождения юридического лица",
  "  11 Наименование регистрирующего органа   Межрайонная инспекция Федеральной",
  "                                           налоговой службы №15 по Санкт-",
  "                                           Петербургу",
  "  12 Адрес регистрирующего органа          ,190068, Санкт-Петербург г,,,, Канала",
  "                                           Грибоедова наб, д 133литерБ,,",
  "  13 ГРН и дата внесения в ЕГРЮЛ записи,        1167847075230",
  "     содержащей указанные сведения             02.02.2016",
  "",
  "                         Сведения об учете в налоговом органе",
  "  14      ИНН юридического лица                                  "+extractInn,
  "  15      КПП юридического лица                                  "+extractKpp,
  "  16      Дата постановки на учет в налоговом органе             02.02.2016",
  "",
  "          Сведения о лице, имеющем право без доверенности действовать от имени юридического лица",
  "  17      ИНН                                                    7707083893",
  "",
  "Выписка из ЕГРЮЛ",
  "24.11.2026 13:42                                  ОГРН 1167847075230                      Страница 2 из 2"
].join("\n");
const extractText=firstExtractPage+"\f"+lastExtractPage+"\f";
const extractParse=text=>parseOfficialFnsExtract(text,{now:today});
test("current FNS PDF layout has scoped registration, full/short names, address and tax identifiers",()=>{
  const parsed=extractParse(extractText);
  assert.equal(parsed.reason,"fns_extract_parsed");
  assert.deepEqual(parsed.record,{inn:extractInn,ogrn:extractOgrn,kpp:extractKpp,
    full_name:extractFull,short_name:extractShort,address:extractAddress,active:true});
  assert.deepEqual(parsed.metadata,{date:"24.11.2026",number:"ЮЭ9965-26-254581820",page_count:2,
    status_basis:"complete_extract_no_adverse_status"});
});
test("official extract must contain every page, current date and the current entity's scoped identifiers",()=>{
  for(const bad of [
    firstExtractPage,
    extractText.replace("Страница 2 из 2","Страница 2 из 3"),
    extractText.replace("ОГРН 1167847075230                      Страница 2","ОГРН 1024701329377                      Страница 2"),
    extractText.replace("14      ИНН юридического лица                                  "+extractInn,
      "14      ИНН юридического лица                                  7707083893"),
    extractText.replace("15      КПП юридического лица","15      ИНН юридического лица"),
    extractText.replace("24.11.2026                                                               №","20.11.2026                                                               №"),
    extractText.replace("Адрес юридического лица","Адрес регистрирующего органа")
  ])assert.equal(extractParse(bad).record,undefined);
  const inactive=extractParse(extractText.replace("Сведения о регистрации",
    "Сведения о состоянии юридического лица\n                                           Сведения о регистрации"));
  assert.equal(inactive.record?.active,false);
  assert.equal(inactive.metadata?.status_basis,"current_adverse_status");
});
test("ordinary complete name search never requires the broken styled exact-name checkbox",async()=>{
  const b=browser({missingLabel:true});
  const result=await lookupFnsViaBrowser(b.page,{query:short,navigate:b.navigate,
    readBody:b.readBody,completeNameSearch:true});
  assert.equal(result.query_kind,"complete_normal_name");
  assert.equal(result.complete,true);
  assert.deepEqual(b.actions,["fill","submit"]);
  assert.equal(parseFnsSearchResult({rows:[{...raw,tot:"100"}]},
    {query:short,completeNameSearch:true}).complete,false);
  assert.equal(parseFnsSearchResult({rows:[raw,{...raw,i:"invalid",tot:"2"}]},
    {query:short,completeNameSearch:true}).complete,false);
});
test("official extract proof requires source linkage, all identifiers and current status; it is not a two-registry proof",async()=>{
  const fns=parseFnsSearchResult({rows:[{k:"ul",i:extractInn,o:extractOgrn,p:extractKpp,
    n:extractFull,c:extractShort,tot:"1",pg:"1"}]},{query:extractShort,completeNameSearch:true});
  const target={organization:extractShort,decision:"external_registry_search_required",candidates:[]};
  const parsed=extractParse(extractText);
  const official={kind:"fns_extract",url:fnsSourceUrl(extractInn),record:parsed.record,
    extract:{...parsed.metadata,sha256:"a".repeat(64)}};
  const hydrated=await hydrateFnsSearchAddresses(fns,target,{confirm:async()=>official});
  const choose=(city,region)=>chooseIndependentInnCandidate({
    row:row("test",extractShort,{"Город/район":city}),target,region,search:hydrated.search
  });
  assert.equal(choose("Кировск","Ленинградская область").status,"review");
  assert.equal(choose("Санкт-Петербург","Ленинградская область").status,"review");
  const candidate=choose("Санкт-Петербург","Санкт-Петербург");
  assert.equal(candidate.status,"candidate");
  const verified=verifyIndependentInnCandidate(candidate,official,target);
  assert.equal(verified.reason,"official_fns_extract_verified");
  assert.deepEqual(verified.source_urls,[fnsSourceUrl(extractInn)]);
  assert.deepEqual(verified.official_extract,official.extract);
  assert.equal(isOfficialExtractProof({...official,url:"https://fake.test/"},extractInn),false);
  for(const bad of [
    {...official,extract:{...official.extract,sha256:""}},
    {...official,record:{...official.record,kpp:"781101002"}},
    {...official,record:{...official.record,active:false}}
  ])assert.equal(verifyIndependentInnCandidate(candidate,bad,target).status,"review");
});

// Regression for the 2026-11-24 VPS outcome: positive official extract,
// positive matching name hit, but incomplete broad name search.
test("official extract canary reports incomplete name search without blocking unrelated queue rows",async()=>{
  const checkpoint=cp([row("known",short,{"ИНН":inn,__evidence:{
    identity_verification:{inn,source_urls:[source]}}})]);
  const before=JSON.stringify(checkpoint);
  const pdf={kind:"fns_extract",url:fnsSourceUrl(inn),record:bankRecord,
    extract:{date:"24.11.2026",number:"ЮЭ9965-26-254581820",page_count:29,
      status_basis:"complete_extract_no_adverse_status",sha256:"a".repeat(64)}};
  const partial=parseFnsSearchResult({rows:[{...raw,tot:"27"}]},
    {query:full,completeNameSearch:true});
  const lookup={search:async(t,hint)=>hint?official():partial,confirm:async()=>pdf};
  assert.equal(partial.complete,false);
  assert.deepEqual(partial.completeness,{raw_rows:1,parsed_rows:1,
    distinct_ogrns:1,reported_total:27,total_proven:false,first_page_only:true,
    missing_or_invalid_total_rows:0,missing_page_rows:0,all_cards_read:true});
  assert.deepEqual(await checkFnsRegistryCanary(checkpoint,lookup),
    {verified:true,reason:"verified_name_search_incomplete",name_search_complete:false});
  assert.deepEqual(await checkFnsRegistryCanary(checkpoint,{...lookup,
    search:async(t,hint)=>hint?official():{...partial,records:[]}}),
    {verified:false,reason:"fns_canary_name_unverified"});
  assert.deepEqual(await checkFnsRegistryCanary(checkpoint,{...lookup,
    confirm:async()=>({...pdf,extract:{...pdf.extract,sha256:""}})}),
    {verified:false,reason:"fns_canary_confirmation_unverified"});
  assert.equal(JSON.stringify(checkpoint),before);
});
test("incomplete unanchored FNS search is reviewed without extracting PDFs, then next complete row can recover",async()=>{
  const other={...raw,i:"7810165652",o:"1024701479571",p:"472701001",
    n:'АКЦИОНЕРНОЕ ОБЩЕСТВО "ВТОРОЙ ПРИМЕР"',c:'АО "ВТОРОЙ ПРИМЕР"'};
  const checkpoint=cp([row("a"),row("b",other.c)]);
  const before=JSON.stringify(checkpoint),calls=[];
  const partial=parseFnsSearchResult({rows:[{...raw,a:null,tot:"12"}]},
    {query:short,completeNameSearch:true});
  const complete=parseFnsSearchResult({rows:[other]},
    {query:other.c,completeNameSearch:true});
  const proof={kind:"fns_extract",url:fnsSourceUrl(other.i),
    record:{...complete.records[0].record,active:true},
    extract:{date:"24.11.2026",number:"ЮЭ9965-26-254581820",page_count:17,
      status_basis:"complete_extract_no_adverse_status",sha256:"b".repeat(64)}};
  const output=await runIndependentInnBackfill({checkpoint,sourceId:"p",
    childId:"c",provider:"fns",limit:2,lookup:{
      search:async t=>t.original_canonical_id==="a"?partial:complete,
      confirm:async id=>{calls.push(id);return proof;}
    },onCheckpoint:async()=>{}});
  assert.equal(output.stats.processed,2);
  assert.equal(output.stats.added,1);
  assert.equal(output.stats.review,1);
  assert.deepEqual(calls,[other.o]);
  assert.equal(output.snapshot.independent_inn_backfill_outcomes.a.reason,
    "registry_name_search_incomplete");
  assert.equal(output.snapshot.final_result.direct_buyers[0]["ИНН"],"");
  assert.equal(output.snapshot.final_result.direct_buyers[1]["ИНН"],other.i);
  assert.equal(JSON.stringify(checkpoint),before);
  // Missing totals or unreadable records stay incomplete; do not
  // interpret a returned positive result as proof of unique identity.
  const unreadable=parseFnsSearchResult({rows:[{...raw,tot:"2"},null]},
    {query:short,completeNameSearch:true});
  assert.equal(unreadable.complete,false);
  assert.equal(unreadable.completeness.missing_or_invalid_total_rows,1);
  assert.equal(unreadable.completeness.parsed_rows,1);
  assert.equal(chooseIndependentInnCandidate({row:row(),target,
    region:"Ленинградская область",search:unreadable}).reason,
    "registry_name_search_incomplete");
});

// A successful download plus an unrecognized document layout is not a
// network outage; only a failure to receive usable PDF text counts.
test("PDF-specific proof failures do not trip the transport circuit breaker",()=>{
  let failures=2;
  for(let i=0;i<4;i++){
    failures=nextFnsExtractFailureCount(failures,null,{
      reason:"fns_extract_header_unproven",pdf_text_available:true});
    assert.equal(failures,0);
  }
  assert.equal(nextFnsExtractFailureCount(2,null,{reason:"fns_extract_not_pdf"}),3);
  assert.equal(nextFnsExtractFailureCount(2,{},null),0);
  const header=extractParse(extractText.replace("полное наименование юридического лица","Наименование"));
  assert.equal(header.reason,"fns_extract_header_unproven");
  assert.equal(header.diagnostic.header_issue,"header_legal_name");
  assert.equal(header.diagnostic.observed_pages,2);
});
test("public region filter binds the visible dictionary selection to the actual submitted region",async()=>{
  const region="Ленинградская область";
  assert.equal(fnsRegionLabelMatches("47 - Ленинградская область",region),true);
  assert.equal(fnsRegionLabelMatches("Ленинградская область (47)",region),true);
  assert.equal(fnsRegionLabelMatches("Ленинградская область другая",region),false);
  const b=browser({regionWidget:true});
  const out=await lookupFnsViaBrowser(b.page,{query:short,navigate:b.navigate,readBody:b.readBody,
    completeNameSearch:true,region});
  assert.equal(out.search_region,region);
  assert.equal(out.complete,true);
  assert.deepEqual(b.actions,["fill","region_open","region_select","submit"]);
  const wrong=browser({regionWidget:true,wrongRegion:true});
  await assert.rejects(lookupFnsViaBrowser(wrong.page,{query:short,navigate:wrong.navigate,
    readBody:wrong.readBody,completeNameSearch:true,region}),e=>e.code==="fns_region_filter_unavailable");
  assert.equal(wrong.listeners.size,0);
  const wrongSelection=browser({regionWidget:true,wrongSelectedRegion:true});
  await assert.rejects(lookupFnsViaBrowser(wrongSelection.page,{query:short,navigate:wrongSelection.navigate,
    readBody:wrongSelection.readBody,completeNameSearch:true,region}),e=>e.code==="fns_region_filter_unavailable");
  assert.ok(!wrongSelection.actions.includes("submit"));
  const absent=browser();
  await assert.rejects(lookupFnsViaBrowser(absent.page,{query:short,navigate:absent.navigate,
    readBody:absent.readBody,completeNameSearch:true,region}),e=>e.code==="fns_region_filter_unavailable");
  assert.ok(!absent.actions.includes("submit"));
  assert.equal(chooseIndependentInnCandidate({row:row(),target,region:"Мурманская область",
    search:out}).reason,"registry_region_scope_unproven");
  assert.equal(chooseIndependentInnCandidate({row:row(),target,region,
    search:out}).status,"candidate");
});
test("reopen only pre-regional-strategy FNS incomplete name reviews; preserve conflicts and completed attempts",async()=>{
  const checkpoint=cp([row("a"),row("b"),row("c"),row("d")]);
  checkpoint.independent_inn_backfill_outcomes={
    a:{status:"review",reason:"registry_name_search_incomplete",provider:"fns"},
    b:{status:"review",reason:"source_ogrn_conflict",provider:"fns"},
    c:{status:"review",reason:"registry_name_search_incomplete",provider:"fns",name_search_revision:2}
  };
  const plan=planIndependentInnBackfill(checkpoint,{provider:"fns"});
  assert.equal(plan.pending,2);
  assert.equal(plan.reopened_fns_name_search,1);
  const result=await runIndependentInnBackfill({checkpoint,sourceId:"p",childId:"c",
    limit:4,provider:"fns",lookup:{search:async()=>({...official(),complete:false}),
      confirm:async()=>{throw Error("must not download");}},onCheckpoint:async()=>{}});
  assert.equal(result.stats.processed,2);
  assert.equal(result.stats.added,0);
  assert.equal(planIndependentInnBackfill(result.snapshot,{provider:"fns"}).pending,0);
  assert.equal(result.snapshot.independent_inn_backfill_outcomes.b.reason,"source_ogrn_conflict");
});
test("unparsed extract is recorded as row-specific proof failure; next company remains processable",async()=>{
  const other={...raw,i:"7810165652",o:"1024701479571",p:"472701001",
    n:'АКЦИОНЕРНОЕ ОБЩЕСТВО "ВТОРОЙ ПРИМЕР"',c:'АО "ВТОРОЙ ПРИМЕР"'};
  const checkpoint=cp([row("a"),row("b",other.c)]);
  const out=await runIndependentInnBackfill({checkpoint,sourceId:"p",childId:"c",
    provider:"fns",limit:2,lookup:{
      search:async t=>parseFnsSearchResult({rows:[t.original_canonical_id==="a"?{...raw,a:null}:other]},
        {query:t.organization,completeNameSearch:true}),
      confirm:async id=>id===ogrn?null:{url:"https://www.tbank.ru/business/contractor/legal/"+other.o+"/",
        record:{inn:other.i,ogrn:other.o,kpp:other.p,full_name:other.n,short_name:other.c,
          address,active:true}},
      confirmationIssue:id=>id===ogrn?"fns_extract_header_unproven":""
    },onCheckpoint:async()=>{}});
  assert.equal(out.stats.processed,2);
  assert.equal(out.stats.added,1);
  assert.deepEqual(out.snapshot.independent_inn_backfill_outcomes.a.confirmation_issues,
    ["fns_extract_header_unproven"]);
  assert.equal(out.snapshot.final_result.direct_buyers[0]["ИНН"],"");
});

// The live name-search logs show first-row-only pagination metadata.
// Synthetic records cover the observed sparse shape without embedding
// any actual lead names, person details or temporary search tokens.
test("FNS sparse first-row totals may prove only bounded fully read name results",()=>{
  const other={...raw,i:"7810165652",o:"1024701479571",p:"472701001",
    n:'АКЦИОНЕРНОЕ ОБЩЕСТВО "ДРУГОЙ ПРИМЕР"',c:'АО "ДРУГОЙ ПРИМЕР"'};
  delete other.tot;delete other.pg;
  const first={...raw,tot:"2",cnt:"2",pg:"1"};
  const read=rows=>parseFnsSearchResult({rows},{query:short,completeNameSearch:true});
  const complete=read([first,other]);
  assert.equal(complete.complete,true);
  assert.equal(complete.total_reported,2);
  assert.equal(complete.completeness.reported_total,2);
  assert.equal(complete.completeness.missing_or_invalid_total_rows,1);
  assert.equal(complete.completeness.missing_page_rows,1);
  for(const bad of [
    [{...first,tot:"21"},other],
    [{...first,tot:"20+"},other],
    [{...first,tot:undefined},other],
    [{...first,pg:undefined},other],
    [{...first,pg:"2"},other],
    [{...first,cnt:"20"},other],
    [first,{...other,tot:"3"}],
    [first,{...other,tot:""}],
    [first,{...other,pg:"2"}],
    [first,{...other,i:"invalid"}],
    [first,{...other,o:first.o}],
    [other,{...first,tot:"2"}],
    Array.from({length:20},(_,i)=>i===0?{...first,tot:"20",cnt:"20"}:{...other})
  ])assert.equal(read(bad).complete,false);
  // A full 20-row response is not proven complete merely because the
  // first row declares 20; the real UI explicitly warns about truncation.
  assert.equal(read(Array.from({length:20},(_,i)=>i===0?
    {...first,tot:"20",cnt:"20"}:{...other})).completeness.total_proven,false);
  assert.equal(read([{...first,tot:"27"},other]).completeness.reported_total,27);
  assert.equal(chooseIndependentInnCandidate({row:row(),target,
    region:"Ленинградская область",search:complete}).status,"candidate");
});
test("row sequence parser diagnostic is numeric and never relaxes the official proof",()=>{
  const changed=extractText.replace("   2      ГРН","   3      ГРН");
  const parsed=extractParse(changed);
  assert.equal(parsed.reason,"fns_extract_rows_unproven");
  assert.equal(parsed.diagnostic.row_issue,"nonsequential_rows");
  assert.equal(parsed.diagnostic.expected_row,2);
  assert.equal(parsed.diagnostic.observed_row,3);
  assert.equal(parsed.record,undefined);
});
