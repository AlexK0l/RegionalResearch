import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  observeSabyFleetPagination,safeSabyFleetPaginationSignals
} from "../src/sabyFleetPaginationDiagnostic.js";
import {safeSabyFleetFailure} from "../src/sabyFleetDiagnostic.js";

const validUrl="https://profile.saby.ru/page/contractor-info"+
  "?anchor=about&tab=all&id=964bc800-1cfc-11e0-a3db-00732e102283";

test("Saby pagination is inspected only on a first-party contractor detail with a valid count",async()=>{
  let called=0;
  const invalid=[
    "https://evil.example/page/contractor-info",
    "https://profile.saby.ru/page/company-list-prof",
    "https://online.saby.ru/auth"
  ];
  for(const url of invalid){
    const result=await observeSabyFleetPagination({
      url:()=>url,evaluate:async()=>{called++;return {status:"observed"};}
    },{expected:220});
    assert.equal(result.status,"not_detail");
  }
  for(const n of [0,-2,NaN,5010,"220",undefined]){
    const result=await observeSabyFleetPagination({
      url:()=>validUrl,
      evaluate:async()=>{called++;return {status:"observed"};}
    },{expected:n});
    assert.equal(result.status,"not_detail");
  }
  assert.equal(called,0);
});

test("pagination reporter returns ONLY controlled statuses and bounded counts",()=>{
  const actual=safeSabyFleetPaginationSignals({
    status:"observed",panel_matches:4,
    controls_total:17,controls_in_truck_section:6,
    controls_in_panel_footer:7,unlabeled_controls:2,
    show_more_controls:1,load_more_controls:1,
    next_page_controls:2,disabled_next_controls:1,
    numbered_page_controls:5,page_current_markers:1,
    navigation_landmarks:2,range_indicators:1,
    page_indicators:1,ellipsis_indicators:1,
    load_more_text_leaves:1,loading_indicators:0,
    is_at_truck_scroller_end:true,
    company_name:"АО Автобан",inn:"7725104641",
    email:"avtoban@example.test",
    private_page:validUrl,
    models:["КАМАЗ", "МАЗ"],unknown:{
      cookie:"secret-cookie"
    }
  });
  assert.deepEqual(actual,{
    status:"observed",panel_matches:4,
    controls_total:17,controls_in_truck_section:6,
    controls_in_panel_footer:7,unlabeled_controls:2,
    show_more_controls:1,load_more_controls:1,
    next_page_controls:2,disabled_next_controls:1,
    numbered_page_controls:5,page_current_markers:1,
    navigation_landmarks:2,range_indicators:1,
    page_indicators:1,ellipsis_indicators:1,
    load_more_text_leaves:1,loading_indicators:0,
    is_at_truck_scroller_end:true
  });
  assert.doesNotMatch(JSON.stringify(actual),
    /Автобан|7725104641|avtoban|КАМАЗ|МАЗ|secret|cookie|contractor-info/);
});

test("malformed DOM responses never inject pagination data into fleet logs",()=>{
  const raw={
    status:"verified",
    panel_matches:"PRIVATE",controls_total:-1,
    controls_in_truck_section:9999999,
    controls_in_panel_footer:4.7,unlabeled_controls:Infinity,
    show_more_controls:true,load_more_controls:1,
    next_page_controls:"СЕКРЕТНЫЙ КОНТРОЛ",
    disabled_next_controls:2,
    numbered_page_controls:0,
    page_current_markers:1,navigation_landmarks:1,
    range_indicators:1,page_indicators:1,
    ellipsis_indicators:0,
    load_more_text_leaves:0,loading_indicators:1,
    is_at_truck_scroller_end:"true"
  };
  const result=safeSabyFleetFailure({
    reason:"vehicle_rows_incomplete",phase:"vehicles",
    fleet_pagination:raw
  });
  assert.equal(result.fleet_pagination.status,"unavailable");
  assert.equal(result.fleet_pagination.controls_total,null);
  assert.equal(result.fleet_pagination.controls_in_truck_section,120);
  assert.equal(result.fleet_pagination.controls_in_panel_footer,null);
  assert.equal(result.fleet_pagination.unlabeled_controls,null);
  assert.equal(result.fleet_pagination.show_more_controls,null);
  assert.equal(result.fleet_pagination.load_more_controls,1);
  assert.equal(result.fleet_pagination.is_at_truck_scroller_end,false);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|СЕКРЕТНЫЙ КОНТРОЛ/);
});

test("real page probe filters DOM output before handing it to recorder",async()=>{
  let calls=0;
  const result=await observeSabyFleetPagination({
    url:()=>validUrl,
    evaluate:async (_fn,args)=>{
      calls++;
      assert.equal(args.expected,220);
      return {
        status:"observed",panel_matches:3,
        controls_total:15,show_more_controls:1,
        next_page_controls:2,range_indicators:1,
        is_at_truck_scroller_end:true,
        actualText:"Покупатель СЕКРЕТНО ИНН 7725104641",
        model:"МАЗ 5440",sessionId:"SESSION_SECRET"
      };
    }
  },{expected:220});
  assert.equal(calls,1);
  assert.equal(result.status,"observed");
  assert.equal(result.next_page_controls,2);
  assert.equal(result.show_more_controls,1);
  assert.equal(result.range_indicators,1);
  assert.equal(result.is_at_truck_scroller_end,true);
  assert.doesNotMatch(JSON.stringify(result),/СЕКРЕТНО|7725104641|МАЗ|SESSION_SECRET/);
  const error=await observeSabyFleetPagination({
    url:()=>validUrl,
    evaluate:async()=>{throw Error("PRIVATE_EMAIL=secret@example.test");}
  },{expected:220});
  assert.equal(error.status,"unavailable");
  assert.doesNotMatch(JSON.stringify(error),/PRIVATE_EMAIL|secret@example.test/);
});

test("pagination probe is read-only, opt-in, and runs only after an exhausted fleet scrollbar",()=>{
  const src=fs.readFileSync(
    new URL("../src/sabyFleetPaginationDiagnostic.js",import.meta.url),"utf8");
  const browser=fs.readFileSync(
    new URL("../src/sabyBrowser.js",import.meta.url),"utf8");
  assert.match(src,/page\.evaluate\(/);
  assert.doesNotMatch(src,/\bclick\s*\(|\.click\s*\(|scrollTop\s*=/);
  assert.doesNotMatch(src,/console\.(?:log|warn|error)/);
  assert.match(browser,/observeSabyFleetPagination/);
  assert.match(browser,/progress\.scroll_at_end===true/);
  assert.match(browser,/\["scroll_not_advanced","window_not_updated"\]/);
  assert.match(browser,/stillSameFleetCompany\(\)/);
  assert.match(browser,/settings\.publicIdentityFallback===true/);
  assert.match(browser,/Unchanged Stage12 behavior for nonexperimental runs/);
});
