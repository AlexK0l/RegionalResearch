// Strict first-party legal-name verification using the actual Saby requisites.
// A short Saby display name is NOT enough to accept an unrelated company.
// The same exact INN/KPP and full legal name must appear in the registered
// requisites section of a Saby page. No manual name-to-alias mapping.
import {sabyInn, sabyNameMatches} from "./sabyEnrichment.js";

const clean=s=>String(s||"").replace(/\s+/g," ").trim();
const linesOf=text=>String(text||"").slice(0,130000).split(/[\r\n]+/)
  .map(clean).filter(Boolean);
const digits=(value,len)=>new RegExp("^\\d{"+len+"}$").test(String(value||""));
const kppValid=kpp=>digits(kpp,9);

export function sabyPublicCompanyUrl(inn,kpp) {
  const i=sabyInn(inn),k=String(kpp||"");
  return i&&kppValid(k) ? "https://saby.ru/profile/"+i+"-"+k : "";
}

// Extract a KPP ONLY when labelled next to the exact matching INN.
// A guessed or unlabelled nine-digit value is not proof of identity.
export function sabyKppFromCardText(text,expectedInn) {
  const inn=sabyInn(expectedInn);
  if(!inn)return "";
  const lines=linesOf(text);
  const matches=new Set();
  for(let i=0;i<lines.length;i++) {
    const line=lines[i];
    const sameLine=line.match(/ИНН\s*[/\\]\s*КПП\s*[:№#—-]?\s*(\d{10}|\d{12})\s*[/\\]\s*(\d{9})/i);
    if(sameLine?.[1]===inn)matches.add(sameLine[2]);
    const marker=/^ИНН(?:\s*[:№#—-])?$/i.test(line) ||
      /^ИНН\s*[/\\]\s*КПП(?:\s*[:№#—-])?$/i.test(line);
    if(!marker)continue;
    const first=lines[i+1]||"";
    const combined=first.match(/^(\d{10}|\d{12})\s*[/\\]\s*(\d{9})$/);
    if(combined?.[1]===inn)matches.add(combined[2]);
    if(first!==inn)continue;
    for(let j=i+2;j<Math.min(i+7,lines.length);j++) {
      if(/^КПП(?:\s*[:№#—-])?$/i.test(lines[j]) &&
         kppValid(lines[j+1]))matches.add(lines[j+1]);
      // Stop at the next organization's registration block.
      if(/^ИНН(?:\s*[:№#—-])?$/i.test(lines[j]))break;
    }
  }
  return matches.size===1?[...matches][0]:"";
}

export function sabyKppFromProfileLinks(urls,expectedInn) {
  const inn=sabyInn(expectedInn);
  if(!inn)return "";
  const found=new Set();
  for(const value of Array.isArray(urls)?urls:[]) {
    try {
      const url=new URL(value);
      if(url.protocol!=="https:"||url.hostname!=="saby.ru")continue;
      const match=/^\/profile\/(\d{10}|\d{12})-(\d{9})\/?$/.exec(url.pathname);
      if(match?.[1]===inn)found.add(match[2]);
    } catch { /* Ignore invalid or third-party URLs. */ }
  }
  return found.size===1?[...found][0]:"";
}

function fieldAfter(lines,start,end,label) {
  for(let j=start;j<Math.min(end,lines.length-1);j++){
    if(label.test(lines[j]))return lines[j+1];
  }
  return "";
}

/**
 * Match a structured "Реквизиты > Название > ИНН > КПП" record. Searching
 * arbitrary body text for a company's name would confuse linked companies
 * or historical mentions with the legal entity currently being inspected.
 * Returns the confirmed official name only; never a guessed abbreviation.
 */
export function sabyOfficialNameFromRequisites(text,expectedInn,expectedKpp,expectedName) {
  const inn=sabyInn(expectedInn),kpp=String(expectedKpp||"");
  if(!inn||!expectedName|| (kpp && !kppValid(kpp)))return "";
  const lines=linesOf(text);
  const matches=new Set();
  for(let i=0;i<lines.length;i++){
    if(!/^(?:Реквизиты|Регистрационные данные)$/i.test(lines[i]))continue;
    const to=Math.min(lines.length,i+48);
    for(let j=i+1;j<Math.min(to,i+15);j++){
      if(!/^(?:Название|Полное наименование|Полное название|Юридическое наименование|Наименование организации)$/i.test(lines[j]))
        continue;
      const name=lines[j+1]||"";
      if(name.length<5||name.length>240||
         !sabyNameMatches(expectedName,name))continue;
      const blockEnd=Math.min(to,j+35);
      const actualInn=fieldAfter(lines,j+2,blockEnd,/^ИНН$/i);
      const actualKpp=fieldAfter(lines,j+2,blockEnd,/^КПП$/i);
      if(actualInn!==inn || (kpp && actualKpp!==kpp))continue;
      matches.add(name);
    }
  }
  return matches.size===1?[...matches][0]:"";
}

/**
 * On an abbreviated profile.saby.ru detail, read Saby's first-party public
 * profile at the exact INN-KPP URL, without changing the original tab.
 * Only a structured requisites record with exact INN, KPP, and full legal
 * name may upgrade the name check. Never log source HTML, URL or credentials.
 */
export async function verifySabyPublicLegalName(
  page,inn,expectedName,{timeoutMs=13000}={}
) {
  const expectedInn=sabyInn(inn);
  if(!expectedInn||!expectedName)return {ok:false,reason:"invalid_expected_identity"};
  if(typeof page?.evaluate!=="function" || typeof page?.context!=="function")
    return {ok:false,reason:"browser_unavailable"};
  let kpp="";
  try {
    const hints=await page.evaluate(()=>{
      const body=String(document.body?.innerText||"").slice(0,45000);
      const links=[...document.querySelectorAll('a[href]')].slice(0,150)
        .map(link=>link.href).filter(Boolean);
      return {body,links};
    });
    const fromText=sabyKppFromCardText(hints?.body,expectedInn);
    const fromLink=sabyKppFromProfileLinks(hints?.links,expectedInn);
    if(fromText && fromLink && fromText!==fromLink)
      return {ok:false,reason:"ambiguous_kpp"};
    kpp=fromText||fromLink;
  } catch {return {ok:false,reason:"requisite_read_failed"};}
  const url=sabyPublicCompanyUrl(expectedInn,kpp);
  if(!url)return {ok:false,reason:"kpp_unavailable"};
  let publicPage;
  try {
    publicPage=await page.context().newPage();
    await publicPage.goto(url,{waitUntil:"domcontentloaded",timeout:Math.min(20000,timeoutMs)});
    const current=new URL(publicPage.url());
    if(current.protocol!=="https:"||current.hostname!=="saby.ru"||
       current.pathname!==new URL(url).pathname)
      return {ok:false,reason:"untrusted_public_route"};
    // Read short, first-party requisites evidence into memory only. Do not
    // print or persist it. A Saby page may hydrate its sections asynchronously.
    let verifiedName="";
    for(let attempt=0;attempt<3;attempt++){
      const text=await publicPage.evaluate(()=>
        String(document.body?.innerText||"").slice(0,130000));
      verifiedName=sabyOfficialNameFromRequisites(
        text,expectedInn,kpp,expectedName);
      if(verifiedName)break;
      if(attempt<2)await publicPage.waitForTimeout(500);
    }
    return verifiedName ?
      {ok:true,reason:"verified",verifiedName,proof:"saby_public_requisites"} :
      {ok:false,reason:"official_name_not_confirmed"};
  } catch {
    return {ok:false,reason:"public_profile_unavailable"};
  } finally {
    if(publicPage)await publicPage.close().catch(()=>{});
  }
}
