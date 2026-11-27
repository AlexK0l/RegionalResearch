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

test("Saby requisites may show FULL registered name while H1 shows SHORT",()=>{
  const record=extractIndependentRegistryIdentity(pageText);
  const out=compareIndependentRegistryAlias({
    ...expected,
    sabyShortName:full,
    sabyPublicTitle:sabyShort,
    record
  });
  assert.equal(out.status,"verified");
  assert.equal(out.requisites_role,"full");
  assert.equal(out.title_role,"short");
  assert.equal(out.official_full_name,full);
  // The word "ГУП" abbreviates the legal form of the full name, not
  // arbitrary similar substrings in a related company name.
  const another=compareIndependentRegistryAlias({
    ...expected,
    sabyShortName:source,
    sabyPublicTitle:sabyShort,
    record
  });
  assert.equal(another.status,"verified");
  assert.equal(another.requisites_role,"full");
  assert.equal(another.title_role,"short");
});

test("source can be exact REGISTERED short name from same full/short record",()=>{
  const record=extractIndependentRegistryIdentity(pageText);
  const cases=[
    [short,full,sabyShort,"short","full","short"],
    [sabyShort,short,full,"short","short","full"],
    [full,short,sabyShort,"full","short","short"]
  ];
  for(const [sourceName,requisites,title,sourceRole,reqRole,titleRole] of cases){
    const actual=compareIndependentRegistryAlias({
      ...expected,sourceName,sabyShortName:requisites,
      sabyPublicTitle:title,record
    });
    assert.equal(actual.status,"verified");
    assert.equal(actual.source_role,sourceRole);
    assert.equal(actual.requisites_role,reqRole);
    assert.equal(actual.title_role,titleRole);
    assert.equal(actual.official_full_name,full);
    assert.equal(actual.inn,inn);
    assert.equal(actual.kpp,kpp);
    assert.equal(actual.ogrn,ogrn);
  }
});

test("registered-short source still rejects wrong legal form, prefix and all wrong identifiers",()=>{
  const record=extractIndependentRegistryIdentity(pageText);
  for(const sourceName of [
    "МУП «Леноблводоканал»",
    "ФГУП «Леноблводоканал»",
    'ГУП «Леноблводоканал Север»',
    'ГУП «Леноблводоканал-Сервис»',
    'ГУП «Леноблводоканал филиал»',
    'ГУП «Водоканал»',
    "Совсем другая компания"
  ]){
    const actual=compareIndependentRegistryAlias({
      ...expected,sourceName,
      sabyShortName:short,sabyPublicTitle:short,record
    });
    assert.equal(actual.status,"review");
    assert.equal(actual.reason,"independent_registered_name_mismatch");
    assert.equal(actual.source_role,"none");
    assert.equal(Object.hasOwn(actual,"official_full_name"),false);
  }
  for(const [field,bad] of [
    ["inn","7707083893"],["kpp","470401002"],
    ["ogrn","1167847156301"]
  ]){
    const actual=compareIndependentRegistryAlias({
      ...expected,sourceName:short,
      sabyShortName:short,sabyPublicTitle:short,
      record:{...record,[field]:bad}
    });
    assert.equal(actual.status,"review");
    assert.equal(actual.reason,"independent_registry_identifier_mismatch");
  }
});

test("third-party full/short legal-form conflict fails before any name alias",()=>{
  const record=extractIndependentRegistryIdentity(pageText);
  for(const badShort of [
    'МУП "ЛЕНОБЛВОДОКАНАЛ"',
    'ФГУП "ЛЕНОБЛВОДОКАНАЛ"',
    'ООО "ЛЕНОБЛВОДОКАНАЛ"'
  ]){
    const out=compareIndependentRegistryAlias({
      ...expected,record:{...record,short_name:badShort}
    });
    assert.equal(out.status,"review");
    assert.equal(out.reason,"independent_registry_legal_form_conflict");
    assert.equal(Object.hasOwn(out,"official_full_name"),false);
  }
});

test("Saby registered requisites and H1 are each checked independently",()=>{
  const record=extractIndependentRegistryIdentity(pageText);
  for(const [requisites,title,wantedReq,wantedTitle] of [
    [full,full,"full","full"],
    [short,short,"short","short"],
    [short,full,"short","full"],
    [full,sabyShort,"full","short"]
  ]){
    const out=compareIndependentRegistryAlias({
      ...expected,sabyShortName:requisites,sabyPublicTitle:title,record
    });
    assert.equal(out.status,"verified");
    assert.equal(out.requisites_role,wantedReq);
    assert.equal(out.title_role,wantedTitle);
  }
});

