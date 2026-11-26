// Bounded statistics recovery, separate from commercial qualification.
// A technical failure is not evidence that an industry has zero companies.
import {STAT_COLS} from "./constants.js";
import {isOpenAIBillingStop} from "./openaiBillingGuard.js";

export const REGIONAL_STATISTICS=Object.freeze([
  {id:"population",label:"Население региона"},
  {id:"forestry",label:"Количество лесных хозяйств"},
  {id:"waste",label:"Количество перевозчиков промышленных и бытовых отходов"},
  {id:"roads",label:"Количество дорожных ремонтно-строительных компаний"},
  {id:"agriculture",label:"Количество агро-хозяйств"},
  {id:"wood",label:"Количество деревообрабатывающих компаний"},
  {id:"chipboard",label:"Количество производителей ДСП"},
  {id:"scrap",label:"Количество компаний по вывозу металлического лома/вторчермета"}
]);
const normalize=value=>String(value??"").trim().toLowerCase().replace(/ё/g,"е").replace(/[\s–—-]+/gu," ");
export function regionalStatisticId(value){
  const s=normalize(value);
  const exact=REGIONAL_STATISTICS.find(item=>normalize(item.label)===s);
  if(exact)return exact.id;
  const matches=[
    ["population",/населени|число жителей/u],
    ["forestry",/лесн.{0,20}хозяйств|лесхоз/u],
    ["waste",/(?:перевоз|вывоз|транспортиров).{0,100}(?:отход|тко|тбо)/u],
    ["roads",/дорожн.{0,50}(?:строит|ремонт)|(?:строит|ремонт).{0,60}дорог/u],
    ["agriculture",/агро|сельскохозяйств/u],
    ["wood",/деревообраб|деревообрабатыва/u],
    ["chipboard",/дсп|древесно.{0,8}стружеч/u],
    ["scrap",/металлическ.{0,30}лом|металлолом|вторчермет/u]
  ].filter(([,re])=>re.test(s));
  return matches.length===1?matches[0][0]:"";
}
const hasSource=value=>String(value??"").match(/https?:\/\/[^\s<>"']+/g)?.some(raw=>{
  try{const u=new URL(raw);return Boolean(u.hostname.includes(".")&&!u.username&&!u.password);}
  catch{return false;}
})===true;
const knownNumber=value=>typeof value==="number"?Number.isFinite(value)&&value>=0:
  /^\d+(?:[ ,.\u00a0\u202f]\d+)*$/u.test(String(value??"").trim());
