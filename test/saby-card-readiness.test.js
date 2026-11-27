import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {createSabyCardReadiness} from "../src/sabyCardReadiness.js";
import {restoreSabyTiming,recordSabyVisitTiming} from "../src/sabyVisitPolicy.js";
import {sabyBrowserSettings} from "../src/sabyBrowser.js";

function fixture({mounts={},timeoutMs=7000,pollMs=450}={}){
  let now=0,same=true;
  const waits=[],reads=[];
  const budget=createSabyCardReadiness({timeoutMs,pollMs,now:()=>now,
    sameCard:()=>same,wait:async ms=>{waits.push(ms);now+=ms;},
    readVisible:async kind=>{reads.push([kind,now]);return now>=(mounts[kind]??Infinity);}});
  return {budget,waits,reads,now:()=>now,advance:ms=>{now+=ms;},drift:()=>{same=false;}};
}

test("missing sections consume one card-wide passive window, not three sequential waits",async()=>{
  const f=fixture();
  const c=await f.budget.waitFor("contacts");
  const before=f.waits.length;
  const fin=await f.budget.waitFor("financials");
  const fleet=await f.budget.waitFor("fleet");
  assert.equal(c.status,"budget_exhausted");
  assert.deepEqual(fin,{status:"budget_exhausted",polls:1});
  assert.deepEqual(fleet,{status:"budget_exhausted",polls:1});
  assert.equal(f.now(),7000);
  assert.equal(f.waits.length,before);
  assert.equal(f.waits.reduce((a,b)=>a+b,0),7000);
  assert.deepEqual(f.reads.slice(-2),[["financials",7000],["fleet",7000]]);
});

test("widgets that hydrate while earlier sections are collected get fresh reads without extra wait",async()=>{
  const f=fixture({mounts:{contacts:900,financials:1500,fleet:2100}});
  assert.equal((await f.budget.waitFor("contacts")).status,"visible");
  assert.equal(f.now(),900);
  f.advance(750); // full contact extraction time
  assert.deepEqual(await f.budget.waitFor("financials"),{status:"visible",polls:1});
  f.advance(600); // full finance extraction / recovery time
  assert.deepEqual(await f.budget.waitFor("fleet"),{status:"visible",polls:1});
  assert.equal(f.now(),2250);
  assert.equal(f.waits.reduce((a,b)=>a+b,0),900);
});

test("later section has the entire unspent budget; still read fresh after deadline",async()=>{
  const f=fixture({mounts:{contacts:0,financials:6200,fleet:8200}});
  assert.deepEqual(await f.budget.waitFor("contacts"),{status:"visible",polls:1});
  assert.equal((await f.budget.waitFor("financials")).status,"visible");
  assert.equal(f.now(),6300);
  f.advance(2100); // long in-card finance recovery is never cut off
  assert.deepEqual(await f.budget.waitFor("fleet"),{status:"visible",polls:1});
  assert.equal(f.budget.remaining(),0);
});

test("card drift stops all further probes and never accepts an in-flight visible result",async()=>{
  const f=fixture();
  f.drift();
  assert.deepEqual(await f.budget.waitFor("contacts"),{status:"card_changed",polls:0});
  assert.equal(f.reads.length,0);assert.equal(f.waits.length,0);
  let same=true;
  const b=createSabyCardReadiness({sameCard:()=>same,
    readVisible:async()=>{same=false;return true;},
    wait:async()=>assert.fail("must not wait on a foreign card")});
  assert.deepEqual(await b.waitFor("fleet"),{status:"card_changed",polls:1});
});

test("transient widget probe failure still retries within budget; timeout is not evidence of absence",async()=>{
  let now=0,calls=0;
  const b=createSabyCardReadiness({sameCard:()=>true,timeoutMs:1000,pollMs:200,
    now:()=>now,wait:async ms=>{now+=ms;},readVisible:async()=>{
      if(++calls===1)throw Error("transient");
      return calls===3;
    }});
  assert.deepEqual(await b.waitFor("financials"),{status:"visible",polls:3});
  assert.equal(now,400);
  await assert.rejects(b.waitFor("unknown"),/KIND_INVALID/);
});

test("full-card only readiness flag defaults on, can restore independent waits, and nested times survive checkpoints",()=>{
  assert.equal(sabyBrowserSettings({}).sharedCardReadiness,true);
  assert.equal(sabyBrowserSettings({SABY_SHARED_CARD_READINESS_ENABLED:"false"}).sharedCardReadiness,false);
  const t=restoreSabyTiming({ready_ms:100,ready_contacts_ms:100});
  recordSabyVisitTiming(t,{timing:{ready_ms:600,ready_financials_ms:100,ready_fleet_ms:500}},1000);
  assert.equal(t.ready_ms,700);
  assert.equal(t.ready_contacts_ms,100);
  assert.equal(t.ready_financials_ms,100);
  assert.equal(t.ready_fleet_ms,500);
  assert.equal(restoreSabyTiming(t).ready_fleet_ms,500);
  const source=fs.readFileSync(new URL("../src/sabyBrowser.js",import.meta.url),"utf8");
  assert.match(source,/const sharedReadiness=fullCard&&settings\.sharedCardReadiness!==false/);
  assert.match(source,/if\(fullCard&&!sharedReadiness&&\(sections\.contacts\|\|sections\.financials\)\)await ready\(\{trucks:true\}\)/);
  assert.match(source,/if\(sharedReadiness\)\{[\s\S]*?closeContactOverlay\(page\)[\s\S]*?await ready\(\{trucks:true\}\)/);
  assert.match(source,/await ownTrucks\(page,settings,fleetProgress/);
  assert.match(source,/visibleOnly:quick/);
});
