// Read-only structural diagnosis of the authenticated Saby detail after
// a UNIQUE head-company search candidate was opened. This does NOT verify
// identity or recover any INN/KPP. No raw DOM, names, phone/email, cookies,
// full URLs, personal data, or credentials are sent to logs.
import {sabyCardRoute} from "./sabyCard.js";
import {sabyInn,sabyNameMatches} from "./sabyEnrichment.js";
import {
  recoverSabyDetailRequisitePair,diagnoseSabyPrivateRequisiteFields
} from "./sabyPublicIdentityFallback.js";

const count=n=>Number.isSafeInteger(n)&&n>=0?Math.min(n,100000):0;
// Read the same CURRENT hydrated private DOM with the existing strict and
// audited parsers, but return only a reason, proof-basis code and counters.
 // A single post-route snapshot is NEVER sufficient to accept a company.
const REQUISITE_REASONS=new Set([
  "invalid_inn","inn_conflict","kpp_ambiguous","multiple_requisites",
  "unique_requisite_pair","no_scoped_inn_kpp","audit_inn_conflict",
  "audit_kpp_ambiguous","audit_section_ambiguous",
  "audit_correlated_labeled_pair"
]);
const REQUISITE_BASES=new Set([
  "strict_private_block","audited_private_label_block"
]);
export function summarizeSabyPrivateOwnerStructure(snapshot,searchTitle,
  expectedInn="") {
  const headings=(Array.isArray(snapshot?.headings)?
    snapshot.headings:[]).slice(0,60);
  const titles=headings
    .map(x=>String(x?.title||"").replace(/\s+/g," ").trim())
    .filter(x=>x.length>=3&&x.length<=220);
  const search=String(searchTitle||"").trim();
  const matches=search?titles.filter(x=>sabyNameMatches(search,x)):[];
  const matchedOwner=headings.filter(x=>
    search&&sabyNameMatches(search,String(x?.title||"")) &&
    x?.has_scoped_inn===true);
  const numbers=[
    "visible_text_chars","main_regions","heading_count","h1_count",
    "visible_inn_labels","visible_kpp_labels","requisites_label_leaves",
    "requisites_role_controls","related_company_headings",
    "public_same_inn_profile_links","public_distinct_kpp_links"
  ];
  const summary={};
  for(const key of numbers)summary[key]=count(snapshot?.[key]);
  // The only raw private text below is an EPHEMERAL in-memory input for
  // the already tested bounded parser. It must never enter the result,
  // console, output JSON, audit log, or a persisted document.
  const currentText=String(snapshot?.current_visible_text||"");
  const parsed=currentText && sabyInn(expectedInn)?
    recoverSabyDetailRequisitePair(currentText,expectedInn):null;
  const structure=currentText && sabyInn(expectedInn)?
    diagnoseSabyPrivateRequisiteFields(currentText,expectedInn):null;
  const lateRequisites={
    status:parsed?"observed":"not_observed",
    reason:parsed&&REQUISITE_REASONS.has(parsed.reason)?
      parsed.reason:"not_observed",
    candidate_pair_present:Boolean(parsed?.kpp),
    pair_basis:parsed?.kpp&&REQUISITE_BASES.has(parsed.basis)?
      parsed.basis:"",
    requisites_headings:count(structure?.requisites_headings),
    labelled_inn_lines:count(structure?.labelled_inn_lines),
    labelled_kpp_lines:count(structure?.labelled_kpp_lines),
    audited_pairs:count(structure?.audited_pairs),
    audited_exact_pairs:count(structure?.audited_exact_pairs)
  };
  return {
    status:"observed_not_verified",
    ...summary,
    selected_name_in_headings:matches.length>0,
    selected_heading_count:matches.length,
    selected_heading_scoped_inn:matchedOwner.length>0,
    selected_heading_scoped_inn_count:matchedOwner.length,
    // Pure booleans/counters only: no actual titles, INNs, links or KPPs.
    detail_region_observed:summary.main_regions>0&&summary.visible_text_chars>50,
    late_requisites:lateRequisites
  };
}
export async function diagnoseSabyPrivateOwnerStructure(page,inn,searchTitle) {
  if(!sabyInn(inn)||sabyCardRoute(page?.url?.())!=="detail")
    return {status:"not_private_detail"};
  try {
    const snapshot=await page.evaluate(({inn})=>{
      const visible=e=>{
        if(!e || typeof e.getBoundingClientRect!=="function")return false;
        const r=e.getBoundingClientRect(),s=getComputedStyle(e);
        return r.width>0&&r.height>0&&
          s.visibility!=="hidden"&&s.display!=="none";
      };
      const clean=s=>String(s||"").replace(/\s+/g," ").trim();
      const inner=e=>String(e?.innerText||e?.textContent||"");
      const body=inner(document.body).slice(0,160000);
      const exact=new RegExp("(?:^|\\D)"+inn+"(?!\\d)");
      const labelled=new RegExp("(?:^|\\s)ИНН\\s*[:：№#—-]?\\s*"+
        inn+"(?!\\d)","iu");
      const foreign=/\b(?:\d{10}|\d{12})\b/gu;
      const regions=[...document.querySelectorAll(
        "main,article,[role='main']"
      )].filter(visible).slice(0,30);
      const headingEls=[...document.querySelectorAll(
        'h1,h2,h3,[role="heading"],[class*="companyName" i],'+
        '[class*="company-name" i]'
      )].filter(visible).slice(0,80);
      const headings=headingEls.map(el=>{
        const title=clean(inner(el)).slice(0,220);
        let hasScopedInn=false;
        for(let node=el.parentElement,depth=0;node&&depth<7;
            node=node.parentElement,depth++){
          if(!visible(node))continue;
          const text=inner(node);
          if(text.length>2500)break;
          if(!labelled.test(clean(text)))continue;
          const nums=[...new Set((text.match(foreign)||[]))];
          if(nums.length===1 && nums[0]===inn)hasScopedInn=true;
          break;
        }
        return {title,has_scoped_inn:hasScopedInn};
      });
      const leaves=[...document.querySelectorAll("body *")]
        .filter(el=>el.children.length===0&&visible(el))
        .slice(0,6000);
      const counts={inn:0,kpp:0,requisites:0,roleControls:0,related:0};
      for(const el of leaves){
        const t=clean(inner(el));
        if(/^(?:ИНН)(?:\s*[:：№#—-]|\s+\d{10,12}|$)/iu.test(t))counts.inn++;
        if(/^(?:КПП)(?:\s*[:：№#—-]|\s+\d{9}|$)/iu.test(t))counts.kpp++;
        if(/^Реквизиты$/iu.test(t))counts.requisites++;
        if(/^(?:Связанные компании|Связанные лица|Филиалы)$/iu.test(t))
          counts.related++;
      }
      const controls=[...document.querySelectorAll(
        "a,button,[role='tab'],[role='button'],[role='link']"
      )].filter(visible).slice(0,600);
      for(const el of controls){
        if(clean(inner(el))==="Реквизиты")counts.roleControls++;
      }
      const publicKpps=new Set();
      let sameInnPublicLinks=0;
      const anchors=[...document.querySelectorAll("a[href]")]
        .slice(0,1500);
      for(const el of anchors){
        if(!visible(el))continue;
        let parsed;
        try{parsed=new URL(el.href,document.baseURI);}catch{continue;}
        if(parsed.protocol!=="https:"||parsed.hostname!=="saby.ru"||
           parsed.username||parsed.password||parsed.search||parsed.hash)
          continue;
        const match=/^\/profile\/(\d{10}|\d{12})-(\d{9})\/?$/u
          .exec(parsed.pathname);
        if(!match||match[1]!==inn)continue;
        sameInnPublicLinks++;
        publicKpps.add(match[2]);
      }
      return {
        headings,
        // Ephemeral visible DOM text is immediately reduced to strict
        // structural evidence in Node and NEVER returned to the caller.
        current_visible_text:body,
        visible_text_chars:body.length,
        main_regions:regions.length,
        heading_count:headings.length,
        h1_count:headingEls.filter(e=>e.tagName==="H1").length,
        visible_inn_labels:counts.inn,
        visible_kpp_labels:counts.kpp,
        requisites_label_leaves:counts.requisites,
        requisites_role_controls:counts.roleControls,
        related_company_headings:counts.related,
        public_same_inn_profile_links:sameInnPublicLinks,
        public_distinct_kpp_links:publicKpps.size
      };
    },{inn:sabyInn(inn)});
    return summarizeSabyPrivateOwnerStructure(snapshot,searchTitle,inn);
  } catch {
    return {status:"private_dom_probe_unavailable"};
  }
}
