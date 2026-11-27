// Reuse only browser-observed catalog/detail history, not guessed routes
// or a second persistent tab. Navigation hints NEVER establish ownership.
import {sabyCardRoute} from "./sabyCard.js";
import {safeSabyNavigationUrl} from "./sabyVisitPolicy.js";
import {compareSabyVerifiedFleetDetail} from "./sabyFleetRouteContinuity.js";

export const SABY_CATALOG_URL="https://profile.saby.ru/page/company-list-prof";
const origins=new WeakMap(),misses=new WeakMap();
const MAX_MISSES=3;
function listUrl(raw){
  try{
    const u=new URL(String(raw||""));
    return u.origin==="https://profile.saby.ru"&&!u.username&&!u.password&&
      u.pathname==="/page/company-list-prof"&&!u.search&&!u.hash?u.href:null;
  }catch{return null;}
}
// Known local=false is a NAVIGATION allowlist value only. Do not extend
// private-card identity/section route-continuity policy.
function sameHistoryCard(a,b){
  const first=safeSabyNavigationUrl(a),last=safeSabyNavigationUrl(b);
  if(!first||!last)return false;
  const x=new URL(first),y=new URL(last);
  x.searchParams.delete("local");y.searchParams.delete("local");
  return compareSabyVerifiedFleetDetail(x.href,y.href).ok;
}
export function rememberSabyCatalogOrigin(page,origin,verifiedDetail){
  origins.delete(page);
  const listing=listUrl(origin),detail=safeSabyNavigationUrl(verifiedDetail);
  if(!listing||!detail||page.url()!==verifiedDetail||sabyCardRoute(detail)!=="detail")return false;
  origins.set(page,{listing,detail});
  return true;
}
export function rememberSabyEmptyCatalog(page){
  const listing=listUrl(page.url());
  if(!listing)return false;
  origins.set(page,{listing,empty:true});
  return true;
}
export function forgetSabyCatalogOrigin(page){origins.delete(page);}
export function noteSabyCatalogColdFallback(page){
  misses.set(page,Math.min(MAX_MISSES,(misses.get(page)||0)+1));
}
export async function openSabyCatalog(page,{reuse=false,timeoutMs=45000}={}){
  const prior=origins.get(page);
  origins.delete(page);
  const permitted=reuse===true&&(misses.get(page)||0)<MAX_MISSES;
  if(permitted&&prior?.empty&&page.url()===prior.listing)
    return {historyAttempted:true,historyHit:true};
  const canReuse=permitted&&prior?.detail&&sameHistoryCard(prior.detail,page.url())&&
    typeof page.goBack==="function";
  if(canReuse){
    const until=Date.now()+Math.min(2500,timeoutMs);
    try{
      // One history entry for the clicked card, plus at most one known
      // UI-only entry created by contact/finance/fleet navigation.
      for(let hop=0;hop<2&&Date.now()<until;hop++){
        const before=page.url();
        await page.goBack({waitUntil:"commit",timeout:Math.max(1,until-Date.now())});
        const current=page.url();
        if(current===prior.listing)return {historyAttempted:true,historyHit:true};
        if(current===before||!sameHistoryCard(prior.detail,current))break;
      }
    }catch{/* Cold fallback before submitting any new query. */}
    noteSabyCatalogColdFallback(page);
  }
  await page.goto(SABY_CATALOG_URL,{waitUntil:"commit",timeout:timeoutMs});
  return {historyAttempted:Boolean(canReuse),historyHit:false};
}
