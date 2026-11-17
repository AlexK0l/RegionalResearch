import test from "node:test";
import assert from "node:assert/strict";
import {priority13AICandidates,applyPriorityStage13,calculatePriority13}
  from "../src/priorityStage13.js";
import {stage13AISettings,classifyStage13UnknownModels}
  from "../src/priorityStage13AI.js";

function row(transport="",notes=[]){
  return {
    "Организация":"ООО «Проверка»",
    "__canonical_id":"test-entity",
    "Наличие транспорта":transport,
    "Основание":"B — перевозка",
    "Выручка последнего подтвержденного года":100000000,
    "Численность":35,
    "Расчётный коэффициент":55,
    "Электронная почта":"company@example.org",
    "Телефон":"+7 999 333 22 11",
    "__evidence":{notes}
  };
}
function final(...rows){
  return {direct_buyers:rows,intermediaries:[{"Организация":"Лизинг"}],
    leasing:[{"Организация":"Посредник"}],statistics:[{"Статистика":"Есть"}]};
}
const cliEnv={STAGE13_AI_ENABLED:"true",STAGE13_AI_MAX_CALLS:"3",
  STAGE13_AI_BATCH_SIZE:"3",STAGE13_AI_MAX_ESTIMATED_USD:"1"};

test("stage13 AI defaults are bounded and cannot request web tools",()=>{
  const settings=stage13AISettings({});
  assert.equal(settings.enabled,true);
  assert.ok(settings.maxCalls<=20);
  assert.ok(settings.batchSize<=12);
  assert.ok(settings.maxUsd<=2);
  assert.equal(stage13AISettings({STAGE13_AI_ENABLED:"false"}).enabled,false);
});
test("color catalog and known plain semi-trailers need no model calls",()=>{
  for(const c of ["TORGBOX: ТОНАР 959500 — 1 шт.",
    "TORGBOX: KRONE SD — 1 шт.",
    "TORGBOX: полуприцеп фургон — 2 шт."]){
    assert.equal(priority13AICandidates(row(c)).length,0);
  }
});
test("Saby cargo trucks never enter the candidate queue",async()=>{
  const data=final(row("Saby (грузовые): KAMAZ 5490 — 5 шт.\nMAZ 6422 — 3 шт."));
  assert.deepEqual(priority13AICandidates(data.direct_buyers[0]),[]);
  let calls=0;
  const stats=await classifyStage13UnknownModels(data,{
    env:cliEnv,requestBatch:async()=>{calls++;return {items:[]}}
  });
  assert.equal(calls,0);
  assert.equal(stats.candidates,0);
  assert.equal(applyPriorityStage13(data).tiers.none,1);
});
test("unknown manufacturer+model from TORGBOX gets ordinary band only after high confidence",async()=>{
  const data=final(row("TORGBOX: KRONE SDP27 (2020 г.) — 1 шт."));
  assert.equal(priority13AICandidates(data.direct_buyers[0]).length,1);
  let calls=0;
  const source=structuredClone(data);
  const stats=await classifyStage13UnknownModels(data,{
    env:cliEnv,
    requestBatch:async tasks=>{
      calls++;
      assert.equal(tasks.length,1);
      assert.match(tasks[0].model_text,/KRONE SDP27/);
      return {items:[{id:tasks[0].id,kind:"semi_trailer",confidence:"high",
        model_quote:"KRONE SDP27",reason:"Вид техники: полуприцеп"}],
        usage:{input_tokens:100,output_tokens:65}};
    }
  });
  assert.equal(calls,1);
  assert.equal(stats.calls,1);
  assert.equal(stats.recognized_semi_trailers,1);
  const report=applyPriorityStage13(data,{aiStats:stats});
  assert.equal(report.tiers.ordinary,1);
  assert.equal(report.tiers.green,0);
  assert.equal(report.tiers.white,0);
  assert.equal(report.openai_calls,1);
  assert.match(data.direct_buyers[0]["Обоснование коэффициента (Apps Script)"],
    /OPENAI.*KRONE SDP27/);
  assert.match(data.direct_buyers[0]["Обоснование коэффициента (Apps Script)"],
    /без веб-проверки/);
  assert.equal(data.direct_buyers[0]["Электронная почта"],source.direct_buyers[0]["Электронная почта"]);
  assert.equal(data.direct_buyers[0]["Телефон"],source.direct_buyers[0]["Телефон"]);
  assert.equal(data.direct_buyers[0]["Расчётный коэффициент"],55);
  assert.deepEqual(data.intermediaries,source.intermediaries);
  assert.deepEqual(data.leasing,source.leasing);
  assert.deepEqual(data.statistics,source.statistics);
  // A repeated offline calculation reuses a matching model verdict
  // without sending a second OpenAI request.
  const repeated=await classifyStage13UnknownModels(data,{
    env:cliEnv,requestBatch:async()=>{throw Error("should be cached")}
  });
  assert.equal(repeated.calls,0);
  assert.equal(repeated.cached,1);
  assert.equal(applyPriorityStage13(data).changed,0);
});
test("model verdict cannot create green/white or grade A even if its text says so",async()=>{
  const data=final(row("TORGBOX: TESTTRAILER S555 (2024) — 2 шт."));
  await classifyStage13UnknownModels(data,{
    env:cliEnv,requestBatch:async batch=>({
      items:batch.map(c=>({id:c.id,kind:"semi_trailer",confidence:"high",
        model_quote:"TESTTRAILER S555",reason:"ЗЕЛЁНАЯ МОДЕЛЬ 100 БАЛЛОВ!"}))
    })
  });
  const report=applyPriorityStage13(data);
  assert.equal(report.tiers.ordinary,1);
  assert.equal(data.direct_buyers[0]["Основание"],"B — перевозка");
  assert.equal(data.direct_buyers[0].__final_grade,undefined);
});
test("without exact manufacturer+model quote or high confidence AI cannot promote",async()=>{
  for(const verdict of [
    {kind:"semi_trailer",confidence:"medium",model_quote:"KRONE SDP27"},
    {kind:"semi_trailer",confidence:"high",model_quote:"ТОНАР 959500"},
    {kind:"truck",confidence:"high",model_quote:"KRONE SDP27"},
    {kind:"unknown",confidence:"low",model_quote:""},
    {kind:"semi_trailer",confidence:"high",model_quote:"2020"},
    {kind:"semi_trailer",confidence:"high",model_quote:"KRONE SDP"}
  ]){
    const data=final(row("TORGBOX: KRONE SDP27 — 1 шт."));
    await classifyStage13UnknownModels(data,{env:cliEnv,
      requestBatch:async batch=>({items:[{...verdict,id:batch[0].id,reason:"Нужна проверка"}]})});
    assert.equal(applyPriorityStage13(data).tiers.none,1,JSON.stringify(verdict));
  }
});
test("only direct positively attributed source notes with model are AI candidates",()=>{
  const note="Компания приобрела полуприцеп завода KRONE 2020 г. https://example.org/test";
  // Explicit 'полуприцеп' is already sufficient for ordinary scoring.
  assert.equal(priority13AICandidates(row("",[note])).length,0);
  const unknown="Компания приобрела KRONE SDP27 в лизинг, владение подтверждено. https://example.org/document";
  assert.ok(priority13AICandidates(row("",[unknown])).some(x=>x.source==="evidence"));
  for(const rejected of [
    "В каталоге поставщиков упомянута KRONE SDP27", // no URL
    "Предположительно имеется KRONE SDP27. https://example.org/guess",
    "В поисковой выдаче вакансий упомянут KRONE SDP27, есть парк машин. https://hh.ru/vacancies/voditel",
    "Договор закупки KRONE SDP27 истёк. https://example.org/old"
  ]){
    assert.equal(priority13AICandidates(row("",[rejected])).length,0,rejected);
  }
});
test("one identical model is classified once across different buyers",async()=>{
  const data=final(row("TORGBOX: KRONE SDP27 — 1 шт."),{
    ...row("TORGBOX: KRONE SDP27 — 7 шт."),"Организация":"ООО Другой",
    "__canonical_id":"test-entity-2"
  });
  let calls=0;
  const stats=await classifyStage13UnknownModels(data,{env:cliEnv,
    requestBatch:async batch=>{
      calls++;
      assert.equal(batch.length,1);
      return {items:[{id:batch[0].id,kind:"semi_trailer",
        confidence:"high",model_quote:"KRONE SDP27",reason:"полуприцеп"}]};
    }});
  assert.equal(calls,1);
  assert.equal(stats.classified,2);
  assert.equal(applyPriorityStage13(data).tiers.ordinary,2);
});
test("source changes invalidate old AI interpretation without any additional call",async()=>{
  const data=final(row("TORGBOX: KRONE SDP27 — 1 шт."));
  await classifyStage13UnknownModels(data,{env:cliEnv,
    requestBatch:async batch=>({items:[{id:batch[0].id,kind:"semi_trailer",
      confidence:"high",model_quote:"KRONE SDP27",reason:"полуприцеп"}]})});
  assert.equal(applyPriorityStage13(data).tiers.ordinary,1);
  data.direct_buyers[0]["Наличие транспорта"]="Saby (грузовые): KAMAZ 5490 — 1 шт.";
  assert.equal(applyPriorityStage13(data).tiers.none,1);
});
test("global budget, own limits, disabled settings and missing API preserve deterministic output",async()=>{
  for(const opts of [
    {env:{...cliEnv,STAGE13_AI_MAX_CALLS:"0"},requestBatch:async()=>{throw Error("paid call!")}},
    {env:{...cliEnv,STAGE13_AI_MAX_ESTIMATED_USD:"0"},requestBatch:async()=>{throw Error("paid call!")}},
    {env:cliEnv,remainingOverallUsd:()=>0,requestBatch:async()=>{throw Error("paid call!")}},
    {env:{...cliEnv,STAGE13_AI_ENABLED:"false"},requestBatch:async()=>{throw Error("paid call!")}},
    {env:cliEnv}
  ]){
    const data=final(row("TORGBOX: KRONE SDP27 — 1 шт."));
    const stats=await classifyStage13UnknownModels(data,opts);
    assert.equal(stats.calls,0);
    assert.equal(applyPriorityStage13(data).tiers.none,1);
  }
});
test("AI API errors must not fail the regional research or imply trailer ownership",async()=>{
  const data=final(row("TORGBOX: KRONE SDP27 — 1 шт."));
  const stats=await classifyStage13UnknownModels(data,{env:cliEnv,
    requestBatch:async()=>{throw Error("provider temporarily unavailable")}});
  assert.equal(stats.calls,1);
  assert.equal(stats.stopped_reason,"model_unavailable");
  assert.equal(applyPriorityStage13(data).tiers.none,1);
});
test("resumed run reuses only matching canonical ID and input hash",async()=>{
  const before=final(row("TORGBOX: KRONE SDP27 — 1 шт."));
  await classifyStage13UnknownModels(before,{env:cliEnv,
    requestBatch:async batch=>({items:[{id:batch[0].id,kind:"semi_trailer",
      confidence:"high",model_quote:"KRONE SDP27",reason:"полуприцеп"}]})});
  const data=final(row("TORGBOX: KRONE SDP27 — 1 шт."));
  const stats=await classifyStage13UnknownModels(data,{env:cliEnv,
    previousRows:before.direct_buyers,
    requestBatch:async()=>{throw Error("checkpoint must be reused")}});
  assert.equal(stats.calls,0);
  assert.equal(stats.cached,1);
  assert.equal(applyPriorityStage13(data).tiers.ordinary,1);
});

