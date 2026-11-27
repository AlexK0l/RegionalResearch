// Explicit empty result on a uniquely scoped company search surface.
// No inference from global loading indicators, missing rows, hidden text,
// or transport success alone. Unknown layouts retain the full old timeout.
export function inspectScopedSabyEmptyDOM({inn}={}){
  const unknown={scope:"",inputExact:false,empty:false,busy:false};
  const clean=s=>String(s||"").replace(/\s+/gu," ").trim();
  const visible=e=>{
    if(!e?.isConnected||!e.getClientRects?.().length)return false;
    const css=getComputedStyle(e);
    return css.display!=="none"&&!["hidden","collapse"].includes(css.visibility)&&css.opacity!=="0";
  };
  const fields=e=>[...e.querySelectorAll('input[type="search"],input[type="text"],input:not([type])')]
    .filter(x=>visible(x)&&!x.disabled&&!x.readOnly&&
      !/парол|логин|password|username|one.time|verification|captcha|телефон|phone/i.test(
        ["placeholder","aria-label","name","autocomplete"].map(k=>x.getAttribute(k)||"").join(" ")));
  // Require either a specifically labelled search region, or the
  // Companies / Owners / Managers tabs observed in the actual Saby UI
  // with an explicit accessible selected Companies tab. Never use a
  // generic "Не найдено" elsewhere on the page.
  const scopes=[];
  for(const root of document.querySelectorAll('[role="search"],form,[role="dialog"]')){
    if(!visible(root))continue;
    const inputs=fields(root);
    if(inputs.length!==1)continue;
    const label=clean(root.getAttribute("aria-label"));
    const tabs=[...root.querySelectorAll('[role="tab"]')].filter(visible);
    const chosen=tabs.filter(t=>t.getAttribute("aria-selected")==="true");
    const names=tabs.map(t=>clean(t.innerText));
    const named=/^(?:Поиск (?:компаний|организаций)|Компании|Организации)$/iu.test(label)&&tabs.length===0;
    const tabbed=chosen.length===1&&clean(chosen[0].innerText)==="Компании"&&
      ["Компании","Владельцы","Управляющие"].every(x=>names.includes(x));
    if(named||tabbed)scopes.push({root,input:inputs[0],scope:tabbed?"company_tabs":"named_company_search"});
  }
  if(scopes.length!==1)return unknown;
  const {root,input,scope}=scopes[0];
  const emptyLabel=/^(?:Не найдено|Ничего не найдено|По вашему запросу ничего не найдено|Нет результатов(?: поиска)?)[.!]?$/iu;
  const errorLabel=/^(?:Сервис временно недоступен|Ошибка загрузки данных|Не удалось загрузить данные|Слишком много запросов|Превышен лимит запросов|Попробуйте позже|Повторите попытку позже)[.!]?$/iu;
  // Bound this to the actual small search panel, not the entire catalog.
  const nodes=[...root.querySelectorAll("*")];
  if(nodes.length>800||clean(root.innerText).length>6000)return unknown;
  const matches=re=>nodes.filter(e=>re.test(clean(e.textContent))&&visible(e)&&
    re.test(clean(e.innerText))&&
    ![...e.children].some(c=>visible(c)&&re.test(clean(c.innerText))));
  const busy=root.getAttribute("aria-busy")==="true"||
    [...root.querySelectorAll('[aria-busy="true"],[role="progressbar"],.controls-LoadingIndicator,[data-qa*="spinner" i]')].some(visible)||
    matches(errorLabel).length>0;
  return {scope,inputExact:/^(?:\d{10}|\d{12})$/.test(inn||"")&&input.value===inn,
    empty:matches(emptyLabel).length===1,busy};
}
export async function readScopedSabyEmpty(page,inn){
  try{return await page.evaluate(inspectScopedSabyEmptyDOM,{inn});}
  catch{return null;}
}
export function scopedSabyEmptyConfirmed(before,first,last,{settled=false,observed=null,onListRoute=false}={}){
  return settled===true&&observed===0&&onListRoute===true&&
    ["company_tabs","named_company_search"].includes(before?.scope)&&
    before.inputExact===false&&before.empty===false&&
    first?.scope===before.scope&&last?.scope===before.scope&&
    [first,last].every(x=>x.inputExact===true&&x.empty===true&&x.busy===false);
}
