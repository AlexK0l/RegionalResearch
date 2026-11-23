// Supplemental Saby finance pass over a FINISHED, previously saved region.
//
// No company discovery, OpenAI, Google Sheets writes or fleet interaction.
// A brand-new SQLite child checkpoint receives the edits; the parent is
// immutable. Verified pre-Saby numbers and all contacts/fleet fields survive.
import {isSabyProfileUrl,sabyInn,sabyNameMatches,sabyNameTokens}
  from "./sabyEnrichment.js";
import {validSabyFinancialEvidence} from "./sabyFinancials.js";
import {withSabyBrowser,collectSabyFinancialsOnly} from "./sabyBrowser.js";

export const FINANCE_REVENUE_FIELD="Выручка последнего подтвержденного года";
export const FINANCE_EMPLOYEES_FIELD="Численность";
const SECTIONS=["direct_buyers","intermediaries","leasing"];
// One bounded in-session retry for temporary search/render failures. Failed
// identity checks never authorize financial data. A reviewed company may
// enter one later pass after the fresh/untested firms, then stays in review.
export const FINANCE_REVIEW_MAX_PASSES=2;
const TRANSIENT_SABY_CODES=new Set([
  "search_scan_error","search_no_unique_result","card_render_timeout",
  "browser_action_timeout"
]);
const NON_RETRYABLE_SABY_CODES=new Set([
  "search_ambiguous","card_changed","search_input_failed",
  "search_confirmed_empty","search_service_unavailable",
  "search_loading_stalled","search_zero_unconfirmed",
  "card_legal_name_unverified"
]);
export function classifySabyFinanceFailure(error){
  const code=String(error?.code||"");
  if(TRANSIENT_SABY_CODES.has(code))
    return {code,retryable:true};
  if(NON_RETRYABLE_SABY_CODES.has(code))
    return {code,retryable:false};
  if(error?.name==="TimeoutError")
    return {code:"browser_action_timeout",retryable:true};
  if(error?.scope==="company")
    return {code:"card_identity_unverified",retryable:false};
  return {code:"collector_unavailable",retryable:false};
}


// A known-good search health check can only use an ALREADY attempted firm
// with fresh, verified finance evidence from an earlier immutable checkpoint.
// It must exercise exact-INN Saby search, not skip it via a saved direct URL.
export function selectSabyFinanceSearchCanary(checkpoint){
  const attempted=new Set(
    (checkpoint?.saby_finance_backfill_attempted_inns||[])
      .map(sabyInn).filter(Boolean));
  for(const section of SECTIONS){
    const rows=checkpoint?.final_result?.[section];
    if(!Array.isArray(rows))continue;
    for(const row of rows){
      const inn=sabyInn(row?.["ИНН"]);
      const saved=row?.__evidence?.saby_finance_backfill;
      if(!attempted.has(inn)||sabyInn(saved?.inn)!==inn||
         !sabyNameTokens(row?.["Организация"]).length||
         !cardId(saved?.source_url)||
         !Number.isFinite(Date.parse(String(saved?.verified_at||""))))
        continue;
      const revenueMatch=Number.isSafeInteger(saved?.revenue_rub)&&
        isSavedFinanceNumber(row[FINANCE_REVENUE_FIELD])&&
        Number(row[FINANCE_REVENUE_FIELD])===saved.revenue_rub;
      const staffMatch=Number.isSafeInteger(saved?.employees)&&
        isSavedFinanceNumber(row[FINANCE_EMPLOYEES_FIELD])&&
        Number(row[FINANCE_EMPLOYEES_FIELD])===saved.employees;
      if(!revenueMatch&&!staffMatch)continue;
      const searchRow=structuredClone(row);
      // Do not let openSavedSabyFinanceCard bypass Saby search: this
      // health check is specifically proving the exact-INN SEARCH works.
      if(searchRow.__evidence)delete searchRow.__evidence.saby;
      return {row:searchRow,source_url:saved.source_url,inn};
    }
  }
  return null;
}
export function verifySabyFinanceSearchCanary(record,canary){
  const identity=record?.identity;
  return !!canary&&identity?.verified===true&&
    sabyInn(identity.inn)===canary.inn&&
    sabyNameMatches(canary.row?.["Организация"],identity.name)&&
    record?.source==="SABY"&&
    cardId(record?.source_url)!==""&&
    cardId(record.source_url)===cardId(canary.source_url);
}

