import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  eligibleSabyPostRouteProof,assessSabyPostRouteSnapshot,
  verifySabyPostRouteOwnerIdentity,safeSabyPostRouteDiagnostic,
  safeSabyPublicProofReason
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

test("real VPS case: stable selected H1 and exact private pair but public Saby proof unavailable stays review with safe cause",async()=>{
  const {page}=fakePage();
  let calls=0;
  const sourceResult={
    status:"review",reason:"registered_name_not_rendered",
    diagnostic:{
      http_status:200,h1_count:2,h1_has_text:true,
      requisites_heading_visible:true,registered_name_label_visible:false,
      inn_label_visible:true,kpp_label_visible:true,
      challenge_observed:false,
      requisite_layout:{anchors:2,field_layouts:[
        {name_values:0,inn_values:1,kpp_values:1,ambiguous:false},
        {name_values:1,inn_values:1,kpp_values:1,ambiguous:false}
      ]},
      private_text:"SECRET_COMPANY_OWNER",company_name:name,
      kpp,raw_url:route,token:"SENSITIVE_COOKIE"
    }
  };
  const result=await verifySabyPostRouteOwnerIdentity(page,inn,name,
    assessment,{
      priorFailure:prior,selectedSearchTitle:short,
      verifyPublic:async()=>{calls++;return sourceResult;}
    });
  assert.equal(calls,1);
  assert.equal(result.ok,false);
  assert.equal(result.reason,"public_identity_unverified");
  assert.equal(result.stable_private_pair,true);
  const diag=safeSabyPostRouteDiagnostic(result);
  assert.equal(diag.public_reason,"registered_name_not_rendered");
  assert.equal(diag.public_http_status,200);
  assert.equal(diag.public_requisite_blocks,2);
  assert.equal(diag.public_complete_registered_blocks,1);
  assert.equal(diag.public_h1_count,2);
  assert.equal(diag.public_registered_name_label_visible,false);
  assert.equal(diag.public_inn_label_visible,true);
  assert.equal(diag.public_kpp_label_visible,true);
  assert.equal(diag.registered_public_verified,false);
  assert.doesNotMatch(JSON.stringify(diag),
    /SECRET_COMPANY_OWNER|SENSITIVE_COOKIE|6700018766|670001001|contractorId|Смоленская/);
});

test("public verification failure codes are an allowlist, never arbitrary source text",()=>{
  const unknown=safeSabyPublicProofReason({
    reason:"ERROR_SECRET_PRIVATE_URL",
    diagnostic:{
      http_status:100000000,h1_count:9999,
      requisite_layout:{anchors:9000,field_layouts:Array.from(
        {length:70},()=>({
          name_values:1,inn_values:1,kpp_values:1,ambiguous:false
        }))},
      raw_text:"SENSITIVE_DO_NOT_LOG"
    }
  });
  assert.equal(unknown.public_reason,"unknown");
  assert.equal(unknown.public_http_status,599);
  assert.equal(unknown.public_h1_count,100);
  assert.equal(unknown.public_requisite_blocks,24);
  assert.equal(unknown.public_complete_registered_blocks,8);
  assert.doesNotMatch(JSON.stringify(unknown),
    /ERROR_SECRET_PRIVATE_URL|SENSITIVE_DO_NOT_LOG/);
  const legalMismatch=safeSabyPublicProofReason({
    reason:"name_not_matched_to_registered_entity"
  });
  assert.equal(legalMismatch.public_reason,
    "name_not_matched_to_registered_entity");
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
