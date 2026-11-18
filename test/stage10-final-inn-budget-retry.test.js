import test from "node:test";
import assert from "node:assert/strict";
import {resolveFinalMissingInns} from "../src/pipeline.js";

const budgetStop=()=>{
  const error=new Error("WEB_BUDGET_STOP:identity:592/600:total=1474/1850");
  error.code="WEB_BUDGET_STOP";
  error.scope="identity";
  return error;
};
const row=(id,{hint=true}={})=>({
  __canonical_id:id,
  "Организация":"ООО "+id,
  "ИНН":"",
  "Город/район":"Смоленская область",
  "__evidence":{
    notes:[],source_urls:[],
    ...(hint?{final_inn_retry_urls:["https://example.org/new-proof/"+id]}:{})
  }
});
const input=(...items)=>({
  direct_buyers:items,intermediaries:[],leasing:[]
});
const run=(options={})=>resolveFinalMissingInns({
  client:{__webBudget:{kind:"full",used:{identity:592,total:1474},
    limits:{identity:600,total:1850},reserved:{identity:0,total:0}}},
  finalResult:input(...(options.rows||[])),
  region:"Смоленская область",
  assertNotCancelled:async()=>{},
  completedIds:options.completedIds||new Set(),
  previousStats:options.previousStats||{},
  lookupBatch:options.lookupBatch||(async()=>({items:[]})),
  onBatch:options.onBatch||(async()=>{})
});

test("stage10: after ALL primary INN checks, exhausted optional retry budget is nonfatal",async()=>{
  const rows=[row("a"),row("b"),row("c",{hint:false})];
  const completedIds=new Set(["a","b","c"]);
  let attempted=0;
  const result=await run({rows,completedIds,lookupBatch:async()=>{
    attempted++;
    throw budgetStop();
  }});
  assert.equal(attempted,1);
  assert.equal(result.completedIds.size,3);
  assert.equal(result.attempted,0);
  assert.equal(result.retried,0);
  assert.equal(result.retryBudgetDeferred,2);
  assert.deepEqual(result.retryBudgetDeferredIds,["a","b"]);
  assert.equal(result.missing,3);
  assert.equal(rows[0]["ИНН"],"");
  assert.ok(!result.completedIds.has("retry:a"),
    "deferred retry must not be falsely marked completed");
});

test("stage10: primary INN lookup exhaustion is still a resumable hard stop",async()=>{
  const rows=[row("a",{hint:false})];
  await assert.rejects(run({rows,completedIds:new Set(),lookupBatch:async()=>{
    throw budgetStop();
  }}),/WEB_BUDGET_STOP:identity/);
});

test("stage10: successful optional retries stay recorded as done and aren't repeated",async()=>{
  const rows=[row("a")];
  const completedIds=new Set(["a"]);
  let lookedUp=0,saved=0;
  const result=await run({rows,completedIds,
    lookupBatch:async({rows:batch,label})=>{
      lookedUp++;
      assert.ok(label.startsWith("retry-"));
      assert.equal(batch.length,1);
      return {items:[]};
    },
    onBatch:async()=>{saved++;}
  });
  assert.equal(lookedUp,1);
  assert.equal(saved,1);
  assert.equal(result.retried,1);
  assert.equal(result.retryBudgetDeferred,0);
  assert.deepEqual(result.retryBudgetDeferredIds,[]);
  assert.ok(result.completedIds.has("retry:a"));
  const resumed=await run({rows,completedIds,lookupBatch:async()=>{
    throw Error("This retry must be skipped on resume");
  }});
  assert.equal(resumed.retried,0);
  assert.equal(resumed.retryBudgetDeferred,0);
});

test("stage10: unexpected API failures are not disguised as web-budget deferrals",async()=>{
  await assert.rejects(run({
    rows:[row("a")],completedIds:new Set(["a"]),
    lookupBatch:async()=>{throw Error("network JSON corrupt");}
  }),/network JSON corrupt/);
});


test("stage10: resume preserves prior 680 completed checks and 283 found INNs in cumulative counters",async()=>{
  const rows=[row("a"),row("b")];
  const completedIds=new Set(["a","b"]);
  const stats={attempted:680,recovered:283,retried:20};
  const resumed=await run({
    rows,completedIds,previousStats:stats,
    lookupBatch:async()=>{throw budgetStop();}
  });
  assert.equal(resumed.attempted,680);
  assert.equal(resumed.recovered,283);
  assert.equal(resumed.retried,20);
  assert.equal(resumed.retryBudgetDeferred,2);
  assert.equal(resumed.completedIds.size,2);
});
