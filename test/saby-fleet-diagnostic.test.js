import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  safeSabyFleetFailure,observeSabyFleetDOM
} from "../src/sabyFleetDiagnostic.js";

const detailUrl="https://profile.saby.ru/page/contractor-info?"+
  "id=PRIVATE_COMPANY_ID&token=PRIVATE_TOKEN";

test("bounded diagnostic reveals only allowlisted fleet stage, not private DOM or errors",()=>{
  const report={
    phase:"vehicles",reason:"vehicle_rows_incomplete",
    preview_status:"found",expected_trucks:7,
    parsed_vehicle_rows:2,window_count:4,scroll_moves:3,
    stale_scroll_moves:2,consecutive_stale_scroll_moves:1,
    scroll_candidates:3,scroll_selected_from_vehicle_rows:true,
    scroll_target_contains_truck:false,scroll_target_vehicle_leaves:40,
    scroll_target_is_panel:false,scroll_at_end:true,
    scroll_top:650,scroll_max:650,
    stitch_reason:"scroll_not_advanced",
    panel_open_attempts:2,panel_wait_polls:7,panel_title_seen:true,
    fleet_ui_route_updated:true,route_guard_reason:"ui_navigation_only",
    side_panel_observed:true,expanded:true,
    company_name:"Дорстройсервис",inn:"7725104641",
    private_email:"private-contact@example.test",
    private_page_url:detailUrl,
    raw_error:"user@secret.test https://secret.test/session"
  };
  const snapshot={
    status:"observed",exact_fleet_heading:true,
    contact_overlay_title:false,fleet_panel_title:true,
    truck_category_labels:2,truck_count_label:true,
    category_expand_control:true,
    full_body:"private-contact@example.test",
    raw_model:"КамАЗ 5490",
    raw_kpp:"504301001"
  };
  const safe=safeSabyFleetFailure(report,snapshot);
  assert.deepEqual(safe,{
    status:"incomplete",phase:"vehicles",reason:"vehicle_rows_incomplete",
    dom_status:"observed",exact_fleet_heading:true,
    contact_overlay_title:false,fleet_panel_title:true,
    truck_category_labels:2,truck_count_label:true,
    category_expand_control:true,preview_status:"found",
    expected_trucks:7,parsed_vehicle_rows:2,
    window_count:4,scroll_moves:3,
    stale_scroll_moves:2,consecutive_stale_scroll_moves:1,
    scroll_candidates:3,scroll_selected_from_vehicle_rows:true,
    scroll_target_contains_truck:false,scroll_target_vehicle_leaves:40,
    scroll_target_is_panel:false,scroll_at_end:true,
    scroll_top:650,scroll_max:650,
    stitch_reason:"scroll_not_advanced",
    panel_open_attempts:2,panel_wait_polls:7,panel_title_seen:true,
    fleet_ui_route_updated:true,fleet_route_reason:"ui_navigation_only",
    fleet_route_delta:null,
    side_panel_observed:true,expanded:true
  });
  assert.doesNotMatch(JSON.stringify(safe),
    /Дорстройсервис|7725104641|PRIVATE|token|user@|private-contact|secret|КамАЗ|504301001/);
});

test("unexpected untrusted values cannot inject diagnostics or fake a verified fleet",()=>{
  const z=safeSabyFleetFailure({
    phase:"password secret",reason:"private token: secret",
    preview_status:"verified",expected_trucks:-3,
    parsed_vehicle_rows:7777777777,
    expanded:"true",side_panel_observed:1
  },{status:"verified",truck_category_labels:999999,
    exact_fleet_heading:"true",fleet_panel_title:1});
  assert.equal(z.status,"incomplete");
  assert.equal(z.phase,"unknown");
  assert.equal(z.reason,"fleet_interaction_failed");
  assert.equal(z.dom_status,"unavailable");
  assert.equal(z.expected_trucks,null);
  assert.equal(z.parsed_vehicle_rows,5000);
  assert.equal(z.truck_category_labels,30);
  assert.equal(z.window_count,null);
  assert.equal(z.scroll_moves,null);
  assert.equal(z.stale_scroll_moves,null);
  assert.equal(z.consecutive_stale_scroll_moves,null);
  assert.equal(z.scroll_candidates,null);
  assert.equal(z.scroll_selected_from_vehicle_rows,false);
  assert.equal(z.scroll_target_contains_truck,false);
  assert.equal(z.scroll_target_vehicle_leaves,null);
  assert.equal(z.scroll_target_is_panel,false);
  assert.equal(z.scroll_at_end,false);
  assert.equal(z.scroll_top,null);
  assert.equal(z.scroll_max,null);
  assert.equal(z.stitch_reason,"not_attempted");
  assert.equal(z.panel_open_attempts,null);
  assert.equal(z.panel_wait_polls,null);
  assert.equal(z.panel_title_seen,false);
  assert.equal(z.fleet_ui_route_updated,false);
  assert.equal(z.fleet_route_reason,"not_observed");
  assert.equal(z.fleet_route_delta,null);
  assert.equal(z.exact_fleet_heading,false);
  assert.equal(z.expanded,false);
  assert.equal(z.side_panel_observed,false);
  assert.doesNotMatch(JSON.stringify(z),/secret|private token/);
});

test("fleet DOM probe only observes first-party contractor detail, never search/login",async()=>{
  let calls=0;
  for(const url of [
    "https://evil.example/page/contractor-info",
    "https://profile.saby.ru/page/company-list-prof",
    "https://online.saby.ru/auth/"
  ]){
    const result=await observeSabyFleetDOM({
      url:()=>url,evaluate:async()=>{calls++;return {status:"observed"};}
    });
    assert.deepEqual(result,{status:"not_detail"});
  }
  assert.equal(calls,0);
});

