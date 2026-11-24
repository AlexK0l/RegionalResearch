import test from "node:test";
import assert from "node:assert/strict";
import {parseFnsSearchResult,fnsSourceUrl,isFnsFormRoute,lookupFnsViaBrowser}
  from "../src/independentInnFns.js";
import {chooseIndependentInnCandidate,verifyIndependentInnCandidate,
  planIndependentInnBackfill,runIndependentInnBackfill,checkFnsRegistryCanary,
  preciseLocalityMatch,hydrateFnsSearchAddresses} from "../src/independentInnBackfill.js";
import {extractVbrGeneralIdentity} from "../src/sabyIndependentVbrBridge.js";
import {extractRegistryVbrRecord,extractRegistryTbankRecord} from "../src/independentInnRegistryBrowser.js";
import {extractIndependentRegistryIdentity} from "../src/sabyIndependentNameBridge.js";

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
  ineffectiveLabel=false,missingAssociatedLabel=false}={}){
  const token="0123456789ABCDEF",old="0000000000000000";
  const listeners=new Set(),visits=[],actions=[];
  let value="",checked=false;
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
    const post=new URLSearchParams({query:wrongQuery?"ДРУГОЙ":value,nameEq:checked?"on":""}).toString();
    if(challenge){
      await emit(response(host+"/","POST",{captchaRequired:true},post));return;
    }
    // Responses may finish out of order. The old token is never accepted.
    await emit(response(host+"/search-result/"+old,"GET",{rows:[{...raw,a:"STALE"}]}));
    if(!staleOnly)await emit(response(host+"/search-result/"+token+"?r=1","GET",{rows:[raw]}));
    await emit(response(host+"/","POST",{t:token},post));
  }};
  const page={
    url:()=>host+"/index.html",
    locator:selector=>{
      if(selector==='input#query[name="query"][type="text"]')return input;
      if(selector==='button#btnSearch[type="submit"]')return submit;
      if(selector==='input#nameEq[name="nameEq"][type="checkbox"]')return checkbox;
      if(selector==='label[for="nameEq"], label:has(input#nameEq)')return label;
      throw Error("unexpected selector: "+selector);
    },
    getByText:(text,opts)=>{
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