export function isSavedFinanceNumber(value){
  if(typeof value==="number")return Number.isSafeInteger(value)&&value>=0;
  if(typeof value!=="string"||!/^\d+$/.test(value.trim()))return false;
  const number=Number(value.trim());
  return Number.isSafeInteger(number)&&number>=0;
}

function cardId(url){
  try{
    const u=new URL(String(url||""));
    return isSabyProfileUrl(u.href)&&
      u.pathname==="/page/contractor-info"?
      String(u.searchParams.get("id")||"").trim():"";
  }catch{return "";}
}

export function planSabyFinanceBackfill(result){
  if(!result||SECTIONS.some(key=>!Array.isArray(result[key])))
    throw new TypeError("FINANCE_BACKFILL_RESULT_INCOMPLETE");
  const rows=SECTIONS.flatMap(section=>result[section]
    .map(row=>({section,row})));
  const frequency=new Map();
  for(const {row} of rows){
    const inn=sabyInn(row?.["ИНН"]);
    if(inn)frequency.set(inn,(frequency.get(inn)||0)+1);
  }
  const eligible=[];
  let invalid=0,duplicate=0,alreadyComplete=0;
  for(const entry of rows){
    const {row}=entry;
    const missingRevenue=!isSavedFinanceNumber(row?.[FINANCE_REVENUE_FIELD]);
    const missingEmployees=!isSavedFinanceNumber(row?.[FINANCE_EMPLOYEES_FIELD]);
    if(!missingRevenue&&!missingEmployees){
      alreadyComplete++;
      continue;
    }
    const inn=sabyInn(row?.["ИНН"]);
    if(!inn||!sabyNameTokens(row?.["Организация"]).length){
      invalid++;
      continue;
    }
    if(frequency.get(inn)!==1){
      duplicate++;
      continue;
    }
    eligible.push({...entry,inn,missingRevenue,missingEmployees});
  }
  return {eligible,invalid,duplicate,alreadyComplete,
    total:rows.length,missingRevenue:rows.filter(({row})=>
      !isSavedFinanceNumber(row?.[FINANCE_REVENUE_FIELD])).length,
    missingEmployees:rows.filter(({row})=>
      !isSavedFinanceNumber(row?.[FINANCE_EMPLOYEES_FIELD])).length};
}

