import test from "node:test";
import assert from "node:assert/strict";
import {createFullJobQueue,fullJobConcurrencyLimit,normalizedRegionKey} from "../src/fullJobQueue.js";
const job=(id,region)=>({id,region,state:"waiting",progress:{},cancelled:false});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test("two distinct regions run at once; third waits until slot is released",async()=>{
  const starts=[],inflight=new Set(),gates=new Map(),max={value:0};
  const q=createFullJobQueue({limit:2,execute:async j=>{
    starts.push(j.id);inflight.add(j.id);max.value=Math.max(max.value,inflight.size);
    const d=deferred();gates.set(j.id,d);await d.promise;
    inflight.delete(j.id);j.state="completed";
  }});
  const a=job("a","Смоленская область"),b=job("b","Тверская область"),c=job("c","Калужская область");
  assert.equal(q.enqueue(a,"test").accepted,true);
  assert.equal(q.enqueue(b,"test").accepted,true);
  assert.equal(q.enqueue(c,"test").accepted,true);
  await tick();
  assert.deepEqual(starts,["a","b"]);
  assert.deepEqual(q.snapshot(),{active:2,pending:1,limit:2});
  assert.equal(c.progress.phase,"queued");
  assert.equal(c.progress.queuePosition,1);
  assert.equal(q.enqueue(job("duplicate"," ТВЕРСКАЯ   ОБЛАСТЬ "),"test").accepted,false);
  gates.get("a").resolve();await tick();
  assert.deepEqual(starts,["a","b","c"]);
  assert.equal(max.value,2);
  gates.get("b").resolve();gates.get("c").resolve();await tick();
  assert.deepEqual(q.snapshot(),{active:0,pending:0,limit:2});
  assert.equal(q.conflict("Смоленская область"),null);
});

test("same region remains locked while an active job is cancelling",async()=>{
  const d=deferred();const q=createFullJobQueue({limit:1,execute:async()=>await d.promise});
  const a=job("a","Республика Коми");
  q.enqueue(a,"test");await tick();
  a.cancelled=true;a.state="cancelling";
  assert.equal(q.enqueue(job("b","РЕСПУБЛИКА КОМИ"),"test").accepted,false);
  d.resolve();await tick();
  assert.equal(q.enqueue(job("b","Республика Коми"),"test").accepted,true);
  await tick();
});

test("cancelling a queued region frees only that region and preserves other jobs",async()=>{
  const d=deferred(),starts=[];
  const q=createFullJobQueue({limit:1,execute:async j=>{
    starts.push(j.id);if(j.id==="a")await d.promise;
  }});
  q.enqueue(job("a","Тверская область"),"test");
  const b=job("b","Калужская область");q.enqueue(b,"test");
  await tick();b.cancelled=true;b.state="cancelled";
  assert.equal(q.cancelQueued("b"),true);
  assert.equal(q.conflict("Калужская область"),null);
  q.enqueue(job("c","Калужская область"),"test");
  d.resolve();await tick();
  assert.deepEqual(starts,["a","c"]);
});

test("concurrency defaults to two and caps at three",()=>{
  assert.equal(fullJobConcurrencyLimit({}),2);
  assert.equal(fullJobConcurrencyLimit({MAX_ACTIVE_FULL_JOBS:"3"}),3);
  assert.equal(fullJobConcurrencyLimit({MAX_ACTIVE_FULL_JOBS:"99"}),3);
  assert.equal(fullJobConcurrencyLimit({MAX_ACTIVE_FULL_JOBS:"0"}),2);
  assert.equal(fullJobConcurrencyLimit({MAX_ACTIVE_FULL_JOBS:"oops"}),2);
  assert.equal(normalizedRegionKey("  ЁЛКИ — Тверская   область "),"елки-тверская область");
});
