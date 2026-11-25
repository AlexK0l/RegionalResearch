import test from "node:test";
import assert from "node:assert/strict";
import {lookupFinalInnBatch, resolveFinalMissingInns, withFinalInnCheckpointFlush} from "../src/pipeline.js";

const exhausted=()=>new Error("OpenAI response status: incomplete; reason: max_output_tokens");
const row=(id,inn="")=>({__canonical_id:id,"Организация":"ООО "+id,"Город/район":"Тест","ИНН":inn,__evidence:{source_urls:[],notes:[]}});
const base={client:{},region:"Test",label:"test",assertNotCancelled:async()=>{},maxOutputTokens:2500,retryOutputTokens:5000};
const targets=req=>JSON.parse(req.input.split("КОМПАНИИ:\n").at(-1));
const ok=id=>({id,confirmed_inn:"",source_urls:[],note:"not found"});

test("singleton output limit retries once with compact prompt and capped web calls",async()=>{
  const calls=[];
  const result=await lookupFinalInnBatch({...base,rows:[row("a")],ask:async(_,req)=>{
    calls.push(req);
    if(calls.length===1)throw exhausted();
    return {items:[ok("a")]};
  }});
  assert.deepEqual(calls.map(x=>x.maxOutputTokens),[2500,5000]);
  assert.deepEqual(calls.map(x=>x.maxToolCalls),[2,1]);
  assert.match(calls[1].input,/ТЕХНИЧЕСКИЙ ПОВТОР/);
  assert.deepEqual(result,{items:[ok("a")],tokenDeferredIds:[]});
});

test("split preserves successful sibling when singleton is exhausted twice",async()=>{
  const calls=[];
  const result=await lookupFinalInnBatch({...base,rows:[row("a"),row("b")],ask:async(_,req)=>{
    const ids=targets(req).map(x=>x.id);
    calls.push(ids.join(","));
    if(ids.length>1||ids[0]==="a")throw exhausted();
    return {items:[ok("b")]};
  }});
  assert.deepEqual(calls,["a,b","a","a","b"]);
  assert.deepEqual(result,{items:[ok("b")],tokenDeferredIds:["a"]});
});

test("empty completed batches shrink rather than repeat forever",async()=>{
  let calls=0;
  const result=await lookupFinalInnBatch({...base,rows:[row("a"),row("b")],ask:async()=>{
    calls++;return {items:[]};
  }});
  assert.equal(calls,3);
  assert.deepEqual(result.items.map(x=>x.id),["a","b"]);
});

test("only actual incomplete output status is recoverable",async()=>{
  for(const err of [new Error("insufficient_quota"),new Error("JOB_CANCELLED"),Object.assign(new Error("max_output_tokens invalid"),{status:400}),new Error("network failure")]){
    let calls=0;
    await assert.rejects(lookupFinalInnBatch({...base,rows:[row("a")],ask:async()=>{calls++;throw err;}}),e=>e===err);
    assert.equal(calls,1);
  }
});

test("primary technical deferral is durable, not marked completed, preserves existing INN and skips on resume",async()=>{
  const a=row("a","7707083893"),b=row("b"),c=row("c");
  const result={direct_buyers:[a,b,c],intermediaries:[],leasing:[]};
  const completedIds=new Set(["c"]),technicalDeferred=new Map();
  const args={client:{},finalResult:result,region:"Test",assertNotCancelled:async()=>{},completedIds,technicalDeferred};
  const snapshot=structuredClone(a);
  const first=await resolveFinalMissingInns({...args,lookupBatch:async({rows})=>({
    items:rows.filter(x=>x.__canonical_id==="b").map(x=>ok(x.__canonical_id)),
    tokenDeferredIds:["a"]
  })});
  // Normal comment/email normalization still runs after identity checks.
  // Assert the actual safety invariant, not unrelated presentation fields.
  assert.equal(a["ИНН"],snapshot["ИНН"]);
  assert.equal(a["Организация"],snapshot["Организация"]);
  assert.equal(a["Город/район"],snapshot["Город/район"]);
  assert.deepEqual(a.__evidence,snapshot.__evidence);
  assert.equal(first.completedIds.has("a"),false);
  assert.equal(first.completedIds.has("b"),true);
  assert.equal(first.technicalDeferred.length,1);
  assert.equal(first.technicalDeferred[0].reason,"max_output_tokens");
  const restored=new Map(first.technicalDeferred.map(x=>[x.pass+":"+x.id,x]));
  const second=await resolveFinalMissingInns({...args,technicalDeferred:restored,lookupBatch:async()=>assert.fail("must not repeat paid checks")});
  assert.equal(second.technicalDeferred.length,1);
});

test("checkpoint is flushed on failure and on success",async()=>{
  let flushes=0;
  const fail=new Error("network failure");
  await assert.rejects(withFinalInnCheckpointFlush(async()=>{throw fail;},async()=>{flushes++;}),e=>e===fail);
  assert.equal(await withFinalInnCheckpointFlush(async()=>42,async()=>{flushes++;}),42);
  assert.equal(flushes,2);
});
