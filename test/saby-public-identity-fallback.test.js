import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  extractSabyDetailRequisitePair,selectSabyInnCandidate,
  acceptSabyPublicIdentityFallback,verifySabyPublicNameFallback,
  safeSabyAliasDiagnostic
} from "../src/sabyPublicIdentityFallback.js";
import {sabyBrowserSettings} from "../src/sabyBrowser.js";
import {compareSabyPublicRequisites} from "../src/sabyPublicRegisteredIdentity.js";

const inn="6700018766",kpp="670001001";
const name="АО «Смоленская агропромышленная компания»";
const official='АКЦИОНЕРНОЕ ОБЩЕСТВО "СМОЛЕНСКАЯ АГРОПРОМЫШЛЕННАЯ КОМПАНИЯ"';
const title="Сапк, АО";
const privateRoute="https://profile.saby.ru/page/contractor-info?source=internal";
const privateText=[
  "О компании",title,
  "Контакты","Реквизиты",
  "ИНН",inn,"КПП",kpp,"ОГРН","1246700008136",
  "Контакты связанных компаний","Суды"
].join("\n");
const assessment={
  ok:false,reason:"legal_name_not_verified",
  detail:{route:"detail",hasScopedInn:true,hasInn:true,
    detailContentPresent:true}
};
const verifiedPublic=compareSabyPublicRequisites({
  expectedInn:inn,expectedKpp:kpp,expectedName:name,
  publicTitle:title,
  records:[{name:official,inn,kpp,ogrn:"1246700008136"}],
  url:"https://saby.ru/profile/"+inn+"-"+kpp
});

