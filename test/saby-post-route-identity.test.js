import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  eligibleSabyPostRouteProof,assessSabyPostRouteSnapshot,
  verifySabyPostRouteOwnerIdentity,safeSabyPostRouteDiagnostic
} from "../src/sabyPostRouteIdentity.js";
import {compareSabyPublicRequisites} from "../src/sabyPublicRegisteredIdentity.js";
import {sabyBrowserSettings} from "../src/sabyBrowser.js";

const inn="6700018766",kpp="670001001";
const name="АО «Смоленская агропромышленная компания»";
const short="Сапк, АО";
const registered='АКЦИОНЕРНОЕ ОБЩЕСТВО "СМОЛЕНСКАЯ АГРОПРОМЫШЛЕННАЯ КОМПАНИЯ"';
const route="https://profile.saby.ru/page/contractor-info?contractorId=OPAQUE";
const sourcePage=[
  "О компании",short,"Контакты","Реквизиты",
  "ИНН",inn,"КПП",kpp,
  "Контакты","Связанные компании","ИНН 7707083893",
  "person@example.test","7 999 123-45-67"
].join("\n");
const prior={
  reason:"private_route_changed",route_change_reason:"non_ui_query_changed",
  route_delta:{status:"observed",non_ui_removed:1,non_ui_added:0,
    non_ui_values_changed:0,ui_values_changed:0}
};
const assessment={
  ok:false,reason:"legal_name_not_verified",
  detail:{route:"detail",hasScopedInn:true,hasInn:true,
    detailContentPresent:true}
};
const publicProof=compareSabyPublicRequisites({
  expectedInn:inn,expectedKpp:kpp,expectedName:name,
  publicTitle:short,
  records:[{name:registered,inn,kpp,ogrn:"1246700008136"}],
  url:"https://saby.ru/profile/"+inn+"-"+kpp
});
const snapshot=(overrides={})=>({
  h1:[short],headings:[short],
  text:sourcePage,...overrides
});
function fakePage(snaps=[snapshot()],{onWait=()=>{},onRead=()=>{}}={}){
  let reads=0,waits=0,url=route;
  return {
    page:{
      url:()=>url,
      evaluate:async()=>{
        const current=snaps[Math.min(reads,snaps.length-1)];
        reads++;
        onRead(reads,changed=>{url=changed;});
        return current;
      },
      waitForTimeout:async()=>{
        waits++;
        onWait(waits,changed=>{url=changed;});
      }
    },
    stats:()=>({reads,waits,url})
  };
}

test("a changed unknown route parameter is NOT itself a legal identity proof",()=>{
  assert.equal(eligibleSabyPostRouteProof(prior),true);
  for(const changed of [
    {...prior,route_delta:{...prior.route_delta,non_ui_removed:2}},
    {...prior,route_delta:{...prior.route_delta,non_ui_added:1}},
    {...prior,route_delta:{...prior.route_delta,non_ui_values_changed:1}},
    {...prior,route_delta:{...prior.route_delta,ui_values_changed:1}},
    {...prior,route_delta:{...prior.route_delta,status:"not_comparable"}},
    {...prior,route_change_reason:"origin_changed"},
    {...prior,reason:"legal_name_not_verified"},
    null
  ])assert.equal(eligibleSabyPostRouteProof(changed),false);
  const out=assessSabyPostRouteSnapshot(snapshot(),inn,short);
  assert.equal(out.ok,true);
  assert.equal(out.kpp,kpp);
  assert.equal(Object.hasOwn(out,"verified"),false);
});

test("fresh post-route H1 plus strict stable private pair plus independent public proof can verify",async()=>{
  assert.equal(publicProof.status,"verified");
  const {page,stats}=fakePage([snapshot(),snapshot(),snapshot()]);
  let publicCalls=0;
  const result=await verifySabyPostRouteOwnerIdentity(
    page,inn,name,assessment,{
      priorFailure:prior,selectedSearchTitle:short,
      stableDelayMs:100,
      verifyPublic:async(_page,gotInn,gotKpp,gotName)=>{
        publicCalls++;
        assert.equal(gotInn,inn);
        assert.equal(gotKpp,kpp);
        assert.equal(gotName,name);
        return publicProof;
      }
    });
  assert.equal(result.ok,true);
  assert.equal(result.reason,"post_route_registered_identity_verified");
  assert.equal(result.identity.verified,true);
  assert.equal(result.identity.kpp,kpp);
  assert.equal(result.identity.registered_name,registered);
  assert.equal(result.identity.private_pair_basis,"strict_private_block");
  assert.equal(publicCalls,1);
  assert.equal(stats().reads,3);
  assert.equal(stats().waits,1);
  assert.deepEqual(safeSabyPostRouteDiagnostic(result),{
    reason:"post_route_registered_identity_verified",accepted:true,
    private_reads:3,selected_owner_h1:true,stable_private_pair:true,
    public_check_made:true,registered_public_verified:true,
    post_public_owner_confirmed:true
  });
  const safe=JSON.stringify(safeSabyPostRouteDiagnostic(result));
  assert.doesNotMatch(safe,/Сапк|6700018766|670001001|person@example|123-45-67|contractorId|OPAQUE/);
});