export function applySabyFinanceBackfill(row,record){
  const identity=record?.identity;
  const inn=sabyInn(row?.["ИНН"]);
  if(!inn||identity?.verified!==true||
     sabyInn(identity.inn)!==inn||
     !sabyNameMatches(row?.["Организация"],identity.name)||
     !isSabyProfileUrl(record?.source_url)||
     !cardId(record?.source_url))
    return {status:"review",reason:"identity_or_source",revenueAdded:false,
      employeesAdded:false};
  const existing=row?.__evidence?.saby;
  if(existing?.inn&&sabyInn(existing.inn)!==inn)
    return {status:"review",reason:"stored_saby_inn_mismatch",
      revenueAdded:false,employeesAdded:false};
  // A previously collected Saby branch/card may have the same INN but a
  // different KPP. Never attach its figures to another private detail card.
  const oldId=cardId(existing?.source_url);
  const newId=cardId(record.source_url);
  const oldKpp=String(existing?.kpp||"").trim();
  const newKpp=String(identity?.kpp||"").trim();
  if((oldId&&oldId!==newId)||
     (/^\d{9}$/.test(oldKpp)&&/^\d{9}$/.test(newKpp)&&oldKpp!==newKpp))
    return {status:"review",reason:"stored_saby_card_mismatch",
      revenueAdded:false,employeesAdded:false};

  const financial=validSabyFinancialEvidence(record.financials);
  if(!financial)return {status:"missing",reason:"financial_not_verified",
    revenueAdded:false,employeesAdded:false};
  const revenueAdded=!isSavedFinanceNumber(row[FINANCE_REVENUE_FIELD])&&
    Number.isSafeInteger(financial.revenue_rub);
  const employeesAdded=!isSavedFinanceNumber(row[FINANCE_EMPLOYEES_FIELD])&&
    Number.isSafeInteger(financial.employees);
  if(!revenueAdded&&!employeesAdded)
    return {status:"unchanged",revenueAdded:false,employeesAdded:false};
  if(revenueAdded)row[FINANCE_REVENUE_FIELD]=financial.revenue_rub;
  if(employeesAdded)row[FINANCE_EMPLOYEES_FIELD]=financial.employees;

  const oldEvidence=row.__evidence||{};
  const detail={
    source:"SABY",inn,
    source_url:record.source_url,
    verified_at:String(record.collected_at||new Date().toISOString()),
    ...(revenueAdded?{
      revenue_rub:financial.revenue_rub,
      revenue_year:financial.revenue_year
    }:{}),
    ...(employeesAdded?{employees:financial.employees}:{})
  };
  // Keep previously collected Saby contacts/fleet and their original status.
  // This separate provenance is readable without merging related branches.
  row.__evidence={
    ...oldEvidence,
    source_urls:[...new Set([...(Array.isArray(oldEvidence.source_urls)?
      oldEvidence.source_urls:[]),record.source_url])],
    saby_finance_backfill:detail
  };
  const note=[
    "Saby (дополнение финансов, ИНН "+inn+")",
    revenueAdded?"выручка "+financial.revenue_year+" г.: "+
      financial.revenue_rub+" руб.":"",
    employeesAdded?"численность: "+financial.employees:"",
    record.source_url
  ].filter(Boolean).join("; ");
  if(!String(row.__comment||"").split("\n").includes(note))
    row.__comment=[String(row.__comment||"").trim(),note].filter(Boolean).join("\n");
  return {status:"updated",revenueAdded,employeesAdded};
}

// Early PR #103 versions incorrectly marked review-only cards "attempted".
// Recover the EXACT one-card reviewed delta from its immutable parent. Do not
// infer identity for a multi-card or mixed successful/reviewed pass.
export function recoverLegacyFinanceReview(child,parent){
  const unchanged={checkpoint:child,recovered:0};
  if(!child||!parent||
     String(child.saby_finance_backfill_source_job_id||"")!==
       String(parent.id||""))
    return unchanged;
  const stats=child.saby_finance_backfill_stats||{};
  if(stats.processed!==1||stats.review!==1||
     Number(stats.revenueAdded||0)!==0||
     Number(stats.employeesAdded||0)!==0||
     Number(stats.unavailable||0)!==0||
     Number(stats.verified||0)!==0)
    return unchanged;
  const prior=new Set(Array.isArray(parent.saby_finance_backfill_attempted_inns)?
    parent.saby_finance_backfill_attempted_inns.map(sabyInn).filter(Boolean):[]);
  const current=Array.isArray(child.saby_finance_backfill_attempted_inns)?
    child.saby_finance_backfill_attempted_inns.map(sabyInn).filter(Boolean):[];
  const added=current.filter(inn=>!prior.has(inn));
  if(added.length!==1 || current.length!==prior.size+1)return unchanged;
  const inn=added[0];
  const oldOutcome=child.saby_finance_backfill_outcomes?.[inn];
  // Both first pilot variants existed: one wrote no outcome and the next
  // wrote status=review, but BOTH incorrectly consumed this exact INN.
  if(oldOutcome&&oldOutcome.status!=="review")return unchanged;
  // Only restore an INN that still exists, uniquely, with missing finance.
  const eligible=planSabyFinanceBackfill(child.final_result).eligible;
  const target=eligible.find(x=>x.inn===inn);
  if(!target)return unchanged;
  const normalized=structuredClone(child);
  normalized.saby_finance_backfill_attempted_inns=current.filter(x=>x!==inn);
  normalized.saby_finance_backfill_review_attempts={
    ...(child.saby_finance_backfill_review_attempts||{}),[inn]:1
  };
  normalized.saby_finance_backfill_outcomes={
    ...(child.saby_finance_backfill_outcomes||{}),
    [inn]:{status:"review",
      reason:oldOutcome?.reason||"legacy_review_unclassified",
      revenueStillMissing:target.missingRevenue,
      employeesStillMissing:target.missingEmployees}
  };
  return {checkpoint:normalized,recovered:1};
}

