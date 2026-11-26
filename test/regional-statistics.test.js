import test from "node:test";
import assert from "node:assert/strict";
import {REGIONAL_STATISTICS,regionalStatisticId,regionalStatisticsCoverage,runRegionalStatistics} from "../src/regionalStatistics.js";
import {OpenAIBillingPauseError} from "../src/openaiBillingGuard.js";
const row=(item,value=120,overrides={})=>({
  "Показатель":item.label,"Значение":value,"Единица измерения":"ед.",
  "Период / дата актуальности":"2026","Источник":"https://example.org/registry",
  "Методика / примечание":"Подсчёт по опубликованному реестру",...overrides
});
test("only missing statistics re-enter the bounded recovery request",async()=>{
  const calls=[],saved=[];
  const result=await runRegionalStatistics({request:async items=>{
    calls.push(items.map(x=>x.id));
    if(calls.length===1)return {statistics:[
      row(items[0]),row(items[1],"н/д",{"Источник":"","Методика / примечание":"Нет открытого воспроизводимого реестра"}),
      row(items[2],300,{"Источник":""})]};
    return {statistics:items.map(item=>row(item,12))};
  },onCheckpoint:async snapshot=>saved.push(structuredClone(snapshot))});
  assert.equal(calls.length,2);
  assert.deepEqual(calls[1],REGIONAL_STATISTICS.slice(2).map(x=>x.id));
  assert.equal(saved[0].state.accepted,2);
  assert.equal(saved[0].state.numeric,1);
  assert.equal(result.state.complete,true);
  assert.equal(result.state.numeric,7);
  assert.equal(result.state.explicit_unavailable,1);
  assert.equal(result.rows.length,8);
  assert.equal(result.rows[0]["Значение"],120);
});
test("billing pause preserves partial metrics and retry cursor; no repeat of first paid response",async()=>{
  let saved,calls=0;
  await assert.rejects(runRegionalStatistics({request:async items=>{
    if(++calls===1)return {statistics:[row(items[0])]};
    throw new OpenAIBillingPauseError();
  },onCheckpoint:async snapshot=>{saved=structuredClone(snapshot);}}),{code:"OPENAI_BILLING_STOP"});
  assert.equal(saved.state.status,"billing_paused");
  assert.equal(saved.state.attempts,1);
  assert.equal(saved.state.accepted,1);
  const recovered=await runRegionalStatistics({
    initialRows:saved.rows,initialState:saved.state,
    request:async items=>{
      assert.equal(items.length,7);assert.ok(!items.some(x=>x.id==="population"));
      return {statistics:items.map(item=>row(item))};
    }
  });
  assert.equal(recovered.state.complete,true);
  assert.equal(recovered.state.attempts,2);
  assert.equal(recovered.rows[0]["Значение"],120);
  const reused=await runRegionalStatistics({initialRows:recovered.rows,initialState:recovered.state,
    request:()=>{throw Error("unexpected paid request");}});
  assert.equal(reused.state.complete,true);
  assert.equal(reused.state.attempts,2);
});
test("budget exhaustion never creates verified figures or successful missing rows",async()=>{
  let calls=0;
  const result=await runRegionalStatistics({
    initialRows:[row(REGIONAL_STATISTICS[0],0)],
    request:async()=>{calls++;throw Object.assign(Error("budget"),{code:"BUDGET"});},
    isBudgetStop:error=>error.code==="BUDGET"
  });
  assert.equal(calls,1);
  assert.equal(result.state.status,"budget_deferred");
  assert.equal(result.state.numeric,1);
  assert.equal(result.rows.filter(x=>x.__statistics_unresolved).length,7);
  assert.equal(regionalStatisticsCoverage(result.rows).accepted,1);
  assert.equal(result.rows[0]["Значение"],0);
});
test("invalid source, period, number and ambiguous label cannot masquerade as coverage",()=>{
  const coverage=regionalStatisticsCoverage([
    row(REGIONAL_STATISTICS[0],"2026.11.26"),
    row(REGIONAL_STATISTICS[1],12,{"Период / дата актуальности":""}),
    row(REGIONAL_STATISTICS[2],12,{"Источник":"поиск"}),
    row(REGIONAL_STATISTICS[3],10,{"Показатель":"дорожные и деревообрабатывающие компании"}),
    row(REGIONAL_STATISTICS[4],12),
    row(REGIONAL_STATISTICS[4],13)
  ]);
  assert.equal(coverage.numeric,1);
  assert.equal(coverage.duplicate_conflicts,1);
  assert.equal(coverage.rejected,4);
  assert.equal(regionalStatisticId("Численность населения"),"population");
});
test("checkpoint pause stops the next request, preserving first response",async()=>{
  let calls=0,snapshot;
  await assert.rejects(runRegionalStatistics({
    request:async items=>{calls++;return {statistics:[row(items[0])]};},
    onCheckpoint:async value=>{snapshot=structuredClone(value);throw Error("MEMORY_PAUSE");}
  }),/MEMORY_PAUSE/);
  assert.equal(calls,1);
  assert.equal(snapshot.state.accepted,1);
  assert.equal(snapshot.state.attempts,1);
});
