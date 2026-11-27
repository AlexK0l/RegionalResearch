// Optional optimization of UI navigation, never an identity proof.
// Each entry is one-use, scoped to the exact browser Page and verified
// detail route. No direct/private API calls, no persistent URLs or cache.
import {sabyCardRoute} from "./sabyCard.js";
import {safeSabyNavigationUrl} from "./sabyVisitPolicy.js";

export const SABY_CATALOG_URL="https://profile.saby.ru/page/company-list-prof";
const origins=new WeakMap();
function listUrl(raw){
  try{
    const u=new URL(String(raw||""));
    return u.origin==="https://profile.saby.ru"&&!u.username&&!u.password&&
      u.pathname==="/page/company-list-prof"&&!u.search&&!u.hash?u.href:null;
  }catch{return null;}
}
export function rememberSabyCatalogOrigin(page,origin,verifiedDetail){
  origins.delete(page);
  const listing=listUrl(origin),detail=safeSabyNavigationUrl(verifiedDetail);
  if(!listing||!detail||page.url()!==verifiedDetail||sabyCardRoute(detail)!=="detail")return false;
  origins.set(page,{listing,detail});
  return true;
}
export function forgetSabyCatalogOrigin(page){origins.delete(page);}

export async function openSabyCatalog(page,{reuse=false,timeoutMs=45000}={}){
  const prior=origins.get(page);
  origins.delete(page);
  // Exact current verified URL only. Section overlays, alias transitions,
  // foreign pages and saved-card routes fall back to normal navigation.
  const canReuse=reuse===true&&prior&&page.url()===prior.detail&&
    typeof page.goBack==="function";
  if(canReuse){
    try{
      await page.goBack({waitUntil:"commit",timeout:Math.min(2500,timeoutMs)});
      if(page.url()===prior.listing)
        return {historyAttempted:true,historyHit:true};
    }catch{/* Always fall back before submitting any INN. */}
  }
  await page.goto(SABY_CATALOG_URL,{waitUntil:"commit",timeout:timeoutMs});
  return {historyAttempted:Boolean(canReuse),historyHit:false};
}