test("fleet DOM probe discards any accidental private content returned by browser",async()=>{
  const out=await observeSabyFleetDOM({
    url:()=>detailUrl,
    evaluate:async()=>({
      status:"observed",exact_fleet_heading:true,
      contact_overlay_title:true,fleet_panel_title:false,
      truck_category_labels:1,truck_count_label:false,
      category_expand_control:false,
      body:"ИНН 7725104641 КПП 504301001",
      email:"private@example.test",
      model:"МАЗ 5516"
    })
  });
  assert.deepEqual(out,{
    status:"observed",exact_fleet_heading:true,
    contact_overlay_title:true,fleet_panel_title:false,
    truck_category_labels:1,truck_count_label:false,
    category_expand_control:false
  });
  assert.doesNotMatch(JSON.stringify(out),
    /7725104641|504301001|private@|МАЗ|PRIVATE/);
  const failed=await observeSabyFleetDOM({
    url:()=>detailUrl,evaluate:async()=>{
      throw new Error("private email or browser URL");
    }
  });
  assert.deepEqual(failed,{status:"unavailable"});
});

test("collector emits fleet-specific failure only when required section incomplete",()=>{
  const source=fs.readFileSync(
    new URL("../src/sabyBrowser.js",import.meta.url),"utf8");
  assert.match(source,/result\.trucks\.status!=="verified"/);
  assert.match(source,/\[SABY_FLEET_DIAG\]/);
  assert.match(source,/settings\.publicIdentityFallback===true/);
  assert.match(source,/safeSabyFleetFailure\(fleetProgress,evidence\)/);
  assert.match(source,/fleetProgress\.reason\s*\|\|=\s*fleetProgress\.phase==="overlay"/);
  assert.match(source,/await ownTrucks\(page,settings,fleetProgress\)/);
  assert.match(source,/fleetProgress\.reason/);
  assert.doesNotMatch(source,/console\.(?:warn|log|info)\([^\n]*error\.message/);
});

test("new fleet URL diagnostics expose counts only, not URLs, company IDs or query names",()=>{
  const out=safeSabyFleetFailure({
    reason:"vehicle_rows_incomplete",phase:"vehicles",
    route_guard_reason:"non_ui_query_changed",
    route_delta:{status:"observed",non_ui_added:1,non_ui_removed:0,
      non_ui_values_changed:1,ui_values_changed:2,
      secret:"hidden=TOKEN_PRIVATE"},
    fleet_ui_route_updated:true,
    confidential_id:"964bc800-1cfc-11e0-a3db-00732e102283",
    private_url:"https://profile.saby.ru/page/contractor-info?id=PRIVATE"
  });
  assert.equal(out.fleet_route_reason,"non_ui_query_changed");
  assert.equal(out.fleet_ui_route_updated,true);
  assert.deepEqual(out.fleet_route_delta,{status:"observed",
    non_ui_added:1,non_ui_removed:0,non_ui_values_changed:1,
    ui_values_changed:2});
  assert.doesNotMatch(JSON.stringify(out),
    /TOKEN_PRIVATE|confidential|964bc800|PRIVATE|contractor-info|hidden/);
  const invalid=safeSabyFleetFailure({
    route_guard_reason:"private_url_is_SECRET",
    route_delta:{status:"observed",non_ui_added:"SECRET",
      non_ui_removed:-2,non_ui_values_changed:0,ui_values_changed:0}
  });
  assert.equal(invalid.fleet_route_reason,"not_observed");
  assert.equal(invalid.fleet_route_delta.non_ui_added,null);
  assert.equal(invalid.fleet_route_delta.non_ui_removed,null);
});

test("scroll diagnostic data cannot leak DOM strings or spoof invalid geometry",()=>{
  const safe=safeSabyFleetFailure({
    phase:"vehicles",reason:"vehicle_rows_incomplete",
    scroll_candidates:3,scroll_target_vehicle_leaves:40,
    scroll_max:1400,scroll_top:900,scroll_at_end:false,
    scroll_target_contains_truck:false,
    scroll_target_is_panel:false,
    scroll_selected_from_vehicle_rows:true,
    stale_scroll_moves:5,consecutive_stale_scroll_moves:2,
    scroll_selector:"secret@company.test",
    scroll_classes:"MY_SECRET_SELECTOR",
    raw_model:"КАМАЗ 5490",inn:"7725104641"
  });
  assert.equal(safe.scroll_candidates,3);
  assert.equal(safe.scroll_target_vehicle_leaves,40);
  assert.equal(safe.scroll_top,900);
  assert.equal(safe.scroll_max,1400);
  assert.equal(safe.stale_scroll_moves,5);
  assert.equal(safe.consecutive_stale_scroll_moves,2);
  assert.equal(safe.scroll_selected_from_vehicle_rows,true);
  assert.doesNotMatch(JSON.stringify(safe),
    /secret@|MY_SECRET_SELECTOR|КАМАЗ|7725104641|scroll_classes/);
  const corrupted=safeSabyFleetFailure({
    scroll_candidates:"private",scroll_target_vehicle_leaves:-40,
    scroll_top:"hidden",scroll_max:Infinity,
    stale_scroll_moves:"1",consecutive_stale_scroll_moves:-1
  });
  assert.equal(corrupted.scroll_candidates,null);
  assert.equal(corrupted.scroll_target_vehicle_leaves,null);
  assert.equal(corrupted.scroll_top,null);
  assert.equal(corrupted.scroll_max,null);
  assert.equal(corrupted.stale_scroll_moves,null);
  assert.equal(corrupted.consecutive_stale_scroll_moves,null);
});
