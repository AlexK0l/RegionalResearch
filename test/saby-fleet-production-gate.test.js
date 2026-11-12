import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  sabyBrowserSettings,
  sabyFleetTreeProductionEnabled,
  shouldUseSabyFleetTree
} from "../src/sabyBrowser.js";

const production={
  SABY_STAGE12_ENABLED:"true",
  SABY_MAX_COMPANIES:"1",
  SABY_HEADLESS:"false",
  SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED:"true",
  SABY_FLEET_TREE_PRODUCTION_ENABLED:"true"
};

test("v27 real fleet tree is disabled by default, even if regular Stage12 runs",()=>{
  const baseline={
    SABY_STAGE12_ENABLED:"true",
    SABY_MAX_COMPANIES:"1",
    SABY_HEADLESS:"false",
    SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED:"true"
  };
  assert.equal(sabyFleetTreeProductionEnabled(baseline),false);
  assert.equal(sabyBrowserSettings(baseline).fleetTreeProductionOptIn,false);
  assert.equal(shouldUseSabyFleetTree(sabyBrowserSettings(baseline)),false);
});

test("production requires EVERY separate explicit safety gate",()=>{
  assert.equal(sabyFleetTreeProductionEnabled(production),true);
  for(const key of [
    "SABY_STAGE12_ENABLED",
    "SABY_MAX_COMPANIES",
    "SABY_HEADLESS",
    "SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED",
    "SABY_FLEET_TREE_PRODUCTION_ENABLED"
  ]) {
    const changed={...production};
    changed[key]=key==="SABY_HEADLESS"?"true":
      key==="SABY_MAX_COMPANIES"?"0":"false";
    assert.equal(sabyFleetTreeProductionEnabled(changed),false,key);
    assert.equal(shouldUseSabyFleetTree(sabyBrowserSettings(changed)),
      false,key);
  }
  assert.equal(sabyFleetTreeProductionEnabled({
    ...production,SABY_MAX_COMPANIES:"10"
  }),false);
  assert.equal(sabyFleetTreeProductionEnabled({
    ...production,SABY_MAX_COMPANIES:"2"
  }),false);
});

test("an explicit production gate activates real tree without inheriting smoke flags",()=>{
  const settings=sabyBrowserSettings(production);
  assert.equal(settings.publicIdentityFallback,true);
  assert.equal(settings.headless,false);
  assert.equal(settings.fleetTailClickOptIn,false);
  assert.equal(settings.fleetTreeProductionOptIn,true);
  assert.equal(settings.fleetScreenshotPath,"");
  assert.equal(shouldUseSabyFleetTree(settings),true);
});

test("smoke remains opt-in and NEVER inherits the production rollout",()=>{
  const naked=sabyBrowserSettings({
    ...production,SABY_SMOKE_ONLY:"true"
  });
  assert.equal(naked.fleetTailClickOptIn,false);
  assert.equal(naked.fleetTreeProductionOptIn,false);
  assert.equal(shouldUseSabyFleetTree(naked),false);
  const explicit=sabyBrowserSettings({
    ...production,SABY_SMOKE_ONLY:"true",
    SABY_FLEET_TAIL_CLICK_OPT_IN:"true"
  });
  assert.equal(explicit.fleetTailClickOptIn,true);
  assert.equal(explicit.fleetTreeProductionOptIn,false);
  assert.equal(shouldUseSabyFleetTree(explicit),true);
});

test("production cannot be enabled by the click flag alone",()=>{
  const settings=sabyBrowserSettings({
    SABY_STAGE12_ENABLED:"true",
    SABY_MAX_COMPANIES:"1",
    SABY_FLEET_TAIL_CLICK_OPT_IN:"true",
    SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED:"true",
    SABY_HEADLESS:"false"
  });
  assert.equal(settings.fleetTailClickOptIn,false);
  assert.equal(settings.fleetTreeProductionOptIn,false);
  assert.equal(shouldUseSabyFleetTree(settings),false);
});

test("structural collector is behind the common guarded branch, legacy fallback remains",()=>{
  const src=fs.readFileSync(new URL("../src/sabyBrowser.js",import.meta.url),"utf8");
  assert.match(src,/const opening=shouldUseSabyFleetTree\(settings\)\?/);
  assert.match(src,/if\(shouldUseSabyFleetTree\(settings\)\)/);
  assert.match(src,/await openSabyVerifiedFleetTreePanel\(/);
  assert.match(src,/await collectSabyFleetTree\(/);
  assert.match(src,/if\(settings\.publicIdentityFallback===true\)/);
  assert.match(src,/Unchanged Stage12 behavior for nonexperimental runs/);
  assert.match(src,/if\(structured\.status==="complete"/);
  assert.match(src,/stillSameFleetCompany\(\)/);
});

test("the production opt-in defaults to false in the environment example",()=>{
  const env=fs.readFileSync(new URL("../.env.example",import.meta.url),"utf8");
  assert.match(env,/^SABY_STAGE12_ENABLED=false$/m);
  assert.match(env,/^SABY_FLEET_TREE_PRODUCTION_ENABLED=false$/m);
});
