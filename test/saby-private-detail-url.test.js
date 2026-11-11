import test from "node:test";
import assert from "node:assert/strict";
import {
  compareSabyPrivateDetailUrl,summarizeSabyPrivateRouteDelta
} from "../src/sabyPrivateDetailUrl.js";
import {
  verifySabyPublicNameFallback,safeSabyAliasDiagnostic
} from "../src/sabyPublicIdentityFallback.js";

const base="https://profile.saby.ru/page/contractor-info";
const inn="6700018766",kpp="670001001";
const short="Сапк, АО";
const long="АО «Смоленская агропромышленная компания»";
const registered='АКЦИОНЕРНОЕ ОБЩЕСТВО "СМОЛЕНСКАЯ АГРОПРОМЫШЛЕННАЯ КОМПАНИЯ"';
const validText=[
  short,"Контакты","Реквизиты",
  "ИНН",inn,"КПП",kpp,"ОГРН","1246700008136",
  "Контакты связанных компаний","Суды"
].join("\n");
const publicProof={
  status:"verified",
  official_inn:inn,official_kpp:kpp,official_name:registered,
  public_short_name:short
};
const assessment={
  reason:"legal_name_not_verified",detail:{hasScopedInn:true}
};

test("pure URL continuity accepts identical detail, reordered queries, safe tab changes",()=>{
  const start=base+"?anchor=about&tab=all&page=public&contractorId=ABC";
  const unchanged=base+"?contractorId=ABC&page=public&tab=all&anchor=about";
  assert.deepEqual(compareSabyPrivateDetailUrl(start,unchanged),{
    ok:true,reason:"same_detail",ui_params_changed:0,
    fragment_changed:false
  });
  const tabbed=base+"?contractorId=ABC&anchor=requisites&tab=company&page=public";
  const s=compareSabyPrivateDetailUrl(start,tabbed);
  assert.equal(s.ok,true);
  assert.equal(s.reason,"ui_navigation_only");
  assert.equal(s.ui_params_changed,2);
  assert.equal(compareSabyPrivateDetailUrl(
    base+"?source=internal",base+"?source=internal&tab=requisites"
  ).reason,"ui_navigation_only");
  assert.equal(compareSabyPrivateDetailUrl(
    base+"#about",base+"#requisites"
  ).reason,"ui_navigation_only");
});

test("URL continuity rejects company changes, unknown query changes and untrusted paths",()=>{
  const before=base+"?contractorId=ABC&tab=about&inn="+inn;
  const changes=[
    [base+"?contractorId=DEF&tab=about&inn="+inn,"non_ui_query_changed"],
    [base+"?contractorId=ABC&tab=about&inn=7707083893","non_ui_query_changed"],
    [base+"?contractorId=ABC&tab=about&inn="+inn+
      "&orgToken=SECRET","non_ui_query_changed"],
    [base+"/other-company?contractorId=ABC&inn="+inn,
      "detail_path_changed"],
    [base+"?contractorId=ABC&tab=about&inn="+inn+"#id=OTHER",
      "non_ui_fragment_changed"],
    ["https://evil.example/page/contractor-info","not_same_first_party_detail"],
    ["https://profile.saby.ru/page/company-list-prof","not_same_first_party_detail"],
    ["http://profile.saby.ru/page/contractor-info","not_same_first_party_detail"],
    ["https://user:pass@profile.saby.ru/page/contractor-info",
      "not_same_first_party_detail"]
  ];
  for(const [next,reason] of changes){
    const observed=compareSabyPrivateDetailUrl(before,next);
    assert.equal(observed.ok,false,next);
    assert.equal(observed.reason,reason);
    const encoded=JSON.stringify(observed);
    assert.doesNotMatch(encoded,/SECRET|7707083893|contractorId|userinfo|inn=/);
  }
});

test("SPA UI tab update after three polls does not interrupt stable private/public proof",async()=>{
  const url=base+"?source=internal&tab=about";
  let current=url,reads=0,waits=0,publicCalls=0;
  const page={
    url:()=>current,
    evaluate:async()=>({
      text:(++reads)<=3?"Сапк, АО\nИНН "+inn:validText,
      headings:[short]
    }),
    getByRole:()=>({count:async()=>0}),
    waitForTimeout:async()=>{
      waits++;
      if(waits===3)current=base+"?source=internal&tab=requisites";
    }
  };
  const result=await verifySabyPublicNameFallback(page,inn,long,assessment,{
    maxHydrationPolls:5,selectedSearchTitle:short,
    verifyPublic:async(_page,gotInn,gotKpp,gotName)=>{
      publicCalls++;
      assert.equal(gotInn,inn);
      assert.equal(gotKpp,kpp);
      assert.equal(gotName,long);
      return publicProof;
    }
  });
  assert.equal(result.ok,true);
  assert.equal(result.reason,"registered_alias_verified");
  assert.equal(result.ui_route_updated,true);
  assert.equal(result.hydration_polls,3);
  assert.equal(result.pair_stability_confirmed,true);
  assert.equal(result.identity.kpp,kpp);
  assert.equal(publicCalls,1);
  assert.equal(reads,5);
  const logged=safeSabyAliasDiagnostic(result);
  assert.equal(logged.ui_route_updated,true);
  assert.equal(logged.accepted,true);
  assert.doesNotMatch(JSON.stringify(logged),/source=|tab=requisites|670001|contractorId/);
});

