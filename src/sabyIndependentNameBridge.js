// Read-only independent bridge for full/short REGISTERED legal names.
// Activated only when canonical Saby has independently confirmed one exact
// INN/KPP/OGRN, but its displayed short name does not equal source full name.
// Do not infer identity from shared tokens. Do not log page content or names.
import {sabyInn,sabyNameMatches,sabyNameTokens} from "./sabyEnrichment.js";
import {auditLegalForm} from "./sabyIdentityAudit.js";

const compact=value=>String(value||"").normalize("NFKC")
  .replace(/\s+/gu," ").trim();
const numbered=value=>compact(value).replace(/\s/gu,"");
const legalTypes=[
  ["ФГУП",/^(?:ФГУП|ФЕДЕРАЛЬНОЕ\s+ГОСУДАРСТВЕННОЕ\s+УНИТАРНОЕ\s+ПРЕДПРИЯТИЕ)(?=$|[\s"«„(])/iu],
  ["ГУП",/^(?:ГУП|ГОСУДАРСТВЕННОЕ\s+УНИТАРНОЕ\s+ПРЕДПРИЯТИЕ)(?=$|[\s"«„(])/iu],
  ["МУП",/^(?:МУП|МУНИЦИПАЛЬНОЕ\s+УНИТАРНОЕ\s+ПРЕДПРИЯТИЕ)(?=$|[\s"«„(])/iu]
];
function unitaryName(value){
  let name=compact(value),form="";
  for(const [code,pattern] of legalTypes){
    const found=pattern.exec(name);
    if(found){
      form=code;name=name.slice(found[0].length).trim();
      break;
    }
  }
  if(!form){
    const end=/,\s*(ФГУП|ГУП|МУП)\s*$/iu.exec(name);
    if(end){
      form=end[1].toUpperCase();
      name=name.slice(0,end.index).trim();
    }
  }
  const tokens=sabyNameTokens(name);
  return {form,tokens};
}
// Explicit unitary company type is part of identity even when name tokens
// match. Other legal forms continue using the existing strict name policy.
export function sameRegisteredName(a,b){
  const left=unitaryName(a),right=unitaryName(b);
  if(left.form||right.form){
    return !!left.form&&left.form===right.form&&
      left.tokens.length>0&&left.tokens.length===right.tokens.length&&
      left.tokens.every((token,index)=>token===right.tokens[index]);
  }
  const formA=auditLegalForm(a),formB=auditLegalForm(b);
  if(formA&&formB&&formA!==formB)return false;
  return sabyNameMatches(a,b);
}

export function independentRegistryRoute(ogrn){
  const value=numbered(ogrn);
  return /^\d{13}$/.test(value)?
    "https://www.tbank.ru/business/contractor/legal/"+value+"/":"";
}
export function canonicalIndependentRegistryRoute(url,ogrn){
  const expected=independentRegistryRoute(ogrn);
  if(!expected)return false;
  try {
    const u=new URL(String(url||""));
    return u.protocol==="https:"&&u.hostname==="www.tbank.ru"&&
      u.port===""&&!u.username&&!u.password&&
      u.pathname===new URL(expected).pathname&&u.search==="";
  } catch{return false;}
}

const labels=[
  ["full_name","Полное название"],["short_name","Краткое название"],
  ["inn","ИНН"],["kpp","КПП"],["ogrn","ОГРН"]
];
const boundaries=/^(?:Регистрация ФНС|Бухгалтерская отчетность|Виды деятельности|Госконтракты|Лицензии|Отзывы|Контакты|Факты о компании)$/iu;
const labelValue=(line,label)=>{
  const value=compact(line);
  if(value.toLowerCase()===label.toLowerCase())return {inline:false,value:""};
  const prefix=label+":";
  if(value.toLowerCase().startsWith(prefix.toLowerCase()))
    return {inline:true,value:compact(value.slice(prefix.length))};
  return null;
};
// Read strictly within ONE bounded "Реквизиты" panel, never stitch data
// from the header, related companies or other parts of the page.
export function extractIndependentRegistryIdentity(raw){
  const lines=String(raw||"").slice(0,120000)
    .split(/[\r\n]+/u).map(compact).filter(Boolean);
  const result=[];
  for(let i=0;i<lines.length;i++){
    if(lines[i]!=="Реквизиты")continue;
    let end=Math.min(lines.length,i+100);
    for(let j=i+1;j<end;j++){
      if(boundaries.test(lines[j])){end=j;break;}
    }
    const seen={};
    for(let j=i+1;j<end;j++){
      for(const [key,label] of labels){
        const matched=labelValue(lines[j],label);
        if(!matched)continue;
        const value=matched.inline?matched.value:lines[j+1]||"";
        if(j+1>=end&&!matched.inline)continue;
        if(!matched.inline&&(boundaries.test(value)||
          labels.some(([,other])=>labelValue(value,other))))continue;
        if(!seen[key])seen[key]=new Set();
        if(value)seen[key].add(value);
      }
    }
    if(!labels.every(([key])=>seen[key]?.size===1))continue;
    const record=Object.fromEntries(labels.map(([key])=>
      [key,[...seen[key]][0]]));
    record.inn=numbered(record.inn);
    record.kpp=numbered(record.kpp);
    record.ogrn=numbered(record.ogrn);
    if(!/^\d{10}$/.test(record.inn)||!/^\d{9}$/.test(record.kpp)||
      !/^\d{13}$/.test(record.ogrn)||
      !record.full_name||!record.short_name)continue;
    result.push(record);
  }
  // Even two different complete blocks are ambiguous. Do not guess.
  return result.length===1?result[0]:null;
}
export function compareIndependentRegistryAlias({
  expectedInn,expectedKpp,expectedOgrn,sourceName,sabyShortName,
  sabyPublicTitle,record
}={}){
  const reject=reason=>({status:"review",reason});
  const inn=sabyInn(expectedInn),kpp=numbered(expectedKpp),
    ogrn=numbered(expectedOgrn);
  if(!inn||inn.length!==10||!/^\d{9}$/.test(kpp)||
    !/^\d{13}$/.test(ogrn))
    return reject("invalid_registry_request");
  if(!record)return reject("independent_requisites_unavailable");
  if(record.inn!==inn||record.kpp!==kpp||record.ogrn!==ogrn)
    return reject("independent_registry_identifier_mismatch");
  if(!sameRegisteredName(sourceName,record.full_name))
    return reject("independent_registered_name_mismatch");
  if(!sameRegisteredName(sabyShortName,record.short_name)||
     !sameRegisteredName(sabyPublicTitle,sabyShortName))
    return reject("independent_short_name_mismatch");
  return {status:"verified",reason:"independent_registry_alias_verified",
    official_full_name:record.full_name,inn,kpp,ogrn};
}
export async function verifyIndependentRegistryAlias(page,options,{
  timeoutMs=12000
}={}){
  const url=independentRegistryRoute(options?.expectedOgrn);
  if(!url||typeof page?.context!=="function")
    return {status:"review",reason:"invalid_registry_request"};
  let tab;
  let phase="open_tab";
  try {
    tab=await page.context().newPage();
    phase="navigate";
    // A third-party SPA may commit an HTTP response long before firing
    // DOMContentLoaded. Await only a committed document; the bounded,
    // company-scoped requisites poll below verifies actual content.
    const response=await tab.goto(url,{
      waitUntil:"commit",timeout:Math.min(20000,timeoutMs)
    });
    phase="read_document";
    if(!canonicalIndependentRegistryRoute(tab.url(),options.expectedOgrn))
      return {status:"review",reason:"independent_registry_route_untrusted"};
    if(Number(response?.status?.()||0)!==200)
      return {status:"review",reason:"independent_registry_http_error"};
    const checks=Math.min(5,Math.max(1,Math.ceil(timeoutMs/2500)));
    for(let attempt=0;attempt<checks;attempt++){
      if(!canonicalIndependentRegistryRoute(tab.url(),options.expectedOgrn))
        return {status:"review",reason:"independent_registry_route_untrusted"};
      const text=await tab.evaluate(()=>
        String(document.body?.innerText||"").slice(0,120000));
      const record=extractIndependentRegistryIdentity(text);
      if(record)return compareIndependentRegistryAlias({...options,record});
      if(attempt+1<checks)await tab.waitForTimeout(650);
    }
    return {status:"review",reason:"independent_requisites_unavailable"};
  } catch{
    // Do not disclose the browser exception, target URL, page HTML or
    // identifiers. Distinguish an unreachable site from a broken page
    // reader so the operator can test network access without running Saby.
    return {status:"review",reason:phase==="navigate"?
      "independent_registry_navigation_failed":
      phase==="open_tab"?"independent_registry_browser_unavailable":
      "independent_registry_snapshot_unavailable"};
  } finally {
    if(tab)await tab.close().catch(()=>{});
  }
}