// Reuse a prior one-company Saby smoke already VERIFIED by Stage12. The
// saved smoke artifact is provenance, never a shortcut to guessed identity.
// The target region row is independently cross-checked by apply... below.
export function verifiedSabyFinanceFromSmoke(smoke,expectedInn){
  const fail=()=>{throw new Error("FINANCE_BACKFILL_SMOKE_NOT_VERIFIED");};
  const expected=sabyInn(expectedInn);
  const result=smoke?.final_result;
  const stats=smoke?.saby_stage12;
  const selection=smoke?.saby_smoke_selection;
  if(!expected||smoke?.source!=="single_company"||
     !result||!Array.isArray(result.direct_buyers)||
     result.direct_buyers.length!==1||
     ["intermediaries","leasing","statistics"].some(key=>
       !Array.isArray(result[key])||result[key].length!==0)||
     selection?.limit!==1||
     stats?.verified!==1||stats?.review!==0||
     stats?.browserError||stats?.revenuesAdded!==1||
     stats?.employeesAdded!==1)
    fail();
  const row=result.direct_buyers[0];
  const saved=row?.__evidence?.saby;
  const financial=validSabyFinancialEvidence(saved?.financials);
  const sourceUrl=String(saved?.source_url||"");
  const verifiedAt=String(saved?.verified_at||"");
  if(sabyInn(row?.["ИНН"])!==expected||
     sabyInn(saved?.inn)!==expected||
     !sabyNameTokens(row?.["Организация"]).length||
     saved?.collection?.financials!=="collected"||
     !cardId(sourceUrl)||
     !financial||!Number.isSafeInteger(financial.revenue_rub)||
     !Number.isSafeInteger(financial.revenue_year)||
     !Number.isSafeInteger(financial.employees)||
     !Number.isFinite(Date.parse(verifiedAt))||
     row[FINANCE_REVENUE_FIELD]!==financial.revenue_rub||
     row[FINANCE_EMPLOYEES_FIELD]!==financial.employees)
    fail();
  return {
    identity:{verified:true,inn:expected,
      name:String(row["Организация"]||"").trim(),
      ...(String(saved.kpp||"").match(/^\d{9}$/)?
        {kpp:String(saved.kpp)}:{})},
    source:"SABY",source_url:sourceUrl,
    collected_at:verifiedAt,financials:financial
  };
}

export function validateFinanceBackfillCheckpoint(source){
  const mode=String(source?.source_mode||"full");
  if(!source||source.version!==1||!source.region||
     !["full","saby"].includes(mode)||
     !(mode==="full"&&source.phase==="completed" ||
       mode==="saby"&&["saby","completed"].includes(source.phase)))
    return {ok:false,code:"FINANCE_BACKFILL_FINAL_CHECKPOINT_REQUIRED"};
  try{
    const plan=planSabyFinanceBackfill(source.final_result);
    return {ok:true,plan};
  }catch{return {ok:false,code:"FINANCE_BACKFILL_RESULT_INCOMPLETE"};}
}

