// Saby company identity gate. Contact and transport sections are NOT proof
// of identity: they may load later, or be absent entirely.
import { sabyInn, sabyNameMatches } from "./sabyEnrichment.js";

export function sabyCardRoute(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (parsed.protocol !== "https:" || parsed.hostname !== "profile.saby.ru")
      return "other_origin";
    if (parsed.pathname === "/page/contractor-info" ||
        parsed.pathname.startsWith("/page/contractor-info/")) return "detail";
    if (parsed.pathname === "/page/company-list-prof") return "list";
    return "other_profile";
  } catch { return "invalid_url"; }
}

export function assessSabyCardEvidence(url, inn, expectedName, evidence) {
  const route = sabyCardRoute(url);
  const actualInn = sabyInn(inn);
  const headers = Array.isArray(evidence?.headings) ? evidence.headings : [];
  const intro = Array.isArray(evidence?.introLines) ? evidence.introLines : [];
  const matchingHeader = headers.find(line=>sabyNameMatches(expectedName,line));
  const matchingIntro = intro.slice(0,60).find(line=>sabyNameMatches(expectedName,line));
  const matchingName=matchingHeader||matchingIntro||"";
  const hasScopedInn=Boolean(evidence?.scopedLabeledInn || evidence?.scopedExactInn);
  const hasInn=Boolean(evidence?.bodyLabeledInn || hasScopedInn);
  const detail={
    route, hasInn, hasScopedInn, hasName:Boolean(matchingName),
    contactSectionPresent:Boolean(evidence?.contactSectionPresent),
    detailContentPresent:Boolean(evidence?.detailContentPresent)
  };
  if(!actualInn||!expectedName) return {ok:false,reason:"invalid_expected_identity",detail};
  if(route!=="detail")return {ok:false,reason:"not_detail_page",detail};
  if(!evidence?.detailContentPresent)return {ok:false,reason:"detail_not_rendered",detail};
  if(!hasInn)return {ok:false,reason:"inn_not_verified",detail};
  if(!matchingName)return {ok:false,reason:"legal_name_not_verified",detail};
  return {ok:true,verifiedName:matchingName,reason:"verified",detail};
}

/** Read only short identity text into Node memory; do not log or persist it. */
export async function verifySabyCard(page,inn,expectedName) {
  const url=page.url();
  if(sabyCardRoute(url)!=="detail") {
    return assessSabyCardEvidence(url,inn,expectedName,null);
  }
  const evidence=await page.evaluate(({inn})=>{
    const visible=element=>{
      const r=element.getBoundingClientRect(),s=getComputedStyle(element);
      return r.width>0 && r.height>0 && s.display!=="none" &&
        s.visibility!=="hidden";
    };
    const normalize=s=>String(s||"").replace(/\s+/g," ").trim();
    const exact=new RegExp("(?:^|\\D)"+inn+"(?!\\d)");
    const labeled=new RegExp(
      "(?:ИНН|INN)(?:\\s*[/\\\\]\\s*КПП)?\\s*[:№#—-]?\\s*"+inn+"(?!\\d)","i"
    );
    const main=(document.body?.innerText||"").slice(0,65000);
    const rootBlocks=[...document.querySelectorAll(
      'main,article,[role="main"],[class*="company" i],' +
      '[class*="card" i],[class*="overview" i],[class*="info" i]'
    )].filter(e=>{
      const r=e.getBoundingClientRect();
      return visible(e) && r.width>220 && r.height>100;
    }).slice(0,120);
    let scopedExactInn=false,scopedLabeledInn=false;
    for(const block of rootBlocks){
      const text=normalize((block.innerText||"").slice(0,5000));
      if(!text)continue;
      scopedExactInn||=exact.test(text);
      scopedLabeledInn||=labeled.test(text);
    }
    const headerElements=[...document.querySelectorAll(
      'h1,h2,h3,[role="heading"],[class*="companyName" i],' +
      '[class*="company-name" i]'
    )].filter(visible).slice(0,80);
    const headings=headerElements.map(e=>normalize(e.innerText))
      .filter(x=>x.length>=3&&x.length<=180).slice(0,50);
    // Saby sometimes renders legal titles as a div, not a semantic heading.
    // Require a complete line near the top of the actual company detail.
    const introLines=main.slice(0,6500).split(/[\r\n]+/)
      .map(normalize).filter(Boolean).slice(0,80);
    return {
      headings,introLines,
      bodyLabeledInn:labeled.test(normalize(main)),
      scopedLabeledInn,scopedExactInn,
      contactSectionPresent:/\bКонтакты\b/i.test(main),
      detailContentPresent:main.trim().length>60 &&
        (rootBlocks.length>0 || headerElements.length>0)
    };
  },{inn});
  return assessSabyCardEvidence(url,inn,expectedName,evidence);
}

export function safeCardDiagnostic(assessment, extra={}) {
  // Immutable allowlist: no names, INNs, URLs, page text, tokens or cookies.
  const detail=assessment?.detail||{};
  return {
    reason:String(assessment?.reason||"unknown"),
    route:String(detail.route||"unknown"),
    hasInn:Boolean(detail.hasInn),
    hasScopedInn:Boolean(detail.hasScopedInn),
    hasName:Boolean(detail.hasName),
    detailContentPresent:Boolean(detail.detailContentPresent),
    contactSectionPresent:Boolean(detail.contactSectionPresent),
    clicked:Boolean(extra.clicked),
    navigationObserved:Boolean(extra.navigationObserved)
  };
}
