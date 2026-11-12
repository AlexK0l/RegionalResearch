import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {compareSabyVerifiedFleetDetail}
  from "../src/sabyFleetRouteContinuity.js";
import {openSabyVerifiedFleetTreePanel}
  from "../src/sabyFleetTreeOpening.js";
const original="https://profile.saby.ru/page/contractor-info?"+
  "anchor=about&tab=all&page=public&local=false&"+
  "id=964bc800-1cfc-11e0-a3db-00732e102283";
const changed="https://profile.saby.ru/page/contractor-info?"+
  "anchor=fleet&tab=all&page=public&local=false&"+
  "id=964bc800-1cfc-11e0-a3db-00732e102283";
const other=changed.replace("964bc800","264bc800");
const live=x=>({
  status:"found",count:220,
  rect:{x,y:120,w:310,h:260}
});

test("real v26 regression: after an allowed same-company SPA URL update, remeasure the tile and open panel on bounded second click",async()=>{
  let current=original,drawer=false,reads=0;
  const clickedAt=[],newPreviewReads=[];
  const result=await openSabyVerifiedFleetTreePanel({
    expected:220,
    readTree:async()=>{
      reads++;
      return drawer?{status:"observed",expected:220,
        rows:[{key:"22014723",label:"FAW CA3250, 2024"}]}:
        {status:"invalid",reason:"tree_missing"};
    },
    readPreview:async()=>{
      // The first tile position belongs to the original UI. A Saby
      // UI-only route update changes the layout's clickable position.
      const tile=live(current===original?100:300);
      newPreviewReads.push(tile.rect.x);
      return tile;
    },
    panelVisible:async()=>drawer,
    sameCompany:()=>compareSabyVerifiedFleetDetail(original,current).ok,
    clickPreview:async target=>{
      clickedAt.push(target.rect.x);
      if(clickedAt.length===1)current=changed;
      else drawer=true;
      return true;
    },
    wait:async()=>{},pollsPerClick:3
  });
  assert.deepEqual(newPreviewReads,[100,300]);
  assert.deepEqual(clickedAt,[100,300]);
  assert.equal(result.opened,true);
  assert.equal(result.reason,"panel_ready");
  assert.equal(result.clicks,2);
  assert.equal(result.titleSeen,true);
  assert.equal(reads,5);
});

test("if Saby's exact tree is already open, do NOT click the tile and close it",async()=>{
  let targets=0,clicks=0;
  const out=await openSabyVerifiedFleetTreePanel({
    expected:220,readTree:async()=>({
      status:"observed",expected:220,
      rows:[{key:"22014723",label:"FAW CA3250, 2024"}]
    }),
    readPreview:async()=>{targets++;return live(100);},
    clickPreview:async()=>{clicks++;return true;},
    panelVisible:async()=>true,
    sameCompany:()=>true
  });
  assert.equal(out.opened,true);
  assert.equal(out.clicks,0);
  assert.equal(targets,0);
  assert.equal(clicks,0);
  assert.equal(out.titleSeen,true);
});

test("the panel title appears before vehicle rows: wait for hydration, never toggle",async()=>{
  let reads=0,previews=0,clicks=0;
  const out=await openSabyVerifiedFleetTreePanel({
    expected:220,
    readTree:async()=>{
      reads++;
      return {
        status:"observed",expected:220,
        rows:reads>=4?[{key:"22014723",label:"FAW CA3250, 2024"}]:[]
      };
    },
    readPreview:async()=>{previews++;return live(100);},
    clickPreview:async()=>{clicks++;return true;},
    panelVisible:async()=>true,
    sameCompany:()=>true,wait:async()=>{},
    pollsPerClick:5
  });
  assert.equal(out.opened,true);
  assert.equal(out.clicks,0);
  assert.equal(reads,4);
  assert.equal(clicks,0);
  assert.equal(previews,0);
});

test("a visible but still unrecognized right drawer must never be toggled closed",async()=>{
  let clicks=0,targets=0,observed=0;
  const out=await openSabyVerifiedFleetTreePanel({
    expected:220,
    readTree:async()=>{observed++;return {
      status:"invalid",reason:"truck_category_missing"
    };},
    readPreview:async()=>{targets++;return live(100);},
    clickPreview:async()=>{clicks++;return true;},
    panelVisible:async()=>true,
    sameCompany:()=>true,wait:async()=>{},
    pollsPerClick:3
  });
  assert.equal(out.opened,false);
  assert.equal(out.reason,"panel_unrecognized");
  assert.equal(out.titleSeen,true);
  assert.equal(clicks,0);
  assert.equal(targets,0);
  assert.equal(observed,4);
});

test("first click opens a drawer not yet parsed: let it hydrate, do not retry and close it",async()=>{
  let clicked=0,polls=0;
  const out=await openSabyVerifiedFleetTreePanel({
    expected:220,
    readTree:async()=>{
      polls++;
      return {status:"invalid",reason:"truck_category_missing"};
    },
    readPreview:async()=>live(100),
    clickPreview:async()=>{clicked++;return true;},
    panelVisible:async()=>clicked>0,
    sameCompany:()=>true,wait:async()=>{},
    pollsPerClick:3
  });
  assert.equal(out.opened,false);
  assert.equal(out.reason,"panel_unrecognized");
  assert.equal(clicked,1);
  assert.equal(out.clicks,1);
});

