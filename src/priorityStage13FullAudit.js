// Stage 13: independent analysis of the completed Saby checkpoint and the
// full post-Saby replay. Financial amounts estimate OpenAI token charges;
// the provider's invoice is authoritative.
import {priority13AICandidates} from "./priorityStage13.js";

const number=v=>Number.isFinite(Number(v))?Math.max(0,Number(v)):0;
const rounded=(x,d=6)=>Number(Number(x||0).toFixed(d));
const band=v=>v>=70?"green":v>=40?"white":v>=20?"ordinary":"none";
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export function stage13SourceAudit(result,{maxPerBuyer=3,batchSize=10,maxCalls=12}={}){
  const buyers=Array.isArray(result?.direct_buyers)?result.direct_buyers:[];
  const selected=[],signatures=new Map(),bySource={evidence:0};
  let rows=0;
  for(let i=0;i<buyers.length;i++){
    const row=buyers[i],found=priority13AICandidates(row,{maxPerBuyer});
    if(found.length)rows++;
    for(const c of found){
      const signature=String(c.model_text||"").toUpperCase()
        .replace(/Ё/g,"Е").replace(/\s+/g," ").trim();
      selected.push({row:i+2,buyer:row["Организация"]||"",
        model:c.model_text,source:c.source,url:c.source_url||"",
        grade:row.__final_grade||"",prior_score:row["Итоговый коэффициент"]??null});
      bySource[c.source]=(bySource[c.source]||0)+1;
      if(!signatures.has(signature))signatures.set(signature,c.model_text);
    }
  }
  const unique=[...signatures.values()];
  const calls=Math.ceil(unique.length/batchSize);
  const batches=Array.from({length:calls},(_,i)=>unique.slice(i*batchSize,(i+1)*batchSize));
  // This baseline was observed from one 5-model live smoke on the same API:
  // 828 input / 418 output. Intercepts approximate per-request overhead.
  const predictedInput=batches.reduce((s,b)=>s+Math.ceil(228+120*b.length),0);
  const predictedOutput=batches.reduce((s,b)=>s+Math.ceil(70+70*b.length),0);
  const expectedUsd=rounded((predictedInput*0.20+predictedOutput*1.20)/1e6);
  const upperUsd=rounded(batches.reduce((s,b)=>
    s+(Math.ceil(228+160*b.length)*0.20+3500*1.20)/1e6,0));
  return {buyers:buyers.length,candidate_rows:rows,candidates:selected.length,
    unique_models:unique.length,planned_calls:calls,
    available_calls:maxCalls,batch_size:batchSize,
    capacity:maxCalls*batchSize,all_models_fit:calls<=maxCalls,
    by_source:bySource,unique_models_list:unique,
    candidates_detail:selected,
    token_forecast:{input:predictedInput,output:predictedOutput,
      expected_usd:expectedUsd,conservative_usd:upperUsd,
      basis:"828 input / 418 output tokens for five models in 2026-11-17 Smolensk live smoke; indicative only"}
  };
}
export function stage13UsageSummary(records,{
  inputUsdPerM=0.2,outputUsdPerM=1.2,cachedInputUsdPerM=0.02,
  model="gpt-5.6-luna"
}={}){
  const perCall=(Array.isArray(records)?records:[]).map((r,index)=>{
    const input=number(r?.input_tokens);
    const output=number(r?.output_tokens);
    const cached=Math.min(input,number(r?.input_tokens_details?.cached_tokens));
    const written=Math.min(input-cached,number(r?.input_tokens_details?.cache_write_tokens));
    const normal=Math.max(0,input-cached);
    const estimatedUsd=(normal*inputUsdPerM+cached*cachedInputUsdPerM+
      output*outputUsdPerM+written*inputUsdPerM*0.25)/1e6;
    return {call:index+1,input_tokens:input,cached_input_tokens:cached,
      cache_write_tokens:written,output_tokens:output,
      reasoning_tokens:number(r?.output_tokens_details?.reasoning_tokens),
      total_tokens:number(r?.total_tokens)||input+output,
      estimated_token_cost_usd:rounded(estimatedUsd,8)};
  });
  return {model,api_calls_with_usage:perCall.length,
    input_tokens:perCall.reduce((s,r)=>s+r.input_tokens,0),
    cached_input_tokens:perCall.reduce((s,r)=>s+r.cached_input_tokens,0),
    output_tokens:perCall.reduce((s,r)=>s+r.output_tokens,0),
    reasoning_tokens:perCall.reduce((s,r)=>s+r.reasoning_tokens,0),
    total_tokens:perCall.reduce((s,r)=>s+r.total_tokens,0),
    estimated_token_cost_usd:rounded(perCall.reduce((s,r)=>s+r.estimated_token_cost_usd,0),8),
    pricing_per_million:{input:inputUsdPerM,cached_input:cachedInputUsdPerM,
      output:outputUsdPerM},
    pricing_note:"Оценка стоимости из фактических токенов; сумма списания OpenAI может отличаться",
    per_call:perCall};
}
export function stage13DiffAudit(before,after,ai={},usage={},selection={}){
  if(!Array.isArray(before?.direct_buyers)||!Array.isArray(after?.direct_buyers)||
     before.direct_buyers.length!==after.direct_buyers.length)
    throw new Error("Stage 13 buyer count changed unexpectedly");
  const changed=[],all=[],issues=[];
  const groupsBefore={none:0,ordinary:0,white:0,green:0},
    groupsAfter={none:0,ordinary:0,white:0,green:0};
  const acceptedKinds={semi_trailer:0,other_trailer:0,truck:0,tractor:0,
    other:0,unknown:0};
  let recognized=0,negative=0,uncertain=0,aiBuyerRows=0;
  for(let i=0;i<before.direct_buyers.length;i++){
    const old=before.direct_buyers[i],fresh=after.direct_buyers[i];
    const from=number(old["Итоговый коэффициент"]),
      to=number(fresh["Итоговый коэффициент"]);
    const oldBand=band(from),newBand=band(to);
    groupsBefore[oldBand]++;groupsAfter[newBand]++;
    const metadata=Array.isArray(fresh.__priority13_ai?.results)?
      fresh.__priority13_ai.results:[];
    if(metadata.length)aiBuyerRows++;
    const classifications=metadata.map(x=>({
      model:x.model_text,verdict:x.kind,confidence:x.confidence,
      source:x.source,source_url:x.source_url,model_quote:x.model_quote,
      reason:x.reason
    }));
    for(const v of classifications){
      if(Object.prototype.hasOwnProperty.call(acceptedKinds,v.verdict))
        acceptedKinds[v.verdict]++;
      if(v.verdict==="semi_trailer"&&v.confidence==="high")recognized++;
      else if(v.verdict==="unknown"||v.confidence!=="high")uncertain++;
      else negative++;
    }
    for(const key of new Set([...Object.keys(old),...Object.keys(fresh)])){
      if(["Итоговый коэффициент","Обоснование коэффициента (Apps Script)",
        "__priority13_ai"].includes(key))continue;
      if(!same(old[key],fresh[key]))
        issues.push({row:i+2,buyer:old["Организация"],field:key});
    }
    const entry={row:i+2,buyer:old["Организация"],inn:old["ИНН"]||"",
      grade:old.__final_grade||"",
      score_before:from,score_after:to,delta:to-from,
      tier_before:oldBand,tier_after:newBand,
      sources:classifications,changed_score:from!==to};
    all.push(entry);
    if(entry.changed_score)changed.push(entry);
  }
  for(const key of ["intermediaries","leasing","statistics"]){
    if(!same(before[key],after[key]))issues.push({field:key});
  }
  const signed=changed.filter(x=>x.delta>0).length,
    fallen=changed.filter(x=>x.delta<0).length;
  const deferred=number(ai.deferred);
  return {version:1,
    input_buyers:before.direct_buyers.length,
    processed_buyers:after.direct_buyers.length,
    score_changed:changed.length,score_increased:signed,score_decreased:fallen,
    before_tiers:groupsBefore,after_tiers:groupsAfter,
    ai_rows_with_verdicts:aiBuyerRows,accepted_types:acceptedKinds,
    high_confidence_semi_results:recognized,
    non_semi_results:negative,uncertain_results:uncertain,
    pending_candidates:deferred,complete:deferred===0&&
      !["model_unavailable","stage13_cost_or_call_budget","global_research_cost_budget","candidate_limit"].includes(ai.stopped_reason),
    ai_summary:ai,usage,source_selection:selection,
    unchanged_source_fields:issues.length===0,
    unexpected_differences:issues.slice(0,100),
    all_buyers:all,changed_buyers:changed};
}
