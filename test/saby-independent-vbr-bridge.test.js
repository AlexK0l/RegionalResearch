import test from "node:test";
import assert from "node:assert/strict";
import {
  vbrSearchUrl,isVbrSearchUrl,isVbrCompanyUrl,
  chooseVbrCompanyUrl,extractVbrGeneralIdentity,
  verifyVbrIndependentRegistryAlias
} from "../src/sabyIndependentVbrBridge.js";

const inn="4703144282",kpp="470401001",ogrn="1167847156300";
const full='ГОСУДАРСТВЕННОЕ УНИТАРНОЕ ПРЕДПРИЯТИЕ "ВОДОКАНАЛ ЛЕНИНГРАДСКОЙ ОБЛАСТИ"';
const short='ГУП "ЛЕНОБЛВОДОКАНАЛ"';
const source='ГУП «Водоканал Ленинградской области»';
const sabyShort="Леноблводоканал, ГУП";
const search=vbrSearchUrl(ogrn);
const company="https://kontragent.vbr.ru/company/gyp-lenoblvodokanal-"+ogrn+"/";
const opts={
  expectedInn:inn,expectedKpp:kpp,expectedOgrn:ogrn,
  sourceName:source,sabyShortName:sabyShort,sabyPublicTitle:sabyShort
};
const pageText=[
  'ГУП "ЛЕНОБЛВОДОКАНАЛ"',"Общая информация",
  "Полное наименование",full+full,
  "Краткое наименование",short+short,
  "ОГРН",ogrn+ogrn,"ИНН",inn+inn,"КПП",kpp+kpp,
  "Дата регистрации","29.03.2016",
  "Сведения об организации",
  "ИНН","7707083893"
].join("\n");

test("VBR search and company routes must remain on trusted origin and exact OGRN",()=>{
  assert.equal(search,"https://kontragent.vbr.ru/search/?s="+ogrn);
  assert.equal(isVbrSearchUrl(search,ogrn),true);
  assert.equal(isVbrCompanyUrl(company,ogrn),true);
  assert.equal(chooseVbrCompanyUrl([company,company],ogrn),company);
  for(const bad of [
    "https://evil.test/company/gyp-lenoblvodokanal-"+ogrn+"/",
    "https://kontragent.vbr.ru.evil.test/company/a-"+ogrn+"/",
    "http://kontragent.vbr.ru/company/a-"+ogrn+"/",
    "https://kontragent.vbr.ru/company/a-1167847156301/",
    company+"?redirect=1",
    "https://user:pass@kontragent.vbr.ru/company/a-"+ogrn+"/"
  ])assert.equal(isVbrCompanyUrl(bad,ogrn),false,bad);
  assert.equal(isVbrSearchUrl(search+"&other=1",ogrn),false);
  assert.equal(isVbrSearchUrl(search.replace(ogrn,"1167847156301"),ogrn),false);
  assert.equal(chooseVbrCompanyUrl([
    company,"https://kontragent.vbr.ru/company/another-"+ogrn+"/"
  ],ogrn),"","two different candidate paths stay ambiguous");
});

test("VBR visible general-information panel can repeat identical DOM values",()=>{
  assert.deepEqual(extractVbrGeneralIdentity(pageText),{
    full_name:full,short_name:short,ogrn,inn,kpp
  });
  const single=pageText.replaceAll(full+full,full)
    .replaceAll(short+short,short).replaceAll(ogrn+ogrn,ogrn)
    .replaceAll(inn+inn,inn).replaceAll(kpp+kpp,kpp);
  assert.deepEqual(extractVbrGeneralIdentity(single),{
    full_name:full,short_name:short,ogrn,inn,kpp
  });
  const wrong=pageText.replace(kpp+kpp,"470401001470401002");
  assert.equal(extractVbrGeneralIdentity(wrong),null);
  const split=pageText.replace("\nИНН\n"+inn+inn,
    "\nСведения об организации\nИНН\n"+inn+inn);
  assert.equal(extractVbrGeneralIdentity(split),null);
  assert.equal(extractVbrGeneralIdentity(pageText+"\nОбщая информация\n"+
    "Полное наименование\n"+full+"\nКраткое наименование\n"+short+
    "\nИНН\n"+inn+"\nКПП\n"+kpp+"\nОГРН\n"+ogrn),null);
});

