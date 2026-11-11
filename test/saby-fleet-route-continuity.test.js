import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {compareSabyVerifiedFleetDetail}
  from "../src/sabyFleetRouteContinuity.js";
import {openSabyFleetPanelWithHydration}
  from "../src/sabyFleetPanelOpening.js";

const base="https://profile.saby.ru/page/contractor-info";
const companyId="964bc800-1cfc-11e0-a3db-00732e102283";
const otherId="264bc800-1cfc-11e0-a3db-00732e102283";
const original=base+"?anchor=about&tab=all&page=public&local=false&id="+companyId;

test("same verified opaque company ID permits only known fleet SPA UI changes",()=>{
  const routes=[
    original,
    base+"?id="+companyId+"&local=false&page=public&tab=all&anchor=about",
    base+"?id="+companyId+"&local=false&page=public&tab=fleet&anchor=transport",
    base+"?id="+companyId+"&local=false&page=public&tab=all&anchor=about&panel=fleet",
    base+"?id="+companyId+"&local=false&page=public&tab=all&anchor=about#fleet"
  ];
  for(const url of routes) {
    const x=compareSabyVerifiedFleetDetail(original,url);
    assert.equal(x.ok,true,url);
    assert.ok(["same_detail","ui_navigation_only"].includes(x.reason));
    assert.equal(typeof x.ui_navigation_only,"boolean");
    assert.doesNotMatch(JSON.stringify(x),/964bc800|id=|about|tab=/);
  }
});

test("known source=internal one-way disappearance is safe only for same contractor",()=>{
  const start=base+"?id="+companyId+"&source=internal&tab=about";
  const after=base+"?id="+companyId+"&tab=fleet";
  assert.equal(compareSabyVerifiedFleetDetail(start,after).ok,true);
  assert.equal(compareSabyVerifiedFleetDetail(after,start).ok,false);
});

test("same opaque ID with unknown query mutations remains fail closed",()=>{
  const invalid=[
    base+"?id="+companyId+"&local=true&anchor=transport&tab=fleet&page=public",
    base+"?id="+companyId+"&anchor=transport&tab=fleet&page=public",
    original+"&token=SECRET",
    original+"&source=not-internal",
    original+"#truckPanelOpaqueId",
    base+"/other?anchor=fleet&tab=all&page=public&local=false&id="+companyId,
    "http://profile.saby.ru/page/contractor-info?"+
      "anchor=fleet&tab=all&page=public&local=false&id="+companyId,
    "https://saby.ru/profile/"+companyId,
    "https://evil.example/page/contractor-info?id="+companyId,
    "https://user:pw@profile.saby.ru/page/contractor-info?id="+companyId
  ];
  for(const url of invalid) {
    const x=compareSabyVerifiedFleetDetail(original,url);
    assert.equal(x.ok,false,url);
    assert.equal(typeof x.reason,"string");
    assert.doesNotMatch(JSON.stringify(x),/SECRET|964bc800|token|contractor-info|local=false|user:pw/);
  }
});

test("a changed or omitted company ID never permits reading another fleet",()=>{
  const invalid=[
    original.replace(companyId,otherId),
    base+"?anchor=fleet&tab=all&page=public&local=false",
    base+"?anchor=fleet&tab=all&page=public&local=false&id=",
    original+"&id="+companyId,
    original.replace("id="+companyId,"contractorId="+companyId)
  ];
  for(const url of invalid) {
    const x=compareSabyVerifiedFleetDetail(original,url);
    assert.equal(x.ok,false,url);
    assert.ok(["company_card_id_changed","stable_card_id_missing"].includes(x.reason));
  }
  assert.equal(compareSabyVerifiedFleetDetail(
    base+"?tab=about",base+"?tab=fleet").ok,false);
  assert.equal(compareSabyVerifiedFleetDetail(
    original,original.replace(companyId,otherId)).reason,
    "company_card_id_changed");
});

test("fleet URL route diagnostics are value-free even for unknown added keys",()=>{
  const next=base+"?id="+companyId+
    "&anchor=fleet&tab=all&page=public&local=false&secret=TOKEN_PRIVATE";
  const x=compareSabyVerifiedFleetDetail(original,next);
  assert.deepEqual(x,{
    ok:false,reason:"non_ui_query_changed",
    route_delta:{status:"observed",non_ui_added:1,
      non_ui_removed:0,non_ui_values_changed:0,ui_values_changed:1}
  });
  assert.doesNotMatch(JSON.stringify(x),/secret|TOKEN_PRIVATE|964bc800|fleet/);
});

test("hydrating the same fleet panel after safe Saby UI navigation is allowed",async()=>{
  let current=original,polls=0,clicks=0;
  const check=()=>compareSabyVerifiedFleetDetail(original,current).ok;
  const out=await openSabyFleetPanelWithHydration({
    clickPreview:async()=>{
      assert.equal(check(),true);
      clicks++;
      current=base+"?id="+companyId+
        "&anchor=fleet&tab=all&page=public&local=false";
      return check();
    },
    readPanel:async()=>{
      if(!check())return {opened:false,routeChanged:true};
      polls++;
      return polls>=3?{opened:true,rows:[{model:"КамАЗ 5490",year:2022}]}:
        {opened:false,rows:[]};
    },
    observePanel:async()=>({fleet_panel_title:polls>=2}),
    wait:async()=>{},pollsPerClick:5
  });
  assert.equal(out.opened,true);
  assert.equal(out.clicks,1);
  assert.equal(clicks,1);
  assert.equal(out.polls,3);
});

test("a changed company ID during panel hydration fails without a second click",async()=>{
  let current=original,clicks=0;
  const check=()=>compareSabyVerifiedFleetDetail(original,current).ok;
  const out=await openSabyFleetPanelWithHydration({
    clickPreview:async()=>{
      clicks++;
      current=original.replace(companyId,otherId);
      return check();
    },
    readPanel:async()=>({opened:true,rows:[]}),
    wait:async()=>{}
  });
  assert.equal(out.opened,false);
  assert.equal(out.reason,"preview_click_unavailable");
  assert.equal(clicks,1);
});

test("browser uses strict fleet route checker without weakening original alias proof",()=>{
  const source=fs.readFileSync(new URL("../src/sabyBrowser.js",import.meta.url),"utf8");
  assert.match(source,/compareSabyVerifiedFleetDetail\(/);
  assert.match(source,/fleetOriginalRoute/);
  assert.match(source,/second_click_after_ui_change_blocked/);
  assert.match(source,/if\(!stillSameFleetCompany\(\)\)/);
  assert.match(source,/post_route_registered_identity_verified/);
  assert.match(source,/Unchanged Stage12 behavior for nonexperimental runs/);
});
