import test from "node:test";
import assert from "node:assert/strict";
import {
  sameRegisteredName,independentRegistryRoute,
  canonicalIndependentRegistryRoute,
  extractIndependentRegistryIdentity,compareIndependentRegistryAlias,
  verifyIndependentRegistryAlias
} from "../src/sabyIndependentNameBridge.js";

const inn="4703144282",kpp="470401001",ogrn="1167847156300";
const source="ГУП «Водоканал Ленинградской области»";
const full='ГОСУДАРСТВЕННОЕ УНИТАРНОЕ ПРЕДПРИЯТИЕ "ВОДОКАНАЛ ЛЕНИНГРАДСКОЙ ОБЛАСТИ"';
const short='ГУП "ЛЕНОБЛВОДОКАНАЛ"';
const sabyShort="Леноблводоканал, ГУП";
const pageText=[
  "Проверка контрагента",short,"Действующая организация",
  "ОГРН",ogrn,"ИНН",inn,"КПП",kpp,
  "Реквизиты","Полное название",full,
  "Уставный капитал","650 млн","Краткое название",short,
  "Юридический адрес","Выборг", "ИНН",inn,
  "ОГРН",ogrn,"КПП",kpp,
  "Регистрация ФНС","ИНН","7707083893"
].join("\n");
const expected={
  expectedInn:inn,expectedKpp:kpp,expectedOgrn:ogrn,
  sourceName:source,sabyShortName:sabyShort,sabyPublicTitle:sabyShort
};

test("unitary full and short names are strict form-aware aliases, not a prefix guess",()=>{
  assert.equal(sameRegisteredName(source,full),true);
  assert.equal(sameRegisteredName(sabyShort,short),true);
  assert.equal(sameRegisteredName(source,
    'МУНИЦИПАЛЬНОЕ УНИТАРНОЕ ПРЕДПРИЯТИЕ "ВОДОКАНАЛ ЛЕНИНГРАДСКОЙ ОБЛАСТИ"'
  ),false);
  assert.equal(sameRegisteredName("ГУП «Водоканал»",
    'ГУП «Водоканал Ленинградской области»'),false);
  assert.equal(sameRegisteredName("ГУП «Водоканал»",
    "Водоканал"),false);
  assert.equal(sameRegisteredName("АО «Водоканал»",
    "ООО «Водоканал»"),false);
  assert.equal(sameRegisteredName(short,sabyShort),true);
});

test("independent source route accepts only expected public company record URL",()=>{
  const route=independentRegistryRoute(ogrn);
  assert.equal(route,
    "https://www.tbank.ru/business/contractor/legal/"+ogrn+"/");
  assert.equal(canonicalIndependentRegistryRoute(route,ogrn),true);
  for(const bad of [
    "https://www.tbank.ru.evil.test/business/contractor/legal/"+ogrn+"/",
    "https://evil.test/business/contractor/legal/"+ogrn+"/",
    "http://www.tbank.ru/business/contractor/legal/"+ogrn+"/",
    "https://www.tbank.ru/business/contractor/legal/1167847156301/",
    "https://www.tbank.ru/business/contractor/legal/"+ogrn+"/?r=1",
    "https://user:secret@www.tbank.ru/business/contractor/legal/"+ogrn+"/"
  ])assert.equal(canonicalIndependentRegistryRoute(bad,ogrn),false,bad);
  assert.equal(independentRegistryRoute("no-ogrn"),"");
});

test("extract registered full and short names in one requisites block",()=>{
  assert.deepEqual(extractIndependentRegistryIdentity(pageText),{
    full_name:full,short_name:short,inn,kpp,ogrn
  });
  // Never combine a company name with a number in another section.
  const fragmented=["Реквизиты","Полное название",full,
    "Краткое название",short,"Регистрация ФНС",
    "ИНН",inn,"КПП",kpp,"ОГРН",ogrn].join("\n");
  assert.equal(extractIndependentRegistryIdentity(fragmented),null);
  assert.equal(extractIndependentRegistryIdentity(
    pageText+"\nРеквизиты\nПолное название\n"+full+
    "\nКраткое название\n"+short+"\nИНН\n"+inn+
    "\nКПП\n"+kpp+"\nОГРН\n"+ogrn),null);
  const conflicting=pageText.replace(
    "\nОГРН\n"+ogrn+"\nКПП", "\nОГРН\n"+ogrn+
    "\nОГРН\n1167847156301\nКПП");
  assert.equal(extractIndependentRegistryIdentity(conflicting),null);
});

test("independent full/short bridge requires all three exact identifiers",()=>{
  const record=extractIndependentRegistryIdentity(pageText);
  const proof=compareIndependentRegistryAlias({...expected,record});
  assert.equal(proof.status,"verified");
  assert.equal(proof.reason,"independent_registry_alias_verified");
  assert.equal(proof.official_full_name,full);
  for(const [field,value] of [
    ["inn","7707083893"],["kpp","470401002"],
    ["ogrn","1167847156301"]
  ]){
    const rejected=compareIndependentRegistryAlias({
      ...expected,record:{...record,[field]:value}
    });
    assert.equal(rejected.status,"review");
    assert.equal(rejected.reason,"independent_registry_identifier_mismatch");
  }
});

test("a merely overlapping name never bridges source and Saby",()=>{
  const record=extractIndependentRegistryIdentity(pageText);
  for(const change of [
    {sourceName:'ГУП "Водоканал Ленинградской области Север"'},
    {sourceName:'МУП "Водоканал Ленинградской области"'},
    {sabyShortName:"Леноблводоканал-Сервис, ГУП"},
    {sabyPublicTitle:"Леноблводоканал, МУП"},
    {record:{...record,short_name:'ГУП "ДРУГОЙ ВОДОКАНАЛ"'}}
  ]){
    const out=compareIndependentRegistryAlias({...expected,record,...change});
    assert.equal(out.status,"review");
  }
});

function mockBrowser({body=pageText,landed=independentRegistryRoute(ogrn),
  status=200,throwOnGoto=false}={}){
  let opened=0,closed=0;
  return {
    page:{context:()=>({newPage:async()=>{
      opened++;
      return {
        goto:async()=>{if(throwOnGoto)throw Error("secret error");
          return {status:()=>status};},
        url:()=>landed,
        evaluate:async()=>body,
        waitForTimeout:async()=>{},
        close:async()=>{closed++;}
      };
    }})},
    count:()=>({opened,closed})
  };
}

test("independent page closes and verifies without changing the Saby page",async()=>{
  const {page,count}=mockBrowser();
  const result=await verifyIndependentRegistryAlias(page,expected);
  assert.equal(result.status,"verified");
  assert.deepEqual(count(),{opened:1,closed:1});
});

test("redirect, unavailable source and inconsistent registry fail closed",async()=>{
  for(const candidate of [
    {landed:"https://evil.test/"},
    {status:403},
    {body:"access denied"},
    {throwOnGoto:true},
    {body:pageText.replace(full,"ДРУГАЯ ОРГАНИЗАЦИЯ")}
  ]){
    const {page,count}=mockBrowser(candidate);
    const result=await verifyIndependentRegistryAlias(page,expected,
      {timeoutMs:1500});
    assert.equal(result.status,"review");
    assert.equal(count().closed,1);
  }
});
