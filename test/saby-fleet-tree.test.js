import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  sabyFleetTreeFooterKey,parseSabyFleetTreeRow,
  validateSabyFleetTreeSnapshot,safeSabyFleetTreeReport,
  collectSabyFleetTree,readSabyFleetTree
} from "../src/sabyFleetTree.js";
import {safeSabyFleetFailure} from "../src/sabyFleetDiagnostic.js";

const firstParty="https://profile.saby.ru/page/contractor-info"+
  "?anchor=about&tab=all&page=public&local=false&"+
  "id=964bc800-1cfc-11e0-a3db-00732e102283";
const otherCompany=firstParty.replace("964bc800","264bc800");

// Derived from the USER-PROVIDED real Wasaby DOM, but anonymized:
//  [item-key=-3] = Грузовые 220
//  [item-parent-key=-3][item-key=22014723] = vehicle model
//  [item-key=node-footer--3] [data-qa=navigation-button]
//    > [title=Ещё] (the title is on the CHILD, not the button).
const labels=[
  "FAW CA3250, 2024","KAMAZ 43118, 2022",
  "KAMAZ 43118, 2022","КАМАЗ K3456",
  "MAZ 5340, 2013","SCANIA P, 2020"
];
const makeRows=n=>Array.from({length:n},(_,i)=>({
  key:String(22014723+i),
  label:labels[i%labels.length]
}));
const raw=(n,{category="-3",hasMore=true,expected=220}={})=>({
  status:"observed",expected,groupKey:category,
  footerKey:"node-footer-"+category,
  hasMore,rows:makeRows(n)
});
function fakeBrowser({counts=[24,40,102,164,220],
  expected=220,changeRouteAfter=-1,category="-3",
  footerMissing=false,wrongPrefix=false}={}){
  let clicks=0,reads=0,navs=0;
  let route=firstParty;
  const page={
    url:()=>route,
    locator:selector=>{
      assert.ok(selector.includes('[item-key="node-footer-'+category+'"]'),
        selector);
      assert.match(selector,/\[data-qa="navigation-button"\]/);
      assert.match(selector,/:has\(\[title="Ещё"\]\)/);
      navs++;
      return {
        count:async()=>1,
        click:async()=>{
          clicks++;
          if(clicks===changeRouteAfter)route=otherCompany;
        }
      };
    }
  };
  const read=async (_page,{expected:requested})=>{
    assert.equal(requested,expected);
    reads++;
    const size=counts[Math.min(clicks,counts.length-1)];
    const rows=makeRows(size);
    if(wrongPrefix&&clicks>=1)rows[0].key="different-first-id";
    return {status:"observed",expected,groupKey:category,
      footerKey:"node-footer-"+category,
      hasMore:!footerMissing,rows};
  };
  return {page,read,
    get clicks(){return clicks;},
    get reads(){return reads;},
    get navs(){return navs;}};
}

