// Bounded public-registry navigation only. No login, CAPTCHA bypass,
// private endpoint, Saby request, or paid API. A single fresh Chromium
// context is separate from the authenticated Stage12 Saby profile.
import {chromium} from "playwright";
import {extractVbrGeneralIdentity,isVbrCompanyUrl,unwrapVbrDuplicate,chooseVbrCompanyUrl}
  from "./sabyIndependentVbrBridge.js";
import {lookupFnsViaBrowser} from "./independentInnFns.js";
import {downloadOfficialFnsExtract} from "./independentInnFnsExtract.js";
import {extractIndependentRegistryIdentity,independentRegistryRoute,
  canonicalIndependentRegistryRoute,sameRegisteredName}
  from "./sabyIndependentNameBridge.js";

const clean=v=>String(v??"").normalize("NFKC").replace(/\s+/gu," ").trim();
const lines=v=>String(v||"").slice(0,120000).split(/[\r\n]+/u)
  .map(clean).filter(Boolean);
function fail(code,details={}){return Object.assign(Error(code),{code,...details});}
// Deliberately avoid raw exception messages and URLs (which can contain
// identifiers or session tokens). Only allowlisted transport categories.
function navigationFailure(error){
  const message=String(error?.message||"");
  if(error?.name==="TimeoutError")return "timeout";
  if(/ERR_NAME_NOT_RESOLVED|ERR_DNS/i.test(message))return "dns";
  if(/ERR_CERT_|ERR_SSL_/i.test(message))return "tls";
  if(/ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_REFUSED/i.test(message))return "connection";
  if(/ERR_ABORTED/i.test(message))return "aborted";
  if(/ERR_TIMED_OUT/i.test(message))return "timeout";
  if(/ERR_BLOCKED_BY_CLIENT|ERR_ACCESS_DENIED/i.test(message))return "blocked";
  if(/ERR_HTTP2_|ERR_QUIC_|ERR_HTTP_RESPONSE_CODE_FAILURE/i.test(message))return "http";
  return "other";
}
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
  if(index<0)return null;
  const status=head.slice(Math.max(0,index-3),index+7);
  if(status.some(l=>/^(?:ликвидирован[ао]?|организация ликвидирована|деятельность прекращена|организация в процессе ликвидации|организация в процессе банкротства)(?:[.! ]|$)/iu.test(l)))return false;
  return status.some(l=>/^действующая организация(?:\.|$)/iu.test(l))?true:null;
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
  maxPages=80,delayMs=900,maxCandidates=8,provider="vbr",confirmationMode="registry",onDiagnostic=()=>{}
}={}){
  if(!["vbr","fns"].includes(provider)||
     !["registry","extract"].includes(confirmationMode)||
     (confirmationMode==="extract"&&provider!=="fns")||
     !Number.isSafeInteger(maxPages)||maxPages<1||maxPages>3000||
     !Number.isSafeInteger(maxCandidates)||maxCandidates<1||maxCandidates>12)
    throw Error("REGISTRY_LOOKUP_BAD_BUDGET");
  const delay=Math.max(provider==="fns"?2000:500,
    Math.min(10000,Number(delayMs)||900));
  let pages=0,uncertain=0,extractDownloads=0,extractFailures=0,lastFnsSearch=null;
  const useExtract=provider==="fns"&&confirmationMode==="extract";
  const unavailable=new Set(),failures=new Map();
  const diag=(source,stage,reason,extra={})=>
    onDiagnostic({provider:source,stage,reason,page_navigations:pages,...extra});
  async function navigate(url,check,{waitUntil="domcontentloaded",source=provider,stage="navigation"}={}){
    if(pages>=maxPages)throw fail("navigation_budget");
    if(pages)await page.waitForTimeout(delay);
    pages++;
    let response;
    try{
      response=await page.goto(url,{waitUntil,timeout:18000});
    }catch(error){
      const transport=navigationFailure(error);
      diag(source,stage,"registry_browser_unavailable",{transport});
      throw fail("registry_browser_unavailable",{transport});
    }
    const status=Number(response?.status?.()||0);
    diag(source,stage,"http_response",{http_status:status});
    if(status===404&&check(page.url()))return false;
    if(status!==200)throw fail("registry_http_unavailable",{http_status:status});
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
  // Confirmation cards need not wait for unrelated page resources. Use
  // commit + bounded, route-checked content polling, as the independent
  // Stage12 name bridges already do.
  async function readConfirmationCard(url,ogrn,source,check,extract){
    if(!await navigate(url,check,{waitUntil:"commit",source,stage:"card_navigation"})){
      diag(source,"card_navigation","not_found",{http_status:404});
      return null;
    }
    let last=null,readSucceeded=false;
    for(let i=0;i<7;i++){
      try{
        const raw=await readBody(check);
        readSucceeded=true;
        const record=extract(raw);
        if(record){
          if(record.ogrn!==ogrn){
            // A readable contradictory card is not a transport failure.
            // Pass it back for the ordinary strict identity rejection.
            diag(source,"card_read","identifier_mismatch");
            return {record,url:page.url()};
          }
          last={record,url:page.url()};
          if(record.active===false||(record.active===true&&
            (provider!=="fns"||record.address)))return last;
        }
      }catch(error){
        if(error?.code!=="registry_browser_unavailable")throw error;
      }
      if(i<6)await page.waitForTimeout(650);
    }
    if(!readSucceeded)throw fail("registry_browser_unavailable",{transport:"snapshot"});
    diag(source,"card_read",last?"record_incomplete":"record_unavailable");
    return last;
  }
  async function card(url,ogrn){
    const check=value=>isVbrCompanyUrl(value,ogrn)&&!new URL(value).hash;
    return readConfirmationCard(url,ogrn,"vbr",check,extractRegistryVbrRecord);
  }
  async function confirmVbr(ogrn){
    const check=value=>exactRegistrySearchRoute(value,ogrn);
    if(!await navigate(registrySearchUrl(ogrn),check,
      {waitUntil:"commit",source:"vbr",stage:"ogrn_search_navigation"}))return null;
    let previous="",stable=false,seen=new Set(),readSucceeded=false;
    for(let i=0;i<6;i++){
      try{
        const snap=await snapshot(check);
        readSucceeded=true;
        if(/(?:^|\n)(?:подтвердите,? что вы не робот|проверка безопасности|доступ запрещ[её]н|access denied|just a moment|captcha)(?:[.!:\s]|$)/imu.test(snap.text))
          throw fail("registry_http_unavailable");
        const urls=(snap.links||[]).map(item=>item.url)
          .filter(url=>isVbrCompanyUrl(url,ogrn)&&!new URL(url).hash);
        for(const url of urls)seen.add(url);
        if(seen.size>1||snap.truncated){
          diag("vbr","ogrn_search","ambiguous_or_truncated");
          return null;
        }
        const current=JSON.stringify([...new Set(urls)].sort());
        if(urls.length&&current===previous){stable=true;break;}
        previous=current;
      }catch(error){
        if(error?.code!=="registry_browser_unavailable")throw error;
      }
      if(i<5)await page.waitForTimeout(650);
    }
    if(!readSucceeded)throw fail("registry_browser_unavailable",{transport:"snapshot"});
    const url=stable?chooseVbrCompanyUrl([...seen],ogrn):"";
    if(!url){diag("vbr","ogrn_search","exact_card_unavailable");return null;}
    return card(url,ogrn);
  }
  function sameIdsAndNames(a,b){
    return !!a&&!!b&&a.inn===b.inn&&a.kpp===b.kpp&&a.ogrn===b.ogrn&&
      sameRegisteredName(a.full_name,b.full_name)&&sameRegisteredName(a.short_name,b.short_name);
  }
  async function attemptConfirmation(source,task){
    if(unavailable.has(source))return null;
    try{
      const found=await task();
      failures.set(source,0);
      diag(source,"confirmation",found?"record_read":"record_unavailable",
        {address_present:Boolean(found?.record?.address),
          active_status:found?.record?.active===true?"active":
            found?.record?.active===false?"inactive":"unknown"});
      return found;
    }catch(error){
      if(error?.code==="navigation_budget")throw error;
      if(page.isClosed?.())throw fail("registry_browser_unavailable");
      const code=["registry_browser_unavailable","registry_http_unavailable","registry_route_untrusted"].includes(error?.code)?
        error.code:"registry_browser_unavailable";
      const count=(failures.get(source)||0)+1;
      failures.set(source,count);
      // Do not retry access restrictions or untrusted routes. A
      // separate independent public source may still supply proof.
      if(code!=="registry_browser_unavailable"||error?.transport==="blocked"||count>=2)
        unavailable.add(source);
      diag(source,"confirmation",code,{
        ...(error?.transport?{transport:error.transport}:{}),
        ...(Number.isInteger(error?.http_status)?{http_status:error.http_status}:{}),
        disabled:unavailable.has(source)});
      return null;
    }
  }
  return {
    get pages(){return pages;},
    get extractDownloads(){return extractDownloads;},
    async search(target,hint){
      const query=clean(hint?.inn||target.organization);
      if(provider==="fns"){
        lastFnsSearch=null;
        const observed=await lookupFnsViaBrowser(page,{query,navigate,readBody,
          completeNameSearch:useExtract});
        lastFnsSearch=observed;
        if(observed.query_kind!=="identifier")
          diag("fns","name_search",observed.complete&&observed.allCardsRead?
            "fns_name_complete":"fns_name_incomplete",observed.completeness);
        return observed;
      }
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
        if(item&&item.record.ogrn===link.ogrn)records.push(item);
      }
      return {state:"observed",complete:state.complete||state.empty,
        allCardsRead:selected.length===state.links.length&&
          records.length===selected.length,records};
    },
    async confirm(ogrn,expected){
      if(useExtract){
        if(!expected||expected.ogrn!==ogrn||!/^\d{13}$/.test(ogrn))return null;
        // Reuse the actual current single-result page only if all three
        // identifiers and both names match. Otherwise perform a normal
        // visible-form query by the official OGRN, not a fabricated URL.
        let observed=lastFnsSearch;
        const uniqueMatch=result=>result?.state==="observed"&&result.complete===true&&
          result.allCardsRead===true&&result.records.length===1&&
          sameIdsAndNames(expected,result.records[0].record);
        if(!uniqueMatch(observed)){
          observed=await lookupFnsViaBrowser(page,{query:ogrn,navigate,readBody,
            completeNameSearch:true});
        }
        lastFnsSearch=null;
        if(!uniqueMatch(observed)){
          diag("fns","extract_lookup","fns_extract_identity_unproven");
          return null;
        }
        // Count the download in the existing hard navigation/request budget.
        if(pages>=maxPages)throw fail("navigation_budget");
        await page.waitForTimeout(delay);
        pages++;extractDownloads++;
        const downloaded=await downloadOfficialFnsExtract(page,expected,{
          onDiagnostic:value=>{const {reason,...extra}=value;
            diag("fns","extract",reason,extra);}
        });
        if(downloaded)extractFailures=0;
        else if(++extractFailures>=3)throw fail("fns_extract_unavailable");
        return downloaded;
      }
      const url=independentRegistryRoute(ogrn);
      if(!url)return null;
      const check=value=>canonicalIndependentRegistryRoute(value,ogrn)&&!new URL(value).hash;
      const readBank=()=>readConfirmationCard(url,ogrn,"tbank",check,extractRegistryTbankRecord);
      if(provider!=="fns")return readBank();
      const bank=await attemptConfirmation("tbank",readBank);
      // Never switch sources to override a contradictory readable card,
      // including a confirmed inactive status. Only missing proof or a
      // technical failure allows the unrelated VBR confirmation route.
      if(bank&&((expected&&!sameIdsAndNames(expected,bank.record))||
        bank.record.ogrn!==ogrn||bank.record.active===false||
        (bank.record.active===true&&bank.record.address)))return bank;
      const vbr=await attemptConfirmation("vbr",()=>confirmVbr(ogrn));
      if(bank&&vbr&&(!sameIdsAndNames(bank.record,vbr.record)||
        (bank.record.address&&vbr.record.address&&
          clean(bank.record.address).toLowerCase()!==clean(vbr.record.address).toLowerCase()))){
        diag("vbr","confirmation","conflicting_independent_records");
        return null;
      }
      if(vbr)return vbr;
      if(unavailable.has("tbank")&&unavailable.has("vbr"))
        throw fail("registry_confirmation_unavailable");
      return bank;
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
