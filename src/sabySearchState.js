// Privacy-safe Saby search state: output is only boolean flags, never INN,
// raw Saby page text, cookies, hidden input values or login credentials.
// This is a diagnostic and strictly bounded no-results policy; it is NOT
// legal identity proof and cannot authorize collection from another firm.
export function inspectSabySearchDOM({inn}={}){
  // This function is serialized verbatim into browser page.evaluate:
  // keep all referenced regexes and helpers INSIDE its own closure.
  const EMPTY=/^(?:ничего не найдено|ничего не найдено по вашему запросу|по вашему запросу ничего не найдено|не найдено ни одной (?:компании|организации)|(?:компании|организации|результаты|записи) не найдены|нет результатов(?: поиска)?|совпадений не найдено)[.!]?\s*$/iu;
  const SERVICE_ERROR=/^(?:сервис временно недоступен|ошибка загрузки данных|не удалось загрузить данные|слишком много запросов|превышен лимит запросов|попробуйте позже|повторите попытку позже)[.!]?\s*$/iu;
  const expected=String(inn||"");
  const valid=/^(?:\d{10}|\d{12})$/.test(expected);
  const visible=el=>{
    if(!el?.isConnected||!el.getClientRects?.().length)return false;
    try{
      const css=getComputedStyle(el);
      return css?.display!=="none"&&css?.visibility!=="hidden";
    }catch{return false;}
  };
  const inputs=[...document.querySelectorAll(
    'input[type="search"],input[type="text"],input:not([type]),'+
    '[role="searchbox"]'
  )].filter(visible);
  const inputExact=valid&&inputs.some(el=>
    el.value===expected && el.type!=="password" &&
    !el.hasAttribute?.("readonly"));
  // A "nothing found" banner is meaningful only when it is a SINGLE,
  // visible leaf message in the current company-list route, not a hidden
  // template or a substring of a long help/legal/company description.
  const elements=document.querySelectorAll("body *");
  let explicitEmpty=false,serviceError=false;
  for(const el of elements){
    if(!visible(el))continue;
    const children=[...el.children||[]];
    const label=String(el.textContent||"").replace(/\s+/gu," ").trim();
    if(label.length>115||!label)continue;
    if(children.some(child=>{
      const t=String(child.textContent||"").replace(/\s+/gu," ").trim();
      return (EMPTY.test(t)||SERVICE_ERROR.test(t))&&visible(child);
    }))continue;
    if(EMPTY.test(label))explicitEmpty=true;
    if(SERVICE_ERROR.test(label))serviceError=true;
    if(explicitEmpty&&serviceError)break;
  }
  const spinnerVisible=[...document.querySelectorAll(
    '[aria-busy="true"],[role="progressbar"],'+
    '.controls-LoadingIndicator,[data-qa*="spinner" i]'
  )].some(visible);
  return {inputExact,explicitEmpty,serviceError,
    spinnerVisible};
}
export async function readSabySearchState(page,inn){
  const data=await page.evaluate(inspectSabySearchDOM,{inn});
  return {
    inputExact:data?.inputExact===true,
    explicitEmpty:data?.explicitEmpty===true,
    serviceError:data?.serviceError===true,
    spinnerVisible:data?.spinnerVisible===true
  };
}

export function classifySabySearchZeroState(first,last,{
  onListRoute=true,beforeSearch=null
}={}){
  const stable=Boolean(onListRoute&&first&&last);
  if(!stable)return "uncertain";
  if(first.serviceError&&last.serviceError)
    return "service_unavailable";
  // Live 2026-11-20 VPS probe observed FOUR visible
  // .controls-LoadingIndicator nodes BEFORE searching and AFTER a successful
  // 40-result search. Global spinnerVisible is NOT evidence of a stalled
  // company search. Require a measured pre-search baseline with NO spinner
  // before identifying newly-present, persistent loading as systemic.
  // When the baseline is missing or already busy, fail closed as uncertain:
  // do not mark the company absent and do not guess at a site-wide outage.
  if(beforeSearch?.spinnerVisible===false&&
     first.inputExact&&last.inputExact&&
     first.spinnerVisible&&last.spinnerVisible&&
     !first.explicitEmpty&&!last.explicitEmpty&&
     !first.serviceError&&!last.serviceError)
    return "loading_stalled";
  if(first.inputExact&&last.inputExact&&
    first.explicitEmpty&&last.explicitEmpty&&
    !first.spinnerVisible&&!last.spinnerVisible&&
    !first.serviceError&&!last.serviceError)
    return "confirmed_empty";
  return "uncertain";
}

/**
 * A zero-row exact-INN search with no explicit "not found" message is NOT
 * evidence that the contractor is absent. Saby's global loading indicators
 * can be visible even before a healthy search; unlike a proven new spinner
 * stall, this uncertain result must be deferred without consuming a review.
 */
export function isUnconfirmedSabyZeroResult(first,last,{
  onListRoute=true,classification="uncertain"
}={}){
  return onListRoute===true&&classification==="uncertain"&&
    first?.inputExact===true&&last?.inputExact===true&&
    first?.explicitEmpty!==true&&last?.explicitEmpty!==true&&
    first?.serviceError!==true&&last?.serviceError!==true;
}
