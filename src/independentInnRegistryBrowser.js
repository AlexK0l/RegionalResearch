// Bounded public-registry navigation only. No login, CAPTCHA bypass,
// private endpoint, Saby request, or paid API. A single fresh Chromium
// context is separate from the authenticated Stage12 Saby profile.
import {chromium} from "playwright";
import {extractVbrGeneralIdentity,isVbrCompanyUrl,unwrapVbrDuplicate}
  from "./sabyIndependentVbrBridge.js";
import {lookupFnsViaBrowser} from "./independentInnFns.js";
import {extractIndependentRegistryIdentity,independentRegistryRoute,
  canonicalIndependentRegistryRoute,sameRegisteredName}
  from "./sabyIndependentNameBridge.js";

const clean=v=>String(v??"").normalize("NFKC").replace(/\s+/gu," ").trim();
const lines=v=>String(v||"").slice(0,120000).split(/[\r\n]+/u)
  .map(clean).filter(Boolean);
function fail(code){return Object.assign(Error(code),{code});}
export function registrySearchUrl(query){
  const url=new URL("https://kontragent.vbr.ru/search/");
  url.searchParams.set("s",clean(query));
  return url.href;
}
export function exactRegistrySearchRoute(raw,query){
  try{
    const u=new URL(raw);
    return u.protocol==="https:"&&u.hostname==="kontragent.vbr.ru"&&
      !u.port&&!u.username&&!u.password&&!u.hash&&u.pathname==="/search/"&&
      u.searchParams.size===1&&u.searchParams.get("s")===clean(query);
  }catch{return false;}
}
function companyOgrn(url){
  try{
    const value=/-([0-9]{13})\/$/.exec(new URL(url).pathname)?.[1]||"";
    return value&&isVbrCompanyUrl(url,value)&&!new URL(url).hash?value:"";
  }catch{return "";}
}
export function inspectRegistrySearch(snapshot,query){
  const text=String(snapshot?.text||"").slice(0,120000);
  const links=new Map();
  for(const item of snapshot?.links||[]){
    const ogrn=companyOgrn(item.url);
    if(ogrn&&!links.has(ogrn))links.set(ogrn,{url:item.url,title:clean(item.title),ogrn});
  }
  // Only an explicit RESULT count, not "Всего в нашей базе ...", can
  // prove completeness. Multiple differing counts are untrustworthy.
  const totals=new Set();
  for(const line of lines(text)){
    const m=/^(?:найдено|результатов поиска:?)\s*[:\s]*([0-9][0-9 \u00a0]*)\s*(?:организац[а-яё]+|компани[а-яё]+|результат[а-яё]*|запис[а-яё]+)?$/iu.exec(line);
    if(m){
      const n=Number(m[1].replace(/\s/gu,""));
      if(Number.isSafeInteger(n))totals.add(n);
    }
  }
  const total=totals.size===1?[...totals][0]:null;
  const inputExact=(snapshot?.inputs||[]).some(v=>clean(v)===clean(query));
  const empty=inputExact&&links.size===0&&
    (total===0||lines(text).some(line=>
      /^(?:ничего не найдено|по вашему запросу ничего не найдено|организации не найдены|поиск не дал результатов)[.!]?$/iu.test(line)));
  const complete=inputExact&&total!==null&&total===links.size&&
    !snapshot?.hasMore&&!snapshot?.truncated;
  return {links:[...links.values()],complete,empty,inputExact,total};
}
function activeAtTop(raw,identity){
  const head=lines(raw).slice(0,35);
  const index=head.findIndex(line=>
    sameRegisteredName(line,identity.full_name)||
    sameRegisteredName(line,identity.short_name));
  if(index<0)return false;
  const status=head.slice(Math.max(0,index-3),index+7);
  return status.some(l=>/^действующая организация(?:\.|$)/iu.test(l))&&
    !status.some(l=>/^(?:ликвидирован[ао]?|организация ликвидирована|деятельность прекращена|организация в процессе ликвидации|организация в процессе банкротства)(?:[.! ]|$)/iu.test(l));
}
export function extractRegistryVbrRecord(raw){
  // Identity and address must originate in the same single panel. Never
  // stitch together an address-only section and a different legal record.
  const whole=extractVbrGeneralIdentity(raw);
  if(!whole)return null;
  const list=lines(raw),blocks=[];
  for(let i=0;i<list.length;i++){
    if(list[i]!=="Общая информация")continue;
    let end=Math.min(list.length,i+85);
    const values=new Set();
    for(let j=i+1;j<end;j++){
      if(/^(?:Сведения об организации|Финансы(?: за \d{4})?|Учредители|Виды деятельности|Вид деятельности по ОКВЭД|Лицензии|Структура и связи|Проверки|Мониторинг организаций)$/iu.test(list[j])){
        end=j;break;
      }
      if(list[j]!=="Юридический адрес"||j+1>=end)continue;
      const address=unwrapVbrDuplicate(list[j+1]);
      if(address&&address.length>=12&&address.length<=500&&/\d/.test(address))
        values.add(address);
    }
    const identity=extractVbrGeneralIdentity(list.slice(i,end).join("\n"));
    if(identity&&identity.inn===whole.inn&&identity.ogrn===whole.ogrn&&
      identity.kpp===whole.kpp&&values.size===1)
      blocks.push({...identity,address:[...values][0]});
  }
  if(blocks.length!==1)return null;
  return {...blocks[0],active:activeAtTop(raw,blocks[0])};
}
export function extractRegistryTbankRecord(raw){
  const identity=extractIndependentRegistryIdentity(raw,{includeAddress:true});
  return identity?{...identity,active:activeAtTop(raw,identity)}:null;
}
export async function createPublicRegistryLookup(page,{
  maxPages=80,delayMs=900,maxCandidates=8,provider="vbr"
}={}){
  if(!["vbr","fns"].includes(provider)||
     !Number.isSafeInteger(maxPages)||maxPages<1||maxPages>3000||
     !Number.isSafeInteger(maxCandidates)||maxCandidates<1||maxCandidates>12)
    throw Error("REGISTRY_LOOKUP_BAD_BUDGET");
  const delay=Math.max(provider==="fns"?2000:500,
    Math.min(10000,Number(delayMs)||900));
  let pages=0,uncertain=0;
  async function navigate(url,check){
    if(pages>=maxPages)throw fail("navigation_budget");
    if(pages)await page.waitForTimeout(delay);
    pages++;
    let response;
    try{
      response=await page.goto(url,{waitUntil:"domcontentloaded",timeout:18000});
    }catch{throw fail("registry_browser_unavailable");}
    const status=Number(response?.status?.()||0);
    if(status===404&&check(page.url()))return false;
    if(status!==200)throw fail("registry_http_unavailable");
    if(!check(page.url()))throw fail("registry_route_untrusted");
    return true;
  }
  async function readBody(check){
    if(!check(page.url()))throw fail("registry_route_untrusted");
    try{
      const body=await page.evaluate(()=>String(document.body?.innerText||"").slice(0,120000));
      if(/(?:^|\n)(?:подтвердите,? что вы не робот|проверка безопасности|доступ запрещ[её]н|access denied|just a moment|captcha)(?:[.!:\s]|$)/imu.test(body))
        throw fail("registry_http_unavailable");
      return body;
    }catch(error){
      if(error?.code==="registry_http_unavailable")throw error;
      throw fail("registry_browser_unavailable");
    }
  }
  async function snapshot(check){
    if(!check(page.url()))throw fail("registry_route_untrusted");
    try{
      return await page.evaluate(()=>{
        const visible=e=>Boolean(e.getClientRects().length);
        const anchors=[...document.querySelectorAll("a[href]")].filter(visible);
        const text=String(document.body?.innerText||"").slice(0,120000);
        return {text,links:anchors.slice(0,1500).map(a=>({
          url:a.href,title:String(a.innerText||a.getAttribute("aria-label")||"").slice(0,250)
        })),inputs:[...document.querySelectorAll("input")].filter(visible)
          .map(e=>String(e.value||"").slice(0,250)),
          truncated:anchors.length>1500,
          hasMore:[...document.querySelectorAll('a[rel="next"],button,a[href]')].
            some(e=>visible(e)&&!e.disabled&&e.getAttribute("aria-disabled")!=="true"&&
              (/^(?:следующ(?:ая|ий|ее)(?: страница)?|показать ещ[её]|загрузить ещ[её]|далее|next|more|[›»])$/iu.test(String(e.innerText||e.getAttribute("aria-label")||"").trim())||
              e.getAttribute("rel")==="next"))};
      });
    }catch{throw fail("registry_browser_unavailable");}
  }
  async function card(url,ogrn){
    const check=value=>isVbrCompanyUrl(value,ogrn)&&!new URL(value).hash;
    if(!await navigate(url,check))return null;
    for(let i=0;i<4;i++){
      const raw=await readBody(check);
      const record=extractRegistryVbrRecord(raw);
      if(record&&record.ogrn===ogrn)return {record,url:page.url()};
      if(i<3)await page.waitForTimeout(650);
    }
    return null;
  }
  return {
    get pages(){return pages;},
    async search(target,hint){
      const query=clean(hint?.inn||target.organization);
      if(provider==="fns")
        return lookupFnsViaBrowser(page,{query,navigate,readBody});
      const check=value=>exactRegistrySearchRoute(value,query);
      if(!await navigate(registrySearchUrl(query),check))
        throw fail("registry_http_unavailable");
      let state=null,previous="",stable=false;
      for(let i=0;i<5;i++){
        const snap=await snapshot(check);
        if(/(?:^|\n)(?:подтвердите,? что вы не робот|проверка безопасности|доступ запрещ[её]н|access denied|just a moment|captcha)(?:[.!:\s]|$)/imu.test(snap.text))
          throw fail("registry_http_unavailable");
        state=inspectRegistrySearch(snap,query);
        const signature=JSON.stringify([state.links.map(x=>x.ogrn).sort(),state.total,
          state.inputExact,state.complete,state.empty]);
        if(signature===previous&&(state.links.length||state.empty)){stable=true;break;}
        previous=signature;
        if(i<4)await page.waitForTimeout(650);
      }
      if(!state||!stable||(!state.links.length&&!state.empty)){
        if(++uncertain>=3)throw fail("registry_search_unresponsive");
        return {state:"unconfirmed",complete:false,allCardsRead:false,records:[]};
      }
      uncertain=0;
      // Prefer anchors explicitly displaying the source legal name when a
      // broad result set exceeds the bounded inspection limit. Such a
      // truncated set can NEVER establish unique name+locality proof.
      const sorted=[...state.links].sort((a,b)=>
        Number(sameRegisteredName(target.organization,b.title))-
        Number(sameRegisteredName(target.organization,a.title)));
      const selected=sorted.slice(0,maxCandidates);
      const records=[];
      for(const link of selected){
        const item=await card(link.url,link.ogrn);
        if(item)records.push(item);
      }
      return {state:"observed",complete:state.complete||state.empty,
        allCardsRead:selected.length===state.links.length&&
          records.length===selected.length,records};
    },
    async confirm(ogrn){
      const url=independentRegistryRoute(ogrn);
      const check=value=>canonicalIndependentRegistryRoute(value,ogrn)&&!new URL(value).hash;
      if(!url||!await navigate(url,check))return null;
      for(let i=0;i<4;i++){
        const raw=await readBody(check);
        const record=extractRegistryTbankRecord(raw);
        if(record)return {record,url:page.url()};
        if(i<3)await page.waitForTimeout(650);
      }
      return null;
    }
  };
}
export async function withPublicRegistryLookup(task,options={}){
  let browser,context;
  try{
    browser=await chromium.launch({headless:true});
    context=await browser.newContext({locale:"ru-RU"});
    const page=await context.newPage();
    // Do not load unnecessary large assets. Normal website scripts and
    // navigation are left intact; no auth state or privileged access.
    // The official FNS UI is left fully intact, including any challenge.
    if(options.provider!=="fns")
      await page.route("**/*",route=>
        ["image","font","media"].includes(route.request().resourceType())?
          route.abort():route.continue());
    return await task(await createPublicRegistryLookup(page,options));
  }finally{
    if(context)await context.close().catch(()=>{});
    if(browser)await browser.close().catch(()=>{});
  }
}
