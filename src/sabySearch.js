// Locate the Saby Profile "Companies" search field without assuming its
// input type. The legacy Python collector fell back to a visible plain input;
// this was lost during the JS port and broke otherwise authenticated sessions.
//
// Never type an INN into credential, verification, or ambiguous fields.
import {sabyInn,sabySearchResultMatches} from "./sabyEnrichment.js";

const SEARCH_HINTS = /поиск|найти|search|назван|организац|компан|company|ИНН|ОГРН|реквизит|контрагент/i;
const AUTH_HINTS = /парол|password|username|user.?name|логин|phone or login|телефон или логин|verification|одноразов|captcha|капча|код подтвержд|one.time.code/i;
const STRICT_SELECTOR = [
  'input[type="search"]','[role="searchbox"]',
  'input[placeholder*="Поиск" i]','input[placeholder*="Search" i]',
  'input[placeholder*="Название" i]','input[placeholder*="ИНН" i]',
  'input[placeholder*="ОГРН" i]','input[placeholder*="Компания" i]',
  'input[placeholder*="Организац" i]','input[placeholder*="Company" i]',
  'input[aria-label*="Поиск" i]','input[aria-label*="Search" i]'
].join(",");
const FALLBACK_SELECTOR = [
  'input[type="text"]','input:not([type])','input[type="search"]',
  'input[role="searchbox"]','[role="searchbox"][contenteditable="true"]',
  '[contenteditable="true"][data-placeholder]'
].join(",");

function typeAllowed(type) {
  return !type || ["text","search"].includes(type.toLowerCase());
}

async function detailsOf(field) {
  // Never retrieve the field's current value, page text, credentials or URLs.
  if (typeof field.evaluate !== "function") return {
    safe:true, searchHint:false, type:"text", hint:"unavailable"
  };
  try {
    const a=await field.evaluate(el => {
      const v=n=>String(el.getAttribute?.(n)||"").slice(0,120);
      return {tag:String(el.tagName||"").toLowerCase(),
        type:v("type").toLowerCase(),
        autocomplete:v("autocomplete").toLowerCase(),
        placeholder:v("placeholder"),label:v("aria-label"),
        name:v("name"),role:v("role"),dataHint:v("data-placeholder"),
        editable:el.isContentEditable===true};
    });
    const hints=[a.placeholder,a.label,a.dataHint,a.name,a.role].join(" ");
    const auth=AUTH_HINTS.test(hints+" "+a.autocomplete);
    const isInput=a.tag==="input" && typeAllowed(a.type);
    const isEditor=a.editable && a.role==="searchbox";
    return {
      safe:(isInput||isEditor) && !auth,
      searchHint:SEARCH_HINTS.test(hints) || a.type==="search" ||
        a.role==="searchbox",
      type:isEditor?"searchbox":a.type||"text",
      hint:auth?"credential":SEARCH_HINTS.test(hints)?"search":"generic"
    };
  } catch {
    return {safe:false,searchHint:false,type:"unknown",hint:"unreadable"};
  }
}

async function visibleCandidates(page, selector) {
  let locator;
  try { locator=page.locator(selector); } catch { return []; }
  let count=0;
  try { count=Math.min(40,await locator.count()); } catch { return []; }
  const result=[];
  for(let i=0;i<count;i++) {
    const field=locator.nth(i);
    if(!await field.isVisible().catch(()=>false))continue;
    if(typeof field.isEnabled==="function" &&
       !await field.isEnabled().catch(()=>false))continue;
    const meta=await detailsOf(field);
    if(meta.safe)result.push({field,meta});
  }
  return result;
}

export async function findSabyCompanySearch(page, {
  timeoutMs=10000, pollMs=350, sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
}={}) {
  const limit=Date.now()+Math.max(0,Number(timeoutMs)||0);
  let lastReason="not_rendered";
  let lastVisible=0;
  let lastEligible=0;
  do {
    const strict=await visibleCandidates(page,STRICT_SELECTOR);
    const hinted=strict.filter(x=>x.meta.searchHint);
    if(hinted.length===1) {
      return {field:hinted[0].field,method:"search_selector"};
    }
    if(hinted.length>1) {
      lastReason="multiple_search_fields";
      lastVisible=hinted.length;
    } else {
      // Preserve the original Python implementation's one-visible-input
      // fallback, but do not guess when Saby shows multiple editable fields.
      const generic=await visibleCandidates(page,FALLBACK_SELECTOR);
      lastVisible=generic.length;
      const byHint=generic.filter(x=>x.meta.searchHint);
      lastEligible=byHint.length;
      if(byHint.length===1) {
        return {field:byHint[0].field,method:"search_hint"};
      }
      if(byHint.length===0 && generic.length===1) {
        return {field:generic[0].field,method:"single_visible_input"};
      }
      lastReason=byHint.length>1?"multiple_search_fields":
        generic.length>1?"ambiguous_visible_inputs":
        generic.length===0?"no_safe_visible_input":"not_rendered";
    }
    if(Date.now()>=limit)break;
    await sleep(Math.min(Math.max(1,pollMs),Math.max(1,limit-Date.now())));
  } while(Date.now()<=limit);
  return {field:null,reason:lastReason,diagnostic:{
    code:lastReason,visibleEditableCount:lastVisible,hintedCount:lastEligible,
    // Categorization only: do not include PII or dynamic DOM attributes.
    urlCategory:"profile-company-list"
  }};
}


/**
 * A Saby result list may use a short registered name or trading alias.
 * A single row with the exact INN can be clicked for further verification,
 * but this function NEVER establishes identity. The detail card must still
 * independently verify both the full expected legal name and the INN.
 * Ambiguous rows (or missing/partial INN matches) remain unselected.
 */
export function chooseSabyCompanyCandidate(rows,expectedName,expectedInn) {
  const inn=sabyInn(expectedInn);
  if(!inn)return {status:"missing",candidate:null,candidateCount:0,exactNameCount:0};
  const expression=new RegExp("(?:^|\\D)"+inn+"(?!\\d)");
  const candidates=(Array.isArray(rows)?rows:[]).filter(item=>
    item && typeof item.text==="string" && expression.test(item.text)
  );
  const exact=candidates.filter(item=>
    sabySearchResultMatches(expectedName,item.text,inn)
  );
  if(exact.length===1) {
    return {status:"exact_name",candidate:exact[0],
      candidateCount:candidates.length,exactNameCount:1};
  }
  if(exact.length>1) {
    return {status:"ambiguous",candidate:null,
      candidateCount:candidates.length,exactNameCount:exact.length};
  }
  if(candidates.length===1) {
    return {status:"unique_inn_only",candidate:candidates[0],
      candidateCount:1,exactNameCount:0};
  }
  return {status:candidates.length?"ambiguous":"missing",candidate:null,
    candidateCount:candidates.length,exactNameCount:0};
}