test("experimental fallback disabled by default in production config and smoke",()=>{
  assert.equal(sabyBrowserSettings({}).publicIdentityFallback,false);
  assert.equal(sabyBrowserSettings({
    SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED:"true"
  }).publicIdentityFallback,true);
  assert.equal(sabyBrowserSettings({
    SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED:"false"
  }).publicIdentityFallback,false);
  const smoke=fs.readFileSync(new URL("../scripts/saby-smoke.js",
    import.meta.url),"utf8");
  assert.match(smoke,/--public-identity-fallback/);
  const browser=fs.readFileSync(new URL("../src/sabyBrowser.js",
    import.meta.url),"utf8");
  assert.match(browser,/publicFallback=settings\.publicIdentityFallback===true/);
  assert.match(browser,/verifySabyPublicNameFallback\(/);
  assert.match(browser,/registered_alias_verified/);
});

test("name mismatch can select exactly one search row by INN but remains candidate",()=>{
  const row={text:title+"\n"+inn,rect:{x:0,y:0,w:270,h:80}};
  const selected=selectSabyInnCandidate([row],inn,name);
  assert.equal(selected.row,row);
  assert.equal(selected.reason,"unique_inn");
  assert.equal(selectSabyInnCandidate([
    row,{text:"САПК филиал\n"+inn,rect:{x:320,y:0,w:270,h:80}}
  ],inn,name).row,null);
  assert.equal(selectSabyInnCandidate([
    {text:"Группа компаний 16700018766"}
  ],inn,name).count,0);
});

test("only exact same-section labelled INN and KPP permits profile lookup",()=>{
  assert.deepEqual(extractSabyDetailRequisitePair(privateText,inn),{
    reason:"unique_requisite_pair",kpp
  });
  for(const bad of [
    "О компании\nИНН\n"+inn+"\nКПП\n"+kpp,
    "Реквизиты\nИНН\n"+inn+"\nКонтакты\nКПП\n"+kpp,
    "Реквизиты\nИНН\n"+inn+"\nКПП\n"+kpp+
      "\nКПП\n670001002",
    "Реквизиты\nИНН\n6700018767\nКПП\n"+kpp,
    "Реквизиты\nИНН\n"+inn+"\nКПП\n"+kpp+
      "\nРеквизиты\nИНН\n"+inn+"\nКПП\n670001002",
    "Реквизиты\nИНН\n"+inn+"\nКПП\n670001",
    "Реквизиты\nИНН\n"+inn+"\nСвязанные компании\nКПП\n"+kpp
  ])assert.equal(extractSabyDetailRequisitePair(bad,inn).kpp,"",bad);
  assert.deepEqual(extractSabyDetailRequisitePair(
    "Реквизиты:\nИНН: "+inn+";\nКПП: "+kpp+";",inn),{
    reason:"unique_requisite_pair",kpp
  });
});

test("confirmed registered full title and private short Saby title can accept alias",()=>{
  assert.equal(verifiedPublic.status,"verified");
  const result=acceptSabyPublicIdentityFallback({
    expectedInn:inn,expectedName:name,privateRoute,
    cardAssessment:assessment,privateText,privateHeadings:[title],
    publicResult:verifiedPublic
  });
  assert.equal(result.ok,true);
  assert.equal(result.reason,"registered_alias_verified");
  assert.equal(result.identity.name,name);
  assert.equal(result.identity.registered_name,official);
  assert.equal(result.identity.verified,true);
  assert.equal(result.identity.inn,inn);
  assert.equal(result.identity.kpp,kpp);
  assert.equal(result.identity.verification,"registered_public_requisites");
  const diagnostic=safeSabyAliasDiagnostic(result);
  assert.deepEqual(diagnostic,{accepted:true,reason:"registered_alias_verified"});
  const str=JSON.stringify(diagnostic);
  assert.equal(str.includes(inn),false);
  assert.equal(str.includes(name),false);
});

test("reject mismatched detail, nonverified public profile and unconnected private header",()=>{
  const params={
    expectedInn:inn,expectedName:name,privateRoute,
    cardAssessment:assessment,privateText,
    privateHeadings:[title],publicResult:verifiedPublic
  };
  const checks=[
    [{...params,privateRoute:"https://evil.example"}, "not_detail_page"],
    [{...params,cardAssessment:{...assessment,
      detail:{hasScopedInn:false}}},"private_inn_not_scoped"],
    [{...params,privateText:"Контакты\n"+inn},"no_scoped_inn_kpp"],
    [{...params,privateHeadings:["АО «Другая организация»"]},
      "private_public_name_disconnected"],
    [{...params,publicResult:{...verifiedPublic,
      official_kpp:"670001002"}},"public_identity_unverified"],
    [{...params,publicResult:{...verifiedPublic,
      official_inn:"7707083893"}},"public_identity_unverified"],
    [{...params,publicResult:{...verifiedPublic,
      status:"review"}},"public_identity_unverified"]
  ];
  for(const [input,reason] of checks)
    assert.equal(acceptSabyPublicIdentityFallback(input).reason,reason);
});

test("mismatched source legal name is not accepted even with matching INN KPP",()=>{
  const wrongName="ООО «НЕО ТРАНС»";
  const comparison=compareSabyPublicRequisites({
    expectedInn:inn,expectedKpp:kpp,expectedName:wrongName,
    publicTitle:title,records:[{name:official,inn,kpp}],
    url:"https://saby.ru/profile/"+inn+"-"+kpp
  });
  const result=acceptSabyPublicIdentityFallback({
    expectedInn:inn,expectedName:wrongName,privateRoute,
    cardAssessment:assessment,privateText,
    privateHeadings:[title],publicResult:comparison
  });
  assert.equal(result.ok,false);
  assert.equal(result.reason,"public_identity_unverified");
});

test("page-based fallback calls canonical public verifier only when private KPP proven",async()=>{
  let calls=0;
  const page={
    url:()=>privateRoute,
    evaluate:async()=>({text:privateText,headings:[title]})
  };
  const success=await verifySabyPublicNameFallback(page,inn,name,assessment,{
    verifyPublic:async(_page,gotInn,gotKpp,gotName)=>{
      calls++;
      assert.equal(gotInn,inn);assert.equal(gotKpp,kpp);
      assert.equal(gotName,name);return verifiedPublic;
    }
  });
  assert.equal(success.ok,true);
  assert.equal(calls,1);
  const broken={
    url:()=>privateRoute,
    evaluate:async()=>({text:"Реквизиты\nИНН\n"+inn,headings:[title]})
  };
  const failure=await verifySabyPublicNameFallback(broken,inn,name,assessment,{
    verifyPublic:async()=>{throw Error("Must not make public request");}
  });
  assert.equal(failure.ok,false);
  assert.equal(failure.reason,"no_scoped_inn_kpp");
  assert.equal(calls,1);
});
