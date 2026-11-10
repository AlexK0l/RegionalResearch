import test from "node:test";
import assert from "node:assert/strict";
import {
  sabyPublicCompanyUrl,sabyKppFromCardText,sabyKppFromProfileLinks,
  sabyOfficialNameFromRequisites,verifySabyPublicLegalName
} from "../src/sabyRegisteredIdentity.js";
import {assessSabyCardEvidence} from "../src/sabyCard.js";
import {sabyNameMatches} from "../src/sabyEnrichment.js";

const inn="6700018766",kpp="670001001";
const full="АО «Смоленская агропромышленная компания»";
const legal='АКЦИОНЕРНОЕ ОБЩЕСТВО "СМОЛЕНСКАЯ АГРОПРОМЫШЛЕННАЯ КОМПАНИЯ"';
const publicText=[
  "Сапк, АО","Реквизиты","Название",legal,
  "ИНН",inn,"КПП",kpp,"ОГРН","1246700008136",
  "ОКПО","49663433","Дополнительные сведения"
].join("\n");

test("public Saby registered name validates short vs full only by structured exact INN and KPP",()=>{
  assert.equal(sabyOfficialNameFromRequisites(publicText,inn,kpp,full),legal);
  assert.equal(sabyNameMatches(full,legal),true);
  assert.equal(sabyOfficialNameFromRequisites(publicText,inn,"670001002",full),"");
  assert.equal(sabyOfficialNameFromRequisites(publicText,"6700018767",kpp,full),"");
  assert.equal(sabyOfficialNameFromRequisites(publicText,inn,kpp,"АО Чужая компания"),"");
  assert.equal(sabyOfficialNameFromRequisites(publicText.replace("Реквизиты","Контакты"),
    inn,kpp,full),"");
});

test("a stray legal name outside of registered requisites is NOT identity proof",()=>{
  const source=[
    "Группа компаний",legal,"Связанные лица",inn,"КПП",kpp,
    "Реквизиты","Название","Чужая компания, АО",
    "ИНН",inn,"КПП",kpp
  ].join("\n");
  assert.equal(sabyOfficialNameFromRequisites(source,inn,kpp,full),"");
});

test("KPP extraction requires exact labelled INN and refuses ambiguous KPP",()=>{
  for(const source of [
    ["ИНН",inn,"КПП",kpp].join("\n"),
    "ИНН: "+inn+"\nКПП: "+kpp,
    "ИНН/КПП "+inn+"/"+kpp,
    "ИНН / КПП\n"+inn+" / "+kpp
  ]) assert.equal(sabyKppFromCardText(source,inn),kpp,source);
  assert.equal(sabyKppFromCardText("ИНН: 6700018767\nКПП: "+kpp,inn),"");
  assert.equal(sabyKppFromCardText("КПП: "+kpp,inn),"");
  assert.equal(sabyKppFromCardText(
    "ИНН "+inn+"\nКПП "+kpp+"\nИНН "+inn+"\nКПП 670001002",inn),"");
});

test("public link resolver accepts only exact first-party INN/KPP routes",()=>{
  const url=sabyPublicCompanyUrl(inn,kpp);
  assert.equal(url,"https://saby.ru/profile/"+inn+"-"+kpp);
  assert.equal(sabyPublicCompanyUrl(inn,"67000100"),"");
  assert.equal(sabyKppFromProfileLinks([
    "https://attacker.test/profile/"+inn+"-"+kpp,
    "https://saby.ru.evil.test/profile/"+inn+"-"+kpp,
    url
  ],inn),kpp);
  assert.equal(sabyKppFromProfileLinks([
    url,"https://saby.ru/profile/"+inn+"-670001002"
  ],inn),"");
  assert.equal(sabyKppFromProfileLinks([url],"6700018767"),"");
});