test("prior route warning or wrong original assessment never permits private read",async()=>{
  const {page,stats}=fakePage();
  let called=0;
  const options={
    priorFailure:{...prior,route_delta:{...prior.route_delta,non_ui_added:1}},
    selectedSearchTitle:short,
    verifyPublic:async()=>{called++;return publicProof;}
  };
  let result=await verifySabyPostRouteOwnerIdentity(page,inn,name,
    assessment,options);
  assert.equal(result.reason,"ineligible_prior_route_change");
  assert.equal(stats().reads,0);
  result=await verifySabyPostRouteOwnerIdentity(page,inn,name,
    {...assessment,detail:{hasScopedInn:false}},{
      ...options,priorFailure:prior
    });
  assert.equal(result.reason,"private_inn_not_scoped");
  assert.equal(stats().reads,0);
  assert.equal(called,0);
});

test("post-route owner must be a unique visible H1 matching the selected company",async()=>{
  for(const heads of [
    [],["Сапк, АО","Филиал компании"],["Чужая организация, ООО"]
  ]) {
    const {page}=fakePage([snapshot({h1:heads})]);
    let publicCalls=0;
    const result=await verifySabyPostRouteOwnerIdentity(
      page,inn,name,assessment,{
        priorFailure:prior,selectedSearchTitle:short,
        verifyPublic:async()=>{publicCalls++;return publicProof;}
      });
    assert.equal(result.ok,false);
    assert.match(result.reason,/selected_owner_h1_(?:missing|disconnected)/);
    assert.equal(publicCalls,0);
  }
});

test("foreign INN or unrelated KPP cannot be adopted from a related company",async()=>{
  const wrong=[
    short,"Реквизиты","ИНН","7707083893","КПП",kpp,
    "Контакты","Связанные компании"
  ].join("\n");
  const extra=[
    sourcePage,"Реквизиты","ИНН",inn,"КПП","670001002"
  ].join("\n");
  for(const raw of [wrong,extra]) {
    const {page}=fakePage([snapshot({text:raw})]);
    let publicCalls=0;
    const result=await verifySabyPostRouteOwnerIdentity(
      page,inn,name,assessment,{
        priorFailure:prior,selectedSearchTitle:short,
        verifyPublic:async()=>{publicCalls++;return publicProof;}
      });
    assert.equal(result.ok,false);
    assert.match(result.reason,/private_pair_/);
    assert.equal(publicCalls,0);
  }
});

test("changing KPP between private captures fails without public verification",async()=>{
  const mutated=sourcePage.replace("\nКПП\n"+kpp,"\nКПП\n670001002");
  const {page,stats}=fakePage([
    snapshot(),snapshot({text:mutated})
  ]);
  let publicCalls=0;
  const result=await verifySabyPostRouteOwnerIdentity(
    page,inn,name,assessment,{
      priorFailure:prior,selectedSearchTitle:short,
      verifyPublic:async()=>{publicCalls++;return publicProof;}
    });
  assert.equal(result.reason,"private_pair_not_stable");
  assert.equal(stats().reads,2);
  assert.equal(publicCalls,0);
});

test("URL change during new verification rejects before public lookup",async()=>{
  const {page}=fakePage([snapshot(),snapshot()],{
    onWait:(_calls,setUrl)=>setUrl(
      "https://profile.saby.ru/page/contractor-info?contractorId=OTHER")
  });
  let publicCalls=0;
  const result=await verifySabyPostRouteOwnerIdentity(
    page,inn,name,assessment,{
      priorFailure:prior,selectedSearchTitle:short,
      verifyPublic:async()=>{publicCalls++;return publicProof;}
    });
  assert.equal(result.reason,"private_url_changed_during_proof");
  assert.equal(publicCalls,0);
});

test("public profile must independently verify exact registered INN/KPP and name",async()=>{
  const {page}=fakePage();
  let publicCalls=0;
  const result=await verifySabyPostRouteOwnerIdentity(
    page,inn,name,assessment,{
      priorFailure:prior,selectedSearchTitle:short,
      verifyPublic:async()=>{
        publicCalls++;
        return {...publicProof,official_kpp:"670001002"};
      }
    });
  assert.equal(publicCalls,1);
  assert.equal(result.ok,false);
  assert.equal(result.reason,"public_identity_unverified");
});

test("after public proof, a switched company heading or KPP must reject enrichment",async()=>{
  const {page}=fakePage([
    snapshot(),snapshot(),snapshot({h1:["Другая организация, ООО"],
      headings:["Другая организация, ООО"]})
  ]);
  let publicCalls=0;
  const result=await verifySabyPostRouteOwnerIdentity(
    page,inn,name,assessment,{
      priorFailure:prior,selectedSearchTitle:short,
      verifyPublic:async()=>{publicCalls++;return publicProof;}
    });
  assert.equal(publicCalls,1);
  assert.equal(result.ok,false);
  assert.equal(result.reason,"private_identity_changed_after_public");
});

test("only the explicit opt-in path can reach the post-route verifier",()=>{
  assert.equal(sabyBrowserSettings({}).publicIdentityFallback,false);
  const src=fs.readFileSync(
    new URL("../src/sabyBrowser.js",import.meta.url),"utf8");
  assert.match(src,/if\(publicFallback &&\s+publicFallbackFailureReason==="private_route_changed"/);
  assert.match(src,/verifySabyPostRouteOwnerIdentity\(/);
  assert.match(src,/safeSabyPostRouteDiagnostic\(/);
  assert.match(src,/post_route_registered_identity_verified/);
});
