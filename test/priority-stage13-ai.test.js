import test from "node:test";
import assert from "node:assert/strict";
import {
  priority13AICandidates,applyPriorityStage13,exactPriority13ModelQuote,
  validPriority13ModelQuote
} from "../src/priorityStage13.js";
import {
  stage13AISettings,classifyStage13UnknownModels,requestStage13ModelBatch
} from "../src/priorityStage13AI.js";

const actualNote=model=>"Компания приобрела транспортное средство марки "+
  model+" по договору лизинга. https://example.org/lease";
const SMOLENSK_NOTE="A — в приговоре указано, что за ООО «АЛЬВАДИ-ТОРГ ПЛЮС» "+
  "закреплены седельный тягач Volvo и бортовой тентовый полуприцеп "+
  "Kögel SN 24; техника использовалась для перевозки вентиляционных панелей. "+
  "([Источник](https://www.zakonrf.info/gorsud/doc-506ecddd-19eb-5d1a-88fc-bd170e8e1e0a/))";
const env={STAGE13_AI_ENABLED:"true",STAGE13_AI_MAX_CALLS:"3",
  STAGE13_AI_BATCH_SIZE:"4",STAGE13_AI_MAX_ESTIMATED_USD:"1"};
function buyer(notes=[],overrides={}){
  return {
    "Организация":"ООО «Проверка»","Основание":"B — перевозки",
    "Наличие транспорта":"",
    "Выручка последнего подтвержденного года":100000000,
    "Численность":35,"Электронная почта":"office@example.org",
    "Телефон":"79993332211","Расчётный коэффициент":55,
    __canonical_id:"testing-entity",
    __evidence:{notes,saby:{trucks:{vehicles:[{model:"KAMAZ 5490"}],
      status:"verified",category:"Грузовые"}}},
    ...overrides
  };
}
const final=(...rows)=>({direct_buyers:rows,intermediaries:[{x:1}],
  leasing:[{x:2}],statistics:[{x:3}]});
const yes=id=>({id,kind:"semi_trailer",confidence:"high",
  model_quote:"TRAILCO N900",reason:"Это полуприцеп"});

test("Saby trucks alone never prove a semitrailer and no paid classification runs",async()=>{
  const data=final(buyer([]));
  assert.deepEqual(priority13AICandidates(data.direct_buyers[0]),[]);
  const s=await classifyStage13UnknownModels(data,{
    env,requestBatch:async()=>{throw Error("unexpected API call")}
  });
  assert.equal(s.calls,0);
  assert.equal(applyPriorityStage13(data).tiers.none,1);
});

test("real sourced Smolensk Kögel SN 24 is selected despite spaces in model code",()=>{
  const row=buyer([SMOLENSK_NOTE],{
    "Организация":"ООО «АЛЬВАДИ-ТОРГ ПЛЮС»",
    "Основание":"A — Конкретный evidence-note одновременно подтверждает прицепную/полуприцепную технику и факт сделки, владения, эксплуатации, ремонта или лизинга."
  });
  const v=priority13AICandidates(row);
  assert.ok(v.length>=1);
  assert.equal(v[0].source,"evidence");
  assert.equal(v[0].model_text,"Kögel SN 24");
  assert.match(v[0].source_url,/zakonrf.info/);
  assert.ok(validPriority13ModelQuote("Kögel SN 24"));
  assert.ok(exactPriority13ModelQuote("Kögel SN 24",v[0].model_text));
});

test("real positive unknown numeric models enter the queue without TORGBOX",()=>{
  const candidate=priority13AICandidates(buyer([actualNote("TRAILCO N900")]));
  assert.equal(candidate.length,1);
  assert.equal(candidate[0].model_text,"TRAILCO N900");
  assert.equal(candidate[0].source,"evidence");
});

test("genuine alphabetic manufacturer/model combinations survive",()=>{
  const models=["Kögel Cargo","Schmitz Cargobull S.KO"];
  for(const model of models){
    assert.ok(priority13AICandidates(buyer([actualNote(model)]))
      .some(x=>x.model_text===model),model);
  }
});

test("known catalog models and already confirmed ordinary trailers need no OpenAI",()=>{
  for(const note of [
    "Судебным актом подтверждено владение полуприцепом KRONE SD. https://example.org/court",
    "Компания эксплуатирует полуприцеп без обозначения модели. https://example.org/fleet"
  ]){
    assert.equal(priority13AICandidates(buyer([note])).length,0);
  }
});

