import test from "node:test";
import assert from "node:assert/strict";
import {stage13SourceAudit,stage13UsageSummary,stage13DiffAudit}
  from "../src/priorityStage13FullAudit.js";

function result(){
  return {direct_buyers:[
    {"Организация":"ООО «АЛЬВАДИ-ТОРГ ПЛЮС»",
      "ИНН":"",__final_grade:"A","Итоговый коэффициент":0,
      "Основание":"A — Конкретный evidence-note одновременно подтверждает прицепную/полуприцепную технику и факт сделки, владения, эксплуатации, ремонта или лизинга.",
      "Телефон":"79991112233","Электронная почта":"a@example.org",
      "__evidence":{notes:[
        "A — в приговоре указано, что за ООО «АЛЬВАДИ-ТОРГ ПЛЮС» закреплены седельный тягач Volvo и бортовой тентовый полуприцеп Kögel SN 24; техника использовалась для перевозки вентиляционных панелей. ([Источник](https://www.zakonrf.info/gorsud/doc-506ecddd-19eb-5d1a-88fc-bd170e8e1e0a/))"
      ]}},
    {"Организация":"ООО Без моделей","Итоговый коэффициент":6,
      "Основание":"C — перевозка","__evidence":{notes:[]}}
  ],intermediaries:[{"Организация":"Лизинг"}],
    leasing:[{"Организация":"Посредник"}],
    statistics:[{"Показатель":"Всего"}]};
}
test("full Stage13 preflight counts all direct buyers and unique sourced models",()=>{
  const s=stage13SourceAudit(result(),{maxPerBuyer:3,batchSize:10,maxCalls:12});
  assert.equal(s.buyers,2);
  assert.equal(s.candidate_rows,1);
  assert.equal(s.candidates,1);
  assert.equal(s.unique_models,1);
  assert.equal(s.unique_models_list[0],"Kögel SN 24");
  assert.equal(s.planned_calls,1);
  assert.equal(s.all_models_fit,true);
  assert.ok(s.token_forecast.expected_usd>0);
  assert.equal(s.by_source.evidence,1);
});
test("refuse misleading full coverage when batch capacity is insufficient",()=>{
  const s=stage13SourceAudit(result(),{maxPerBuyer:3,batchSize:1,maxCalls:0});
  assert.equal(s.all_models_fit,false);
  assert.equal(s.planned_calls,1);
});
test("actual token-price estimate distinguishes model output, input and cache",()=>{
  const data=stage13UsageSummary([{
    input_tokens:828,input_tokens_details:{cached_tokens:0},
    output_tokens:418,output_tokens_details:{reasoning_tokens:156},total_tokens:1246
  }]);
  assert.equal(data.estimated_token_cost_usd,0.0006672);
  assert.equal(data.reasoning_tokens,156);
  assert.equal(data.total_tokens,1246);
  assert.equal(data.api_calls_with_usage,1);
  assert.equal(stage13UsageSummary([{
    input_tokens:828,input_tokens_details:{cached_tokens:100},
    output_tokens:418,total_tokens:1246
  }]).estimated_token_cost_usd,0.0006492);
});
test("full Stage13 score audit reports promotions without modifying other source fields",()=>{
  const before=result(),after=structuredClone(before);
  const row=after.direct_buyers[0];
  row["Итоговый коэффициент"]=20;
  row["Обоснование коэффициента (Apps Script)"]="КЛАССИФИКАЦИЯ МОДЕЛИ OPENAI";
  row.__priority13_ai={results:[{model_text:"Kögel SN 24",
    kind:"semi_trailer",confidence:"high",source:"evidence",source_url:"https://example.org",
    model_quote:"Kögel SN 24",reason:"Полуприцеп"}]};
  const report=stage13DiffAudit(before,after,{deferred:0,stopped_reason:""},{},stage13SourceAudit(before));
  assert.equal(report.input_buyers,2);
  assert.equal(report.processed_buyers,2);
  assert.equal(report.score_changed,1);
  assert.equal(report.score_increased,1);
  assert.equal(report.score_decreased,0);
  assert.equal(report.high_confidence_semi_results,1);
  assert.equal(report.after_tiers.ordinary,1);
  assert.equal(report.unchanged_source_fields,true);
  assert.equal(report.complete,true);
  assert.equal(report.changed_buyers[0].score_after,20);
  assert.equal(before.direct_buyers[0]["Итоговый коэффициент"],0);
  after.direct_buyers[1]["Телефон"]="70000000000";
  const unsafe=stage13DiffAudit(before,after,{deferred:0},null,{});
  assert.equal(unsafe.unchanged_source_fields,false);
  assert.deepEqual(unsafe.unexpected_differences,[{
    row:3,buyer:"ООО Без моделей",field:"Телефон"
  }]);
});
test("deferred work or a model error never counts as completed full Stage13",()=>{
  const data=result();
  assert.equal(stage13DiffAudit(data,data,{deferred:1,stopped_reason:"candidate_limit"}).complete,false);
  assert.equal(stage13DiffAudit(data,data,{deferred:0,stopped_reason:"model_unavailable"}).complete,false);
});