test("card evidence accepts independently verified full name from requisites",()=>{
  const assessment=assessSabyCardEvidence(
    "https://profile.saby.ru/page/contractor-info",
    inn,full,{
      headings:["Сапк, АО"],introLines:["Сапк, АО","ИНН "+inn],
      requisiteNames:[legal],scopedExactInn:true,scopedLabeledInn:true,
      bodyLabeledInn:true,detailContentPresent:true
    });
  assert.equal(assessment.ok,true);
  assert.equal(assessment.verifiedName,legal);
  const missing=assessSabyCardEvidence(
    "https://profile.saby.ru/page/contractor-info",
    inn,full,{
      headings:["Сапк, АО"],introLines:["Сапк, АО","ИНН "+inn],
      requisiteNames:["Чужая компания, АО"],scopedExactInn:true,
      bodyLabeledInn:true,detailContentPresent:true
    });
  assert.equal(missing.reason,"legal_name_not_verified");
});

function fakeCard({raw="ИНН\n"+inn+"\nКПП\n"+kpp,links=[],
  publicUrl="https://saby.ru/profile/"+inn+"-"+kpp,
  text=publicText}={}) {
  let opened=0,closed=0;
  const page={
    async evaluate(){return {body:raw,links};},
    context(){return {
      async newPage(){
        opened++;
        return {
          async goto(){},
          url:()=>publicUrl,
          async evaluate(){return text;},
          async waitForTimeout(){},
          async close(){closed++;}
        };
      }
    };}
  };
  return {page,stats:()=>({opened,closed})};
}

test("verified Saby public requisites returns actual full legal name, closes child tab",async()=>{
  const {page,stats}=fakeCard();
  const result=await verifySabyPublicLegalName(page,inn,full);
  assert.deepEqual(result,{ok:true,reason:"verified",verifiedName:legal,
    proof:"saby_public_requisites"});
  assert.deepEqual(stats(),{opened:1,closed:1});
});

test("untrusted redirected page never upgrades identity",async()=>{
  const {page,stats}=fakeCard({
    publicUrl:"https://evil.example/profile/"+inn+"-"+kpp
  });
  const result=await verifySabyPublicLegalName(page,inn,full);
  assert.equal(result.ok,false);
  assert.equal(result.reason,"untrusted_public_route");
  assert.deepEqual(stats(),{opened:1,closed:1});
});

test("missing KPP never opens a public browser tab",async()=>{
  const {page,stats}=fakeCard({raw:"ИНН "+inn});
  const result=await verifySabyPublicLegalName(page,inn,full);
  assert.equal(result.ok,false);
  assert.equal(result.reason,"kpp_unavailable");
  assert.deepEqual(stats(),{opened:0,closed:0});
});

test("public Saby card with unrelated registered legal name stays review",async()=>{
  const {page,stats}=fakeCard({text:publicText.replace(legal,"Чужая компания, АО")});
  const result=await verifySabyPublicLegalName(page,inn,full);
  assert.equal(result.ok,false);
  assert.equal(result.reason,"official_name_not_confirmed");
  assert.deepEqual(stats(),{opened:1,closed:1});
});

test("when account card lacks KPP, first-party observed INN/KPP may locate official Saby requisites",async()=>{
  const {page,stats}=fakeCard({raw:"ИНН "+inn});
  const result=await verifySabyPublicLegalName(page,inn,full,{kppHints:[kpp]});
  assert.equal(result.ok,true);
  assert.equal(result.verifiedName,legal);
  assert.deepEqual(stats(),{opened:1,closed:1});
});

test("conflicting candidate KPPs cannot verify legal identity",async()=>{
  const {page,stats}=fakeCard({raw:"ИНН "+inn});
  const result=await verifySabyPublicLegalName(page,inn,full,{
    kppHints:[kpp,"670001002"]
  });
  assert.equal(result.ok,false);
  assert.equal(result.reason,"ambiguous_kpp");
  assert.deepEqual(stats(),{opened:0,closed:0});
});

test("observed network KPP conflicting with card KPP fails closed",async()=>{
  const {page,stats}=fakeCard();
  const result=await verifySabyPublicLegalName(page,inn,full,{
    kppHints:["670001002"]
  });
  assert.equal(result.ok,false);
  assert.equal(result.reason,"ambiguous_kpp");
  assert.deepEqual(stats(),{opened:0,closed:0});
});
