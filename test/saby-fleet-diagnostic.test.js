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
    parsed_vehicle_rows:2,side_panel_observed:true,expanded:true,
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
  assert.match(source,/fleetProgress\.reason\|\|=fleetProgress\.phase==="overlay"/);
  assert.match(source,/await ownTrucks\(page,settings,fleetProgress\)/);
  assert.match(source,/fleetProgress\.reason/);
  assert.doesNotMatch(source,/console\.(?:warn|log|info)\([^\n]*error\.message/);
});
