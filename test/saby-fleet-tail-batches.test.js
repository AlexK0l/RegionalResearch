import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  collectSabyFleetTailBatches,safeSabyFleetTailBatchReport
} from "../src/sabyFleetTailBatches.js";
import {safeSabyFleetFailure} from "../src/sabyFleetDiagnostic.js";

const car=i=>({model:"Грузовик модель "+String(i+1),year:2020+i%5});
const all=Array.from({length:220},(_,i)=>car(i));
// Repeated model/year entries are distinct recorded vehicles, not duplicates
// to remove. Full ordered prefix is still provable by its exact positions.
all[25]={...all[24]};all[105]={...all[104]};
const stableTail=n=>({
  status:"observed",truck_row_count_changed:false,
  sample_before:{truck_row_count:n},sample_after:{truck_row_count:n}
});
function makeLoader({initial=102,clickCounts=[164,220],
  maxScroll=2,replaceAt=null,tailVisible=true,changedAfter=-1}={}){
  let count=initial,pos=0,clicks=0,moves=0,reads=0,
    tailChecks=0,waits=0,changed=false;
  const api={
    get count(){return count;},
    get clicks(){return clicks;},
    get moves(){return moves;},
    get reads(){return reads;},
    get tailChecks(){return tailChecks;},
    get waits(){return waits;},
    readWindow:async()=>{
      reads++;
      return {opened:true,rows:replaceAt===clicks?
        all.slice(110,110+count):all.slice(0,count),
        scroll:{available:true,at_end:pos>=maxScroll}};
    },
    advanceScroll:async()=>{
      if(pos>=maxScroll)return {
        opened:true,scroll:{available:true,moved:false,at_end:true}
      };
      pos++;moves++;
      return {opened:true,scroll:{available:true,moved:true,
        at_end:pos>=maxScroll}};
    },
    observeTail:async n=>{
      tailChecks++;
      return tailVisible?stableTail(n):{
        status:"incomplete_observation"
      };
    },
    clickTail:async(rows,tail)=>{
      assert.equal(rows.length,count);
      assert.equal(tail.status,"observed");
      clicks++;
      count=clickCounts[Math.min(clicks-1,clickCounts.length-1)];
      pos=0;
      if(clicks===changedAfter)changed=true;
      return {status:"rows_extended",click_attempted:true,
        rows_before:rows.length,rows_after:count};
    },
    sameCompany:()=>!changed,
    wait:async()=>{waits++;},
    now:()=>Date.now()
  };
  return api;
}

test("after the real v22 40-to-102 growth, 2 more guarded clicks collect exactly 220 contiguous rows",async()=>{
  const m=makeLoader();
  const out=await collectSabyFleetTailBatches({
    expected:220,initialRows:all.slice(0,102),
    readWindow:m.readWindow,advanceScroll:m.advanceScroll,
    observeTail:m.observeTail,clickTail:m.clickTail,
    sameCompany:m.sameCompany,wait:m.wait,
    maxMs:50000
  });
  assert.equal(out.status,"complete");
  assert.equal(out.reason,"exact_count");
  assert.equal(out.rows_before,102);
  assert.equal(out.rows_after,220);
  assert.equal(out.extra_clicks,2);
  assert.equal(out.additional_scroll_moves,4);
  assert.equal(out.rounds,2);
  assert.equal(out.tail_checks,2);
  assert.equal(out.last_click_status,"rows_extended");
  assert.equal(m.clicks,2);
  assert.equal(m.tailChecks,2);
  assert.equal(out.rows.length,220);
  assert.deepEqual(out.rows,all);
  assert.deepEqual(out.rows[24],out.rows[25]);
  assert.deepEqual(out.rows[104],out.rows[105]);
});

test("never mark a fleet verified when 3 extra clicks yield only 186 of 220",async()=>{
  const m=makeLoader({maxScroll:1,clickCounts:[130,158,186]});
  const out=await collectSabyFleetTailBatches({
    expected:220,initialRows:all.slice(0,102),
    readWindow:m.readWindow,advanceScroll:m.advanceScroll,
    observeTail:m.observeTail,clickTail:m.clickTail,
    sameCompany:m.sameCompany,wait:m.wait
  });
  assert.equal(out.status,"incomplete");
  assert.equal(out.reason,"click_limit");
  assert.equal(out.rows_after,186);
  assert.equal(out.extra_clicks,3);
  assert.equal(m.clicks,3);
});

test("a replaced 102-row page cannot prove an ordered prefix",async()=>{
  const m=makeLoader({maxScroll:1,replaceAt:1,clickCounts:[164]});
  const out=await collectSabyFleetTailBatches({
    expected:220,initialRows:all.slice(0,102),
    readWindow:m.readWindow,advanceScroll:m.advanceScroll,
    observeTail:m.observeTail,clickTail:m.clickTail,
    sameCompany:m.sameCompany,wait:m.wait
  });
  assert.equal(out.status,"incomplete");
  assert.equal(out.reason,"post_click_window_invalid");
  assert.equal(out.rows_after,102);
  assert.equal(m.clicks,1);
});

test("a private contractor route change aborts the batch before accepting newer rows",async()=>{
  const m=makeLoader({maxScroll:0,changedAfter:1});
  const out=await collectSabyFleetTailBatches({
    expected:220,initialRows:all.slice(0,102),
    readWindow:m.readWindow,advanceScroll:m.advanceScroll,
    observeTail:m.observeTail,clickTail:m.clickTail,
    sameCompany:m.sameCompany,wait:m.wait
  });
  assert.equal(out.status,"incomplete");
  assert.equal(out.reason,"company_changed");
  assert.equal(out.rows_after,102);
  assert.equal(out.extra_clicks,0,
    "no completed trustworthy click counted after a route change");
});

