// Optional, fail-closed Saby Stage12 identity recovery for abbreviated
// company names. Search by INN is a CANDIDATE only, never identity proof.
// No source JSON changes here; Stage12 contacts may be written only AFTER
// three concordant identities: source INN, authenticated detail INN/KPP,
// and registered name+INN/KPP on canonical first-party public profile.
import {sabyCardRoute} from "./sabyCard.js";
import {sabyInn,sabyNameMatches,sabyNameTokens} from "./sabyEnrichment.js";
import {auditSelectSearchResult} from "./sabyIdentityAudit.js";
import {verifyPublicSabyIdentity} from "./sabyPublicRegisteredIdentity.js";

const label=(line,key)=>{
  const s=String(line||"").trim();
  const re=new RegExp("^"+key+"(?:\\s*[:：№#—-]\\s*|\\s+)(\\d+)\\s*[.,;]?\\s*$","iu");
  const m=re.exec(s);
  return m?.[1]||"";
};
const boundedLines=text=>String(text||"").slice(0,150000)
  .split(/[\r\n]+/).map(s=>String(s||"").trim()).filter(Boolean);
const STOP=/^(?:О компании|Контакты|Контакты и телефоны|Владельцы|Связанные компании|Подразделения|Филиалы|Автопарк компании|Лицензии|Регистрация компании|Реквизиты)\s*$/iu;
const KPP=/^\d{9}$/;
function field(lines,start,stop,key) {
  const out=new Set();
  for(let i=start;i<stop;i++) {
    const val=label(lines[i],key);
    if(val)out.add(val);
    else if(new RegExp("^"+key+"\\s*[:：]?\\s*$","iu").test(lines[i])) {
      const next=String(lines[i+1]||"").trim().replace(/[.;,]$/u,"");
      if(/^\d+$/.test(next))out.add(next);
    }
  }
  return [...out];
}
/** INN + KPP must be explicit labels in ONE authenticated, bounded detail
 * "Реквизиты" section. A number seen in a header, news, URL or associated
 * companies is not safe. Reject multiple KPP/INNs, even if one is correct.
 */
export function extractSabyDetailRequisitePair(text,expectedInn) {
  const inn=sabyInn(expectedInn);
  if(!inn)return {reason:"invalid_inn",kpp:""};
  const lines=boundedLines(text),found=[],ambiguous=[];
  for(let i=0;i<lines.length;i++) {
    if(!/^Реквизиты\s*:?\s*$/iu.test(lines[i]))continue;
    const start=i+1;
    let stop=Math.min(lines.length,start+45);
    for(let j=start;j<stop;j++)if(STOP.test(lines[j])){stop=j;break;}
    const inns=field(lines,start,stop,"ИНН")
      .filter(x=>sabyInn(x));
    const kpps=field(lines,start,stop,"КПП")
      .filter(x=>KPP.test(x));
    if(inns.length>1||kpps.length>1){
      ambiguous.push(true);
      continue;
    }
    if(inns.length===1&&kpps.length===1)
      found.push({inn:inns[0],kpp:kpps[0]});
  }
  if(ambiguous.length)return {reason:"multiple_requisites",kpp:""};
  if(!found.length)return {reason:"no_scoped_inn_kpp",kpp:""};
  if(found.some(x=>x.inn!==inn))return {reason:"inn_conflict",kpp:""};
  const distinct=new Set(found.map(x=>x.kpp));
  if(distinct.size!==1)return {reason:"kpp_ambiguous",kpp:""};
  return {reason:"unique_requisite_pair",kpp:[...distinct][0]};
}
export function selectSabyInnCandidate(rows,inn,expectedName) {
  const result=auditSelectSearchResult(rows,inn,expectedName);
  // Ambiguity is never resolved by first hit / source-name similarity.
  return {
    row:result.row||null,reason:result.kind,
    count:result.count
  };
}
export function acceptSabyPublicIdentityFallback({
  expectedInn,expectedName,privateRoute,cardAssessment,
  privateText,privateHeadings,publicResult
}) {
  const reject=(reason)=>({ok:false,reason,
    identity:null});
  const inn=sabyInn(expectedInn);
  if(!inn||!sabyNameTokens(expectedName).length)return reject("invalid_identity");
  if(sabyCardRoute(privateRoute)!=="detail")return reject("not_detail_page");
  if(cardAssessment?.reason!=="legal_name_not_verified" ||
     cardAssessment?.detail?.hasScopedInn!==true)
    return reject("private_inn_not_scoped");
  const pair=extractSabyDetailRequisitePair(privateText,inn);
  if(!pair.kpp)return reject(pair.reason);
  if(!publicResult)return reject("public_verification_not_available");
  if(publicResult.status!=="verified" ||
     publicResult.official_inn!==inn ||
     publicResult.official_kpp!==pair.kpp ||
     !publicResult.official_name)
    return reject("public_identity_unverified");
  // A public registered name can prove the source company, while public
  // short title identifies how Saby displays the same registered entity.
  // The private detail heading MUST be independently tied to one of them.
  const titles=(Array.isArray(privateHeadings)?privateHeadings:[])
    .map(x=>String(x||"").trim()).filter(Boolean).slice(0,18);
  const publicName=String(publicResult.public_short_name||"");
  const registered=String(publicResult.official_name||"");
  const privateName=titles.find(x=>
    (publicName&&sabyNameMatches(x,publicName)) ||
    sabyNameMatches(x,registered));
  if(!privateName)return reject("private_public_name_disconnected");
  return {
    ok:true,reason:"registered_alias_verified",
    identity:{
      inn,name:expectedName,verified:true,
      registered_name:registered,
      public_title:publicName,
      kpp:pair.kpp,
      verification:"registered_public_requisites"
    }
  };
}
export function safeSabyAliasDiagnostic(outcome) {
  return {
    reason:String(outcome?.reason||"unknown").slice(0,64),
    accepted:outcome?.ok===true
  };
}
export async function verifySabyPublicNameFallback(page,inn,name,
  cardAssessment,{verifyPublic=verifyPublicSabyIdentity}={}) {
  const route=typeof page?.url==="function"?page.url():"";
  if(sabyCardRoute(route)!=="detail" ||
     cardAssessment?.reason!=="legal_name_not_verified" ||
     cardAssessment?.detail?.hasScopedInn!==true)
    return {ok:false,reason:"private_inn_not_scoped"};
  let snapshot;
  try {
    snapshot=await page.evaluate(()=>{
      const visible=e=>{
        const r=e.getBoundingClientRect(),s=getComputedStyle(e);
        return r.width>0&&r.height>0&&s.visibility!=="hidden"&&s.display!=="none";
      };
      const headings=[...document.querySelectorAll(
        'h1,h2,[role="heading"],[class*="companyName" i],' +
        '[class*="company-name" i]'
      )].filter(visible).slice(0,70).map(x=>
        String(x.innerText||"").replace(/\s+/g," ").trim())
        .filter(x=>x.length>=3&&x.length<=200).slice(0,18);
      return {text:String(document.body?.innerText||"").slice(0,150000),
        headings};
    });
  } catch {
    return {ok:false,reason:"private_dom_unavailable"};
  }
  const pair=extractSabyDetailRequisitePair(snapshot?.text,inn);
  if(!pair.kpp)return {ok:false,reason:pair.reason};
  const publicResult=await verifyPublic(page,inn,pair.kpp,name);
  return acceptSabyPublicIdentityFallback({
    expectedInn:inn,expectedName:name,privateRoute:route,
    cardAssessment,privateText:snapshot.text,
    privateHeadings:snapshot.headings,publicResult
  });
}