test("real smoke false positives from Smolensk do not create candidates",async()=>{
  const rows=[
    buyer(["Компания приобрела оборудование для переработки растительных масел мощностью 300 тонн в месяц. https://example.org/plant"],{"Организация":"ООО «Грейнлюкс»"}),
    buyer(["ООО «Деловые Линии» использует автомобильный транспорт для грузовых перевозок. https://example.org/profile"],{"Организация":"ООО «ДЛ-Транс» / ГК «Деловые Линии»"})
  ];
  for(const row of rows)assert.deepEqual(priority13AICandidates(row),[]);
  const stats=await classifyStage13UnknownModels(final(...rows),{
    env,requestBatch:async()=>{throw Error("unnecessary paid request")}}
  );
  assert.equal(stats.calls,0);
});

test("ordinary agricultural trailer 2ПТС-6 lacks a manufacturer pair",()=>{
  const note="A — в рамках банкротных торгов реализовывался конкретный "+
    "прицеп тракторный 2ПТС-6, принадлежавший должнику. "+
    "([Источник](https://heveya.ru/lot/4701534))";
  assert.deepEqual(priority13AICandidates(buyer([note])),[]);
});

test("plans, expired deals and unattributed references may be typed but never prove ownership",()=>{
  for(const note of [
    "Компания планирует приобрести транспортное средство марки TRAILCO N900. https://example.org/plan",
    "Компания приобрела транспортное средство марки TRAILCO N900.", // no URL
    "Договор на транспортное средство марки TRAILCO N900 истёк. https://example.org/old",
    "В поисковой выдаче вакансий указано TRAILCO N900 и парк. https://hh.ru/vacancies/voditel",
    "Запрос цен на транспортное средство марки TRAILCO N900. https://example.org/rfq"
  ]){
    const found=priority13AICandidates(buyer([note]));
    assert.ok(found.every(v=>v.evidence_eligible===false),note);
  }
});

test("positive OpenAI answer changes E only to ordinary 20-39",async()=>{
  const input=final(buyer([actualNote("TRAILCO N900")]));
  const before=structuredClone(input);
  let calls=0;
  const stats=await classifyStage13UnknownModels(input,{env,
    requestBatch:async batch=>{
      calls++;
      return {items:batch.map(x=>yes(x.id)),usage:{input_tokens:200,output_tokens:60}};
    }
  });
  assert.equal(calls,1);
  assert.equal(stats.recognized_semi_trailers,1);
  const report=applyPriorityStage13(input,{aiStats:stats});
  assert.equal(report.tiers.ordinary,1);
  assert.equal(report.tiers.green,0);
  assert.equal(report.tiers.white,0);
  assert.equal(report.openai_calls,1);
  const a=input.direct_buyers[0],b=before.direct_buyers[0];
  assert.ok(a["Итоговый коэффициент"]>=20&&a["Итоговый коэффициент"]<=39);
  assert.match(a["Обоснование коэффициента (Apps Script)"],/OPENAI.*TRAILCO N900/);
  for(const key of Object.keys(b))
    assert.deepEqual(a[key],b[key],"original field unchanged: "+key);
  assert.deepEqual(input.intermediaries,before.intermediaries);
  assert.deepEqual(input.leasing,before.leasing);
  assert.deepEqual(input.statistics,before.statistics);
});

test("non-semitrailer, low confidence, partial quote, wrong model never upgrade",async()=>{
  for(const answer of [
    {kind:"other_trailer",confidence:"high",model_quote:"TRAILCO N900"},
    {kind:"truck",confidence:"high",model_quote:"TRAILCO N900"},
    {kind:"semi_trailer",confidence:"medium",model_quote:"TRAILCO N900"},
    {kind:"semi_trailer",confidence:"high",model_quote:"TRAILCO N9"},
    {kind:"semi_trailer",confidence:"high",model_quote:"2ПТС-6"}
  ]){
    const data=final(buyer([actualNote("TRAILCO N900")]));
    await classifyStage13UnknownModels(data,{env,
      requestBatch:async batch=>({items:[{...answer,id:batch[0].id,reason:"test"}]})});
    assert.equal(applyPriorityStage13(data).tiers.none,1,JSON.stringify(answer));
  }
});

test("identical model is asked once across distinct sourced buyers",async()=>{
  const a=buyer([actualNote("TRAILCO N900")]);
  const b=buyer([actualNote("TRAILCO N900")],{
    "Организация":"ООО «Другое»",__canonical_id:"testing-2"
  });
  const data=final(a,b);
  let calls=0;
  const stat=await classifyStage13UnknownModels(data,{env,requestBatch:async batch=>{
    calls++;assert.equal(batch.length,1);
    return {items:[yes(batch[0].id)]};
  }});
  assert.equal(calls,1);
  assert.equal(stat.classified,2);
  assert.equal(applyPriorityStage13(data).tiers.ordinary,2);
});

