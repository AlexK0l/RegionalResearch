import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  extractSabyDetailRequisitePair,selectSabyInnCandidate,
  sabySearchRowInnEvidence,
  isSabyBranchResult,SABY_BRANCH_MARKER_SOURCE,
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
  const withBranch=selectSabyInnCandidate([
    row,{text:"Филиал САПК, АО\n"+inn,rect:{x:320,y:0,w:270,h:80}}
  ],inn,name);
  assert.equal(withBranch.row,row);
  assert.equal(withBranch.reason,"unique_primary_excluding_branches");
  assert.equal(withBranch.branches,1);
  assert.equal(withBranch.count,1);
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


test("Russian branch markers are detected with Unicode boundaries, never ASCII \\b",()=>{
  const cases=[
    "Филиал в Смоленске\n"+inn,
    "ДСК Автобан, АО - филиал в Туле\nИНН "+inn,
    "Обособленное подразделение ДСК Автобан\n"+inn,
    "Представительство ДСК Автобан\n"+inn,
    "Территориальное подразделение ДСК Автобан\n"+inn
  ];
  for(const caseText of cases) assert.equal(
    isSabyBranchResult(caseText,inn),true,caseText);
  for(const notBranch of [
    "ДСК Автобан, АО\nИНН "+inn,
    "ООО Филиалист\nИНН "+inn,
    "Филиал ДСК Автобан\n7707083893"
  ])assert.equal(isSabyBranchResult(notBranch,inn),false,notBranch);
  assert.match(SABY_BRANCH_MARKER_SOURCE,/\\p\{L\}/);
});

test("multiple independent heads with one INN still require review, not first-hit guessing",()=>{
  const rows=[
    {text:"ДСК Автобан, АО\n"+inn,rect:{x:10,y:100,w:200,h:60}},
    {text:"ДСК Автобан Регион, АО\n"+inn,rect:{x:10,y:200,w:200,h:60}}
  ];
  const selected=selectSabyInnCandidate(rows,inn,
    "АКЦИОНЕРНОЕ ОБЩЕСТВО ДОРОЖНО-СТРОИТЕЛЬНАЯ КОМПАНИЯ АВТОБАН");
  assert.equal(selected.row,null);
  assert.equal(selected.reason,"ambiguous");
  assert.equal(selected.branches,0);
  assert.equal(selected.count,2);
  assert.equal(selected.observed,2);
});

test("entire capped result window and branch-only result fail closed",()=>{
  const rows=Array.from({length:20},(_,i)=>({
    text:"Филиал "+i+" ДСК Автобан\n"+inn,
    rect:{x:0,y:i*30,w:200,h:28}
  }));
  const capped=selectSabyInnCandidate(rows,inn,name);
  assert.equal(capped.reason,"result_window_full");
  assert.equal(capped.row,null);
  const justBranch=selectSabyInnCandidate(rows.slice(0,2),inn,name);
  assert.equal(justBranch.reason,"branch_only");
  assert.equal(justBranch.row,null);
});


test("registries in one result: exclude other INN, not 13-digit OGRN",()=>{
  const exact=sabySearchRowInnEvidence(
    "Головная организация, АО\nИНН "+inn+"\nОГРН 1026700008136",inn);
  assert.deepEqual(exact,{
    hasExpected:true,foreignInnCount:0,exclusiveExpected:true
  });
  const other=sabySearchRowInnEvidence(
    "Контрагент, ООО\nИНН 7707083893\nСвязи: "+inn,inn);
  assert.deepEqual(other,{
    hasExpected:true,foreignInnCount:1,exclusiveExpected:false
  });
  const missing=sabySearchRowInnEvidence(
    "Контрагент, ООО\nИНН 7707083893",inn);
  assert.equal(missing.exclusiveExpected,false);
  assert.equal(missing.hasExpected,false);
  assert.equal(sabySearchRowInnEvidence(
    "Главная компания, АО\nИНН "+inn+
    "\nПодрядчик 7707083893\nЕщё один 7725104642",inn
  ).foreignInnCount,2);
});

test("40 real-layout-style Saby search rows reduce to 1 head + 11 branches + 28 related",()=>{
  const rect=i=>({x:220,y:89+i*110,w:553,h:85});
  const rows=[
    {text:"САПК, АО\nИНН "+inn+"\nОГРН 1026700008136",
      rect:rect(0)}
  ];
  for(let i=0;i<11;i++){
    const head=i<2?"Филиал САПК, АО, г. "+(i?"Чехов":"Тула"):
      i<10?"САПК, АО, подразделение":
        "САПК, АО, подразделение, г. Пушкино";
    rows.push({text:head+"\nИНН "+inn,rect:rect(rows.length)});
  }
  for(let i=0;i<28;i++){
    rows.push({
      text:"Связанная организация "+i+", ООО\nИНН 7707083893"+
        "\nКомпания группы "+inn,
      rect:rect(rows.length)
    });
  }
  assert.equal(rows.length,40);
  // The report documented 40 separate clickable rows and 33 titles.
  // Do not use the exact firm name/INN as an exception in production.
  Object.defineProperty(rows,"meta",{value:{
    rawCandidates:40,geometryDuplicates:0,
    rejectedFragments:0,uniqueTitles:33,rawCapped:false,
    truncated:false
  }});
  const result=selectSabyInnCandidate(rows,inn,name);
  assert.equal(result.row,rows[0]);
  assert.equal(result.reason,"unique_primary_after_exclusions");
  assert.equal(result.observed,40);
  assert.equal(result.count,1);
  assert.equal(result.primaryCandidates,1);
  assert.equal(result.branches,11);
  assert.equal(result.foreignInnRows,28);
  assert.equal(result.rawCandidates,40);
  assert.equal(result.uniqueTitles,33);
});

test("40 results with two eligible main firms still fail closed",()=>{
  const head=t=>({text:t+"\nИНН "+inn,
    rect:{x:220,y:100,w:553,h:85}});
  const rows=[head("Новая фирма, АО"),head("Новая фирма Регион, АО")];
  for(let i=0;i<38;i++)
    rows.push(head("Связанная "+i+", ООО\nИНН 7707083893"));
  Object.defineProperty(rows,"meta",{value:{truncated:false,rawCapped:false}});
  const result=selectSabyInnCandidate(rows,inn,name);
  assert.equal(result.row,null);
  assert.equal(result.reason,"ambiguous");
  assert.equal(result.count,2);
  assert.equal(result.foreignInnRows,38);
});

test("truncated 40-row scan cannot select even one plausible head",()=>{
  const rows=[
    {text:"САПК, АО\n"+inn,rect:{x:220,y:89,w:553,h:82}}
  ];
  Object.defineProperty(rows,"meta",{value:{rawCapped:false,truncated:true}});
  const result=selectSabyInnCandidate(rows,inn,name);
  assert.equal(result.row,null);
  assert.equal(result.reason,"result_window_full");
});

test("a legitimate main with another INN mentioned in its row stays review",()=>{
  const row={text:"САПК, АО\nИНН "+inn+
    "\nСвязанные компании: 7707083893"};
  const result=selectSabyInnCandidate([row],inn,name);
  assert.equal(result.row,null);
  assert.equal(result.foreignInnRows,1);
  assert.equal(result.primaryCandidates,0);
});