test("untrusted INN/company query change during hydration fails before any public request",async()=>{
  const start=base+"?contractorId=ABC&tab=about";
  let current=start,reads=0,publicCalls=0;
  const page={
    url:()=>current,
    evaluate:async()=>{reads++;return {
      text:"Сапк, АО\nИНН "+inn,headings:[short]
    };},
    getByRole:()=>({count:async()=>0}),
    waitForTimeout:async()=>{
      current=base+"?contractorId=DIFFERENT&tab=requisites";
    }
  };
  const result=await verifySabyPublicNameFallback(page,inn,long,assessment,{
    maxHydrationPolls:4,selectedSearchTitle:short,
    verifyPublic:async()=>{
      publicCalls++;
      throw Error("Must not read public page for wrong private company");
    }
  });
  assert.equal(result.ok,false);
  assert.equal(result.reason,"private_route_changed");
  assert.equal(result.route_change_reason,"non_ui_query_changed");
  assert.equal(result.hydration_polls,1);
  assert.equal(result.ui_route_updated,false);
  assert.equal(reads,1);
  assert.equal(publicCalls,0);
  const safe=safeSabyAliasDiagnostic(result);
  assert.equal(safe.route_change_reason,"non_ui_query_changed");
  assert.doesNotMatch(JSON.stringify(safe),/ABC|DIFFERENT|contractorId/);
});

test("unknown fragment or changed detail path stays rejected without reaching public verification",async()=>{
  for(const changed of [
    base+"/another-company?source=internal",
    base+"?source=internal#other-company-guid"
  ]){
    let current=base+"?source=internal",called=0;
    const page={
      url:()=>current,
      evaluate:async()=>({text:"Сапк, АО\nИНН "+inn,headings:[short]}),
      getByRole:()=>({count:async()=>0}),
      waitForTimeout:async()=>{current=changed;}
    };
    const result=await verifySabyPublicNameFallback(page,inn,long,assessment,{
      maxHydrationPolls:4,verifyPublic:async()=>{called++;return publicProof;}
    });
    assert.equal(result.ok,false);
    assert.equal(result.reason,"private_route_changed");
    assert.equal(called,0);
  }
});

test("safe non-UI query change telemetry distinguishes added, removed and replaced values",()=>{
  const initial=base+"?contractorId=VERY_PRIVATE_A&source=internal&tab=about";
  const current=base+"?contractorId=VERY_PRIVATE_B&token=HIDDEN&tab=requisites";
  const outcome=summarizeSabyPrivateRouteDelta(initial,current);
  assert.deepEqual(outcome,{
    status:"observed",
    non_ui_added:1,
    non_ui_removed:1,
    non_ui_values_changed:1,
    ui_values_changed:1
  });
  const serialized=JSON.stringify(outcome);
  assert.doesNotMatch(serialized,/VERY_PRIVATE|contractorId|token|HIDDEN|source|tab|requisites/i);
  assert.deepEqual(summarizeSabyPrivateRouteDelta(
    initial,"https://evil.example/page/contractor-info"),
    {status:"not_comparable"});
  assert.deepEqual(summarizeSabyPrivateRouteDelta(
    initial,base+"/other-company"),
    {status:"not_comparable"});
});