test("checkpoint cache is tied to same source and legal entity",async()=>{
  const first=final(buyer([actualNote("TRAILCO N900")]));
  await classifyStage13UnknownModels(first,{env,
    requestBatch:async batch=>({items:[yes(batch[0].id)]})});
  const copied=final(buyer([actualNote("TRAILCO N900")]));
  const reused=await classifyStage13UnknownModels(copied,{
    env,previousRows:first.direct_buyers,
    requestBatch:async()=>{throw Error("cache missed")}
  });
  assert.equal(reused.calls,0);
  assert.equal(reused.cached,1);
  assert.equal(applyPriorityStage13(copied).tiers.ordinary,1);
  copied.direct_buyers[0].__evidence.notes=["Новые данные: парк не подтверждён. https://example.org/"];
  assert.equal(applyPriorityStage13(copied).tiers.none,1);
});

test("budget/disabled/provider failure cannot promote models",async()=>{
  for(const options of [
    {env:{...env,STAGE13_AI_ENABLED:"false"}},
    {env:{...env,STAGE13_AI_MAX_CALLS:"0"}},
    {env:{...env,STAGE13_AI_MAX_ESTIMATED_USD:"0"}},
    {env,remainingOverallUsd:()=>0},
    {env}
  ]){
    const input=final(buyer([actualNote("TRAILCO N900")]));
    const stats=await classifyStage13UnknownModels(input,{
      ...options,requestBatch:options.requestBatch,
      ...(options.requestBatch===undefined&&options.env?.STAGE13_AI_ENABLED!=="false"?
        {client:null}:{})
    });
    assert.equal(stats.calls,0);
    assert.equal(applyPriorityStage13(input).tiers.none,1);
  }
  const input=final(buyer([actualNote("TRAILCO N900")]));
  const stats=await classifyStage13UnknownModels(input,{env,
    requestBatch:async()=>{throw Error("provider unavailable")}});
  assert.equal(stats.calls,1);
  assert.equal(stats.stopped_reason,"model_unavailable");
  assert.equal(applyPriorityStage13(input).tiers.none,1);
});

test("real Responses API shape: one structured request, no web tools",async()=>{
  let requests=0;
  const client={responses:{create:async(req,opt)=>{
    requests++;
    assert.equal(Object.hasOwn(req,"tools"),false);
    assert.equal(req.text.format.type,"json_schema");
    assert.equal(req.text.format.strict,true);
    assert.equal(opt.maxRetries,0);
    const input=JSON.parse(req.input.split("\n").at(-1));
    return {status:"completed",output_text:JSON.stringify({items:input.map(x=>yes(x.id))}),
      usage:{input_tokens:180,output_tokens:45}};
  }}};
  const data=final(buyer([actualNote("TRAILCO N900")]));
  const stats=await classifyStage13UnknownModels(data,{client,env});
  assert.equal(requests,1);
  assert.equal(stats.web_search_calls,0);
  assert.equal(applyPriorityStage13(data).tiers.ordinary,1);
});

test("direct production request helper is reusable by real Smolensk smoke",async()=>{
  let received=false;
  const client={responses:{create:async(req,opt)=>{
    received=true;
    assert.equal(Object.hasOwn(req,"tools"),false);
    assert.equal(opt.maxRetries,0);
    return {status:"completed",output_text:JSON.stringify({items:[{
      id:"smoke-1",kind:"semi_trailer",confidence:"high",
      model_quote:"Kögel SN 24",reason:"полуприцеп"
    }]})};
  }}};
  const response=await requestStage13ModelBatch(client,[{
    id:"smoke-1",model_text:"Kögel SN 24",text:SMOLENSK_NOTE
  }],{model:"test-model",maxOutputTokens:1000,timeoutMs:12000});
  assert.equal(received,true);
  assert.equal(response.items[0].kind,"semi_trailer");
});


test("Smolensk Kögel SN 24 positive model verdict raises E from 0 to ordinary",async()=>{
  const caseRow=buyer([SMOLENSK_NOTE],{
    "Организация":"ООО «АЛЬВАДИ-ТОРГ ПЛЮС»",
    "Основание":"A — Конкретный evidence-note одновременно подтверждает прицепную/полуприцепную технику и факт сделки, владения, эксплуатации, ремонта или лизинга."
  });
  const data=final(caseRow);
  const old=applyPriorityStage13(structuredClone(data));
  assert.equal(old.tiers.none,1);
  const stats=await classifyStage13UnknownModels(data,{env,
    requestBatch:async batch=>({items:batch.map(x=>({
      id:x.id,kind:"semi_trailer",confidence:"high",
      model_quote:"Kögel SN 24",reason:"проверенный тип модели"
    }))})
  });
  assert.equal(stats.calls,1);
  assert.equal(stats.recognized_semi_trailers,1);
  assert.equal(applyPriorityStage13(data).tiers.ordinary,1);
  assert.ok(caseRow["Итоговый коэффициент"]>=20&&caseRow["Итоговый коэффициент"]<=39);
});