test("a mere purchasing PLAN or a request for quotation cannot prove equipment ownership",()=>{
  const offers=[
    "Компания планирует приобрести KRONE SDP27 в будущем. https://example.org/business-plan",
    "Для бизнеса размещен запрос цен на KRONE SDP27 и лизинг. https://example.org/rfq",
    "В каталоге размещено коммерческое предложение на KRONE SDP27. https://example.org/catalog"
  ];
  for(const note of offers){
    assert.equal(priority13AICandidates(row("",[note])).length,0,note);
  }
  const proven="В судебном акте указано, что компания приобрела KRONE SDP27 и владеет ею. https://example.org/judgment";
  assert.equal(priority13AICandidates(row("",[proven])).length,1);
});

test("Responses API integration uses strict JSON schema, no web tools and no retries",async()=>{
  let requests=0,usage=0;
  const client={responses:{create:async(req,opts)=>{
    requests++;
    assert.equal(Object.hasOwn(req,"tools"),false);
    assert.equal(req.text.format.type,"json_schema");
    assert.equal(req.text.format.strict,true);
    assert.equal(opts.maxRetries,0);
    assert.ok(opts.timeout<=60000);
    const input=req.input.split("\n").at(-1);
    const item=JSON.parse(input)[0];
    return {status:"completed",output_text:JSON.stringify({items:[{
      id:item.id,kind:"semi_trailer",confidence:"high",
      model_quote:"KRONE SDP27",reason:"Тип полуприцепа известен"
    }]}),usage:{input_tokens:330,output_tokens:90}};
  }}};
  const data=final(row("TORGBOX: KRONE SDP27 — 1 шт."));
  const stats=await classifyStage13UnknownModels(data,{
    client,env:cliEnv,onUsage:u=>{usage+=u.input_tokens+u.output_tokens}
  });
  assert.equal(requests,1);
  assert.equal(stats.web_search_calls,0);
  assert.equal(stats.calls,1);
  assert.equal(usage,420);
  assert.equal(applyPriorityStage13(data).tiers.ordinary,1);
});

