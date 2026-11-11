import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {openSabyFleetPanelWithHydration}
  from "../src/sabyFleetPanelOpening.js";
import {safeSabyFleetFailure} from "../src/sabyFleetDiagnostic.js";

const privateRows=[{model:"Грузовик КАМАЗ 5490",year:2020}];

test("hydrating side panel is observed after several DOM polls, without a second click",async()=>{
  let clicked=0,polls=0,waits=0;
  const result=await openSabyFleetPanelWithHydration({
    clickPreview:async()=>{clicked++;return true;},
    readPanel:async()=>{
      polls++;
      return polls>=5?{opened:true,rows:privateRows}:{opened:false,rows:[]};
    },
    observePanel:async()=>({fleet_panel_title:polls>=2}),
    wait:async()=>{waits++;},
    pollsPerClick:8,pollMs:100
  });
  assert.equal(result.opened,true);
  assert.equal(result.reason,"panel_ready");
  assert.equal(result.clicks,1);
  assert.equal(result.polls,5);
  assert.equal(clicked,1);
  assert.equal(waits,4);
  assert.equal(result.panel.rows.length,1);
});

test("retry exactly one click only if no panel title or category is visible",async()=>{
  let clicks=0,polls=0;
  const result=await openSabyFleetPanelWithHydration({
    clickPreview:async()=>{clicks++;return true;},
    readPanel:async()=>{
      polls++;
      return clicks===2?{opened:true,rows:privateRows}:{opened:false};
    },
    observePanel:async()=>({fleet_panel_title:false,truck_category_labels:1}),
    wait:async()=>{},
    pollsPerClick:3
  });
  assert.equal(result.opened,true);
  assert.equal(result.clicks,2);
  assert.equal(result.polls,4);
  assert.equal(clicks,2);
});

test("already visible but unrecognized side panel must never be toggled closed",async()=>{
  let clicks=0;
  const result=await openSabyFleetPanelWithHydration({
    clickPreview:async()=>{clicks++;return true;},
    readPanel:async()=>({opened:false}),
    observePanel:async()=>({fleet_panel_title:true,truck_category_labels:1}),
    wait:async()=>{},
    pollsPerClick:3
  });
  assert.equal(result.opened,false);
  assert.equal(result.reason,"panel_unrecognized");
  assert.equal(result.titleSeen,true);
  assert.equal(clicks,1);
});

test("two visible truck category labels also block destructive second click",async()=>{
  let clicks=0;
  const result=await openSabyFleetPanelWithHydration({
    clickPreview:async()=>{clicks++;return true;},
    readPanel:async()=>({opened:false}),
    observePanel:async()=>({fleet_panel_title:false,truck_category_labels:2}),
    wait:async()=>{},
    pollsPerClick:2
  });
  assert.equal(result.opened,false);
  assert.equal(result.reason,"panel_unrecognized");
  assert.equal(clicks,1);
});

test("changed page URL aborts without another click or using another legal entity",async()=>{
  let clicks=0;
  const result=await openSabyFleetPanelWithHydration({
    clickPreview:async()=>{clicks++;return true;},
    readPanel:async()=>({opened:false,routeChanged:true}),
    wait:async()=>{}
  });
  assert.equal(result.opened,false);
  assert.equal(result.reason,"detail_changed");
  assert.equal(clicks,1);
  assert.equal(result.polls,1);
});

test("click rejected on changed URL never enters a DOM read",async()=>{
  let reads=0;
  const result=await openSabyFleetPanelWithHydration({
    clickPreview:async()=>false,
    readPanel:async()=>{reads++;return {opened:true};}
  });
  assert.equal(result.opened,false);
  assert.equal(result.reason,"preview_click_unavailable");
  assert.equal(result.clicks,0);
  assert.equal(reads,0);
});

test("if the panel never appears, bounded attempts end incomplete",async()=>{
  let clicks=0,reads=0;
  const result=await openSabyFleetPanelWithHydration({
    clickPreview:async()=>{clicks++;return true;},
    readPanel:async()=>{reads++;return {opened:false};},
    observePanel:async()=>({fleet_panel_title:false,truck_category_labels:1}),
    pollsPerClick:4,wait:async()=>{}
  });
  assert.equal(result.opened,false);
  assert.equal(result.reason,"panel_not_observed");
  assert.equal(clicks,2);
  assert.equal(reads,8);
});

test("sanitized diagnostics omit private data even with hydrated panel rows",()=>{
  const safe=safeSabyFleetFailure({
    reason:"vehicle_rows_incomplete",
    phase:"vehicles",
    stitch_reason:"panel_unrecognized",
    panel_open_attempts:1,
    panel_wait_polls:20,
    panel_title_seen:true,
    private_name:"АО СЕКРЕТНАЯ КОМПАНИЯ",
    panel:privateRows,
    url:"https://profile.saby.ru/page/contractor-info?id=SECRET"
  });
  assert.equal(safe.panel_open_attempts,1);
  assert.equal(safe.panel_wait_polls,20);
  assert.equal(safe.panel_title_seen,true);
  assert.equal(safe.stitch_reason,"panel_unrecognized");
  assert.doesNotMatch(JSON.stringify(safe),/СЕКРЕТНАЯ|КАМАЗ|SECRET|5490|contractor-info/);
});

test("hydration wait stays opt-in and regular Stage12 collection stays unchanged",()=>{
  const text=fs.readFileSync(new URL("../src/sabyBrowser.js",import.meta.url),"utf8");
  assert.match(text,/openSabyFleetPanelWithHydration\(/);
  assert.match(text,/settings\.publicIdentityFallback===true/);
  assert.match(text,/sidePanelTrucks\(page,preview\.count,"window"\)/);
  assert.match(text,/Unchanged Stage12 behavior for nonexperimental runs/);
});