test("historical TORGBOX text is not an active OpenAI candidate source",()=>{
  const row=buyer([],{TORGBOX:"KRONE SDP27 — 1 шт."});
  assert.equal(priority13AICandidates(row).length,0);
});

test("already ordinary buyer STILL sends out-of-catalog trailer model to OpenAI",async()=>{
  const known=row=>row;
  const r=buyer([actualNote("WIELTON NW3A48SD")],{
    "Основание":"B — Компания эксплуатирует полуприцеп и организует перевозки"
  });
  assert.equal(priority13AICandidates(r).length,1);
  let calls=0;
  const data=final(r);
  const stats=await classifyStage13UnknownModels(data,{env,
    requestBatch:async batch=>{
      calls++;return {items:batch.map(c=>({id:c.id,
        kind:"semi_trailer",confidence:"high",model_quote:c.model_text,
        reason:"Полуприцеп"}))};
    }
  });
  assert.equal(calls,1);
  assert.equal(stats.recognized_semi_trailers,1);
  assert.equal(applyPriorityStage13(data).tiers.ordinary,1);
});
test("catalog pair is not sent to AI; another make/model in the same buyer still is",()=>{
  const r=buyer([actualNote("WIELTON NW3A48SD"),
    actualNote("SCHMITZ 9084")]);
  assert.deepEqual(priority13AICandidates(r).map(c=>c.model_text),["WIELTON NW3A48SD"]);
});
test("segment-only Schmitz SCS and SCO 24 are typed but cannot raise coefficient",async()=>{
  const r=buyer([],{"Техника/сегмент":
    "Шторные полуприцепы Schmitz SCS, Schmitz SCO 24; международные перевозки"});
  const candidates=priority13AICandidates(r);
  assert.deepEqual(candidates.map(c=>c.model_text).sort(),
    ["Schmitz SCO 24","Schmitz SCS"]);
  assert.ok(candidates.every(c=>c.evidence_eligible===false&&c.source==="segment"));
  const data=final(r);
  const stats=await classifyStage13UnknownModels(data,{env,
    requestBatch:async batch=>({
      items:batch.map(c=>({id:c.id,kind:"semi_trailer",
        confidence:"high",model_quote:c.model_text,reason:"полуприцеп"}))
    })
  });
  assert.equal(stats.recognized_semi_trailers,2);
  assert.equal(applyPriorityStage13(data).tiers.none,1);
  assert.equal(r["Итоговый коэффициент"],0);
});
test("real full-checkpoint examples appear even when prior scores are ordinary",()=>{
  const samples=[
    ["ООО «АРИХОН»","WIELTON NW3A48SD"],
    ["ООО «ТМГ ИНДУСТРИЯ»","V-TRAILER VTPP31"],
    ["ООО «ГЛОБАЛ ТРЕЙД»","Wielton NW3A44SD"],
    ["ООО «Регион Паллет»","Tonar 9445"],
    ["ООО «СПЕКТР67»","KOGEL S24-1"],
    ["ООО «КСП «Струково»","KRONE SDP 27"],
    ["ПАО «НК «Роснефть» — Смоленскнефтепродукт»","НЕФАЗ-96895"]
  ];
  for(const [company,model] of samples){
    const note="A — "+company+" получил по договору полуприцеп "+
      model+" и эксплуатирует его. https://example.org/court";
    const r=buyer([note],{"Техника/сегмент":"Полуприцеп "+model,
      "Основание":"A — указан полуприцеп по договору"});
    const found=priority13AICandidates(r);
    assert.ok(found.some(c=>c.model_text.replace(/\s+/g," ").includes(model.replace("НЕФАЗ-","НЕФАЗ ")) ||
       c.model_text===model||c.model_text===model.replace("НЕФАЗ-","НЕФАЗ ")),model);
  }
});
test("a source hyperlink only in the source list does not prove a segment-only vehicle",()=>{
  const r=buyer([],{"Техника/сегмент":"Полуприцеп Schmitz SCO 24"});
  r.__evidence.source_urls=["https://example.org/unrelated"];
  const found=priority13AICandidates(r);
  assert.equal(found.length,1);
  assert.equal(found[0].evidence_eligible,false);
});
test("Saby (грузовые) trucks are excluded even when the row has many KAMAZ models",()=>{
  const r=buyer([],{"Наличие транспорта":
    "Saby (грузовые): KAMAZ 5490 — 1 шт.; MAZ 6430 — 2 шт."});
  assert.deepEqual(priority13AICandidates(r),[]);
});