export async function runSabyFinanceBackfill({
  checkpoint:parent,sourceJobId,childJobId,maxCompanies=1,targetInn="",
  env=process.env,
  sessionRunner=withSabyBrowser,
  collectCompany=collectSabyFinancialsOnly,
  onCheckpoint=async()=>{},
  onProgress=()=>{},
  waitBetweenCompanies=ms=>new Promise(resolve=>setTimeout(resolve,ms))
}={}){
  const valid=validateFinanceBackfillCheckpoint(parent);
  if(!valid.ok)throw new Error(valid.code);
  if(!/^[a-f0-9-]{36}$/i.test(String(sourceJobId||""))||
     !/^[a-f0-9-]{36}$/i.test(String(childJobId||""))||
     sourceJobId===childJobId)
    throw new Error("FINANCE_BACKFILL_SOURCE_OR_CHILD_ID_INVALID");
  if(!Number.isSafeInteger(maxCompanies)||maxCompanies<1||maxCompanies>10000)
    throw new Error("FINANCE_BACKFILL_MAX_COMPANIES_INVALID");
  const target=targetInn?sabyInn(targetInn):"";
  if(targetInn && (!target||maxCompanies!==1))
    throw new Error("FINANCE_BACKFILL_TARGET_INVALID");
  const sourcePlan=valid.plan;
  const attempted=new Set(Array.isArray(parent.saby_finance_backfill_attempted_inns)?
    parent.saby_finance_backfill_attempted_inns.map(sabyInn).filter(Boolean):[]);
  const reviewCounts={...(parent.saby_finance_backfill_review_attempts||{})};
  const reviewCount=inn=>{
    const n=Number(reviewCounts[inn]||0);
    return Number.isSafeInteger(n)?Math.max(0,
      Math.min(FINANCE_REVIEW_MAX_PASSES,n)):0;
  };
  const pending=()=>sourcePlan.eligible.filter(entry=>
    !attempted.has(entry.inn)&&
    reviewCount(entry.inn)<FINANCE_REVIEW_MAX_PASSES);
  // Keep temporary search uncertainty pending, but never let it consume
  // the next session before untouched INNs. Prioritize never-observed INNs,
  // then both kinds of deferred search, then prior identity reviews.
  // Stable sort preserves original row order inside each tier.
  const priorDeferredSearch=inn=>{
    const outcome=parent.saby_finance_backfill_outcomes?.[inn];
    return outcome?.status==="deferred"&&
      (outcome.reason==="search_loading_stalled"||
       outcome.reason==="search_zero_unconfirmed");
  };
  const tier=inn=>reviewCount(inn)>0?2:priorDeferredSearch(inn)?1:0;
  const selected=pending().filter(entry=>!target||entry.inn===target)
    .sort((a,b)=>tier(a.inn)-tier(b.inn))
    .slice(0,maxCompanies);
  if(target && selected.length!==1)
    throw new Error("FINANCE_BACKFILL_TARGET_NOT_ELIGIBLE_OR_ALREADY_ATTEMPTED");
  const result=structuredClone(parent.final_result);
  const lookup=new Map();
  for(const section of SECTIONS)
    for(const row of result[section])
      lookup.set(section+":"+sabyInn(row["ИНН"]),row);
  // A missing Saby financial report is not an application failure. Keep a
  // compact outcome for each verified legal entity in the immutable child.
  const outcomes={...(parent.saby_finance_backfill_outcomes||{})};
  const stats={
    eligible:sourcePlan.eligible.length,
    missingRevenueBefore:sourcePlan.missingRevenue,
    missingEmployeesBefore:sourcePlan.missingEmployees,
    scheduled:selected.length,processed:0,
    revenueAdded:0,employeesAdded:0,
    verified:0,review:0,unavailable:0,unchanged:0,retries:0,
    loadingDeferred:0,unconfirmedSearches:0,
    canaryChecks:0,canaryPassed:0,
    unvisited:pending().length,
    reviewRetryable:pending().filter(x=>reviewCount(x.inn)>0).length,
    reviewExhausted:sourcePlan.eligible.filter(x=>
      !attempted.has(x.inn)&&reviewCount(x.inn)>=FINANCE_REVIEW_MAX_PASSES).length,
    missingRevenueAfter:sourcePlan.missingRevenue,
    missingEmployeesAfter:sourcePlan.missingEmployees,
    browserError:""
  };
  const now=new Date().toISOString();
  let snapshot={
    ...parent,source_mode:"saby",phase:"saby",
    created_at:now,updated_at:now,
    final_result:result,
    saby_finance_backfill_source_job_id:sourceJobId,
    saby_finance_backfill_root_job_id:
      parent.saby_finance_backfill_root_job_id||sourceJobId,
    saby_finance_backfill_attempted_inns:[...attempted],
    saby_finance_backfill_outcomes:outcomes,
    saby_finance_backfill_review_attempts:reviewCounts,
    saby_finance_backfill_stats:stats
  };
  const save=async(phase="saby")=>{
    const after=planSabyFinanceBackfill(result);
    stats.missingRevenueAfter=after.missingRevenue;
    stats.missingEmployeesAfter=after.missingEmployees;
    stats.unvisited=pending().length;
    stats.reviewRetryable=pending().filter(x=>reviewCount(x.inn)>0).length;
    stats.reviewExhausted=after.eligible.filter(x=>
      !attempted.has(x.inn)&&
      reviewCount(x.inn)>=FINANCE_REVIEW_MAX_PASSES).length;
    snapshot={...snapshot,phase,final_result:result,
      updated_at:new Date().toISOString(),
      saby_finance_backfill_attempted_inns:[...attempted],
      saby_finance_backfill_outcomes:{...outcomes},
      saby_finance_backfill_review_attempts:{...reviewCounts},
      saby_finance_backfill_stats:{...stats}};
    await onCheckpoint(structuredClone(snapshot));
  };
  await save();
  if(!selected.length){
    // No new work does not mean that safety reviews were resolved.
    await save(stats.reviewExhausted===0?"completed":"saby");
    return {snapshot,stats:{...stats},childJobId};
  }
  try{
    await sessionRunner(async ({page,settings})=>{
      const rawDelay=Number(settings?.delayMs??env.SABY_DELAY_MS??1500);
      const delayMs=Number.isFinite(rawDelay)?
        Math.max(250,Math.min(30000,rawDelay)):1500;
      let consecutiveReview=0;
      let consecutiveStalls=0;
      let consecutiveUnconfirmed=0;
      let lastCanarySuccess=0;
      const canary=selectSabyFinanceSearchCanary(parent);
      // A previous company-specific review is not evidence of a site-wide
      // malfunction. When multiple reviews occur in a row, prove search
      // health against a previously verified contractor before halting the
      // batch. Search is forced; no saved-card shortcut or write is allowed.
      const verifySearchHealth=async trigger=>{
        if(lastCanarySuccess>0&&Date.now()-lastCanarySuccess<5*60*1000)
          return true;
        if(!canary)return false;
        stats.canaryChecks++;
        let proven=false;
        let reason="identity_or_card_unverified";
        try{
          const found=await collectCompany(page,canary.row,settings);
          proven=verifySabyFinanceSearchCanary(found,canary);
          if(proven)reason="verified";
        }catch(error){
          // Classified codes are an explicit allowlist. Never log raw
          // exceptions, company names, identifiers, URLs or page content.
          reason=classifySabyFinanceFailure(error).code;
        }
        console.info("[SABY_FINANCE_SEARCH_CANARY_DIAG] "+
          JSON.stringify({verified:proven,checks:stats.canaryChecks,
            trigger,reason}));
        if(proven){
          stats.canaryPassed++;
          lastCanarySuccess=Date.now();
        }
        return proven;
      };
      for(const [index,entry] of selected.entries()){
        const row=lookup.get(entry.section+":"+entry.inn);
        if(!row)throw new Error("FINANCE_BACKFILL_ROW_MISMATCH");
        let outcome={status:"unavailable",reason:"financial_not_verified"};
        try{
          let record;
          try{
            record=await collectCompany(page,row,settings);
          }catch(error){
            const failure=classifySabyFinanceFailure(error);
            // Retry only a transient scanner/card hydration failure once.
            // The legal INN and private card are reverified from scratch;
            // no fallback to unverified search-result data is permitted.
            if(!failure.retryable)throw error;
            stats.retries++;
            console.warn("[SABY_FINANCE_RETRY] "+JSON.stringify({
              code:failure.code,attempt:2,max_attempts:2
            }));
            await waitBetweenCompanies(delayMs);
            record=await collectCompany(page,row,settings);
          }
          const applied=applySabyFinanceBackfill(row,record);
          if(applied.status==="updated"){
            stats.verified++;
            if(applied.revenueAdded)stats.revenueAdded++;
            if(applied.employeesAdded)stats.employeesAdded++;
          }else if(applied.status==="review"){
            stats.review++;
          }else if(applied.status==="unchanged"){
            // Both numbers may already be present, or Saby supplied only
            // a number already saved in stages 1-11. Nothing to overwrite.
            stats.unchanged++;
          }else{
            // A genuinely unavailable annual report is a terminal
            // observation, NOT a zero value and not an identity failure.
            stats.unavailable++;
          }
          const reason=String(applied.reason||"");
          const safeReason=new Set(["identity_or_source",
            "stored_saby_inn_mismatch","stored_saby_card_mismatch",
            "financial_not_verified"]).has(reason)?reason:"";
          outcome={status:applied.status,
            ...(safeReason?{reason:safeReason}:{})};
        }catch(error){
          const failure=classifySabyFinanceFailure(error);
          // Only a STABLE, explicit first-party "no results" message
          // for the exact query may be treated as an unavailable Saby
          // source. No identity is inferred; no finance value is written.
          if(failure.code==="search_confirmed_empty"){
            stats.unavailable++;
            outcome={status:"missing",reason:"saby_no_results"};
            console.info("[SABY_FINANCE_BACKFILL_DIAG] "+JSON.stringify({
              code:"search_confirmed_empty",scope:"company",action:"skip_unavailable"
            }));
          }else if(failure.code==="search_zero_unconfirmed"){
            // Exact-INN input and transport were observed, but the visible
            // list offered neither a result nor a proven empty message.
            // An immediate retry cannot add legal proof. Do not consume
            // either identity-review budget or the company as attempted.
            stats.unconfirmedSearches++;
            outcome={status:"deferred",reason:"search_zero_unconfirmed"};
            console.warn("[SABY_FINANCE_BACKFILL_DIAG] "+JSON.stringify({
              code:"search_zero_unconfirmed",scope:"company",
              action:"defer_without_review"
            }));
          }else if(failure.code==="search_loading_stalled"){
            // One timed-out exact-INN search is NOT proof of a site-wide
            // outage. Save a temporary deferral without consuming either
            // the INN or an identity review allowance. Other firms remain
            // eligible for this same browser session.
            stats.loadingDeferred++;
            outcome={status:"deferred",reason:"search_loading_stalled"};
            console.warn("[SABY_FINANCE_BACKFILL_DIAG] "+JSON.stringify({
              code:"search_loading_stalled",scope:"company",
              action:"defer_and_continue"
            }));
          }else if(["search_input_failed","search_scan_error",
            "search_service_unavailable"].includes(failure.code)){
            // Proven unsafe search state: pause immediately and preserve the
            // current and future INNs. Never infer a company's identity.
            stats.browserError="saby_search_unavailable";
            console.warn("[SABY_FINANCE_BACKFILL_DIAG] "+JSON.stringify({
              code:failure.code,scope:"systemic",action:"pause"
            }));
            break;
          }else{
            // Never log raw Playwright errors, company names or profile URLs.
            stats.review++;
            outcome={status:"review",reason:failure.code};
            console.warn("[SABY_FINANCE_BACKFILL_DIAG] "+JSON.stringify({
              code:failure.code,scope:"company",action:"defer"
            }));
          }
        }
        outcomes[entry.inn]={
          ...outcome,
          revenueStillMissing:!isSavedFinanceNumber(row[FINANCE_REVENUE_FIELD]),
          employeesStillMissing:!isSavedFinanceNumber(row[FINANCE_EMPLOYEES_FIELD])
        };
        if(outcome.status==="deferred"){
          // A generic Wasaby spinner may be visible before search, even
          // when it is healthy. Such uncertain zeros need a separate
          // known-good search check, not a loading-stall conclusion.
          if(outcome.reason==="search_zero_unconfirmed"){
            consecutiveUnconfirmed++;
            consecutiveStalls=0;
          }else{
            consecutiveStalls++;
            consecutiveUnconfirmed=0;
          }
          consecutiveReview=0;
        }else if(outcome.status==="review"){
          consecutiveUnconfirmed=0;
          consecutiveStalls=0;
          // A genuine INN/card mismatch is never retried automatically.
          // Temporary failures get one LATER pass, after fresh firms.
          const permanent=new Set(["identity_or_source",
            "stored_saby_inn_mismatch","stored_saby_card_mismatch",
            "search_ambiguous","card_changed"]).has(outcome.reason);
          reviewCounts[entry.inn]=permanent?
            FINANCE_REVIEW_MAX_PASSES:
            Math.min(FINANCE_REVIEW_MAX_PASSES,reviewCount(entry.inn)+1);
          consecutiveReview++;
        }else{
          consecutiveStalls=0;
          consecutiveUnconfirmed=0;
          attempted.add(entry.inn);
          delete reviewCounts[entry.inn];
          consecutiveReview=0;
        }
        stats.processed++;
        await save();
        await onProgress({...stats});
        if(consecutiveUnconfirmed>=3){
          // Three silent zero-row queries may mean several contractors
          // are absent OR the whole Saby search has stopped working.
          // Re-search an ALREADY VERIFIED firm with no writes to tell
          // the cases apart; never conclude identity from query transport.
          const proven=await verifySearchHealth("unconfirmed_zero");
          if(!proven){
            stats.browserError=canary?
              "saby_search_canary_unverified":
              "saby_search_canary_unavailable";
            console.warn("[SABY_FINANCE_BACKFILL_DIAG] "+
              JSON.stringify({code:canary?"search_canary_unverified":
                "search_canary_unavailable",action:"pause",
                unconfirmed:stats.unconfirmedSearches}));
            break;
          }
          // A known-good INN succeeded. Other zero-row responses remain
          // deferred as company-specific uncertainty; proceed with new INNs.
          consecutiveUnconfirmed=0;
        }
        if(consecutiveStalls>=3){
          stats.browserError="saby_consecutive_loading_stalls";
          console.warn("[SABY_FINANCE_BACKFILL_DIAG] "+
            JSON.stringify({code:"three_consecutive_loading_stalls",
              action:"pause",deferred:stats.loadingDeferred}));
          break;
        }
        if(consecutiveReview>=3){
          // Diverse companies can legitimately fail legal-name, KPP or
          // public-profile checks in succession. The failed rows remain
          // under review, but must not stop other firms when exact-INN
          // Saby search is independently shown to work.
          const proven=await verifySearchHealth("consecutive_reviews");
          if(!proven){
            stats.browserError=canary?
              "saby_review_canary_unverified":
              "saby_consecutive_unverified_cards";
            console.warn("[SABY_FINANCE_BACKFILL_DIAG] "+
              JSON.stringify({code:canary?
                "review_canary_unverified":"three_consecutive_reviews",
                action:"pause",reviews:stats.review}));
            break;
          }
          console.info("[SABY_FINANCE_BACKFILL_DIAG] "+
            JSON.stringify({code:"review_canary_verified",
              action:"continue",reviews:stats.review}));
          consecutiveReview=0;
        }
        // Match Stage12's pacing without adding a delay after last company.
        if(index+1<selected.length)await waitBetweenCompanies(delayMs);
      }
    },{env});
  }catch{
    stats.browserError="saby_browser_unavailable";
  }
  // Priority V/W (revenue/headcount) needs deterministic offline
  // recalculation. Original classification evidence remains in the cloned
  // checkpoint and does not require OpenAI. For resumable child exports the
  // existing persistedCheckpointExport does this at download time.
  const allVisited=stats.unvisited===0&&!stats.browserError;
  if(allVisited){
    const {applyPriorityStage13}=await import("./priorityStage13.js");
    const {finalizeStage13CommercialOutput}=await import("./priorityStage13Finalize.js");
    const priority=applyPriorityStage13(result,{
      aiStats:parent.priority_ai_stats||null});
    priority.commercial_postprocess=finalizeStage13CommercialOutput(result);
    snapshot={...snapshot,priority_stats:priority};
  }
  await save(allVisited&&stats.reviewExhausted===0?"completed":"saby");
  return {snapshot,stats:{...stats},childJobId};
}
