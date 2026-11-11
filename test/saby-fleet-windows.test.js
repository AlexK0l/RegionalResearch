import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  appendSabyTruckWindow,collectSabyTruckWindows
} from "../src/sabyFleetWindows.js";

const car=i=>({
  model:"Грузовой автомобиль модель "+String(i+1),
  year:i%4===0?2018:null
});
const cars=n=>Array.from({length:n},(_,i)=>car(i));

test("append full DOM list growth without collapsing genuine repeated vehicles",()=>{
  const rows=[car(1),car(1),car(2),car(3)];
  const start=appendSabyTruckWindow([],rows.slice(0,2),4);
  assert.equal(start.status,"advanced");
  const more=appendSabyTruckWindow(start.rows,rows,4);
  assert.equal(more.status,"advanced");
  assert.equal(more.rows.length,4);
  assert.equal(more.rows.filter(v=>v.model===car(1).model).length,2);
});

test("unique overlapping windows stitch 220 visible vehicle records without model deduplication",async()=>{
  const expected=220,original=cars(expected);
  original[35]={...original[34]};
  original[126]={...original[125]};
  const starts=Array.from({length:10},(_,i)=>i*20);
  let pointer=0,scrollCalls=0;
  const out=await collectSabyTruckWindows({
    expected,maxWindows:20,wait:async()=>{},
    readWindow:async()=>({
      opened:true,
      rows:original.slice(starts[pointer],starts[pointer]+40)
    }),
    advanceScroll:async()=>{
      if(pointer>=starts.length-1)
        return {opened:true,scroll:{moved:false}};
      scrollCalls++;
      pointer++;
      return {opened:true,scroll:{moved:true}};
    }
  });
  assert.equal(out.status,"complete");
  assert.equal(out.reason,"exact_count");
  assert.equal(out.windows,10);
  assert.equal(out.scrollMoves,9);
  assert.equal(scrollCalls,9);
  assert.equal(out.rows.length,220);
  assert.deepEqual(out.rows,original);
  assert.equal(out.rows.filter(r=>r.model===original[34].model).length,2);
});

test("stuck virtual list cannot invent missing vehicles",async()=>{
  const first=cars(40);
  const out=await collectSabyTruckWindows({
    expected:220,maxWindows:12,wait:async()=>{},
    readWindow:async()=>({opened:true,rows:first}),
    advanceScroll:async()=>({opened:true,scroll:{moved:true}})
  });
  assert.equal(out.status,"incomplete");
  assert.equal(out.reason,"window_not_updated");
  assert.equal(out.rows.length,40);
  assert.equal(out.windows,1);
  assert.equal(out.scrollMoves,1);
});

test("no active scroll stops with a real partial list, never marks fleet complete",async()=>{
  const original=cars(40);
  const out=await collectSabyTruckWindows({
    expected:220,wait:async()=>{},
    readWindow:async()=>({opened:true,rows:original}),
    advanceScroll:async()=>({opened:true,scroll:{moved:false}})
  });
  assert.equal(out.status,"incomplete");
  assert.equal(out.reason,"scroll_not_advanced");
  assert.equal(out.rows.length,40);
});

test("a non-overlapping virtual window cannot silently skip rows",async()=>{
  const original=cars(100);
  let idx=0;
  const windows=[original.slice(0,40),original.slice(60,100)];
  const out=await collectSabyTruckWindows({
    expected:100,wait:async()=>{},
    readWindow:async()=>({opened:true,rows:windows[idx]}),
    advanceScroll:async()=>{idx=1;return {opened:true,scroll:{moved:true}};}
  });
  assert.equal(out.status,"incomplete");
  assert.equal(out.reason,"unanchored_window");
  assert.equal(out.rows.length,40);
});

test("ambiguous overlap among repeated-model windows must stay deferred",()=>{
  const A={model:"КАМАЗ 5490",year:2020};
  const B={model:"МАЗ 5516",year:null};
  const old=[car(0),A,B,A,B];
  const next=[A,B,A,B,car(5)];
  const out=appendSabyTruckWindow(old,next,10);
  assert.equal(out.status,"invalid");
  assert.equal(out.reason,"ambiguous_overlap");
});

test("repeated indistinguishable models cannot prove unseen scroll positions",()=>{
  const A={model:"КАМАЗ 5490",year:2020};
  const current=Array.from({length:40},()=>({...A}));
  const next=Array.from({length:40},()=>({...A}));
  const out=appendSabyTruckWindow(current,next,220);
  assert.equal(out.status,"unchanged");
  assert.equal(out.rows.length,40);
});