function validRow(row){
  if(!row||typeof row!=="object"||row.__statistics_unresolved===true)return false;
  const value=row["Значение"],method=String(row["Методика / примечание"]??"").trim();
  if(/^(?:н\/д|н\.д\.|нет данных|не установлено)$/i.test(String(value??"").trim()))
    return method.length>=12;
  return knownNumber(value)&&hasSource(row["Источник"])&&
    Boolean(String(row["Единица измерения"]??"").trim())&&
    Boolean(String(row["Период / дата актуальности"]??"").trim())&&method.length>0;
}
function canonicalRow(row,item){
  return Object.fromEntries(STAT_COLS.map(col=>[col,col==="Показатель"?item.label:(row[col]??"")]));
}
function ingest(rows,accepted,allowed,diagnostics){
  for(const row of Array.isArray(rows)?rows:[]){
    const id=regionalStatisticId(row?.["Показатель"]);
    if(!id||!allowed.has(id)||!validRow(row)){
      diagnostics.rejected++;
      continue;
    }
    const item=REGIONAL_STATISTICS.find(x=>x.id===id);
    const candidate=canonicalRow(row,item);
    if(accepted.has(id)){
      if(JSON.stringify(accepted.get(id))!==JSON.stringify(candidate))diagnostics.duplicate_conflicts++;
      continue;
    }
    accepted.set(id,candidate);
  }
}
export function regionalStatisticsCoverage(rows){
  const accepted=new Map(),diagnostics={rejected:0,duplicate_conflicts:0};
  ingest(rows,accepted,new Set(REGIONAL_STATISTICS.map(x=>x.id)),diagnostics);
  return {complete:accepted.size===REGIONAL_STATISTICS.length,
    accepted:accepted.size,missing:REGIONAL_STATISTICS.filter(x=>!accepted.has(x.id)).map(x=>x.id),
    ...diagnostics};
}
export function regionalStatisticsPrompt(items){
  return [
    "Верни ТОЛЬКО JSON {\"statistics\":[]}.",
    "Заполни только перечисленные показатели, без повторов и посторонних строк:",
    ...items.map(item=>"- "+item.label),
    "Каждая строка содержит ровно поля: "+STAT_COLS.map(x=>JSON.stringify(x)).join(", ")+".",
    "Числовое значение только с конкретным источником, единицей измерения, датой/периодом и воспроизводимой методикой. Для населения используй официальную актуальную статистику.",
    "Не оценивай число организаций по размеру текущей исследовательской выборки. Не подменяй число компаний числом объектов, филиалов или транспортных средств.",
    "Если точное число не удалось подтвердить, укажи н/д и конкретную причину в методике; не выдумывай чисел и источников."
  ].join("\n");
}
// At most two paid requests for all eight indicators together. Only genuinely
// missing/invalid indicators enter the second request. Billing pauses are
// durable and do not spend a retry slot for a request rejected before work.
export async function runRegionalStatistics({
  initialRows=[],initialState=null,request,onCheckpoint=async()=>{},
  assertNotCancelled=async()=>{},isBudgetStop=()=>false,maxAttempts=2
}={}){
  if(typeof request!=="function")throw TypeError("Regional statistics request required");
  maxAttempts=Math.max(1,Math.min(2,Math.trunc(Number(maxAttempts)||2)));
  const accepted=new Map(),diagnostics={rejected:0,duplicate_conflicts:0};
  ingest(initialRows,accepted,new Set(REGIONAL_STATISTICS.map(x=>x.id)),diagnostics);
  let attempts=initialState?.version===1?Math.max(0,Math.min(maxAttempts,Math.trunc(Number(initialState.attempts)||0))):0;
  let lastError="",status="pending";
  const missing=()=>REGIONAL_STATISTICS.filter(x=>!accepted.has(x.id));
  const snapshot=()=>{
    const unresolved=missing();
    const state={version:1,attempts,accepted:accepted.size,missing:unresolved.map(x=>x.id),
      complete:unresolved.length===0,status:unresolved.length===0?"complete":status,
      last_error:lastError,...diagnostics};
    const rows=REGIONAL_STATISTICS.map(item=>accepted.get(item.id)||{
      "Показатель":item.label,"Значение":"н/д","Единица измерения":"",
      "Период / дата актуальности":"","Источник":"",
      "Методика / примечание":"Показатель не подтверждён: "+(
        status==="budget_deferred"?"достигнут лимит исследования":
        status==="billing_paused"?"пауза OpenAI API":
        "не получен пригодный для проверки ответ"),
      __statistics_unresolved:true
    });
    return {rows,state};
  };
  while(missing().length&&attempts<maxAttempts){
    await assertNotCancelled();
    const items=missing();
    let raw,error;
    try{raw=await request(items,{attempt:attempts+1});}
    catch(e){error=e;}
    if(error){
      if(isOpenAIBillingStop(error)){
        status="billing_paused";lastError="openai_billing_stop";
        await onCheckpoint(snapshot());
        throw error;
      }
      if(error?.message==="JOB_CANCELLED"||error?.name==="AbortError")throw error;
      if(isBudgetStop(error)){
        status="budget_deferred";lastError="research_budget";
        await onCheckpoint(snapshot());
        return snapshot();
      }
      attempts++;
      status="technical_deferred";lastError="statistics_request_failed";
    }else{
      attempts++;
      ingest(raw?.statistics??raw,accepted,new Set(items.map(x=>x.id)),diagnostics);
      status=missing().length?"partial":"complete";
      lastError="";
    }
    await onCheckpoint(snapshot());
  }
  if(missing().length&&status==="pending")status=initialState?.status||"partial";
  return snapshot();
}
