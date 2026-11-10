import test from "node:test";
import assert from "node:assert/strict";
import {
  sabyPublicProfileRoute,canonicalSabyPublicRoute,
  extractSabyPublicRequisites,compareSabyPublicRequisites,
  verifyPublicSabyIdentity
} from "../src/sabyPublicRegisteredIdentity.js";

const inn="7725104641",kpp="504301001",ogrn="1027739058258";
const source="АО «ДСК «Автобан»";
const short='ДСК "Автобан", АО';
const full='АКЦИОНЕРНОЕ ОБЩЕСТВО "ДОРОЖНО-СТРОИТЕЛЬНАЯ КОМПАНИЯ "АВТОБАН"';
const route="https://saby.ru/profile/"+inn+"-"+kpp;
const text=[
  "Компания, ИНН или руководитель","Реквизиты:",
  "О компании","Название: "+short,
  "ИНН: "+inn,"КПП: "+kpp,
  "Контакты","Телефоны","Связанные компании",
  "Реквизиты","Название",full,
  "ИНН",inn,"КПП",kpp,"ОГРН",ogrn,
  "ОКПО","51115503","Регистрация компании"
].join("\n");

test("Saby public profile address uses only observed exact INN and KPP",()=>{
  assert.equal(sabyPublicProfileRoute(inn,kpp),route);
  assert.equal(sabyPublicProfileRoute(inn,"50430100"),"");
  assert.equal(canonicalSabyPublicRoute(route,inn,kpp),true);
  for(const url of [
    "http://saby.ru/profile/"+inn+"-"+kpp,
    "https://saby.ru.evil.test/profile/"+inn+"-"+kpp,
    "https://evil.test/profile/"+inn+"-"+kpp,
    "https://user:pw@saby.ru/profile/"+inn+"-"+kpp,
    "https://saby.ru/profile/"+inn+"-504301002",
    "https://saby.ru/profile/"+inn+"-"+kpp+"/related"
  ])assert.equal(canonicalSabyPublicRoute(url,inn,kpp),false,url);
});

test("public requisites extract full official name from labelled registered block",()=>{
  assert.deepEqual(extractSabyPublicRequisites(text),[
    {name:full,inn,kpp,ogrn}
  ]);
  assert.deepEqual(extractSabyPublicRequisites(
    "О компании\nНазвание: "+short+"\nРеквизиты:\n- ИНН: "+inn+
    "\n- КПП: "+kpp),[]);
  assert.deepEqual(extractSabyPublicRequisites(
    "Связанные компании\nНазвание\n"+full+"\nИНН\n"+inn+"\nКПП\n"+kpp),[]);
  assert.deepEqual(extractSabyPublicRequisites(
    "Реквизиты\nО компании\nНазвание\n"+short+
    "\nИНН\n"+inn+"\nКПП\n"+kpp),[]);
  assert.deepEqual(extractSabyPublicRequisites(
    "Реквизиты\nНазвание\n"+full+"\nИНН\n7700000000\nКПП\n"+kpp),
    [{name:full,inn:"7700000000",kpp,ogrn:""}]);
});

test("source shortened title can be verified only via same public registered record",()=>{
  const observed={
    expectedInn:inn,expectedKpp:kpp,expectedName:source,
    publicTitle:short,records:extractSabyPublicRequisites(text),url:route
  };
  const verified=compareSabyPublicRequisites(observed);
  assert.equal(verified.status,"verified");
  assert.equal(verified.match_type,"short_title_registered_alias");
  assert.equal(verified.official_name,full);
  assert.equal(verified.official_inn,inn);
  assert.equal(verified.official_kpp,kpp);
  assert.equal(compareSabyPublicRequisites({
    ...observed,expectedName:full,publicTitle:"не важно"
  }).match_type,"registered_full_name");
});

test("source display mismatch and legal-form conflict remain review",()=>{
  const basics={
    expectedInn:inn,expectedKpp:kpp,publicTitle:short,
    records:extractSabyPublicRequisites(text),url:route
  };
  assert.equal(compareSabyPublicRequisites({
    ...basics,expectedName:"ООО «НЕО ТРАНС»"
  }).reason,"legal_form_conflict");
  assert.equal(compareSabyPublicRequisites({
    ...basics,expectedName:"АО «Другая компания»"
  }).reason,"name_not_matched_to_registered_entity");
  assert.equal(compareSabyPublicRequisites({
    ...basics,expectedName:source,publicTitle:""
  }).status,"review");
  assert.equal(compareSabyPublicRequisites({
    ...basics,expectedName:source,
    records:[{...basics.records[0],kpp:"504301002"}]
  }).reason,"inn_kpp_conflict");
  assert.equal(compareSabyPublicRequisites({
    ...basics,expectedName:source,url:"https://evil.example"
  }).reason,"public_route_untrusted");
});

function fakeBrowser({
  body=text,title=short,
  landed=route
}={}) {
  let opened=0,closed=0,requested="";
  return {
    page:{
      context:()=>({newPage:async()=>{
        opened++;
        return {
          goto:async url=>{requested=url;},
          url:()=>landed,
          evaluate:async()=>({body,title}),
          waitForTimeout:async()=>{},
          close:async()=>{closed++;}
        };
      }})
    },
    stats:()=>({opened,closed,requested})
  };
}

test("public browser verified request preserves original tab and closes child tab",async()=>{
  const {page,stats}=fakeBrowser();
  const result=await verifyPublicSabyIdentity(page,inn,kpp,source);
  assert.equal(result.status,"verified");
  assert.deepEqual(stats(),{opened:1,closed:1,requested:route});
});

test("public browser redirects and missing registered records never verify",async()=>{
  for(const obj of [
    {landed:"https://attacker.test/profile/"+inn+"-"+kpp},
    {body:"О компании\nНазвание: "+short+"\nИНН: "+inn,
      title:short}
  ]) {
    const {page,stats}=fakeBrowser(obj);
    const result=await verifyPublicSabyIdentity(page,inn,kpp,source);
    assert.equal(result.status,"review");
    assert.equal(stats().closed,1);
  }
});