test("wrong count, truncated model or future year is always rejected",()=>{
  const tooLong=Array.from({length:41},(_,i)=>car(i));
  const over=appendSabyTruckWindow([],tooLong,40);
  assert.equal(over.status,"invalid");
  for(const row of [
    {model:"МАЗ…",year:2020},
    {model:"КАМАЗ 5490",year:2500},
    {model:"",year:null}
  ]) {
    assert.equal(appendSabyTruckWindow([],[row],3).status,"invalid");
  }
});

test("fleet virtual-window collector is opt-in and preserves ordinary Saby extraction",()=>{
  const src=fs.readFileSync(new URL("../src/sabyBrowser.js",import.meta.url),"utf8");
  assert.match(src,/settings\.publicIdentityFallback===true/);
  assert.match(src,/collectSabyTruckWindows\(/);
  assert.match(src,/sidePanelTrucks\(page,preview\.count,"window"\)/);
  assert.match(src,/sidePanelTrucks\(page,preview\.count,"advance"\)/);
  assert.match(src,/sidePanelTrucks\(page,preview\.count,"reset"\)/);
  assert.match(src,/Unchanged Stage12 behavior for nonexperimental runs/);
});


test("220 real vehicles can load only after multiple small scrolls per DOM window",async()=>{
  const expected=220,all=cars(expected);
  const starts=Array.from({length:10},(_,i)=>i*20);
  let moves=0;
  const out=await collectSabyTruckWindows({
    expected,maxWindows:20,maxScrollMoves:60,
    maxStaleScrolls:4,wait:async()=>{},
    readWindow:async()=>({
      opened:true,
      rows:all.slice(starts[Math.min(9,Math.floor(moves/3))],
        starts[Math.min(9,Math.floor(moves/3))]+40)
    }),
    advanceScroll:async()=>{
      moves++;
      return {opened:true,scroll:{moved:true}};
    }
  });
  assert.equal(out.status,"complete");
  assert.equal(out.reason,"exact_count");
  assert.equal(out.windows,10);
  assert.equal(out.scrollMoves,27);
  assert.equal(out.totalStaleScrollMoves,18);
  assert.equal(out.staleScrollMoves,0);
  assert.equal(out.rows.length,220);
  assert.deepEqual(out.rows,all);
});

test("an unchanged panel stops after a strict bounded number of extra scrolls",async()=>{
  let moves=0,reads=0;
  const out=await collectSabyTruckWindows({
    expected:220,maxStaleScrolls:3,maxWindows:60,maxScrollMoves:40,
    wait:async()=>{},
    readWindow:async()=>{
      reads++;
      return {opened:true,rows:cars(40)};
    },
    advanceScroll:async()=>{
      moves++;
      return {opened:true,scroll:{moved:true}};
    }
  });
  assert.equal(out.status,"incomplete");
  assert.equal(out.reason,"window_not_updated");
  assert.equal(out.windows,1);
  assert.equal(out.rows.length,40);
  assert.equal(out.scrollMoves,4);
  assert.equal(out.staleScrollMoves,4);
  assert.equal(out.totalStaleScrollMoves,4);
  assert.equal(moves,4);
  assert.ok(reads<30);
});

test("multiple unchanged scrolls do not allow skipping even one vehicle",async()=>{
  const expected=100,all=cars(expected);
  let moves=0;
  const out=await collectSabyTruckWindows({
    expected,maxStaleScrolls:5,wait:async()=>{},
    readWindow:async()=>({
      opened:true,rows:moves>=3?all.slice(60,100):all.slice(0,40)
    }),
    advanceScroll:async()=>{
      moves++;
      return {opened:true,scroll:{moved:true}};
    }
  });
  assert.equal(out.status,"incomplete");
  assert.equal(out.reason,"unanchored_window");
  assert.equal(out.rows.length,40);
  assert.equal(out.scrollMoves,3);
});

test("an interrupted or changed private card aborts without accepting fleet",async()=>{
  const out=await collectSabyTruckWindows({
    expected:220,wait:async()=>{},
    readWindow:async()=>({opened:false,routeChanged:true}),
    advanceScroll:async()=>{
      assert.fail("must not scroll after a private route change");
    }
  });
  assert.equal(out.status,"incomplete");
  assert.equal(out.reason,"detail_changed");
  assert.equal(out.rows.length,0);
  assert.equal(out.scrollMoves,0);
});

test("new experimental scroller prefers rows, without changing ordinary Stage12",()=>{
  const source=fs.readFileSync(
    new URL("../src/sabyBrowser.js",import.meta.url),"utf8");
  assert.match(source,/selected_from_vehicle_rows/);
  assert.match(source,/rawNodes\.filter\(n=>e\.contains\(n\)\)/);
  assert.match(source,/const windowMode=\["window","reset","advance"\]/);
  assert.match(source,/vehicleScrolls\[0\]\?\.element\|\|oldScroller/);
  assert.match(source,/else if\(action==="read" && rows\.length<expected\)/);
  assert.match(source,/maxStaleScrolls/);
});
