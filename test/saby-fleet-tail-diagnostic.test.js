import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  observeSabyFleetTail,
  safeSabyFleetTailSignals,
  safeSabyFleetTailComparison
} from "../src/sabyFleetTailDiagnostic.js";
import {safeSabyFleetFailure} from "../src/sabyFleetDiagnostic.js";

const contractor="https://profile.saby.ru/page/contractor-info"+
  "?anchor=about&tab=all&page=public&local=false&"+
  "id=964bc800-1cfc-11e0-a3db-00732e102283";

test("fleet-tail probe refuses non-first-party routes and invalid counts",async()=>{
  let reads=0;
  for(const [url,count] of [
    ["https://evil.example/page/contractor-info?id=private",220],
    ["https://profile.saby.ru/page/company-list-prof",220],
    [contractor,0],[contractor,5010],[contractor,"220"],
    [contractor,undefined]
  ]){
    const result=await observeSabyFleetTail({
      url:()=>url,
      evaluate:async()=>{reads++;return {status:"observed"};}
    },{expected:count,wait:async()=>assert.fail("do not wait")});
    assert.equal(result.status,"incomplete_observation");
    assert.equal(result.sample_before.status,"not_detail");
  }
  assert.equal(reads,0);
});

test("read-only probe identifies custom three-dot loader after bounded wait",async()=>{
  let reads=0,waited=0;
  const result=await observeSabyFleetTail({
    url:()=>contractor,
    evaluate:async (_fn,{expected})=>{
      assert.equal(expected,220);
      reads++;
      return {
        status:"observed",panel_matches:6,
        truck_row_count:reads===1?40:41,
        gap_height:78,
        small_dot_candidates:3,
        three_dot_cluster:true,
        dot_semantic_click:false,
        dot_pointer_cursor:false,
        dot_animated:true,
        dot_loading_class:true,
        dot_more_class:false,
        gap_interactive_elements:0,
        company_name:"АО СЕКРЕТ",inn:"7725104641",
        model:"КАМАЗ 43118, 2022",
        cookie:"DO_NOT_LOG"
      };
    }
  },{expected:220,waitMs:11000,wait:async ms=>{waited=ms;}});
  assert.equal(reads,2);
  assert.equal(waited,11000);
  assert.equal(result.status,"observed");
  assert.equal(result.waited_ms,11000);
  assert.equal(result.truck_row_count_changed,true);
  assert.equal(result.sample_before.truck_row_count,40);
  assert.equal(result.sample_after.truck_row_count,41);
  assert.equal(result.sample_before.three_dot_cluster,true);
  assert.equal(result.sample_before.dot_animated,true);
  assert.equal(result.sample_before.dot_semantic_click,false);
  assert.doesNotMatch(JSON.stringify(result),
    /СЕКРЕТ|КАМАЗ|7725104641|DO_NOT_LOG|company_name/);
});

test("three-dot shape without pointer/animation cannot be assumed clickable",async()=>{
  const raw={
    status:"observed",panel_matches:1,truck_row_count:40,
    gap_height:58,small_dot_candidates:3,
    three_dot_cluster:true,dot_semantic_click:false,
    dot_pointer_cursor:false,dot_animated:false,
    dot_loading_class:false,dot_more_class:false,
    gap_interactive_elements:0
  };
  const result=await observeSabyFleetTail({
    url:()=>contractor,
    evaluate:async()=>raw
  },{expected:220,wait:async()=>{}});
  assert.equal(result.status,"observed");
  assert.equal(result.truck_row_count_changed,false);
  assert.equal(result.sample_after.dot_more_class,false);
  assert.equal(result.sample_after.dot_pointer_cursor,false);
});

test("a missing visible gap stops without repeating blind waits",async()=>{
  let waitCalls=0,reads=0;
  const out=await observeSabyFleetTail({
    url:()=>contractor,
    evaluate:async()=>{reads++;return {
      status:"gap_not_visible",panel_matches:2,truck_row_count:40
    };}
  },{expected:220,wait:async()=>{waitCalls++;}});
  assert.equal(out.status,"incomplete_observation");
  assert.equal(out.sample_before.status,"gap_not_visible");
  assert.equal(reads,1);
  assert.equal(waitCalls,0);
  assert.equal(out.waited_ms,0);
});

