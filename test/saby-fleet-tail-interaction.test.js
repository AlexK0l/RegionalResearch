import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  safeSabyFleetTailClickReport,
  isSabyFleetTailClickEligible,
  locateSabyFleetTailClick,
  probeSabyFleetTailClick
} from "../src/sabyFleetTailInteraction.js";
import {sabyBrowserSettings,safeSabySectionDiagnostic}
  from "../src/sabyBrowser.js";
import {safeSabyFleetFailure} from "../src/sabyFleetDiagnostic.js";
import {appendSabyTruckWindow}
  from "../src/sabyFleetWindows.js";

const url="https://profile.saby.ru/page/contractor-info"+
  "?anchor=about&tab=all&page=public&local=false"+
  "&id=964bc800-1cfc-11e0-a3db-00732e102283";
const other=url.replace("964bc800","264bc800");
const rows=n=>Array.from({length:n},(_,i)=>({
  model:"Грузовой автомобиль "+(i+1),year:2020
}));
const tail=(n=40)=>({
  status:"observed",waited_ms:11000,
  truck_row_count_changed:false,
  sample_before:{
    status:"observed",truck_row_count:n,
    three_dot_cluster:true,small_dot_candidates:3,
    dot_pointer_cursor:true,dot_animated:false,
    dot_loading_class:false,gap_interactive_elements:0
  },
  sample_after:{
    status:"observed",truck_row_count:n,
    three_dot_cluster:true,small_dot_candidates:3,
    dot_pointer_cursor:true,dot_animated:false,
    dot_loading_class:false,gap_interactive_elements:0
  }
});
function pageFactory({target="ready",clicked,after=rows(40)}={}){
  const actions={clicks:0,reads:0,waits:0};
  let current=url;
  const page={
    url:()=>current,
    evaluate:async(_fn,{expected,rowsBefore})=>{
      assert.equal(expected,220);
      assert.equal(rowsBefore,40);
      return target==="ready"?{status:"ready",x:1130,y:842}:
        {status:target};
    },
    mouse:{
      click:async (x,y)=>{
        assert.equal(x,1130);
        assert.equal(y,842);
        actions.clicks++;
        if(clicked)current=clicked;
      }
    }
  };
  return {page,actions,readPanel:async()=>{
    actions.reads++;
    return {opened:true,rows:after};
  },wait:async()=>{actions.waits++;}};
}

test("v21 fixed evidence authorizes one explicitly opted-in click",()=>{
  assert.equal(isSabyFleetTailClickEligible(tail(),40),true);
  for(const change of [
    t=>{t.sample_before.dot_animated=true;},
    t=>{t.sample_before.dot_loading_class=true;},
    t=>{t.sample_before.dot_pointer_cursor=false;},
    t=>{t.sample_after.three_dot_cluster=false;},
    t=>{t.sample_after.small_dot_candidates=5;},
    t=>{t.sample_after.truck_row_count=41;},
    t=>{t.truck_row_count_changed=true;},
    t=>{t.waited_ms=1000;},
    t=>{t.sample_after.gap_interactive_elements=1;},
  ]){
    const x=tail();change(x);
    assert.equal(isSabyFleetTailClickEligible(x,40),false);
  }
});

test("one narrow click can expose additional rows, never repeated",async()=>{
  const m=pageFactory({after:rows(220)});
  const diagnostic=await probeSabyFleetTailClick(m.page,{
    originalUrl:url,expected:220,baselineRows:rows(40),
    tail:tail(),readPanel:m.readPanel,wait:m.wait
  });
  assert.deepEqual(diagnostic,{
    status:"rows_extended",click_attempted:true,
    rows_before:40,rows_after:220,
    row_sequence_changed:true,panel_open_after:true,samples:1
  });
  assert.equal(m.actions.clicks,1);
  assert.equal(m.actions.reads,1);
  assert.equal(m.actions.waits,0);
  const full=appendSabyTruckWindow(rows(40),rows(220),220);
  assert.equal(full.status,"advanced");
  assert.equal(full.rows.length,220);
});

test("one click that swaps out the 40 rows is NOT proof of contiguous new vehicles",async()=>{
  const m=pageFactory({after:rows(40).map((r,i)=>({
    model:"Другой грузовик "+(i+1),year:2021
  }))});
  const out=await probeSabyFleetTailClick(m.page,{
    originalUrl:url,expected:220,baselineRows:rows(40),
    tail:tail(),readPanel:m.readPanel,wait:m.wait
  });
  assert.equal(out.status,"rows_replaced");
  assert.equal(out.row_sequence_changed,true);
  assert.equal(out.rows_after,40);
  assert.equal(m.actions.clicks,1);
});

test("unchanged 40 rows after click stop without any second interaction",async()=>{
  const m=pageFactory();
  const out=await probeSabyFleetTailClick(m.page,{
    originalUrl:url,expected:220,baselineRows:rows(40),
    tail:tail(),readPanel:m.readPanel,wait:m.wait
  });
  assert.equal(out.status,"rows_unchanged");
  assert.equal(out.rows_after,40);
  assert.equal(out.samples,8);
  assert.equal(m.actions.clicks,1);
  assert.equal(m.actions.waits,7);
});

test("non-pointing or ambiguous tail target is never clicked",async()=>{
  for(const target of ["target_missing","target_ambiguous",
    "target_not_pointer","target_not_at_end","target_blocked"]){
    const m=pageFactory({target});
    const out=await probeSabyFleetTailClick(m.page,{
      originalUrl:url,expected:220,baselineRows:rows(40),
      tail:tail(),readPanel:m.readPanel,wait:m.wait
    });
    assert.equal(out.status,target);
    assert.equal(out.click_attempted,false);
    assert.equal(m.actions.clicks,0);
    assert.equal(m.actions.reads,0);
  }
});

