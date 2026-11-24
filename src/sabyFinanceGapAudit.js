// Aggregate ONLY: no company names, INNs, KPPs or URLs in output.
// Never fetch Saby or re-open a legal card. A saved card URL is a hint,
// not proof of the currently registered company.
import {planSabyFinanceBackfill,FINANCE_REVIEW_MAX_PASSES}
  from "./sabyFinanceBackfill.js";
import {sabyInn} from "./sabyEnrichment.js";

// Stored checkpoint fields can originate from external UI. Never echo an
// arbitrary status, reason or browser exception into the operator report.
const knownStatuses=new Set([
  "updated","unchanged","missing","review","deferred","not_attempted"
]);
const knownReasons=new Set([
  "unspecified","search_zero_unconfirmed","search_loading_stalled",
  "saby_no_results","financial_not_verified",
  "card_legal_name_unverified","card_identity_unverified",
  "search_ambiguous","card_changed","collector_unavailable",
  "search_no_unique_result","card_render_timeout","browser_action_timeout",
  "search_scan_error","search_service_unavailable","search_input_failed",
  "search_confirmed_empty","identity_or_source",
  "stored_saby_inn_mismatch","stored_saby_card_mismatch",
  "legacy_review_unclassified"
]);
const knownBrowserErrors=new Set([
  "saby_search_unavailable","saby_search_canary_unverified",
  "saby_search_canary_unavailable","saby_review_canary_unverified",
  "saby_consecutive_unverified_cards","saby_consecutive_loading_stalls",
  "saby_browser_unavailable"
]);
const safeCode=(value,allowlist,fallback)=>
  allowlist.has(String(value||""))?String(value):fallback;

function savedCardHint(row,inn){
  const e=row?.__evidence?.saby;
  if(sabyInn(e?.inn)!==inn)return {card:false,kpp:false};
  try{
    const url=new URL(String(e?.source_url||""));
    const id=url.searchParams.get("id")||"";
    const card=url.protocol==="https:"&&
      url.hostname==="profile.saby.ru"&&
      !url.username&&!url.password&&!url.port&&
      url.pathname==="/page/contractor-info"&&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(id);
    return {card,kpp:card&&/^\d{9}$/.test(String(e?.kpp||""))};
  }catch{return {card:false,kpp:false};}
}
function grouped(entries,outcomes,counts){
  const groups=new Map();
  let cardHints=0,kppHints=0;
  for(const e of entries){
    const o=outcomes[e.inn]||{};
    const key=safeCode(o.status||"not_attempted",
      knownStatuses,"unknown")+":"+
      safeCode(o.reason||"unspecified",knownReasons,"unclassified");
    groups.set(key,(groups.get(key)||0)+1);
    const hint=savedCardHint(e.row,e.inn);
    if(hint.card)cardHints++;
    if(hint.kpp)kppHints++;
  }
  return {
    count:entries.length,
    prior_review_attempts:entries.filter(e=>counts(e.inn)>0).length,
    saved_saby_card_hints:cardHints,
    saved_saby_card_with_kpp_hints:kppHints,
    by_reason:[...groups].map(([reason,count])=>({reason,count}))
      .sort((a,b)=>b.count-a.count||a.reason.localeCompare(b.reason))
  };
}
export function auditSabyFinanceGaps(checkpoint,{checkpointId=""}={}){
  if(!checkpoint?.final_result)
    throw Error("SABY_FINANCE_GAP_CHECKPOINT_REQUIRED");
  const plan=planSabyFinanceBackfill(checkpoint.final_result);
  const attempted=new Set((Array.isArray(
    checkpoint.saby_finance_backfill_attempted_inns)?
    checkpoint.saby_finance_backfill_attempted_inns:[])
    .map(sabyInn).filter(Boolean));
  const review=checkpoint.saby_finance_backfill_review_attempts||{};
  const counts=inn=>{
    const n=Number(review[inn]||0);
    return Number.isSafeInteger(n)?
      Math.max(0,Math.min(FINANCE_REVIEW_MAX_PASSES,n)):0;
  };
  const outcomes=checkpoint.saby_finance_backfill_outcomes||{};
  const pending=[],exhausted=[],attemptedMissing=[];
  for(const e of plan.eligible){
    if(attempted.has(e.inn))attemptedMissing.push(e);
    else if(counts(e.inn)>=FINANCE_REVIEW_MAX_PASSES)
      exhausted.push(e);
    else pending.push(e);
  }
  const unobserved=pending.filter(e=>
    !Object.hasOwn(outcomes,e.inn));
  const old=checkpoint.saby_finance_backfill_stats||{};
  return {
    checkpoint:checkpointId,
    source_mode:String(checkpoint.source_mode||""),
    phase:String(checkpoint.phase||""),
    region:String(checkpoint.region||""),
    commercial_rows:plan.total,
    finance_gaps:{
      revenue_missing:plan.missingRevenue,
      employees_missing:plan.missingEmployees,
      eligible_unique_inn:plan.eligible.length,
      excluded_invalid:plan.invalid,
      excluded_duplicate_inn:plan.duplicate,
      already_complete:plan.alreadyComplete
    },
    attempted_missing_finance:attemptedMissing.length,
    pending:grouped(pending,outcomes,counts),
    exhausted:grouped(exhausted,outcomes,counts),
    pending_never_observed:unobserved.length,
    latest_pass:{
      processed:Number(old.processed||0),
      revenue_added:Number(old.revenueAdded||0),
      employees_added:Number(old.employeesAdded||0),
      search_unconfirmed:Number(old.unconfirmedSearches||0),
      canary_checks:Number(old.canaryChecks||0),
      canary_passed:Number(old.canaryPassed||0),
      browser_error:old.browserError?
        safeCode(old.browserError,knownBrowserErrors,"unclassified"):""
    }
  };
}
