// Independent opt-in Saby identity proof AFTER the original private URL
// changed. A URL change is NEVER considered safe or proof of identity.
// Reaccept the CURRENT stable private company only after strict INN/KPP,
// the selected Saby-search H1, and canonical registered public proof agree.
//
// This runs only after an existing fallback rejects a single removed
// non-UI query parameter. No company search retry, no private tab clicks,
// no contact/fleet reads, no account writes. Never log raw DOM or URLs.
import {sabyCardRoute} from "./sabyCard.js";
import {sabyInn,sabyNameMatches,sabyNameTokens} from "./sabyEnrichment.js";
import {
  recoverSabyDetailRequisitePair,diagnoseSabyPrivateRequisiteFields,
  acceptSabyPublicIdentityFallback
} from "./sabyPublicIdentityFallback.js";
import {verifyPublicSabyIdentity} from "./sabyPublicRegisteredIdentity.js";

const compact=s=>String(s||"").normalize("NFKC").replace(/\s+/g," ").trim();
const reasonNames=new Set([
  "ineligible_prior_route_change","invalid_source_identity",
  "private_detail_unavailable","private_url_changed_during_proof",
  "private_snapshot_unavailable","selected_owner_h1_missing",
  "selected_owner_h1_disconnected","private_pair_unavailable",
  "private_pair_ambiguous","private_pair_not_stable",
  "public_identity_unverified","private_identity_changed_after_public",
  "private_public_name_disconnected","selected_private_heading_disconnected",
  "public_verification_not_available","public_identity_unverified",
  "post_route_registered_identity_verified","private_inn_not_scoped"
]);
const maxReads=3;
const cap=n=>Number.isFinite(Number(n))?
  Math.max(0,Math.min(100,Math.floor(Number(n)))):0;
const reject=(reason,extra={})=>({ok:false,reason,...extra});

// The original verifier's value-free report proves the old/new URLs had
// the same first-party route path and one non-UI key disappeared. It does
// NOT prove this change was safe, nor reveal which key disappeared.
export function eligibleSabyPostRouteProof(priorFailure) {
  const delta=priorFailure?.route_delta||{};
  return priorFailure?.reason==="private_route_changed" &&
    priorFailure?.route_change_reason==="non_ui_query_changed" &&
    delta.status==="observed" &&
    delta.non_ui_removed===1 &&
    delta.non_ui_added===0 &&
    delta.non_ui_values_changed===0 &&
    delta.ui_values_changed===0;
}

async function captureSabyPostRouteSnapshot(page) {
  return page.evaluate(()=>{
    const visible=e=>{
      if(!e||typeof e.getBoundingClientRect!=="function")return false;
      const r=e.getBoundingClientRect(),s=getComputedStyle(e);
      return r.width>0&&r.height>0&&
        s.visibility!=="hidden"&&s.display!=="none";
    };
    const clean=s=>String(s||"").replace(/\s+/g," ").trim();
    const headings=[...document.querySelectorAll(
      'h1,h2,[role="heading"],[class*="companyName" i],' +
      '[class*="company-name" i]'
    )].filter(visible).slice(0,70).map(el=>
      clean(el.innerText||"")).filter(s=>s.length>=3&&s.length<=200)
      .slice(0,18);
    const h1=[...document.querySelectorAll("h1")].filter(visible)
      .slice(0,8).map(el=>clean(el.innerText||""))
      .filter(s=>s.length>=3&&s.length<=220);
    return {
      headings,h1,
      text:String(document.body?.innerText||"").slice(0,150000)
    };
  });
}

// Pure, in-memory snapshot assessment. The returned pair is sensitive and
// must NEVER be logged; only safeSabyPostRouteDiagnostic is printable.
export function assessSabyPostRouteSnapshot(snapshot,inn,selectedSearchTitle) {
  const h1=(Array.isArray(snapshot?.h1)?snapshot.h1:[])
    .map(compact).filter(Boolean);
  if(h1.length!==1)
    return {ok:false,reason:"selected_owner_h1_missing"};
  const owner=h1[0];
  if(!selectedSearchTitle || !sabyNameMatches(owner,selectedSearchTitle))
    return {ok:false,reason:"selected_owner_h1_disconnected"};
  const pair=recoverSabyDetailRequisitePair(snapshot?.text||"",inn);
  const diagnostics=diagnoseSabyPrivateRequisiteFields(snapshot?.text||"",inn);
  if(!pair.kpp)
    return {ok:false,reason:pair.reason==="no_scoped_inn_kpp"?
      "private_pair_unavailable":"private_pair_ambiguous"};
  // Avoid accepting a single matching pair if the wider audited page
  // contains another full INN/KPP or related firm's conflicting pair.
  if(pair.basis!=="strict_private_block" ||
     diagnostics.audited_pairs!==1 ||
     diagnostics.audited_exact_pairs!==1)
    return {ok:false,reason:"private_pair_ambiguous"};
  const headings=Array.isArray(snapshot?.headings)?snapshot.headings:[];
  if(!headings.some(title=>sabyNameMatches(title,owner)))
    return {ok:false,reason:"selected_owner_h1_disconnected"};
  return {ok:true,kpp:pair.kpp,owner,
    snapshot,private_pair_basis:pair.basis};
}

