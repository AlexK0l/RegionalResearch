// Public first-party Saby company-profile verification using an ALREADY
// OBSERVED INN/KPP. A Saby display title alone is not legal identity proof.
//
// This read-only module never writes data back to Stage 12, the final XLSX,
// the checkpoint or the Saby authenticated account.
import {sabyInn,sabyNameMatches} from "./sabyEnrichment.js";
import {auditLegalForm} from "./sabyIdentityAudit.js";

const compact=s=>String(s??"").normalize("NFKC")
  .replace(/\s+/g," ").trim();
const linesOf=text=>String(text??"").slice(0,200000)
  .split(/[\r\n]+/).map(compact).filter(Boolean);
const isKpp=s=>/^\d{9}$/.test(String(s||""));
const legalName=s=>{
  const value=compact(s);
  return value.length>=4 && value.length<=260 &&
    /[а-яa-z]/iu.test(value) &&
    !/@|(?:\+7|8)\s*[\s(.-]?\d{3}|(?:^|\s)(?:контакты|телефон|электронная почта)(?:\s|$)/iu.test(value);
};
export function sabyPublicProfileRoute(rawInn,rawKpp) {
  const inn=sabyInn(rawInn),kpp=String(rawKpp||"").trim();
  return inn&&isKpp(kpp) ? "https://saby.ru/profile/"+inn+"-"+kpp : "";
}
export function canonicalSabyPublicRoute(url,expectedInn,expectedKpp) {
  const canonical=sabyPublicProfileRoute(expectedInn,expectedKpp);
  if(!canonical)return false;
  try {
    const u=new URL(String(url));
    return u.protocol==="https:" && u.hostname==="saby.ru" &&
      u.port==="" && !u.username && !u.password &&
      u.pathname===new URL(canonical).pathname;
  } catch {return false;}
}
function field(lines,from,to,labels) {
  for(let i=from;i<Math.min(to,lines.length);i++) {
    const line=lines[i];
    const marker=labels.some(label=>line===label);
    if(marker)return compact(lines[i+1]||"");
    for(const label of labels) {
      const match=new RegExp("^"+label+"\\s*[:：]\\s*(.+)$","iu").exec(line);
      if(match)return compact(match[1]);
    }
  }
  return "";
}
/**
 * Only a true 'Реквизиты' heading directly followed by 'Название' counts:
 * stray page navigation, 'О компании', about text, related organisations,
 * mentions in news or links cannot establish registered legal title.
 */
export function extractSabyPublicRequisites(text) {
  const lines=linesOf(text),found=new Map();
  for(let i=0;i<lines.length;i++){
    if(lines[i]!=="Реквизиты")continue;
    // The registered-name field must be the very FIRST field after the
    // heading. A navigation link 'Реквизиты' near an 'О компании' summary
    // is not the actual registered requisites section.
    const maxName=Math.min(i+2,lines.length);
    const name=field(lines,i+1,maxName,[
      "Название","Полное название","Полное наименование",
      "Наименование организации","Юридическое наименование"
    ]);
    if(!legalName(name))continue;
    // The requisites block must include both LABELLED INN and KPP, in a
    // narrow range after the title, never a number scraped elsewhere.
    const from=i+2;
    let to=Math.min(i+26,lines.length);
    for(let j=from;j<to;j++){
      if(/^(?:Контакты|О компании|Владельцы|Связанные компании|Автопарк компании|Реквизиты|Лицензии)$/iu.test(lines[j])) {
        to=j;break;
      }
    }
    const inn=field(lines,from,to,["ИНН"]);
    const kpp=field(lines,from,to,["КПП"]);
    const ogrn=field(lines,from,to,["ОГРН"]);
    if(!sabyInn(inn)||!isKpp(kpp))continue;
    const candidate={
      name,inn,kpp,ogrn:/^(?:\d{13}|\d{15})$/.test(ogrn)?ogrn:""
    };
    found.set(JSON.stringify(candidate),candidate);
  }
  return [...found.values()].slice(0,12);
}
export function compareSabyPublicRequisites({
  expectedInn,expectedKpp,expectedName,publicTitle,records,url
}) {
  const result={
    status:"review",reason:"requisites_unavailable",
    official_name:"",public_short_name:compact(publicTitle).slice(0,220),
    official_inn:"",official_kpp:"",official_ogrn:"",
    match_type:"",source_inn:sabyInn(expectedInn)
  };
  if(!canonicalSabyPublicRoute(url,expectedInn,expectedKpp)){
    result.reason="public_route_untrusted";return result;
  }
  const all=Array.isArray(records)?records:[];
  if(!all.length)return result;
  const exact=all.filter(x=>x.inn===sabyInn(expectedInn) &&
    x.kpp===String(expectedKpp));
  if(exact.length!==1 || all.some(x=>x.inn!==sabyInn(expectedInn) ||
      x.kpp!==String(expectedKpp))) {
    result.reason=exact.length>1?"ambiguous_requisites":"inn_kpp_conflict";
    return result;
  }
  const req=exact[0];
  result.official_name=req.name;
  result.official_inn=req.inn;
  result.official_kpp=req.kpp;
  result.official_ogrn=req.ogrn||"";
  const formA=auditLegalForm(expectedName);
  const formB=auditLegalForm(req.name);
  if(formA&&formB&&formA!==formB){
    result.reason="legal_form_conflict";return result;
  }
  if(sabyNameMatches(expectedName,req.name)){
    result.status="verified";
    result.reason="exact_registered_name_and_inn_kpp";
    result.match_type="registered_full_name";
  } else if(sabyNameMatches(expectedName,publicTitle)){
    // The short header and full legal title are linked by one exact
    // Saby INN+KPP requisites record, not by guessed abbreviation.
    result.status="verified";
    result.reason="same_public_profile_short_and_registered_name";
    result.match_type="short_title_registered_alias";
  } else {
    result.reason="name_not_matched_to_registered_entity";
  }
  return result;
}

/** Read a canonical public profile in a separate tab, preserve original tab.
 * Return only allowlisted fields; never persist HTML, page text, cookies,
 * contact details, or remote addresses.
 */
export async function verifyPublicSabyIdentity(page,inn,kpp,sourceName,{
  timeoutMs=14000
}={}) {
  const url=sabyPublicProfileRoute(inn,kpp);
  if(!url||!sourceName)return {status:"review",reason:"invalid_request"};
  if(typeof page?.context!=="function")
    return {status:"review",reason:"browser_context_unavailable"};
  let tab;
  try {
    tab=await page.context().newPage();
    await tab.goto(url,{
      waitUntil:"domcontentloaded",timeout:Math.min(20000,timeoutMs)
    });
    if(!canonicalSabyPublicRoute(tab.url(),inn,kpp))
      return {status:"review",reason:"public_route_untrusted"};
    let observation;
    for(let attempt=0;attempt<4;attempt++){
      observation=await tab.evaluate(()=>{
        const short=String(
          document.querySelector("h1")?.innerText||"").trim().slice(0,220);
        // Raw body text is confined to the browser page and transient
        // parsing; never logged, returned or saved.
        return {
          title:short,
          body:String(document.body?.innerText||"").slice(0,200000)
        };
      });
      const records=extractSabyPublicRequisites(observation.body);
      const assessment=compareSabyPublicRequisites({
        expectedInn:inn,expectedKpp:kpp,expectedName:sourceName,
        publicTitle:observation.title,records,url:tab.url()
      });
      if(records.length || attempt===3)return assessment;
      await tab.waitForTimeout(650);
    }
    return {status:"review",reason:"requisites_unavailable"};
  } catch {
    return {status:"review",reason:"public_page_unavailable"};
  } finally {
    if(tab)await tab.close().catch(()=>{});
  }
}