function browser({
  links=[company],text=pageText,
  searchStatus=200,companyStatus=200,
  searchUrl=search,companyUrl=company,
  errorAt=""
}={}){
  let url="",opened=0,closed=0,visits=[],reads=0;
  const tab={
    goto:async(next,config)=>{
      visits.push({url:next,waitUntil:config.waitUntil});
      if(errorAt===(visits.length===1?"search":"company"))
        throw Error("secret credential in exception");
      url=visits.length===1?searchUrl:companyUrl;
      return {status:()=>visits.length===1?searchStatus:companyStatus};
    },
    url:()=>url,
    evaluate:async()=>{
      reads++;
      if(errorAt==="snapshot")throw Error("private DOM");
      return visits.length===1?links:text;
    },
    waitForTimeout:async()=>{},
    close:async()=>{closed++;}
  };
  return {
    page:{context:()=>({newPage:async()=>{
      if(errorAt==="browser")throw Error("secret browser");
      opened++;return tab;
    }})},
    stats:()=>({opened,closed,visits,reads})
  };
}
test("real VBR search dynamically resolves company and strictly verifies full/short names",async()=>{
  const {page,stats}=browser();
  const r=await verifyVbrIndependentRegistryAlias(page,opts);
  assert.equal(r.status,"verified");
  assert.equal(r.reason,"independent_registry_alias_verified");
  assert.equal(r.provider,"vbr");
  assert.equal(r.official_full_name,full);
  assert.equal(r.inn,inn);
  assert.equal(r.kpp,kpp);
  assert.equal(r.ogrn,ogrn);
  assert.deepEqual(stats().visits.map(x=>x.waitUntil),["commit","commit"]);
  assert.deepEqual(stats().visits.map(x=>x.url),[search,company]);
  assert.equal(stats().closed,1);
});

test("VBR browser verifies full Saby requisites name against the registry full field",async()=>{
  const {page,stats}=browser();
  const result=await verifyVbrIndependentRegistryAlias(page,{
    ...opts,sabyShortName:full,
    sabyPublicTitle:sabyShort
  });
  assert.equal(result.status,"verified");
  assert.equal(result.requisites_role,"full");
  assert.equal(result.title_role,"short");
  assert.equal(result.official_full_name,full);
  assert.equal(stats().closed,1);
});

test("VBR grants source-short alias only with matching full/short record and all IDs",async()=>{
  const {page,stats}=browser();
  const verified=await verifyVbrIndependentRegistryAlias(page,{
    ...opts,sourceName:short,sabyShortName:full,
    sabyPublicTitle:sabyShort
  });
  assert.equal(verified.status,"verified");
  assert.equal(verified.provider,"vbr");
  assert.equal(verified.source_role,"short");
  assert.equal(verified.requisites_role,"full");
  assert.equal(verified.title_role,"short");
  assert.equal(verified.official_full_name,full);
  assert.equal(stats().closed,1);
  for(const sourceName of ["МУП «Леноблводоканал»",
    "ГУП «Леноблводоканал Филиал»"]){
    const sample=browser();
    const out=await verifyVbrIndependentRegistryAlias(sample.page,{
      ...opts,sourceName,sabyShortName:full,sabyPublicTitle:sabyShort
    });
    assert.equal(out.status,"review");
    assert.equal(out.reason,"independent_registered_name_mismatch");
  }
});

test("VBR identity conflicts never authorize an alias, even with the same search OGRN",async()=>{
  for(const change of [
    {text:pageText.replace(short+short,"ГУП ДРУГАЯ ОРГАНИЗАЦИЯ")},
    {text:pageText.replace(full+full,"ДРУГОЕ ПОЛНОЕ ИМЯ")},
    {text:pageText.replace(inn+inn,"77070838937707083893")},
    {text:pageText.replace(kpp+kpp,"470401002470401002")},
    {text:pageText.replace(ogrn+ogrn,"11678471563011167847156301")}
  ]){
    const {page,stats}=browser(change);
    const r=await verifyVbrIndependentRegistryAlias(page,opts);
    assert.equal(r.status,"review");
    assert.equal(stats().closed,1);
  }
});

test("VBR redirects, wrong HTTP and ambiguous search results fail closed",async()=>{
  const failures=[
    [{searchStatus:503},"vbr_search_http_error"],
    [{searchUrl:"https://evil.test/"},"vbr_search_route_untrusted"],
    [{links:[company,"https://kontragent.vbr.ru/company/another-"+ogrn+"/"]},
      "vbr_search_result_ambiguous"],
    [{links:[]},"vbr_search_result_unavailable"],
    [{companyStatus:403},"vbr_company_http_error"],
    [{companyUrl:"https://evil.test/company/a-"+ogrn+"/"},
      "vbr_company_route_untrusted"],
    [{text:"Общая информация\nИНН\n"+inn},
      "vbr_registry_record_unavailable"],
    [{errorAt:"search"},"vbr_search_navigation_failed"],
    [{errorAt:"company"},"vbr_company_navigation_failed"],
    [{errorAt:"snapshot"},"vbr_search_snapshot_unavailable"],
    [{errorAt:"browser"},"vbr_browser_unavailable"]
  ];
  for(const [options,reason] of failures){
    const {page,stats}=browser(options);
    const r=await verifyVbrIndependentRegistryAlias(page,opts);
    assert.equal(r.status,"review",reason);
    assert.equal(r.reason,reason);
    assert.equal(stats().closed,options.errorAt==="browser"?0:1);
    assert.doesNotMatch(JSON.stringify(r),/secret|4703144282|1167847156300/);
  }
});
