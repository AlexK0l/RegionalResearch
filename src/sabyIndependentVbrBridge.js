// Independent, read-only proof of registered full/short titles via VBR.
// Never fabricate a company slug. Obtain exactly one candidate from VBR
// search by OGRN, and verify the returned page's INN/KPP/OGRN and BOTH names.
import {compareIndependentRegistryAlias} from "./sabyIndependentNameBridge.js";

const clean=value=>String(value??"").normalize("NFKC")
  .replace(/\s+/gu," ").trim();
const registryDomain="kontragent.vbr.ru";
const id13=ogrn=>/^\d{13}$/.test(String(ogrn||""));
export const vbrSearchUrl=ogrn=>id13(ogrn)?
  "https://"+registryDomain+"/search/?s="+ogrn:"";
export function isVbrSearchUrl(url,ogrn){
  if(!vbrSearchUrl(ogrn))return false;
  try{
    const u=new URL(String(url||""));
    return u.protocol==="https:"&&u.hostname===registryDomain&&
      u.port===""&&!u.username&&!u.password&&
      u.pathname==="/search/"&&u.searchParams.size===1&&
      u.searchParams.get("s")===ogrn;
  }catch{return false;}
}
export function isVbrCompanyUrl(url,ogrn){
  if(!id13(ogrn))return false;
  try{
    const u=new URL(String(url||""));
    return u.protocol==="https:"&&u.hostname===registryDomain&&
      u.port===""&&!u.username&&!u.password&&!u.search&&
      /^\/company\/[a-z0-9-]+-[0-9]{13}\/$/iu.test(u.pathname)&&
      u.pathname.endsWith("-"+ogrn+"/");
  }catch{return false;}
}
export function chooseVbrCompanyUrl(urls,ogrn){
  const valid=[...new Set((Array.isArray(urls)?urls:[]).filter(url=>
    isVbrCompanyUrl(url,ogrn)))];
  return valid.length===1?valid[0]:"";
}
// VBR can display 2 copies of a value in one visible field: text nodes
// represent desktop/mobile markup. Accept only IDENTICAL halves.
export function unwrapVbrDuplicate(value){
  const str=clean(value);
  const len=str.length/2;
  if(Number.isInteger(len)&&len>0&&str.slice(0,len)===str.slice(len))
    return str.slice(0,len);
  // Desktop/mobile copies can also have one separating whitespace.
  const half=(str.length-1)/2;
  if(Number.isInteger(half)&&half>0&&str[half]===" "&&
    str.slice(0,half)===str.slice(half+1))
    return str.slice(0,half);
  return str;
}
const fields=[
  ["full_name","Полное наименование"],
  ["short_name","Краткое наименование"],
  ["ogrn","ОГРН"],["inn","ИНН"],["kpp","КПП"]
];
const endSection=/^(?:Сведения об организации|Финансы(?: за \d{4})?|Учредители|Виды деятельности|Вид деятельности по ОКВЭД|Лицензии|Структура и связи|Проверки|Мониторинг организаций)$/iu;
export function extractVbrGeneralIdentity(text){
  const lines=String(text||"").slice(0,120000).split(/[\r\n]+/u)
    .map(clean).filter(Boolean);
  const records=[];
  for(let i=0;i<lines.length;i++){
    if(lines[i]!=="Общая информация")continue;
    let end=Math.min(lines.length,i+85);
    for(let j=i+1;j<end;j++)if(endSection.test(lines[j])){
      end=j;break;
    }
    const found=new Map();
    for(let j=i+1;j<end;j++){
      for(const [key,label] of fields){
        if(lines[j]!==label)continue;
        const next=lines[j+1]||"";
        if(j+1>=end||fields.some(([,other])=>other===next)||
          endSection.test(next))continue;
        const value=unwrapVbrDuplicate(next);
        if(!value)continue;
        if(!found.has(key))found.set(key,new Set());
        found.get(key).add(value);
      }
    }
    if(fields.some(([key])=>found.get(key)?.size!==1))continue;
    const record=Object.fromEntries(fields.map(([key])=>
      [key,[...found.get(key)][0]]));
    if(!/^\d{10}$/.test(record.inn)||
       !/^\d{9}$/.test(record.kpp)||
       !/^\d{13}$/.test(record.ogrn))continue;
    records.push(record);
  }
  return records.length===1?records[0]:null;
}
export async function verifyVbrIndependentRegistryAlias(page,options,{
  timeoutMs=12000
}={}){
  const ogrn=String(options?.expectedOgrn||"");
  const target=vbrSearchUrl(ogrn);
  if(!target||typeof page?.context!=="function")
    return {status:"review",reason:"vbr_invalid_request"};
  let tab,stage="new_tab";
  try{
    tab=await page.context().newPage();
    stage="search_navigate";
    const searchResponse=await tab.goto(target,{
      waitUntil:"commit",timeout:Math.min(16000,timeoutMs)
    });
    if(!isVbrSearchUrl(tab.url(),ogrn))
      return {status:"review",reason:"vbr_search_route_untrusted"};
    if(Number(searchResponse?.status?.()||0)!==200)
      return {status:"review",reason:"vbr_search_http_error"};
    stage="search_read";
    const seen=new Set();
    for(let i=0;i<6;i++){
      if(!isVbrSearchUrl(tab.url(),ogrn))
        return {status:"review",reason:"vbr_search_route_untrusted"};
      const urls=await tab.evaluate(()=>[...document.querySelectorAll("a[href]")]
        .slice(0,1200).map(a=>a.href).filter(Boolean));
      for(const url of urls)if(isVbrCompanyUrl(url,ogrn))seen.add(url);
      if(seen.size>1)
        return {status:"review",reason:"vbr_search_result_ambiguous"};
      if(seen.size===1)break;
      if(i<5)await tab.waitForTimeout(550);
    }
    const companyUrl=chooseVbrCompanyUrl([...seen],ogrn);
    if(!companyUrl)
      return {status:"review",reason:"vbr_search_result_unavailable"};
    stage="company_navigate";
    const response=await tab.goto(companyUrl,{
      waitUntil:"commit",timeout:Math.min(16000,timeoutMs)
    });
    if(!isVbrCompanyUrl(tab.url(),ogrn))
      return {status:"review",reason:"vbr_company_route_untrusted"};
    if(Number(response?.status?.()||0)!==200)
      return {status:"review",reason:"vbr_company_http_error"};
    stage="company_read";
    for(let i=0;i<5;i++){
      if(!isVbrCompanyUrl(tab.url(),ogrn))
        return {status:"review",reason:"vbr_company_route_untrusted"};
      const text=await tab.evaluate(()=>
        String(document.body?.innerText||"").slice(0,120000));
      const record=extractVbrGeneralIdentity(text);
      if(record){
        const proof=compareIndependentRegistryAlias({...options,record});
        return {...proof,provider:"vbr"};
      }
      if(i<4)await tab.waitForTimeout(650);
    }
    return {status:"review",reason:"vbr_registry_record_unavailable"};
  }catch{
    return {status:"review",reason:stage==="new_tab"?
      "vbr_browser_unavailable":
      stage==="search_navigate"?"vbr_search_navigation_failed":
      stage==="search_read"?"vbr_search_snapshot_unavailable":
      stage==="company_navigate"?"vbr_company_navigation_failed":
      "vbr_company_snapshot_unavailable"};
  }finally{
    if(tab)await tab.close().catch(()=>{});
  }
}