test("unknown alphabetic model names can be recognized, not just numerical codes",async()=>{
  const data=final(row("TORGBOX: Kögel Cargo — 1 шт.",
    ["Компания приобрела Schmitz Cargobull S.KO в лизинг. https://example.org/document"]));
  const candidates=priority13AICandidates(data.direct_buyers[0]);
  assert.ok(candidates.some(c=>c.model_text.includes("Kögel Cargo")));
  assert.ok(candidates.some(c=>c.model_text.includes("Schmitz Cargobull S.KO")));
  let asked=0;
  const stats=await classifyStage13UnknownModels(data,{env:cliEnv,
    requestBatch:async batch=>{
      asked+=batch.length;
      return {items:batch.map(c=>({id:c.id,kind:"semi_trailer",
        confidence:"high",model_quote:c.model_text,
        reason:"подтверждён тип полуприцепа"}))};
    }
  });
  assert.ok(asked>=2);
  assert.ok(stats.recognized_semi_trailers>=2);
  const rep=applyPriorityStage13(data);
  assert.equal(rep.tiers.ordinary,1);
  assert.equal(rep.tiers.white,0);
  assert.equal(rep.tiers.green,0);
});

test("alphabetic parser cannot mistake the prefix of a numeric model for another model",()=>{
  const items=priority13AICandidates(row("TORGBOX: KRONE SDP27 — 1 шт."));
  assert.equal(items.length,1);
  assert.equal(items[0].model_text,"KRONE SDP27");
});

