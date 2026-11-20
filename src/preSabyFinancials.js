// Source-bound financial enrichment BEFORE Saby (stages 1-11).
// No network/API calls here: the normal, budgeted stage-10 web search supplies
// quotes and URLs. Saby only fills still-unavailable values in stage 12.
export const REVENUE_FIELD = "Выручка последнего подтвержденного года";
export const STAFF_FIELD = "Численность";
export const PRE_SABY_FINANCIAL_FIELDS = Object.freeze([REVENUE_FIELD, STAFF_FIELD]);

const INN_LABEL = /(?:^|[^\p{L}\p{N}])инн\s*[:№-]?\s*(\d{10}|\d{12})(?!\d)/giu;
const REVENUE_LABEL = /(?:выручк\p{L}*|доход(?:ы)?\s+от\s+основной\s+деятельности|оборот)/giu;
const STAFF_LABEL = /(?:численност\p{L}*|среднесписочн\p{L}*|сотрудник\p{L}*|работник\p{L}*|персонал)/giu;
const NUMBER = /(?<!\d)(\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s*(млрд|млн|тыс)?/giu;

function innOf(value) {
  const digits=String(value??"").replace(/\D/g,"");
  return /^(?:\d{10}|\d{12})$/.test(digits)?digits:"";
}
function whole(value,limit) {
  // No fractions, ranges, currency words or units in stored fields.
  if(typeof value==="number")
    return Number.isSafeInteger(value)&&value>0&&value<=limit?value:null;
  if(typeof value!=="string"||!/^\d+$/.test(value.trim()))return null;
  const number=Number(value.trim());
  return Number.isSafeInteger(number)&&number>0&&number<=limit?number:null;
}
export function hasPreSabyFinancialNumber(value,field) {
  return whole(value,field===STAFF_FIELD?10000000:1e15)!==null;
}
function sourceUrl(value) {
  try {
    const url=new URL(String(value||""));
    if(url.protocol!=="https:"||!url.hostname.includes(".")||
       url.hostname==="localhost"||url.hostname.endsWith(".local"))return "";
    return url.href;
  } catch {return "";}
}
function quoteBelongsToInn(quote,inn) {
  const mentioned=[...quote.matchAll(INN_LABEL)].map(m=>m[1]);
  return mentioned.length>0&&mentioned.every(value=>value===inn);
}
function numberFromText(amount,scale) {
  const numeric=Number(String(amount).replace(/[\s\u00a0\u202f]/g,"").replace(",","."));
  const unit=String(scale||"").toLowerCase();
  const factor=unit==="млрд"?1e9:unit==="млн"?1e6:unit==="тыс"?1e3:1;
  const rubles=numeric*factor;
  const rounded=Math.round(rubles);
  return Number.isSafeInteger(rounded)&&Math.abs(rounded-rubles)<0.00001?rounded:null;
}
function excerptShowsValue(quote,field,number) {
  const label=field===REVENUE_FIELD?REVENUE_LABEL:STAFF_LABEL;
  for(const match of quote.matchAll(label)) {
    // A claim must be next to a labelled measure, not elsewhere on the page
    // or embedded inside the entity INN/year/other numerical identifier.
    const fragment=quote.slice(match.index+match[0].length,match.index+match[0].length+130);
    for(const amount of fragment.matchAll(NUMBER)) {
      if(field===STAFF_FIELD && amount[2])continue; // 1.2 тыс ≠ exact headcount
      if(numberFromText(amount[1],amount[2])===number)return true;
    }
  }
  return false;
}
export function validatePreSabyFinancialFact(row,fact,nowYear=new Date().getUTCFullYear()) {
  const field=String(fact?.field||"");
  if(!PRE_SABY_FINANCIAL_FIELDS.includes(field))return null;
  const inn=innOf(row?.["ИНН"]);
  const value=whole(fact?.value,field===STAFF_FIELD?10000000:1e15);
  const url=sourceUrl(fact?.source_url);
  const excerpt=String(fact?.evidence_excerpt||"").trim().replace(/\s+/gu," ");
  if(!inn||value===null||!url||!excerpt||excerpt.length>2400 ||
     !quoteBelongsToInn(excerpt,inn)||!excerptShowsValue(excerpt,field,value))return null;
  let year="";
  if(field===REVENUE_FIELD) {
    year=String(fact?.year||"").trim();
    if(!/^\d{4}$/.test(year)||Number(year)<2000||Number(year)>nowYear ||
       !new RegExp("(?<!\\d)"+year+"(?!\\d)").test(excerpt))return null;
  } else if(/^\d{4}$/.test(String(fact?.year||"").trim())) {
    year=String(fact.year).trim();
    if(Number(year)>nowYear)return null;
  }
  return {field,value,year,source_url:url,evidence_excerpt:excerpt.slice(0,950),
    inn,method:"stage10_verified_source"};
}
function selectCandidate(facts,field) {
  const items=facts.filter(f=>f.field===field);
  if(!items.length)return null;
  const year=Math.max(...items.map(f=>Number(f.year||0)));
  const best=items.filter(f=>Number(f.year||0)===year);
  return new Set(best.map(f=>f.value)).size===1?best[0]:null;
}
export function applyPreSabyFinancialFacts(row,result,{nowYear=new Date().getUTCFullYear()}={}) {
  const facts=Array.isArray(result?.financial_facts)?
    result.financial_facts.slice(0,12):[];
  const checked=facts.map(f=>validatePreSabyFinancialFact(row,f,nowYear))
    .filter(Boolean);
  const applied=[];
  for(const field of PRE_SABY_FINANCIAL_FIELDS) {
    if(hasPreSabyFinancialNumber(row?.[field],field))continue;
    const chosen=selectCandidate(checked,field);
    if(!chosen)continue;
    row[field]=chosen.value;
    applied.push(chosen);
  }
  if(applied.length) {
    const old=row.__evidence||{};
    const previous=Array.isArray(old.pre_saby_financial_facts)?
      old.pre_saby_financial_facts:[];
    const all=[...previous];
    for(const item of applied) {
      if(!all.some(prior=>prior.field===item.field &&
          prior.inn===item.inn&&prior.value===item.value&&
          prior.year===item.year&&prior.source_url===item.source_url))
        all.push(item);
    }
    row.__evidence={
      ...old,
      source_urls:[...new Set([...(Array.isArray(old.source_urls)?old.source_urls:[]),
        ...applied.map(item=>item.source_url)])],
      pre_saby_financial_facts:all.slice(-40)
    };
  }
  return {applied,valid_facts:checked.length,rejected_facts:facts.length-checked.length};
}
export function preSabyFinancialCoverage(result) {
  const rows=["direct_buyers","intermediaries","leasing"]
    .flatMap(key=>Array.isArray(result?.[key])?result[key]:[]);
  const revenue=rows.filter(row=>hasPreSabyFinancialNumber(row?.[REVENUE_FIELD],REVENUE_FIELD)).length;
  const staff=rows.filter(row=>hasPreSabyFinancialNumber(row?.[STAFF_FIELD],STAFF_FIELD)).length;
  const sourceBacked=(field)=>rows.filter(row=>
    Array.isArray(row?.__evidence?.pre_saby_financial_facts) &&
    row.__evidence.pre_saby_financial_facts.some(f=>
      f.field===field&&Number(f.value)===Number(row[field])&&f.inn===innOf(row["ИНН"]))
  ).length;
  return {total:rows.length,
    revenue_present:revenue,revenue_missing:rows.length-revenue,
    employees_present:staff,employees_missing:rows.length-staff,
    stage10_source_backed_revenue:sourceBacked(REVENUE_FIELD),
    stage10_source_backed_employees:sourceBacked(STAFF_FIELD)};
}