test("no scrolling beyond the currently expanded list means no next click",async()=>{
  const m=makeLoader({maxScroll:4});
  m.advanceScroll=async()=>({
    opened:true,scroll:{available:true,moved:false,at_end:false}
  });
  const out=await collectSabyFleetTailBatches({
    expected:220,initialRows:all.slice(0,102),
    readWindow:m.readWindow,advanceScroll:m.advanceScroll,
    observeTail:m.observeTail,clickTail:m.clickTail,
    sameCompany:m.sameCompany,wait:m.wait
  });
  assert.equal(out.status,"incomplete");
  assert.equal(out.reason,"scroll_not_advanced");
  assert.equal(out.extra_clicks,0);
  assert.equal(m.clicks,0);
});

test("do not click if row-tail geometry or stable sample is absent",async()=>{
  const m=makeLoader({maxScroll:0,tailVisible:false});
  const out=await collectSabyFleetTailBatches({
    expected:220,initialRows:all.slice(0,102),
    readWindow:m.readWindow,advanceScroll:m.advanceScroll,
    observeTail:m.observeTail,clickTail:m.clickTail,
    sameCompany:m.sameCompany,wait:m.wait
  });
  assert.equal(out.status,"incomplete");
  assert.equal(out.reason,"tail_not_ready");
  assert.equal(m.clicks,0);
});

test("invalid newly added model/year rows stop without overclaiming 220",async()=>{
  const invalid=all.slice();
  invalid[150]={model:"...",year:2022};
  const m=makeLoader({maxScroll:0,clickCounts:[164]});
  m.readWindow=async()=>({
    opened:true,rows:m.clicks?invalid.slice(0,164):all.slice(0,102),
    scroll:{available:true,at_end:true}
  });
  const out=await collectSabyFleetTailBatches({
    expected:220,initialRows:all.slice(0,102),
    readWindow:m.readWindow,advanceScroll:m.advanceScroll,
    observeTail:m.observeTail,clickTail:m.clickTail,
    sameCompany:m.sameCompany,wait:m.wait
  });
  assert.equal(out.status,"incomplete");
  assert.equal(out.reason,"post_click_window_invalid");
  assert.equal(out.rows_after,102);
  assert.equal(m.clicks,1);
});

test("invalid baseline never initiates any click or scroll",async()=>{
  const m=makeLoader({maxScroll:0});
  const out=await collectSabyFleetTailBatches({
    expected:220,
    initialRows:[{model:"...",year:2022},...all.slice(1,102)],
    readWindow:m.readWindow,advanceScroll:m.advanceScroll,
    observeTail:m.observeTail,clickTail:m.clickTail,
    sameCompany:m.sameCompany,wait:m.wait
  });
  assert.equal(out.status,"incomplete");
  assert.equal(out.reason,"invalid_rows");
  assert.equal(m.reads,0);
  assert.equal(m.clicks,0);
});

test("budget exhaustion stops without opening arbitrary additional sections",async()=>{
  const m=makeLoader({maxScroll:99});
  const out=await collectSabyFleetTailBatches({
    expected:220,initialRows:all.slice(0,102),
    readWindow:m.readWindow,advanceScroll:m.advanceScroll,
    observeTail:m.observeTail,clickTail:m.clickTail,
    sameCompany:m.sameCompany,wait:m.wait,
    maxMovesPerRound:3,maxScrollMoves:4
  });
  assert.equal(out.status,"incomplete");
  assert.equal(out.reason,"scroll_limit");
  assert.equal(out.extra_clicks,0);
  assert.equal(m.moves,3);
});

test("sanitized multi-batch diagnostics never expose company IDs or vehicle models",()=>{
  const raw={
    status:"complete",reason:"exact_count",rows_before:102,
    rows_after:220,extra_clicks:2,additional_scroll_moves:9,
    rounds:2,tail_checks:2,last_click_status:"rows_extended",
    models:["КАМАЗ 43118"],private_url:"https://profile.saby.ru/SECRET",
    name:"Дорстройсервис",inn:"7725104641",
    nested:{cookie:"SESSION_SECRET"}
  };
  const safe=safeSabyFleetTailBatchReport(raw);
  assert.deepEqual(safe,{
    status:"complete",reason:"exact_count",rows_before:102,
    rows_after:220,extra_clicks:2,additional_scroll_moves:9,
    rounds:2,tail_checks:2,last_click_status:"rows_extended"
  });
  assert.doesNotMatch(JSON.stringify(safe),
    /КАМАЗ|7725104641|SECRET|session|nested|Дорстройсервис/i);
  const report=safeSabyFleetFailure({
    phase:"vehicles",reason:"vehicle_rows_incomplete",
    fleet_tail_batches:raw
  });
  assert.deepEqual(report.fleet_tail_batches,safe);
});

test("batch accumulation is experimental-only and standard production Stage12 unchanged",()=>{
  const src=fs.readFileSync(
    new URL("../src/sabyBrowser.js",import.meta.url),"utf8");
  assert.match(src,/settings\.fleetTailClickOptIn/);
  assert.match(src,/collectSabyFleetTailBatches\(/);
  assert.match(src,/maxExtraClicks:3/);
  assert.match(src,/appendSabyTruckWindow/);
  assert.match(src,/Unchanged Stage12 behavior for nonexperimental runs/);
});
