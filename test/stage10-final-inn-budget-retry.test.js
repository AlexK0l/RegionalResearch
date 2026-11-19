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

test("stage10: primary INN phase budget is a nonfatal defer, not a research error",async()=>{
  const rows=[row("a",{hint:false})];
  const batches=[];
  const result=await run({rows,completedIds:new Set(),
    lookupBatch:async()=>{throw budgetStop();},
    onBatch:async progress=>batches.push({
      completedIds:[...progress.completedIds],
      primaryBudgetDeferred:progress.primaryBudgetDeferred,
      primaryBudgetDeferredIds:progress.primaryBudgetDeferredIds
    })
  });
  assert.equal(result.primaryBudgetDeferred,1);
  assert.deepEqual(result.primaryBudgetDeferredIds,["a"]);
  assert.equal(result.attempted,0);
  assert.equal(result.recovered,0);
  assert.equal(result.completedIds.size,0,
    "unchecked company must not be recorded as searched");
  assert.equal(rows[0]["ИНН"],"");
  assert.deepEqual(batches.at(-1),{
    completedIds:[],primaryBudgetDeferred:1,primaryBudgetDeferredIds:["a"]
  },"even if the first lookup failed, the checkpoint callback must run");
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

test("stage10: 591/600 and 1457/1850 never stop Stage11-13 for identity budget",async()=>{
  const rows=Array.from({length:25},(_,i)=>row("company-"+i,{hint:false}));
  const labels=[];
  const checkpoints=[];
  const result=await run({rows,lookupBatch:async({label})=>{
    labels.push(label);
    if(label.startsWith("1/"))throw budgetStop();
    return {items:[]};
  },onBatch:async state=>checkpoints.push({
    attempted:state.attempted,
    deferred:state.primaryBudgetDeferred||0,
    ids:[...state.completedIds]
  })});
  assert.equal(labels.filter(s=>s==="5/5").length,0,
    "once identity phase cap is reached, no queued batch launches");
  assert.equal(result.primaryBudgetDeferred,25-result.attempted);
  assert.equal(result.completedIds.size,result.attempted);
  assert.equal(result.completedIds.has("company-0"),false);
  assert.equal(result.primaryBudgetDeferredIds.includes("company-0"),true);
  assert.equal(result.completedIds.size+result.primaryBudgetDeferredIds.length,25);
  assert.equal(result.recovered,0);
  assert.equal(rows.filter(x=>x["ИНН"]).length,0);
  assert.equal(checkpoints.at(-1).deferred,result.primaryBudgetDeferred,
    "the terminal snapshot must contain deferred primary count");
});

test("stage10: pending primary INN never retried as if it had been searched",async()=>{
  const rows=[row("a"),row("b")];
  const calls=[];
  const result=await run({rows,
    completedIds:new Set(["a"]),
    lookupBatch:async({label})=>{
      calls.push(label);
      throw budgetStop();
    }
  });
  assert.deepEqual(calls,["1/1"],
    "optional retry cannot consume a second call after primary budget stop");
  assert.equal(result.primaryBudgetDeferred,1);
  assert.deepEqual(result.primaryBudgetDeferredIds,["b"]);
  assert.equal(result.retryBudgetDeferred,1);
  assert.deepEqual(result.retryBudgetDeferredIds,["a"]);
  assert.equal(result.completedIds.has("retry:a"),false);
  assert.equal(result.completedIds.has("b"),false);
});

test("stage10: budget deferral preserves cumulative 680 checked/283 recovered",async()=>{
  const result=await run({
    rows:[row("a",{hint:false}),row("b",{hint:false})],
    completedIds:new Set(),
    previousStats:{attempted:680,recovered:283,retried:20},
    lookupBatch:async()=>{throw budgetStop();}
  });
  assert.equal(result.attempted,680);
  assert.equal(result.recovered,283);
  assert.equal(result.retried,20);
  assert.equal(result.primaryBudgetDeferred,2);
  assert.deepEqual(result.primaryBudgetDeferredIds,["a","b"]);
});

test("stage10: total/cost stop and unexpected API failures remain hard errors",async()=>{
  for(const scope of ["total","estimated_cost_usd"]){
    const error=budgetStop();
    error.scope=scope;
    await assert.rejects(run({rows:[row("a",{hint:false})],
      lookupBatch:async()=>{throw error;}
    }),err=>err===error);
  }
  await assert.rejects(run({rows:[row("a",{hint:false})],
    lookupBatch:async()=>{throw Error("unexpected network failure");}
  }),/unexpected network failure/);
  await assert.rejects(run({rows:[row("a",{hint:false})],
    lookupBatch:async()=>{throw Error("JOB_CANCELLED");}
  }),/JOB_CANCELLED/);
});
