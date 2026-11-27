// Locate the Saby Profile "Companies" search field without assuming its
// input type. The legacy Python collector fell back to a visible plain input;
// this was lost during the JS port and broke otherwise authenticated sessions.
//
// Never type an INN into credential, verification, or ambiguous fields.
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
        editable:el.isContentEditable===true,
        readonly:el.readOnly===true||el.hasAttribute?.("readonly")===true||
          v("aria-readonly").toLowerCase()==="true"};
    });
    const hints=[a.placeholder,a.label,a.dataHint,a.name,a.role].join(" ");
    const auth=AUTH_HINTS.test(hints+" "+a.autocomplete);
    const isInput=a.tag==="input" && typeAllowed(a.type);
    const isEditor=a.editable && a.role==="searchbox";
    return {
      safe:(isInput||isEditor) && !auth && !a.readonly,
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
    // A visible, enabled but readonly Wasaby input is not actionable.
    if(typeof field.isEditable==="function" &&
       !await field.isEditable().catch(()=>false))continue;
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


// A Wasaby search field can be replaced between isVisible()/isEnabled()
// and Playwright's actionability checks. Reacquire the *safe* field once,
// without falling back to page.keyboard (which could type into login/other
// inputs). A failed field action NEVER counts as a searched contractor.
export async function submitSabyCompanySearch(page, inn, {
  // Proving the exact Saby company-list route is mandatory.
  isListRoute=()=>false,
  findSearch=findSabyCompanySearch,
  timeoutMs=15000,
  firstFindTimeoutMs=timeoutMs,
  onTiming=()=>{},
  actionTimeoutMs=8000,
  maxAttempts=2,
  wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  onRetry=()=>{}
}={}) {
  const identifier=String(inn||"");
  if(!/^(?:\d{10}|\d{12})$/.test(identifier) ||
     typeof isListRoute!=="function"||!isListRoute())
    return {ok:false,reason:"unsafe_identity_or_route",attempts:0};
  const limit=Math.min(2,Math.max(1,Math.floor(maxAttempts)||2));
  const measure=async(key,fn)=>{
    const start=performance.now();
    try{return await fn();}
    finally{onTiming(key,Math.round(performance.now()-start));}
  };
  let stage="find";
  for(let attempt=1;attempt<=limit;attempt++){
    if(!isListRoute())
      return {ok:false,reason:"route_changed",stage,attempts:attempt-1};
    // The caller may have already waited for initial hydration. The
    // first actual action still finds a fresh safe field AFTER that wait.
    const found=await measure("field_find_ms",()=>findSearch(page,{
      timeoutMs:attempt===1?firstFindTimeoutMs:timeoutMs
    }));
    if(!isListRoute())
      return {ok:false,reason:"route_changed",stage:"find",attempts:attempt};
    if(!found?.field)
      return {ok:false,reason:found?.reason||"no_safe_search_field",
        diagnostic:found?.diagnostic,stage:"find",attempts:attempt};
    try{
      stage="fill";
      await measure("field_fill_ms",()=>found.field.fill(identifier,{timeout:actionTimeoutMs}));
      if(!isListRoute())
        return {ok:false,reason:"route_changed",stage,attempts:attempt};
      stage="press";
      await measure("field_press_ms",()=>found.field.press("Enter",{timeout:actionTimeoutMs}));
      return {ok:true,method:found.method,attempts:attempt};
    }catch{
      // Do not log Playwright exceptions, dynamic selectors, DOM or values.
      if(!isListRoute())
        return {ok:false,reason:"route_changed",stage,attempts:attempt};
      if(attempt===limit)
        return {ok:false,reason:"search_action_timeout",
          stage,attempts:attempt};
      onRetry({stage,attempt});
      await measure("field_retry_wait_ms",()=>wait(600));
    }
  }
  return {ok:false,reason:"search_action_timeout",stage,attempts:limit};
}


/**
 * The Wasaby company-list can show one editable input before its search
 * handlers have been hydrated. A successful VPS network probe waited 1200ms
 * after opening the same route; the production collector used only navigation
 * commit and immediately pressed Enter. Reacquire the only safe search field
 * after a bounded settling period, without assuming that a visible input is
 * already wired to the Saby search API.
 *
 * The default returns only after a second safe field lookup. A production
 * caller that will immediately submit through submitSabyCompanySearch may
 * fuse that second lookup with the submission's mandatory first lookup.
 * No field/locator is carried across the settling wait or baseline read.
 * Never read or log any input value, DOM text, URL or credentials.
 */
export async function waitForSabySearchHydration(page,{
  isListRoute=()=>false,
  findSearch=findSabyCompanySearch,
  timeoutMs=7000,settleMs=1400,
  deferReacquireToSubmission=false,mountedPreviousInn="",onTiming=()=>{},
  wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))
}={}){
  if(typeof isListRoute!=="function"||!isListRoute())
    return {ok:false,reason:"route_changed"};
  const readyTimeout=Math.max(500,Math.min(10000,Number(timeoutMs)||7000));
  const measure=async(key,fn)=>{
    const start=performance.now();
    try{return await fn();}
    finally{onTiming(key,Math.round(performance.now()-start));}
  };
  const first=await measure("initial_field_ms",()=>findSearch(page,{timeoutMs:readyTimeout}));
  if(!first?.field)return {ok:false,reason:first?.reason||"search_not_rendered"};
  // Only the independently revalidated, already-used mounted document
  // can skip a cold handler-settle delay. Confirm the freshly found SAFE
  // field still contains the prior exact query (boolean only). The
  // submission must still reacquire the field, not reuse this locator.
  if(/^(?:\d{10}|\d{12})$/.test(mountedPreviousInn)){
    let matches=false;
    try{
      matches=await measure("mounted_field_proof_ms",()=>first.field.evaluate(
        (el,previous)=>el.value===previous,mountedPreviousInn));
    }catch{}
    if(!isListRoute())return {ok:false,reason:"route_changed"};
    if(matches!==true)return {ok:false,reason:"search_not_stable"};
  }else{
    const settle=Math.max(1200,Math.min(2500,Number(settleMs)||1400));
    await measure("field_settle_ms",()=>wait(settle));
  }
  if(!isListRoute())return {ok:false,reason:"route_changed"};
  const reacquireTimeoutMs=Math.min(3000,readyTimeout);
  if(deferReacquireToSubmission)
    return {ok:true,reacquireTimeoutMs};
  // The first field may have been removed by Wasaby between paint and
  // hydration. Re-find rather than typing into a detached locator.
  const second=await measure("hydration_reacquire_ms",()=>findSearch(page,{timeoutMs:reacquireTimeoutMs}));
  if(!second?.field)return {ok:false,reason:second?.reason||"search_not_stable"};
  return {ok:true,method:second.method};
}