test("real Saby category footer keys are dynamic; title=Ещё is on a child",()=>{
  assert.equal(sabyFleetTreeFooterKey("-3"),"node-footer--3");
  assert.equal(sabyFleetTreeFooterKey("-1"),"node-footer--1");
  assert.equal(sabyFleetTreeFooterKey("-125"),"node-footer--125");
  for(const x of ["3","",null,"node-footer--3","-a"])
    assert.equal(sabyFleetTreeFooterKey(x),null);
  const src=fs.readFileSync(new URL("../src/sabyFleetTree.js",import.meta.url),"utf8");
  assert.match(src,/\[data-qa="item"\]\[item-parent-key\]\[item-key\]/);
  assert.match(src,/\[data-qa="item"\]\[item-key\]/);
  assert.match(src,/\[data-qa="navigation-button"\]/);
  assert.match(src,/\[title="Ещё"\]/);
  assert.match(src, /controls-BigSeparator__collapsed/);
  assert.match(src,/:scope > div:first-child/);
  assert.doesNotMatch(src, /page\.mouse\.click\(/);
  assert.doesNotMatch(src, /scrollTop\s*=/);
});

test("every Saby item-key is a distinct truck even with identical model and year",()=>{
  const snapshot=raw(6);
  const out=validateSabyFleetTreeSnapshot(snapshot,{expected:220});
  assert.equal(out.status,"valid");
  assert.equal(out.rows.length,6);
  assert.deepEqual(out.rows[1],{
    key:"22014724",model:"KAMAZ 43118",year:2022
  });
  assert.deepEqual(out.rows[2],{
    key:"22014725",model:"KAMAZ 43118",year:2022
  });
  assert.deepEqual(out.rows[3],{
    key:"22014726",model:"КАМАЗ K3456",year:null
  });
  assert.notEqual(out.rows[1].key,out.rows[2].key);
});

test("VIN and GRZ metadata are NOT separate items; model without year stays valid",()=>{
  assert.deepEqual(parseSabyFleetTreeRow({
    key:"775557",label:"КАМАЗ K3456"
  }),{key:"775557",model:"КАМАЗ K3456",year:null});
  assert.equal(parseSabyFleetTreeRow({
    key:"775559",label:"VIN: MOCK_VIN"
  }),null);
  assert.equal(parseSabyFleetTreeRow({
    key:"775558",label:"ГРЗ ТС: MOCK_PLATE"
  }),null);
  assert.equal(parseSabyFleetTreeRow({
    key:"node-footer--3",label:"FAW CA3250, 2024"
  }),null);
  assert.equal(parseSabyFleetTreeRow({
    key:"something",label:"..."
  }),null);
  const withMetadata=raw(6);
  withMetadata.rows[3].label="VIN: MOCK_VIN";
  assert.equal(validateSabyFleetTreeSnapshot(
    withMetadata,{expected:220}).reason,"invalid_model");
});

test("reject duplicate IDs, replaced first-page records, wrong parent group and false 220th item",()=>{
  const x=raw(6);x.rows[1].key=x.rows[0].key;
  assert.equal(validateSabyFleetTreeSnapshot(x,{expected:220}).reason,
    "duplicate_item_key");
  const base=validateSabyFleetTreeSnapshot(raw(6),{expected:220});
  const newer=raw(7);newer.rows[0].key="12345";
  assert.equal(validateSabyFleetTreeSnapshot(newer,{
    expected:220,previousRows:base.rows,
    previousGroupKey:base.groupKey
  }).reason,"row_prefix_changed");
  assert.equal(validateSabyFleetTreeSnapshot(raw(7,{category:"-4"}),{
    expected:220,previousRows:base.rows,
    previousGroupKey:base.groupKey
  }).reason,"invalid_group_key");
  const bogus=raw(220);bogus.rows[219].label="VIN: FAKE_VEHICLE_220";
  assert.equal(validateSabyFleetTreeSnapshot(bogus,{expected:220}).reason,
    "invalid_model");
});

test("controlled semantic clicks expand exact 24->40->102->164->220 without geometric probes",async()=>{
  const m=fakeBrowser();
  const res=await collectSabyFleetTree(m.page,{
    expected:220,originalUrl:firstParty,read:m.read,
    wait:async()=>{},maxClicks:20,maxMs:80000
  });
  assert.equal(res.status,"complete");
  assert.equal(res.reason,"complete");
  assert.equal(res.rows,220);
  assert.equal(res.clicks,4);
  assert.equal(m.clicks,4);
  assert.equal(m.navs,4);
  assert.equal(res.same_company,true);
  assert.equal(res.vehicles.length,220);
  assert.equal(Object.keys(res.vehicles[0]).sort().join(","),"model,year");
  assert.deepEqual(res.vehicles[1],res.vehicles[2]);
  assert.equal(res.vehicles[3].year,null);
});

test("category key is read from current DOM, never hard-coded -3",async()=>{
  const m=fakeBrowser({counts:[219,220],category:"-6"});
  const res=await collectSabyFleetTree(m.page,{
    expected:220,originalUrl:firstParty,read:m.read,
    wait:async()=>{}
  });
  assert.equal(res.status,"complete");
  assert.equal(m.clicks,1);
});

test("no further click if footer missing or list stops changing",async()=>{
  const missing=fakeBrowser({counts:[24,40],footerMissing:true});
  const a=await collectSabyFleetTree(missing.page,{
    expected:220,originalUrl:firstParty,read:missing.read,
    wait:async()=>{}
  });
  assert.equal(a.reason,"footer_missing");
  assert.equal(missing.clicks,0);
  assert.equal(a.vehicles,null);
  const stale=fakeBrowser({counts:[40,40]});
  const b=await collectSabyFleetTree(stale.page,{
    expected:220,originalUrl:firstParty,read:stale.read,
    wait:async()=>{},maxPolls:3
  });
  assert.equal(b.reason,"no_growth");
  assert.equal(stale.clicks,1);
  assert.equal(b.vehicles,null);
});

test("strict prefix and same-company continuity abort on replacement or route change",async()=>{
  const swapped=fakeBrowser({counts:[40,102],wrongPrefix:true});
  const a=await collectSabyFleetTree(swapped.page,{
    expected:220,originalUrl:firstParty,read:swapped.read,
    wait:async()=>{}
  });
  assert.equal(a.reason,"row_prefix_changed");
  assert.equal(swapped.clicks,1);
  assert.equal(a.vehicles,null);
  const changed=fakeBrowser({counts:[40,102],
    changeRouteAfter:1});
  const b=await collectSabyFleetTree(changed.page,{
    expected:220,originalUrl:firstParty,read:changed.read,
    wait:async()=>{}
  });
  assert.equal(b.reason,"wrong_company");
  assert.equal(changed.clicks,1);
  assert.equal(b.same_company,false);
  assert.equal(b.vehicles,null);
});

test("hard click limit and bad category count never complete an unverified fleet",async()=>{
  const m=fakeBrowser({counts:[24,40,102,164,220]});
  const x=await collectSabyFleetTree(m.page,{
    expected:220,originalUrl:firstParty,read:m.read,
    maxClicks:2,wait:async()=>{}
  });
  assert.equal(x.reason,"click_limit");
  assert.equal(x.clicks,2);
  assert.equal(m.clicks,2);
  assert.equal(x.vehicles,null);
  assert.equal(validateSabyFleetTreeSnapshot(
    raw(220,{expected:221}),{expected:220}
  ).reason,"truck_count_mismatch");
});

test("strict first-party route required before any DOM read or control interaction",async()=>{
  let readCalls=0,clicks=0;
  const evil={url:()=>"https://evil.example/page/contractor-info",
    locator:()=>{clicks++;return {};}};
  const x=await collectSabyFleetTree(evil,{
    expected:220,originalUrl:firstParty,
    read:async()=>{readCalls++;return raw(220);}
  });
  assert.equal(x.status,"incomplete");
  assert.equal(x.vehicles,null);
  assert.equal(readCalls,0);
  assert.equal(clicks,0);
  let evaluated=0;
  const out=await readSabyFleetTree({
    url:()=>"https://evil.example/page/contractor-info",
    evaluate:async()=>{evaluated++;}
  },{expected:220});
  assert.equal(out.reason,"invalid_setup");
  assert.equal(evaluated,0);
});

test("all log/report fields are sanitized: no item IDs, models, VIN, phones or card URLs",()=>{
  const p=safeSabyFleetTreeReport({
    status:"incomplete",reason:"footer_missing",
    expected:220,rows:164,clicks:3,samples:7,
    same_company:true,
    vehicles:[{key:"PRIVATE",model:"KAMAZ 43118",year:2020}],
    vin:"SECRET_VIN",phone:"+79000000000",
    profile_url:"https://profile.saby.ru/SECRET"
  });
  assert.deepEqual(p,{
    status:"incomplete",reason:"footer_missing",expected:220,
    rows:164,clicks:3,samples:7,same_company:true
  });
  const x=safeSabyFleetFailure({
    phase:"vehicles",reason:"vehicle_rows_incomplete",
    fleet_tree:{...p,hiddenSecret:"SECRET"}
  });
  assert.deepEqual(x.fleet_tree,p);
  assert.doesNotMatch(JSON.stringify(x),
    /PRIVATE|KAMAZ|SECRET|79000000000|profile_url/);
});

test("semantic code stays behind explicit smoke-only flag; standard production Stage12 unchanged",()=>{
  const src=fs.readFileSync(
    new URL("../src/sabyBrowser.js",import.meta.url),"utf8");
  assert.match(src,/if\(settings\.fleetTailClickOptIn\) \{/);
  assert.match(src,/collectSabyFleetTree\(page/);
  assert.match(src,/structured\.status==="complete"/);
  assert.match(src,/Unchanged Stage12 behavior for nonexperimental runs/);
  assert.match(src,/settings\.publicIdentityFallback===true/);
});
