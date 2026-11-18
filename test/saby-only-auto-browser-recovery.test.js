import test from "node:test";
import assert from "node:assert/strict";
import {runSabyOnlyWithRecovery}
  from "../src/sabyOnlyRecovery.js";

const ids=["7707083893","7702070139","7736207543"];
const stats=more=>({
  processed:0,verified:0,review:0,phonesAdded:0,emailsAdded:0,
  transportsAdded:0,vehiclesVerified:0,partialResults:0,
  companyReviews:0,systemicErrors:0,circuitOpen:false,browserError:"",
  fullSweepCompleted:false,deadlineReached:false,deferred:3,...more
});

test("one browser run processes complete queue without reopening or asking a user",async()=>{
  let calls=0;
  const out=await runSabyOnlyWithRecovery({
    total:3,maxDurationMs:7200000,wait:async()=>assert.fail("no wait"),
    runPass:async()=>{
      calls++;
      return {completedInns:ids,deferredInns:[],attemptedInns:[],
        stats:stats({processed:3,verified:3,deferred:0,fullSweepCompleted:true})};
    }
  });
  assert.equal(calls,1);
  assert.equal(out.stats.browserRestarts,0);
  assert.equal(out.stats.fullSweepCompleted,true);
  assert.equal(out.stats.processed,3);
  assert.equal(out.stats.totalAttempts,3);
  assert.deepEqual(out.deferredInns,[]);
});

test("after circuit break, one new browser session continues from the exact saved cursor",async()=>{
  const visited=[],observed=[],progress=[];
  let count=0;
  const out=await runSabyOnlyWithRecovery({
    total:3,maxDurationMs:7200000,wait:async()=>{},
    completedInns:[],attemptedInns:[],
    onRecovery:x=>observed.push(x),
    onProgress:x=>progress.push(x),
    runPass:async opts=>{
      count++;
      visited.push({
        completed:[...opts.completedInns],
        attempted:[...opts.attemptedInns]
      });
      if(count===1){
        await opts.onProgress(stats({processed:1,systemicErrors:1}));
        return {stats:stats({processed:1,review:1,systemicErrors:1,
          circuitOpen:true}),completedInns:[],
          deferredInns:ids,attemptedInns:[ids[0]]};
      }
      await opts.onProgress(stats({processed:3,verified:3,deferred:0}));
      return {stats:stats({processed:3,verified:3,deferred:0,
        fullSweepCompleted:true}),completedInns:ids,
        deferredInns:[],attemptedInns:[]};
    }
  });
  assert.equal(count,2);
  assert.deepEqual(visited[1].attempted,[ids[0]]);
  assert.equal(observed.length,1);
  assert.equal(observed[0].reason,"circuit_open");
  assert.equal(out.stats.browserRestarts,1);
  assert.equal(out.stats.circuitOpen,false);
  assert.equal(out.stats.fullSweepCompleted,true);
  assert.equal(out.stats.processed,3);
  assert.equal(out.stats.totalAttempts,4);
  assert.equal(out.stats.verified,3);
  assert.ok(progress.every(x=>x.processed<=3));
});

test("persistent browser outage stops after bounded restarts and retains all deferred",async()=>{
  let calls=0;const recoveries=[];
  const out=await runSabyOnlyWithRecovery({
    total:3,maxDurationMs:7200000,wait:async()=>{},
    onRecovery:x=>recoveries.push(x),
    runPass:async()=>{
      calls++;
      return {stats:stats({browserError:"Playwright unavailable"}),
        completedInns:[],attemptedInns:[],deferredInns:ids};
    }
  });
  assert.equal(calls,3);
  assert.equal(recoveries.length,2);
  assert.equal(out.stats.browserRestarts,2);
  assert.equal(out.stats.fullSweepCompleted,false);
  assert.equal(out.stats.processed,0);
  assert.equal(out.stats.deferred,3);
});

test("company reviews without systemic errors do not cause repeated Saby passes",async()=>{
  let calls=0;
  const out=await runSabyOnlyWithRecovery({
    total:3,maxDurationMs:7200000,wait:async()=>assert.fail("not a circuit"),
    runPass:async()=>{
      calls++;
      return {stats:stats({processed:3,review:3,companyReviews:3,
        deferred:3,fullSweepCompleted:true}),
        completedInns:[],attemptedInns:ids,deferredInns:ids};
    }
  });
  assert.equal(calls,1);
  assert.equal(out.stats.review,3);
  assert.equal(out.stats.fullSweepCompleted,true);
});

test("deadline and cancellation never open another browser",async()=>{
  let calls=0;
  const expired=await runSabyOnlyWithRecovery({
    total:3,maxDurationMs:60000,wait:async()=>{},
    runPass:async()=>{
      calls++;
      return {stats:stats({processed:1,circuitOpen:true,deadlineReached:true}),
        completedInns:[],attemptedInns:[ids[0]],deferredInns:ids};
    }
  });
  assert.equal(calls,1);
  assert.equal(expired.stats.fullSweepCompleted,false);
  const abort=new AbortController();
  abort.abort();
  await assert.rejects(
    runSabyOnlyWithRecovery({
      total:3,maxDurationMs:120000,signal:abort.signal,
      runPass:()=>assert.fail("browser must not launch")
    }),/JOB_CANCELLED/
  );
});
