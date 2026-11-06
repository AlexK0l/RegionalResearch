import test from "node:test";
import assert from "node:assert/strict";
import { estimateResearchEta, historicalStageDurations } from "../src/researchEta.js";

const MINUTE=60000;
function steps() {
  return Array.from({length:11}, (_,i)=>({
    step:i+1,status:"waiting",startedAt:null,completedAt:null
  }));
}
function job(statuses,state="active",mode="full") {
  return { mode,state,progress:{phase:"research",statuses} };
}
function done(step,start,duration) {
  step.status="done";
  step.startedAt=start;
  step.completedAt=start+duration;
}
test("no false deadline before two measured discovery stages",()=>{
  const a=steps();
  a[0].status="running";a[0].startedAt=100000;
  assert.equal(estimateResearchEta(job(a),{now:130000}).status,"calibrating");
  done(a[0],100000,120000);
  assert.equal(estimateResearchEta(job(a),{now:220000}).status,"calibrating");
});
test("two finished steps yield countdown that decreases with time",()=>{
  const a=steps();
  done(a[0],100000,120000);
  done(a[1],220000,180000);
  a[2].status="running";a[2].startedAt=400000;
  const first=estimateResearchEta(job(a),{now:410000});
  const second=estimateResearchEta(job(a),{now:415000});
  assert.equal(first.status,"estimated");
  assert.equal(second.status,"estimated");
  assert.ok(first.remainingMs>second.remainingMs);
  assert.equal(first.remainingMs-second.remainingMs,5000);
  assert.match(first.reason,/Приблизительно/);
  // 9 discovery steps don't imply 90% of total elapsed time:
  // stages 10 and 11 remain in the estimate independently.
  assert.ok(first.remainingMs>56*MINUTE);
});
test("resume at final INN stage works even without stage 1–9 timestamps",()=>{
  const a=steps();
  for(let i=0;i<9;i++)a[i].status="done";
  a[9].status="running";a[9].startedAt=1000000;
  const result=estimateResearchEta(job(a,"active","resume"),{now:1000000+60000});
  assert.equal(result.status,"estimated");
  assert.equal(result.completedStages,9);
  assert.ok(result.remainingMs>50*MINUTE);
});
test("overrun shows recalibrating instead of a fake zero countdown",()=>{
  const a=steps();
  done(a[0],100000,60000);done(a[1],160000,60000);
  a[2].status="running";a[2].startedAt=220000;
  const result=estimateResearchEta(job(a),{now:220000+10*MINUTE});
  assert.equal(result.status,"recalibrating");
  assert.equal(result.remainingMs,null);
});
test("queued, failed, canceled and completed jobs don't keep counting",()=>{
  const a=steps();
  assert.equal(estimateResearchEta(job(a,"waiting")).status,"queued");
  assert.equal(estimateResearchEta(job(a,"cancelled")).status,"cancelled");
  assert.equal(estimateResearchEta(job(a,"failed")).status,"failed");
  assert.equal(estimateResearchEta(job(a,"completed")).remainingMs,0);
  assert.equal(estimateResearchEta(job(a,"active","quality")).status,"not_applicable");
});
test("historical runs allow immediate coarse estimate with per-step real durations",()=>{
  const h=steps();
  for(let i=0;i<11;i++)done(h[i],100000+i*MINUTE,MINUTE);
  const history=historicalStageDurations([job(h,"completed")]);
  assert.equal(history.length,11);
  assert.equal(history[0],MINUTE);
  const current=steps();current[0].status="running";current[0].startedAt=300000;
  const result=estimateResearchEta(job(current),{now:320000,history});
  assert.equal(result.status,"estimated");
  assert.ok(result.remainingMs<11*MINUTE);
  assert.equal(result.basis,"measured");
});