test("another company card is never clicked or read, even with same title",async()=>{
  const m=pageFactory({clicked:other,after:rows(220)});
  const out=await probeSabyFleetTailClick(m.page,{
    originalUrl:url,expected:220,baselineRows:rows(40),
    tail:tail(),readPanel:m.readPanel,wait:m.wait
  });
  assert.equal(out.status,"company_changed");
  assert.equal(out.click_attempted,true);
  assert.equal(m.actions.clicks,1);
  assert.equal(m.actions.reads,0);
  const p={...m.page,url:()=>other};
  const before=await probeSabyFleetTailClick(p,{
    originalUrl:url,expected:220,baselineRows:rows(40),
    tail:tail(),readPanel:m.readPanel
  });
  assert.equal(before.status,"company_changed");
  assert.equal(before.click_attempted,false);
});

test("no DOM read before first-party route and exact-count validation",async()=>{
  let called=0;
  for(const input of [
    {expected:0,rowsBefore:40,url},
    {expected:5010,rowsBefore:40,url},
    {expected:220,rowsBefore:220,url},
    {expected:220,rowsBefore:40,url:"https://evil.example/contractor-info"}
  ]){
    const out=await locateSabyFleetTailClick({
      url:()=>input.url,
      evaluate:async()=>{called++;return {status:"ready",x:10,y:20};}
    },{expected:input.expected,rowsBefore:input.rowsBefore});
    assert.equal(out.status,"target_missing");
  }
  assert.equal(called,0);
});

test("browser/DOM error is value-free and does not click anything",async()=>{
  const m=pageFactory();
  m.page.evaluate=async()=>{throw Error("SECRET 7725104641 password");};
  const out=await probeSabyFleetTailClick(m.page,{
    originalUrl:url,expected:220,baselineRows:rows(40),
    tail:tail(),readPanel:m.readPanel,wait:m.wait
  });
  assert.equal(out.status,"target_missing");
  assert.equal(m.actions.clicks,0);
  assert.doesNotMatch(JSON.stringify(out),/7725104641|password|SECRET/);
});

test("sanitized fleet report never logs vehicle models, contact or URL",()=>{
  const out=safeSabyFleetFailure({
    phase:"vehicles",reason:"vehicle_rows_incomplete",
    fleet_tail_click:{
      status:"rows_extended",click_attempted:true,
      rows_before:40,rows_after:70,
      row_sequence_changed:true,panel_open_after:true,samples:3,
      private_model:"КАМАЗ 43118",email:"contact@example.test",
      url:"https://profile.saby.ru/SECRET",
      session:"SESSION_SECRET"
    },
    tail_merge_reason:"ambiguous_overlap"
  });
  assert.equal(out.fleet_tail_click.status,"rows_extended");
  assert.equal(out.fleet_tail_click.rows_after,70);
  assert.equal(out.tail_merge_reason,"ambiguous_overlap");
  assert.doesNotMatch(JSON.stringify(out),
    /КАМАЗ|contact@|SECRET|SESSION|private_model/);
  const invalid=safeSabyFleetTailClickReport({
    status:"secret_company",rows_before:-1,
    rows_after:"220",click_attempted:"yes",
    samples:999,private_name:"PRIVATE"
  });
  assert.equal(invalid.status,"invalid_setup");
  assert.equal(invalid.rows_before,null);
  assert.equal(invalid.rows_after,null);
  assert.equal(invalid.click_attempted,false);
  assert.equal(invalid.samples,12);
  assert.doesNotMatch(JSON.stringify(invalid),/PRIVATE|secret_company/);
});

test("experimental click is smoke-only, explicit, headed, not default Stage12",()=>{
  const source=fs.readFileSync(
    new URL("../src/sabyBrowser.js",import.meta.url),"utf8");
  const smoke=fs.readFileSync(
    new URL("../scripts/saby-smoke.js",import.meta.url),"utf8");
  assert.match(source,/env\.SABY_SMOKE_ONLY==="true"/);
  assert.match(source,/env\.SABY_FLEET_TAIL_CLICK_OPT_IN==="true"/);
  assert.match(source,/settings\.fleetTailClickOptIn/);
  assert.match(source,/if\(clicked\.status==="rows_extended"/);
  assert.match(source,/appendSabyTruckWindow/);
  assert.match(source,/Unchanged Stage12 behavior for nonexperimental runs/);
  assert.match(smoke,/args\.includes\("--fleet-tail-click"\)/);
  assert.match(smoke,/env\.SABY_MAX_COMPANIES!=="1"/);
  assert.match(smoke,/SABY_FLEET_TAIL_CLICK_OPT_IN:"false"/);
  assert.equal(sabyBrowserSettings({
    SABY_SMOKE_ONLY:"true",
    SABY_MAX_COMPANIES:"2",
    SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED:"true",
    SABY_FLEET_TAIL_CLICK_OPT_IN:"true"
  }).fleetTailClickOptIn,false);
  assert.match(smoke,/args\.includes\("--headless"\)/);
  assert.equal(sabyBrowserSettings({
    SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED:"true",
    SABY_FLEET_TAIL_CLICK_OPT_IN:"true"
  }).fleetTailClickOptIn,false);
  assert.equal(sabyBrowserSettings({
    SABY_SMOKE_ONLY:"true",
    SABY_MAX_COMPANIES:"1",
    SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED:"true",
    SABY_FLEET_TAIL_CLICK_OPT_IN:"true"
  }).fleetTailClickOptIn,true);
  assert.equal(sabyBrowserSettings({}).fleetTailClickOptIn,false);
});
