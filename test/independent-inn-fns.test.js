import test from "node:test";
import assert from "node:assert/strict";
import {parseFnsSearchResult,fnsSourceUrl,isFnsFormRoute,lookupFnsViaBrowser}
  from "../src/independentInnFns.js";
import {chooseIndependentInnCandidate,verifyIndependentInnCandidate,
  planIndependentInnBackfill,runIndependentInnBackfill,checkFnsRegistryCanary,
  preciseLocalityMatch} from "../src/independentInnBackfill.js";
import {extractVbrGeneralIdentity} from "../src/sabyIndependentVbrBridge.js";
import {extractRegistryVbrRecord} from "../src/independentInnRegistryBrowser.js";

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
function browser({challenge=false,wrongQuery=false,staleOnly=false}={}){
  const token="0123456789ABCDEF",old="0000000000000000";
  const listeners=new Set(),visits=[];
  let value="",checked=false;
  const input={count:async()=>1,waitFor:async()=>{},fill:async v=>{value=v;},inputValue:async()=>value};
  const checkbox={count:async()=>1,check:async()=>{checked=true;},isChecked:async()=>checked};
  const response=(url,method,payload,post="")=>({
    url:()=>url,status:()=>200,json:async()=>payload,
    request:()=>({method:()=>method,postData:()=>post})
  });
  const emit=async response=>{for(const fn of [...listeners])await fn(response);};
  const host="https://egrul.nalog.ru";
  const submit={count:async()=>1,click:async()=>{
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
    url:()=>host+"/index.html",getByPlaceholder:()=>input,
    getByRole:role=>role==="checkbox"?checkbox:submit,
    locator:()=>checkbox,on:(_event,fn)=>listeners.add(fn),
    off:(_event,fn)=>listeners.delete(fn),waitForTimeout:async()=>{}
  };
  return {page,visits,listeners,navigate:async(u,check)=>{
    visits.push(u);assert.equal(check(page.url()),true);return true;
  },readBody:async()=>"Результаты поиска"};
}
test("official form observer accepts only matching submitted query and correlated response; no direct endpoint requests",async()=>{
  const b=browser();
  const found=await lookupFnsViaBrowser(b.page,{query:short,navigate:b.navigate,readBody:b.readBody});
  assert.equal(found.records[0].record.address,address);
  assert.equal(found.complete,true);
  assert.deepEqual(b.visits,["https://egrul.nalog.ru/"]);
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
  assert.equal(isFnsFormRoute("https://egrul.nalog.ru.evil.test/index.html"),false);
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
