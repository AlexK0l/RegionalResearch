#!/usr/bin/env node
// One real OpenAI Responses request against sourced Smolensk vehicle models.
// Default mode is offline preview. --live explicitly authorizes ONE paid call.
// No web search; no Saby calls; does not write to JSON, checkpoint or XLSX.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import {applyPriorityStage13,priority13AICandidates} from "../src/priorityStage13.js";
import {stage13AISettings,requestStage13ModelBatch,
  classifyStage13UnknownModels} from "../src/priorityStage13AI.js";

const args=process.argv.slice(2);
const option=name=>args.find(s=>s.startsWith("--"+name+"="))?.slice(name.length+3)||"";
const fail=message=>{throw new Error("Stage13 Smolensk smoke: "+message)};
async function main(){
  const file=option("result");
  if(!file)fail("provide --result=<completed-final.json>");
  const live=args.includes("--live");
  if(args.some(s=>s.startsWith("--")&&!s.startsWith("--result=")&&s!=="--live"))
    fail("unsupported option");
  const saved=JSON.parse(await fs.readFile(path.resolve(file),"utf8"));
  if(saved.phase&&saved.phase!=="completed")fail("result is not completed");
  const result=saved.final_result||saved;
  if(!Array.isArray(result.direct_buyers))fail("no direct buyers");
  const buyers=result.direct_buyers;
  const positiveCases=[
    {name:"ООО «АЛЬВАДИ-ТОРГ ПЛЮС»",model:"Kögel SN 24"},
    {name:"ООО «АРИХОН»",model:"WIELTON NW3A48SD"},
    {name:"ООО «ТМГ ИНДУСТРИЯ»",model:"V-TRAILER VTPP31"}
  ];
  const items=[];
  const sourceRow=new Map();
  for(const [i,sample] of positiveCases.entries()){
    const row=buyers.find(r=>r["Организация"]===sample.name);
    if(!row)fail("missing actual buyer: "+sample.name);
    const note=(row.__evidence?.notes||[]).find(n=>
      n.includes(sample.model)&&/https?:\/\//i.test(n));
    if(!note)fail("no URL-linked model evidence for "+sample.name);
    const candidate={id:"smolensk-positive-"+i,model_text:sample.model,
      text:note,source_url:(note.match(/https?:\/\/[^\s<>\])]+/i)||[])[0]||""};
    items.push({...candidate,expected:"semi_trailer",buyer:sample.name});
    sourceRow.set(candidate.id,row);
  }
  const trailerBuyer=buyers.find(r=>r["Организация"]==="МУП ЖКХ «НАДЕЖДА»");
  if(!trailerBuyer)fail("missing agricultural trailer negative control");
  const trailerNote=trailerBuyer.__evidence?.notes?.find(n=>
    n.includes("2ПТС-6")&&/https?:\/\//i.test(n));
  if(!trailerNote)fail("missing sourced 2ПТС-6 negative control");
  items.push({id:"smolensk-negative-trailer",model_text:"2ПТС-6",
    text:trailerNote,expected:"other_trailer",buyer:trailerBuyer["Организация"]});
  const truckBuyer=buyers.find(r=>
    (r.__evidence?.saby?.trucks?.vehicles||[]).some(v=>v.model==="KAMAZ 5490"));
  if(!truckBuyer)fail("missing Saby KAMAZ 5490 negative control");
  items.push({id:"smolensk-negative-truck",model_text:"KAMAZ 5490",
    text:"Saby (Грузовые) зарегистрированная модель: KAMAZ 5490",
    expected:"truck_or_tractor",buyer:truckBuyer["Организация"]});

  // This tests that the live extraction path on real evidence is not empty,
  // not just that an arbitrary model can be sent to a working API.
  const candidate=priority13AICandidates(sourceRow.get("smolensk-positive-0"));
  assert.ok(candidate.some(c=>c.model_text==="Kögel SN 24"&&c.source==="evidence"),
    "real Kögel SN 24 must enter the production AI candidate queue");

  const display=items.map(x=>({buyer:x.buyer,model:x.model_text,
    expected:x.expected,source_url:x.source_url||"Saby"}));
  console.log(JSON.stringify({mode:live?"live":"preview",source:"saved Smolensk research",
    buyers_total:buyers.length,scenarios:display,api_calls_allowed:live?1:0,
    source_unchanged:true},null,2));
  if(!live){
    console.log("SMOKE PREVIEW PASSED (0 API calls); --live makes exactly one request.");
    return;
  }
  if(!process.env.OPENAI_API_KEY)fail("OPENAI_API_KEY missing");
  const cfg=stage13AISettings({...process.env,
    STAGE13_AI_ENABLED:"true",STAGE13_AI_MAX_CALLS:"1",
    STAGE13_AI_BATCH_SIZE:"5",STAGE13_AI_MAX_ESTIMATED_USD:"0.03"});
  const estimated=((JSON.stringify(items).length/3)*0.2+cfg.maxOutputTokens*1.2)/1e6*2;
  if(estimated>0.03)fail("request exceeds $0.03 preflight estimate");
  const {default:OpenAI}=await import("openai");
  const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
  const requested=items.map(({id,model_text,text})=>({id,model_text,text}));
  let actualUsage={};
  const reply=await requestStage13ModelBatch(client,requested,{
    model:cfg.model,maxOutputTokens:cfg.maxOutputTokens,
    timeoutMs:cfg.timeoutMs,onUsage:usage=>{actualUsage=usage}
  });
  const found=new Map(reply.items.map(x=>[x.id,x]));
  const results=items.map(item=>{
    const answer=found.get(item.id);
    return {buyer:item.buyer,model:item.model_text,expected:item.expected,
      detected:answer?.kind||"missing",confidence:answer?.confidence||"missing",
      quote:answer?.model_quote||"",reason:answer?.reason||""};
  });
  console.log(JSON.stringify({
    model:cfg.model,api_calls:1,web_search_calls:0,
    estimated_cost_usd_before_call:Number(estimated.toFixed(5)),
    tokens:actualUsage,decisions:results
  },null,2));
  const positives=results.filter(r=>r.expected==="semi_trailer");
  const negatives=results.filter(r=>r.expected!=="semi_trailer");
  const high=positives.filter(r=>r.detected==="semi_trailer"&&r.confidence==="high"&&
    r.quote===r.model);
  assert.ok(high.length>=2,
    "positive real semitrailers were not identified at high confidence (minimum 2/3)");
  assert.ok(negatives.every(r=>r.detected!=="semi_trailer"),
    "a tractor/trailer was misclassified as a semitrailer");

  // Replay the actual Kögel response into the production model-to-score path
  // WITHOUT issuing a second API request.
  const positive=found.get("smolensk-positive-0");
  if(positive?.kind==="semi_trailer"&&positive?.confidence==="high"){
    const cloned=structuredClone(sourceRow.get("smolensk-positive-0"));
    const sample={direct_buyers:[cloned],intermediaries:[],leasing:[],statistics:[]};
    const stats=await classifyStage13UnknownModels(sample,{
      env:{...process.env,STAGE13_AI_ENABLED:"true",STAGE13_AI_MAX_CALLS:"1",
        STAGE13_AI_BATCH_SIZE:"1",STAGE13_AI_MAX_ESTIMATED_USD:"0.03"},
      requestBatch:async list=>({items:list.map(x=>({...positive,id:x.id}))})
    });
    const scoring=applyPriorityStage13(sample,{aiStats:stats});
    assert.equal(scoring.tiers.ordinary,1);
    assert.ok(cloned["Итоговый коэффициент"]>=20&&cloned["Итоговый коэффициент"]<=39);
    console.log(JSON.stringify({buyer:cloned["Организация"],
      before:sourceRow.get("smolensk-positive-0")["Итоговый коэффициент"],
      after:cloned["Итоговый коэффициент"],
      color_tier:"ordinary",added_paid_calls:0},null,2));
  }
  console.log("STAGE13 SMOLENSK REAL POSITIVE API SMOKE PASSED");
}
main().catch(error=>{console.error(error.stack||String(error));process.exitCode=1});