test("registered roles reject unrelated, prefix-only or wrong-form names",()=>{
  const record=extractIndependentRegistryIdentity(pageText);
  for(const [requisites,title,wantedReq,wantedTitle] of [
    ['ГУП "ВОДОКАНАЛ ЛЕНИНГРАДСКОЙ ОБЛАСТИ И САНКТ-ПЕТЕРБУРГА"',
      sabyShort,"none","short"],
    ['МУП "ВОДОКАНАЛ ЛЕНИНГРАДСКОЙ ОБЛАСТИ"',
      sabyShort,"none","short"],
    [full,'ЛЕНОБЛВОДОКАНАЛ-СЕРВИС, ГУП',"full","none"],
    [full,'ЛЕНОБЛВОДОКАНАЛ, МУП',"full","none"],
    [full,"ДРУГОЙ ПОСТАВЩИК, ГУП","full","none"],
    [short,"ГУП «Водоканал»","short","none"]
  ]){
    const out=compareIndependentRegistryAlias({
      ...expected,sabyShortName:requisites,sabyPublicTitle:title,record
    });
    assert.equal(out.status,"review");
    assert.equal(out.reason,"independent_short_name_mismatch");
    assert.equal(out.requisites_role,wantedReq);
    assert.equal(out.title_role,wantedTitle);
    assert.equal(Object.hasOwn(out,"official_full_name"),false);
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
  status=200,throwOnGoto=false,throwOnEvaluate=false,
  throwOnNewTab=false}={}){
  let opened=0,closed=0,options=null;
  return {
    page:{context:()=>({newPage:async()=>{
      if(throwOnNewTab)throw Error("secret browser error");
      opened++;
      return {
        goto:async(_url,opts)=>{options=opts;
          if(throwOnGoto)throw Error("secret error");
          return {status:()=>status};},
        url:()=>landed,
        evaluate:async()=>{if(throwOnEvaluate)throw Error("secret DOM");
          return body;},
        waitForTimeout:async()=>{},
        close:async()=>{closed++;}
      };
    }})},
    count:()=>({opened,closed}),
    navigation:()=>options
  };
}

test("independent page closes and verifies without changing the Saby page",async()=>{
  const {page,count,navigation}=mockBrowser();
  const result=await verifyIndependentRegistryAlias(page,expected);
  assert.equal(result.status,"verified");
  assert.equal(navigation().waitUntil,"commit");
  assert.equal(navigation().timeout,12000);
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

test("public registry failures have safe, stage-specific reason codes",async()=>{
  for(const [failure,expectedReason] of [
    [{throwOnNewTab:true},"independent_registry_browser_unavailable"],
    [{throwOnGoto:true},"independent_registry_navigation_failed"],
    [{throwOnEvaluate:true},"independent_registry_snapshot_unavailable"]
  ]){
    const {page,count}=mockBrowser(failure);
    const result=await verifyIndependentRegistryAlias(page,expected);
    assert.equal(result.status,"review");
    assert.equal(result.reason,expectedReason);
    assert.equal(count().closed,failure.throwOnNewTab?0:1);
    assert.doesNotMatch(JSON.stringify(result),/secret|4703144282|1167847156300/);
  }
});

test("observed ZAOR display decoration can bridge exact official full and short names only after all three IDs agree",async()=>{
  const {sameRegisteredSabyDisplayName}=await import("../src/sabyIndependentNameBridge.js");
  const {auditLegalForm}=await import("../src/sabyIdentityAudit.js");
  const officialFull='ЗАКРЫТОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО РАБОТНИКОВ "НАРОДНОЕ ПРЕДПРИЯТИЕ НАБЕРЕЖНОЧЕЛНИНСКИЙ КАРТОННО-БУМАЖНЫЙ КОМБИНАТ ИМ.С.П.ТИТОВА"';
  const officialShort='ЗАОР "НП НЧ КБК ИМ.С.П.ТИТОВА"';
  const decorated='НП НЧ КБК им.С.П.Титова, ЗАОР (Бухгалтерия Управления)';
  const r={inn:"1650017638",kpp:"165001001",ogrn:"1021602014500",
    full_name:officialFull,short_name:officialShort};
  const opt={expectedInn:r.inn,expectedKpp:r.kpp,expectedOgrn:r.ogrn,
    sourceName:officialShort,sabyShortName:officialFull,sabyPublicTitle:decorated,record:r};
  assert.equal(auditLegalForm(officialFull),"ЗАОР");
  assert.equal(auditLegalForm(officialShort),"ЗАОР");
  assert.equal(sameRegisteredName(decorated,officialShort),false);
  assert.equal(sameRegisteredSabyDisplayName(decorated,officialShort),true);
  const out=compareIndependentRegistryAlias(opt);
  assert.equal(out.status,"verified");
  assert.equal(out.official_short_name,officialShort);
  for(const change of [
    {sourceName:decorated},{sabyShortName:decorated},
    {sabyPublicTitle:decorated.replace("ЗАОР","ЗАО")},
    {sabyPublicTitle:decorated.replace("Бухгалтерия Управления","Филиал")},
    {sabyPublicTitle:decorated.replace("Бухгалтерия Управления","Другое название")},
    {sabyPublicTitle:decorated.replace("Титова","Иванова")},
    {expectedInn:"7707083893"},{expectedKpp:"165001002"},{expectedOgrn:"1021602014501"}
  ])assert.notEqual(compareIndependentRegistryAlias({...opt,...change}).status,"verified");
  assert.equal(sameRegisteredName(officialShort,officialShort.replace("ЗАОР","ЗАО")),false);
});