test("two-word manufacturer is not independently classified ahead of its numeric model",()=>{
  const items=priority13AICandidates(row("TORGBOX: Schmitz Cargobull SKO26 — 1 шт."));
  assert.deepEqual(items.map(v=>v.model_text),["Schmitz Cargobull SKO26"]);
});


test("real Stage13 smoke: factory power and buyer names are not model candidates",async()=>{
  const industrial=row("",[
    "Компания приобрела оборудование для переработки растительных масел мощностью 300 тонн в месяц. https://example.org/plant"
  ]);
  industrial["Организация"]="ООО «Грейнлюкс»";
  const corporate=row("",[
    "ООО «Деловые Линии» использует автомобильный транспорт для грузовых перевозок. https://example.org/profile"
  ]);
  corporate["Организация"]="ООО «ДЛ-Транс» / ГК «Деловые Линии»";
  assert.deepEqual(priority13AICandidates(industrial),[]);
  assert.deepEqual(priority13AICandidates(corporate),[]);
  const data=final(industrial,corporate);
  const stats=await classifyStage13UnknownModels(data,{
    env:cliEnv,requestBatch:async()=>{throw new Error("irrelevant paid classification")}
  });
  assert.equal(stats.calls,0);
  assert.equal(stats.candidates,0);
});
test("unrelated equipment purchases and corporate names cannot trigger model classification",()=>{
  const fakes=[
    "Купила устройство для производства масел мощностью 300 кВт. https://example.org/plant",
    "Компания приобрела серверное оборудование DELL 300 для склада. https://example.org/it",
    "В собственности ООО «Деловые Линии» находится транспортный парк. https://example.org/company"
  ];
  for(const note of fakes){
    assert.equal(priority13AICandidates(row("",[note])).length,0,note);
  }
});
test("new numeric vehicle models in source-bound evidence still reach OpenAI",()=>{
  const unknown=row("",[
    "Компания приобрела транспортное средство марки TRAILCO N900 по договору лизинга. https://example.org/lease"
  ]);
  const candidates=priority13AICandidates(unknown);
  assert.equal(candidates.length,1);
  assert.equal(candidates[0].model_text,"TRAILCO N900");
  assert.equal(candidates[0].source,"evidence");
});
test("known semitrailer manufacturers, letter-only models and TORGBOX codes remain eligible",()=>{
  assert.deepEqual(
    priority13AICandidates(row("TORGBOX: Schmitz Cargobull SKO26 — 1 шт."))
      .map(x=>x.model_text),["Schmitz Cargobull SKO26"]);
  assert.deepEqual(
    priority13AICandidates(row("TORGBOX: Kögel Cargo — 1 шт."))
      .map(x=>x.model_text),["Kögel Cargo"]);
  assert.deepEqual(
    priority13AICandidates(row("TORGBOX: KRONE SDP27 — 1 шт."))
      .map(x=>x.model_text),["KRONE SDP27"]);
  const known=row("",["Компания приобрела Schmitz Cargobull S.KO в лизинг. https://example.org/lease"]);
  assert.deepEqual(priority13AICandidates(known).map(x=>x.model_text),["Schmitz Cargobull S.KO"]);
});
test("general vehicle terms without a manufacturer are not a model",()=>{
  for(const c of [
    "TORGBOX: тракторный прицеп 2ПТС-6 — 1 шт.",
    "TORGBOX: прицеп самосвальный 2ПТС-6 — 2 шт."
  ]){
    assert.equal(priority13AICandidates(row(c)).length,0,c);
  }
});
