// Resolve a Saby public profile route by INN only, without inventing a KPP,
// using Saby's own public company search. This is a *candidate discovery*
// path, not identity proof: registered requisites must still match exact
// INN, KPP and the full expected legal name before any enrichment is applied.
import {sabyInn} from "./sabyEnrichment.js";
import {findSabyCompanySearch} from "./sabySearch.js";

const ROOT="https://saby.ru/profile";
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function sabyPublicProfileCandidate(raw,expectedInn) {
  const inn=sabyInn(expectedInn);
  if(!inn)return null;
  try {
    const url=new URL(raw);
    if(url.protocol!=="https:" || url.hostname!=="saby.ru" ||
       url.username || url.password || url.port)return null;
    const matched=/^\/profile\/(\d{10}|\d{12})-(\d{9})\/?$/.exec(url.pathname);
    if(matched?.[1]!==inn)return null;
    return {url:ROOT+"/"+inn+"-"+matched[2],kpp:matched[2]};
  } catch {return null;}
}

export function chooseSabyPublicProfile(urls,expectedInn) {
  const choices=new Map();
  for(const input of Array.isArray(urls)?urls:[]){
    const candidate=sabyPublicProfileCandidate(input,expectedInn);
    if(candidate)choices.set(candidate.kpp,candidate);
  }
  const all=[...choices.values()];
  return {
    status:all.length===1?"unique":all.length?"ambiguous":"missing",
    candidate:all.length===1?all[0]:null,
    count:all.length
  };
}

/**
 * Visit Saby's first-party public landing page, enter the same exact INN,
 * then inspect canonical /profile/{INN}-{KPP} links or resulting navigation.
 * Never read company names/contact data from search results; no third-party
 * search engine, paid API, or raw DOM/log persistence. Only safe counters.
 */
export async function discoverSabyPublicProfileByInn(
  page,expectedInn,{timeoutMs=12000}={}
) {
  const inn=sabyInn(expectedInn);
  if(!inn || typeof page?.context!=="function")
    return {status:"invalid_request",candidate:null,count:0};
  const duration=Math.max(3000,Math.min(18000,Number(timeoutMs)||12000));
  let tab;
  try {
    tab=await page.context().newPage();
    await tab.goto(ROOT,{waitUntil:"domcontentloaded",timeout:duration});
    let u=new URL(tab.url());
    if(u.protocol!=="https:" || u.hostname!=="saby.ru")
      return {status:"untrusted_search_origin",candidate:null,count:0};
    const field=await findSabyCompanySearch(tab,{
      timeoutMs:Math.min(6000,duration)
    });
    if(!field.field)
      return {status:"search_field_missing",candidate:null,count:0};
    await field.field.fill(inn);
    // Suggestions may render asynchronously; Enter can also navigate to
    // the relevant public result list. Check both before and after Enter.
    await pause(550);
    let selected=chooseSabyPublicProfile(
      await sabyPublicCandidates(tab),inn);
    if(selected.status==="unique" || selected.status==="ambiguous")
      return selected;
    await field.field.press("Enter");
    const until=Date.now()+Math.max(2500,duration-3000);
    do {
      selected=chooseSabyPublicProfile(await sabyPublicCandidates(tab),inn);
      if(selected.status!=="missing")return selected;
      await pause(500);
    } while(Date.now()<until);
    return selected;
  } catch {
    return {status:"public_search_unavailable",candidate:null,count:0};
  } finally {
    if(tab)await tab.close().catch(()=>{});
  }
}

async function sabyPublicCandidates(tab) {
  // Refuse links on a redirected third-party page. Return only hrefs and
  // the current route; selection afterwards is strict first-party.
  let current;
  try {
    current=new URL(tab.url());
    if(current.hostname!=="saby.ru" || current.protocol!=="https:")
      return [];
  } catch {return [];}
  const hrefs=await tab.evaluate(()=>{
    return [...document.querySelectorAll("a[href]")]
      .slice(0,300).map(a=>a.href).filter(Boolean);
  }).catch(()=>[]);
  return [current.href,...hrefs];
}