test("non-UI route change stays rejected while safe telemetry is forwarded",async()=>{
  const start=base+"?contractorId=A&source=internal&tab=about";
  let current=start,reads=0,publicCalls=0;
  const page={
    url:()=>current,
    evaluate:async()=>{reads++;return {text:"Сапк, АО\\nИНН "+inn,headings:[short]};},
    getByRole:()=>({count:async()=>0}),
    waitForTimeout:async()=>{
      current=base+"?contractorId=B&tab=requisites";
    }
  };
  const result=await verifySabyPublicNameFallback(page,inn,long,assessment,{
    maxHydrationPolls:2,selectedSearchTitle:short,
    verifyPublic:async()=>{publicCalls++;return publicProof;}
  });
  assert.equal(result.ok,false);
  assert.equal(result.reason,"private_route_changed");
  assert.equal(result.route_change_reason,"non_ui_query_changed");
  assert.equal(reads,1,"unsafe route change must not start another DOM read");
  assert.equal(publicCalls,0);
  const report=safeSabyAliasDiagnostic(result);
  assert.deepEqual(report.route_delta,{
    status:"observed",non_ui_added:0,non_ui_removed:1,
    non_ui_values_changed:1,ui_values_changed:1
  });
  assert.doesNotMatch(JSON.stringify(report),
    /contractorId|source=|internal|tab=requisites|VERY_PRIVATE/);
});

test("only exact loss of source=internal is tolerated; company and unknown keys still block",()=>{
  const original=base+"?source=internal&contractorId=ABC&tab=about";
  const after=base+"?contractorId=ABC&tab=about";
  const permitted=compareSabyPrivateDetailUrl(original,after);
  assert.equal(permitted.ok,true);
  assert.equal(permitted.reason,"ui_navigation_only");
  assert.equal(permitted.ui_params_changed,1);
  const forbidden=[
    [base+"?source=other&contractorId=ABC&tab=about",original],
    [base+"?source=internal&contractorId=ABC&tab=about",after],
    [base+"?source=internal&contractorId=ABC&tab=about",
      base+"?contractorId=DEF&tab=about"],
    [original,base+"?tab=about"],
    [base+"?source=other&contractorId=ABC",base+"?contractorId=ABC"],
    [base+"?source=internal&source=other",base],
    [base+"?source=internal&companyId=OLD",base+"?companyId=NEW"],
    [base+"?source=internal&inn="+inn,base+"?inn=7707083893"],
    [base+"?source=internal&kpp="+kpp,base+"?kpp=770701001"],
    [base+"?source=internal&unknown=state",base]
  ];
  for(const [from,to] of forbidden) {
    const verdict=compareSabyPrivateDetailUrl(from,to);
    assert.equal(verdict.ok,false,from+" -> "+to);
    assert.equal(verdict.reason,"non_ui_query_changed");
  }
});

test("known navigation marker can disappear during late private hydration, but full proof is still required",async()=>{
  const initial=base+"?contractorId=UNCHANGED&source=internal&tab=about";
  const after=base+"?contractorId=UNCHANGED&tab=about";
  let current=initial,reads=0,waits=0,publicCalls=0;
  const page={
    url:()=>current,
    evaluate:async()=>({
      text:(++reads)<=3?short+"\\nИНН "+inn:validText,
      headings:[short]
    }),
    getByRole:()=>({count:async()=>0}),
    waitForTimeout:async()=>{
      waits++;
      if(waits===2)current=after;
    }
  };
  const result=await verifySabyPublicNameFallback(page,inn,long,assessment,{
    maxHydrationPolls:5,selectedSearchTitle:short,
    verifyPublic:async(_page,gotInn,gotKpp,gotName)=>{
      publicCalls++;
      assert.equal(gotInn,inn);
      assert.equal(gotKpp,kpp);
      assert.equal(gotName,long);
      return publicProof;
    }
  });
  assert.equal(result.ok,true);
  assert.equal(result.reason,"registered_alias_verified");
  assert.equal(result.ui_route_updated,true);
  assert.equal(result.pair_stability_confirmed,true);
  assert.equal(publicCalls,1);
  assert.equal(result.identity.kpp,kpp);
  assert.doesNotMatch(JSON.stringify(safeSabyAliasDiagnostic(result)),
    /contractorId|UNCHANGED|source=internal|tab=about/);
});

test("source marker disappearance is never enough to accept a wrong private requisites INN",async()=>{
  const initial=base+"?contractorId=UNCHANGED&source=internal";
  const wrongText=[short,"Реквизиты","ИНН","7707083893","КПП",kpp,
    "Контакты связанных компаний"].join("\\n");
  let current=initial,publicCalls=0;
  const page={
    url:()=>current,
    evaluate:async()=>({text:wrongText,headings:[short]}),
    getByRole:()=>({count:async()=>0}),
    waitForTimeout:async()=>{current=base+"?contractorId=UNCHANGED";}
  };
  const result=await verifySabyPublicNameFallback(page,inn,long,assessment,{
    maxHydrationPolls:4,selectedSearchTitle:short,
    verifyPublic:async()=>{publicCalls++;return publicProof;}
  });
  assert.equal(result.ok,false);
  assert.ok(["inn_conflict","audit_inn_conflict","no_scoped_inn_kpp"].includes(result.reason));
  assert.equal(publicCalls,0);
});