export async function verifySabyPostRouteOwnerIdentity(page,inn,name,
  cardAssessment,{
    priorFailure,
    selectedSearchTitle="",
    verifyPublic=verifyPublicSabyIdentity,
    snapshotReader=captureSabyPostRouteSnapshot,
    stableDelayMs=650
  }={}) {
  const diag={private_reads:0,stable_private_pair:false,
    selected_owner_h1:false,public_check_made:false,
    registered_public_verified:false,post_public_owner_confirmed:false};
  const fail=reason=>reject(reason,diag);
  if(!eligibleSabyPostRouteProof(priorFailure))
    return fail("ineligible_prior_route_change");
  const expected=sabyInn(inn);
  if(!expected||!sabyNameTokens(name).length || !selectedSearchTitle)
    return fail("invalid_source_identity");
  if(cardAssessment?.reason!=="legal_name_not_verified" ||
     cardAssessment?.detail?.hasScopedInn!==true)
    return fail("private_inn_not_scoped");
  const stableUrl=typeof page?.url==="function"?page.url():"";
  if(sabyCardRoute(stableUrl)!=="detail")
    return fail("private_detail_unavailable");
  const stillStable=()=>page?.url?.()===stableUrl &&
    sabyCardRoute(page?.url?.())==="detail";
  const read=async()=>{
    if(!stillStable())return null;
    const snapshot=await snapshotReader(page);
    diag.private_reads=Math.min(maxReads,diag.private_reads+1);
    if(!stillStable())return null;
    return assessSabyPostRouteSnapshot(
      snapshot,expected,selectedSearchTitle);
  };
  let first,second,third,publicResult;
  try{
    first=await read();
    if(!first)return fail("private_url_changed_during_proof");
    if(!first.ok)return fail(first.reason);
    diag.selected_owner_h1=true;
    const delay=Math.max(100,Math.min(1800,Number(stableDelayMs)||650));
    if(typeof page?.waitForTimeout!=="function")
      return fail("private_snapshot_unavailable");
    await page.waitForTimeout(delay);
    if(!stillStable())return fail("private_url_changed_during_proof");
    second=await read();
    if(!second)return fail("private_url_changed_during_proof");
    if(!second.ok)return fail(second.reason);
    if(first.kpp!==second.kpp || first.owner!==second.owner)
      return fail("private_pair_not_stable");
    diag.stable_private_pair=true;
    diag.public_check_made=true;
    publicResult=await verifyPublic(page,expected,second.kpp,name);
    if(!stillStable())return fail("private_url_changed_during_proof");
    if(publicResult?.status!=="verified")
      return fail("public_identity_unverified");
    diag.registered_public_verified=true;
    third=await read();
    if(!third)return fail("private_url_changed_during_proof");
    if(!third.ok || third.kpp!==second.kpp ||
       third.owner!==second.owner)
      return fail("private_identity_changed_after_public");
    diag.post_public_owner_confirmed=true;
    const accepted=acceptSabyPublicIdentityFallback({
      expectedInn:expected,expectedName:name,privateRoute:stableUrl,
      cardAssessment,privateText:third.snapshot.text,
      privateHeadings:third.snapshot.headings,
      publicResult,selectedSearchTitle
    });
    if(!stillStable())return fail("private_url_changed_during_proof");
    if(!accepted.ok)
      return fail(reasonNames.has(accepted.reason)?
        accepted.reason:"public_identity_unverified");
    return {ok:true,reason:"post_route_registered_identity_verified",
      identity:accepted.identity,...diag};
  }catch{
    return fail("private_snapshot_unavailable");
  }
}

export function safeSabyPostRouteDiagnostic(result) {
  return {
    reason:reasonNames.has(result?.reason)?result.reason:"unknown",
    accepted:result?.ok===true,
    private_reads:cap(result?.private_reads),
    selected_owner_h1:result?.selected_owner_h1===true,
    stable_private_pair:result?.stable_private_pair===true,
    public_check_made:result?.public_check_made===true,
    registered_public_verified:result?.registered_public_verified===true,
    post_public_owner_confirmed:result?.post_public_owner_confirmed===true
  };
}
