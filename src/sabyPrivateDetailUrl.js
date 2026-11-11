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

/**
 * Read-only, value-free URL change telemetry for experimental Saby smoke.
 * Counts are intentionally aggregated: never log key names, URL values,
 * company IDs, INNs, credential fragments, or full URLs.
 * This diagnostic MUST NOT be used to authorize a private route change.
 */
export function summarizeSabyPrivateRouteDelta(initialUrl,currentUrl) {
  const before=safeDetail(initialUrl),after=safeDetail(currentUrl);
  if(!before || !after || before.origin!==after.origin ||
     before.pathname!==after.pathname)
    return {status:"not_comparable"};
  const counts={
    status:"observed",non_ui_added:0,non_ui_removed:0,
    non_ui_values_changed:0,ui_values_changed:0
  };
  const keys=new Set([
    ...before.searchParams.keys(),...after.searchParams.keys()
  ]);
  for(const key of keys) {
    const oldValues=values(before,key),newValues=values(after,key);
    if(sameValues(oldValues,newValues))continue;
    if(UI_QUERY_KEYS.has(key)) {
      counts.ui_values_changed++;
    } else if(!oldValues.length) {
      counts.non_ui_added++;
    } else if(!newValues.length) {
      counts.non_ui_removed++;
    } else {
      counts.non_ui_values_changed++;
    }
  }
  for(const key of [
    "non_ui_added","non_ui_removed","non_ui_values_changed","ui_values_changed"
  ]) counts[key]=Math.min(counts[key],64);
  return counts;
}