test("raw CSS, URL and model strings are never returned or logged",()=>{
  const safe=safeSabyFleetTailSignals({
    status:"observed",panel_matches:8,truck_row_count:40,
    gap_height:70,small_dot_candidates:3,
    three_dot_cluster:true,dot_semantic_click:true,
    dot_pointer_cursor:true,dot_animated:false,
    dot_loading_class:false,dot_more_class:true,
    gap_interactive_elements:1,
    className:"PRIVATE_CLASS_Token",
    model:"КАМАЗ 43118",
    url:"https://profile.saby.ru/?token=SECRET",
    phone:"+7 900 1234567"
  });
  assert.deepEqual(safe,{
    status:"observed",panel_matches:8,truck_row_count:40,
    gap_height:70,small_dot_candidates:3,
    three_dot_cluster:true,dot_semantic_click:true,
    dot_pointer_cursor:true,dot_animated:false,
    dot_loading_class:false,dot_more_class:true,
    gap_interactive_elements:1
  });
  assert.doesNotMatch(JSON.stringify(safe),
    /PRIVATE_CLASS|КАМАЗ|SECRET|900 1234567|url/);
});

test("malformed or unknown evidence remains safely bounded",()=>{
  const sample=safeSabyFleetTailSignals({
    status:"verified",panel_matches:1e9,truck_row_count:"220",
    gap_height:-1,small_dot_candidates:true,
    three_dot_cluster:1,dot_semantic_click:"true",
    dot_pointer_cursor:false,dot_animated:true,
    dot_loading_class:1,dot_more_class:null,
    gap_interactive_elements:NaN
  });
  assert.equal(sample.status,"unavailable");
  assert.equal(sample.panel_matches,16);
  assert.equal(sample.truck_row_count,null);
  assert.equal(sample.gap_height,null);
  assert.equal(sample.small_dot_candidates,null);
  assert.equal(sample.three_dot_cluster,false);
  assert.equal(sample.dot_semantic_click,false);
  assert.equal(sample.dot_animated,true);
  assert.equal(sample.dot_loading_class,false);
  assert.equal(sample.gap_interactive_elements,null);
  assert.equal(safeSabyFleetTailComparison().status,"incomplete_observation");
  const f=safeSabyFleetFailure({
    phase:"vehicles",reason:"vehicle_rows_incomplete",
    fleet_tail:{
      sample_before:{
        status:"observed",truck_row_count:40,
        private_session:"DO_NOT_LOG",
      },
      sample_after:{
        status:"observed",truck_row_count:40,
        model:"МАШИНА_СЕКРЕТ"
      },
      waited_ms:11000
    }
  });
  assert.equal(f.fleet_tail.status,"observed");
  assert.equal(f.fleet_tail.sample_before.truck_row_count,40);
  assert.equal(f.fleet_tail.sample_after.truck_row_count,40);
  assert.equal(f.fleet_tail.truck_row_count_changed,false);
  assert.doesNotMatch(JSON.stringify(f),/DO_NOT_LOG|МАШИНА_СЕКРЕТ/);
});

test("probe is opt-in and strictly read-only after exhausted authenticated fleet",()=>{
  const src=fs.readFileSync(
    new URL("../src/sabyFleetTailDiagnostic.js",import.meta.url),"utf8");
  const browser=fs.readFileSync(
    new URL("../src/sabyBrowser.js",import.meta.url),"utf8");
  assert.match(src,/page\.evaluate\(/);
  assert.doesNotMatch(src,/\b(?:click|scrollIntoView|fetch)\s*\(|scrollTop\s*=/);
  assert.doesNotMatch(src,/console\.(?:log|warn|error)/);
  assert.match(browser,/progress\.scroll_at_end===true/);
  assert.match(browser,/observeSabyFleetTail\(page/);
  assert.match(browser,/pagination\.next_page_controls===0/);
  assert.match(browser,/stillSameFleetCompany\(\)/);
  assert.match(browser,/settings\.publicIdentityFallback===true/);
  assert.match(browser,/Unchanged Stage12 behavior for nonexperimental runs/);
});
