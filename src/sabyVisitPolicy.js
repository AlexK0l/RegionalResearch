// Pure Stage12 scheduling helpers. A fast read is never an attempted
// full-detail sweep, nor is a saved private route proof of fresh ownership.
import {sabyInn,sabyNameMatches} from "./sabyEnrichment.js";
export const SABY_FAST_STRATEGY="combined_visible_v1";
export const SABY_LEGACY_STRATEGY="section_passes_v1";
export const SABY_ALL_FLEETS_SCOPE="all_commercial_v1";
export const SABY_DIRECT_FLEETS_SCOPE="direct_buyers_v1";

export function validSabyPassCursor(raw){
  return raw?.version===1&&Array.isArray(raw.planned_inns)&&Array.isArray(raw.attempted);
}
// Pin the set of required fleet sections when the sweep is planned.
// Upgrading a running old sweep never silently reinterprets an attempted
// intermediary/lease task as a completed fleet task.
export function sabyFleetScope(env,raw){
  if(validSabyPassCursor(raw))
    return raw.fleet_scope===SABY_ALL_FLEETS_SCOPE?
      SABY_ALL_FLEETS_SCOPE:SABY_DIRECT_FLEETS_SCOPE;
  return String(env?.SABY_ALL_COMPANY_FLEETS_ENABLED??"true").toLowerCase()==="false"?
    SABY_DIRECT_FLEETS_SCOPE:SABY_ALL_FLEETS_SCOPE;
}
export function sabyVisitStrategy(env,raw){
  // The old v1 cursor already counts section attempts. Keep its scheduling
  // semantics for the remainder of that sweep, including after a restart.
  if(validSabyPassCursor(raw))
    return raw.strategy===SABY_FAST_STRATEGY?SABY_FAST_STRATEGY:SABY_LEGACY_STRATEGY;
  return String(env?.SABY_FAST_PASS_ENABLED??"true").toLowerCase()==="false"?
    SABY_LEGACY_STRATEGY:SABY_FAST_STRATEGY;
}
// Only observed first-party contractor detail URLs with a single UUID and
// known UI navigation fields. Never retain arbitrary query credentials,
// fragments, duplicate keys or guessed card IDs as navigation hints.
export function safeSabyNavigationUrl(raw){
  try{
    const u=new URL(String(raw||""));
    if(u.origin!=="https://profile.saby.ru"||u.username||u.password||
      u.pathname!=="/page/contractor-info"||u.hash&&
      !/^#(?:about|requisites|contacts|contact|all|info|fleet|transport)$/i.test(u.hash))return null;
    if(u.searchParams.getAll("id").length!==1||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(u.searchParams.get("id")))return null;
    for(const [key,value] of u.searchParams){
      if(u.searchParams.getAll(key).length!==1)return null;
      if(key==="id")continue;
      if(key==="source"&&value==="internal")continue;
      if(!["anchor","tab","page","section","subtab","view","panel","mode"].includes(key)||
        !/^[a-z0-9_-]{1,64}$/i.test(value))return null;
    }
    return u.href;
  }catch{return null;}
}
export function rememberSabyNavigationHint(row,record){
  const inn=sabyInn(row?.["ИНН"]),name=String(row?.["Организация"]||"").trim(),
    url=safeSabyNavigationUrl(record?.source_url);
  if(!inn||!name||!url||record?.identity?.verified!==true||
    sabyInn(record.identity.inn)!==inn||!sabyNameMatches(name,record.identity.name)||
    !Number.isFinite(Date.parse(record.collected_at)))return false;
  const e=row.__evidence||{},stored=e.saby;
  // Do not let a new route hint displace a different previously verified
  // private card for this INN. The full exact-INN search remains available.
  const oldUrl=safeSabyNavigationUrl(stored?.source_url);
  if(stored?.inn===inn&&oldUrl&&
    new URL(oldUrl).searchParams.get("id")!==new URL(url).searchParams.get("id"))return false;
  const kpp=String(record.identity.kpp||"");
  if(stored?.inn===inn&&stored.kpp&&kpp&&stored.kpp!==kpp)return false;
  const hint={inn,name,source_url:url,verified_at:record.collected_at,
    ...( /^\d{9}$/.test(kpp)?{kpp}:{})};
  if(JSON.stringify(e.saby_navigation_hint)===JSON.stringify(hint))return false;
  row.__evidence={...e,saby_navigation_hint:hint};
  return true;
}
export function storedSabyNavigationHint(row){
  const h=row?.__evidence?.saby_navigation_hint,inn=sabyInn(row?.["ИНН"]);
  if(!inn||h?.inn!==inn||h.name!==String(row?.["Организация"]||"").trim()||
    !Number.isFinite(Date.parse(h.verified_at)))return null;
  const url=safeSabyNavigationUrl(h.source_url),stored=row.__evidence?.saby,
    prior=safeSabyNavigationUrl(stored?.source_url);
  if(!url)return null;
  if(stored?.inn===inn&&prior&&new URL(prior).searchParams.get("id")!==new URL(url).searchParams.get("id"))return null;
  if(stored?.inn===inn&&stored.kpp&&h.kpp&&stored.kpp!==h.kpp)return null;
  return url;
}
export function createSabyAdaptiveDelay(base,env={}){
  // Keep production pacing unchanged unless explicitly opted in after
  // inspecting live timings. Never lower the configured floor.
  const enabled=String(env.SABY_ADAPTIVE_DELAY_ENABLED||"false").toLowerCase()==="true";
  const raw=Number(env.SABY_ADAPTIVE_DELAY_MIN_MS??1000);
  const floor=Math.min(base,Number.isFinite(raw)?Math.max(750,Math.floor(raw)):1000);
  let stable=0;
  return {next({success=false,systemic=false,elapsedMs=0}={}){
    if(!enabled)return base;
    if(systemic){stable=0;return Math.min(30000,base*2);}
    if(!success||elapsedMs>12000){stable=0;return base;}
    stable++;
    return stable>=4?floor:base;
  }};
}
const KEYS=["visit_ms","saved_card_ms","search_card_ms","search_ms","identity_ms",
  "ready_ms","contacts_ms","financials_ms","fleet_ms","checkpoint_ms","delay_ms",
  "session_open_ms","session_close_ms","admission_ms"];
const count=n=>Number.isSafeInteger(n)&&n>=0?Math.min(n,Number.MAX_SAFE_INTEGER):0;
export function restoreSabyTiming(raw){
  return {visits:count(raw?.visits),timed_visits:count(raw?.timed_visits),
    saved_card_hits:count(raw?.saved_card_hits),saved_card_misses:count(raw?.saved_card_misses),
    full_searches:count(raw?.full_searches),quick_finance_filled:count(raw?.quick_finance_filled),
    quick_fleet_completed:count(raw?.quick_fleet_completed),
    ...Object.fromEntries(KEYS.map(k=>[k,count(raw?.[k])]))};
}
export function sabyAddTiming(target,key,ms){
  if(!KEYS.includes(key)||!Number.isFinite(ms)||ms<0)return;
  target[key]=Math.min(Number.MAX_SAFE_INTEGER,count(target[key])+Math.round(ms));
}
export function recordSabyVisitTiming(target,record,ms){
  target.visits++;
  sabyAddTiming(target,"visit_ms",ms);
  const t=record?.timing;
  if(!t||typeof t!=="object")return;
  target.timed_visits++;
  for(const key of KEYS)if(!["visit_ms","checkpoint_ms","delay_ms","session_open_ms","session_close_ms","admission_ms"].includes(key))
    sabyAddTiming(target,key,t[key]);
  if(t.saved_card==="hit")target.saved_card_hits++;
  if(t.saved_card==="miss")target.saved_card_misses++;
  if(t.full_search===true)target.full_searches++;
}
