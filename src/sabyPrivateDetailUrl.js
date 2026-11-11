// Classify first-party Saby SPA URL updates without accepting a change of
// company identity. This helper is used ONLY in the opt-in registered-alias
// verifier. It never returns URL text, query values or credentials.
import {sabyCardRoute} from "./sabyCard.js";

// UI navigation params already occur on legitimate Saby contractor-info
// routes, e.g. ?anchor=about&tab=all&page=public. Everything else must
// remain exactly the same, including any opaque contractor identifiers.
const UI_QUERY_KEYS=new Set([
  "anchor","tab","page","section","subtab","view","panel","mode"
]);
const UI_FRAGMENTS=new Set([
  "about","requisites","contacts","contact","all","info",
  "fleet","transport"
]);
function safeDetail(url) {
  try {
    const u=new URL(String(url||""));
    if(sabyCardRoute(u.href)!=="detail")return null;
    if(u.username||u.password)return null;
    return u;
  } catch {return null;}
}
const values=(url,key)=>url.searchParams.getAll(key).slice().sort();
const sameValues=(a,b)=>a.length===b.length &&
  a.every((value,i)=>value===b[i]);
function uiFragment(value) {
  if(!value)return true;
  let fragment;
  try {fragment=decodeURIComponent(value.slice(1)).toLowerCase();}
  catch {return false;}
  return UI_FRAGMENTS.has(fragment);
}

/**
 * Only the same HTTPS profile.saby.ru contractor-info path may remain
 * under observation. Known UI query fields and known navigation fragment
 * names can vary. Unknown fields, IDs, INN, KPP, nested state and new
 * contractor-info path segments are all fail-closed. Even a safe URL
 * change is NOT proof of legal identity: private labelled INN/KPP and
 * canonical public registered name+INN/KPP are still required.
 */
export function compareSabyPrivateDetailUrl(initialUrl,currentUrl) {
  const before=safeDetail(initialUrl),after=safeDetail(currentUrl);
  if(!before || !after)
    return {ok:false,reason:"not_same_first_party_detail"};
  if(before.origin!==after.origin)
    return {ok:false,reason:"origin_changed"};
  if(before.pathname!==after.pathname)
    return {ok:false,reason:"detail_path_changed"};
  const keys=new Set([
    ...before.searchParams.keys(),...after.searchParams.keys()
  ]);
  let uiParamsChanged=0;
  for(const key of keys) {
    if(sameValues(values(before,key),values(after,key)))continue;
    if(!UI_QUERY_KEYS.has(key))
      return {ok:false,reason:"non_ui_query_changed"};
    uiParamsChanged++;
  }
  if(before.hash!==after.hash &&
     (!uiFragment(before.hash)||!uiFragment(after.hash)))
    return {ok:false,reason:"non_ui_fragment_changed"};
  const fragmentChanged=before.hash!==after.hash;
  return {
    ok:true,
    reason:uiParamsChanged||fragmentChanged?"ui_navigation_only":"same_detail",
    ui_params_changed:uiParamsChanged,
    fragment_changed:fragmentChanged
  };
}