test("a different opaque contractor ID after the first click aborts all additional reads and clicks",async()=>{
  let current=original,clicks=0;
  const out=await openSabyVerifiedFleetTreePanel({
    expected:220,
    readTree:async()=>({status:"invalid",reason:"tree_missing"}),
    readPreview:async()=>live(100),
    clickPreview:async()=>{
      clicks++;current=other;return true;
    },
    panelVisible:async()=>false,
    sameCompany:()=>compareSabyVerifiedFleetDetail(original,current).ok,
    wait:async()=>{},pollsPerClick:3
  });
  assert.equal(out.opened,false);
  assert.equal(out.reason,"detail_changed");
  assert.equal(clicks,1);
  assert.equal(out.clicks,1);
});

test("a wrong first-party ID BEFORE any operation blocks DOM reads and clicks",async()=>{
  let reads=0,clicks=0;
  const out=await openSabyVerifiedFleetTreePanel({
    expected:220,
    readTree:async()=>{reads++;return {
      status:"observed",expected:220
    };},
    readPreview:async()=>live(100),
    clickPreview:async()=>{clicks++;return true;},
    panelVisible:async()=>false,
    sameCompany:()=>compareSabyVerifiedFleetDetail(original,other).ok
  });
  assert.equal(out.opened,false);
  assert.equal(out.reason,"detail_changed");
  assert.equal(reads,0);
  assert.equal(clicks,0);
});

test("the next preview is not on the same unique truck count: no speculative click",async()=>{
  let clicks=0,previews=0;
  const out=await openSabyVerifiedFleetTreePanel({
    expected:220,
    readTree:async()=>({status:"invalid",reason:"tree_missing"}),
    readPreview:async()=>{
      previews++;
      return previews===1?live(100):{...live(300),count:23};
    },
    clickPreview:async()=>{clicks++;return true;},
    panelVisible:async()=>false,
    sameCompany:()=>true,wait:async()=>{},pollsPerClick:2
  });
  assert.equal(out.reason,"preview_click_unavailable");
  assert.equal(clicks,1);
  assert.equal(previews,2);
});

test("incorrect truck count, ambiguous panel or reader failure never authorizes clicking",async()=>{
  for(const reason of [
    "truck_count_mismatch","truck_category_ambiguous",
    "multiple_tree_panels","invalid_group_key","footer_ambiguous"
  ]){
    let clicks=0;
    const out=await openSabyVerifiedFleetTreePanel({
      expected:220,
      readTree:async()=>({status:"invalid",reason}),
      readPreview:async()=>live(100),
      clickPreview:async()=>{clicks++;return true;},
      panelVisible:async()=>false,
      sameCompany:()=>true
    });
    assert.equal(out.reason,"panel_unrecognized",reason);
    assert.equal(clicks,0,reason);
  }
  const out=await openSabyVerifiedFleetTreePanel({
    expected:220,
    readTree:async()=>{throw new Error("private DOM error");},
    readPreview:async()=>live(100),
    clickPreview:async()=>true,
    panelVisible:async()=>false,
    sameCompany:()=>true
  });
  assert.equal(out.reason,"panel_unrecognized");
  assert.doesNotMatch(JSON.stringify(out),/private|DOM error/);
});

test("two bounded clicks without actual drawer evidence fail closed",async()=>{
  let clicks=0;
  const out=await openSabyVerifiedFleetTreePanel({
    expected:220,
    readTree:async()=>({status:"invalid",reason:"tree_missing"}),
    readPreview:async()=>live(100+clicks*50),
    clickPreview:async()=>{clicks++;return true;},
    panelVisible:async()=>false,
    sameCompany:()=>true,
    wait:async()=>{},
    maxClicks:12,pollsPerClick:2
  });
  assert.equal(out.reason,"panel_not_observed");
  assert.equal(out.clicks,2);
  assert.equal(clicks,2);
  assert.equal(out.titleSeen,false);
});

test("structural opener is restricted to the explicit smoke or separately gated production path; legacy remains",()=>{
  const source=fs.readFileSync(
    new URL("../src/sabyBrowser.js",import.meta.url),"utf8");
  assert.match(source,
    /const opening=shouldUseSabyFleetTree\(settings\)\?\s*await openSabyVerifiedFleetTreePanel/);
  assert.match(source,/readSabyFleetTree\(page,\{expected:preview\.count\}\)/);
  assert.match(source,/readPreview:async\(\)=>/);
  assert.match(source,/truckPreview\(page\)/);
  assert.match(source,/viewport\.width\*\.68/);
  assert.match(source,/await openSabyFleetPanelWithHydration\(/);
  assert.match(source,/second_click_after_ui_change_blocked/);
  assert.match(source,/Unchanged Stage12 behavior for nonexperimental runs/);
});
