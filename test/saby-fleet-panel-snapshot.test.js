import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  sabyFleetScreenshotPath,captureSabyFleetPanelScreenshot
} from "../src/sabyFleetPanelSnapshot.js";

const file=(name)=>fileURLToPath(new URL("../"+name,import.meta.url));
const original="https://profile.saby.ru/page/contractor-info"+
  "?anchor=about&tab=all&page=public&local=false&"+
  "id=964bc800-1cfc-11e0-a3db-00732e102283";
const otherId=original.replace(
  "964bc800-1cfc-11e0-a3db-00732e102283",
  "264bc800-1cfc-11e0-a3db-00732e102283"
);
const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const pretendPath=path.join(os.tmpdir(),"saby-picture.png");
function fakePage(url=original) {
  const calls={evaluate:0,screenshot:0,options:null};
  const page={
    url:()=>url,
    evaluate:async(fn,args)=>{
      calls.evaluate++;
      assert.equal(typeof fn,"function");
      assert.equal(args.expected,220);
      return {x:940,y:50,width:420,height:810};
    },
    screenshot:async opts=>{
      calls.screenshot++;
      calls.options=opts;
      return png;
    }
  };
  return {page,calls};
}

test("screenshot filename is separate from, and never replaces, the source JSON",()=>{
  const originalPath=path.join(os.tmpdir(),"data","v19.json");
  assert.equal(sabyFleetScreenshotPath(originalPath),
    path.join(os.tmpdir(),"data","v19.fleet-panel.png"));
  assert.throws(()=>sabyFleetScreenshotPath(
    path.join(os.tmpdir(),"data","v19")) ,/JSON output path/);
});

test("saved fleet panel screenshot is cropped, private, explicit and never overwritten",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"saby-fleet-picture-"));
  try{
    const target=path.join(dir,"v20.fleet-panel.png");
    const {page,calls}=fakePage();
    const first=await captureSabyFleetPanelScreenshot(page,{
      originalUrl:original,expected:220,targetPath:target
    });
    assert.deepEqual(first,{status:"saved",file_path:target});
    assert.equal(calls.evaluate,1);
    assert.equal(calls.screenshot,1);
    assert.equal(calls.options.type,"png");
    assert.deepEqual(calls.options.clip,
      {x:940,y:50,width:420,height:810});
    assert.equal(calls.options.animations,"disabled");
    assert.equal(calls.options.caret,"hide");
    const bytes=await fs.readFile(target);
    assert.deepEqual(bytes,png);
    if(process.platform!=="win32"){
      const mode=(await fs.stat(target)).mode&0o777;
      assert.equal(mode,0o600);
    }
    const again=await captureSabyFleetPanelScreenshot(page,{
      originalUrl:original,expected:220,targetPath:target
    });
    assert.equal(again.status,"already_exists");
    assert.deepEqual(await fs.readFile(target),png);
  }finally{
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test("screenshot refuses a different company, wrong host or unknown URL mutation before DOM read",async()=>{
  for(const url of [
    otherId,
    "https://evil.example/page/contractor-info?id=OTHER",
    original+"&secret=PRIVATE_TOKEN",
    original.replace("local=false","local=true"),
    "https://profile.saby.ru/page/company-list-prof"
  ]){
    const {page,calls}=fakePage(url);
    const out=await captureSabyFleetPanelScreenshot(page,{
      originalUrl:original,expected:220,targetPath:pretendPath
    });
    assert.equal(out.status,"company_route_not_verified");
    assert.equal(calls.evaluate,0);
    assert.equal(calls.screenshot,0);
    assert.doesNotMatch(JSON.stringify(out),/PRIVATE|secret|964bc800/);
  }
});

test("missing panel or invalid bounds cannot produce a screenshot",async()=>{
  for(const bounds of [
    null,{x:-30,y:20,width:400,height:800},
    {x:900,y:10,width:50,height:800},
    {x:900,y:10,width:400,height:30}
  ]){
    let screenshots=0;
    const page={
      url:()=>original,
      evaluate:async()=>bounds,
      screenshot:async()=>{screenshots++;return png;}
    };
    const out=await captureSabyFleetPanelScreenshot(page,{
      originalUrl:original,expected:220,targetPath:pretendPath
    });
    assert.ok(["panel_not_located","panel_bounds_invalid"].includes(out.status));
    assert.equal(screenshots,0);
  }
});

test("screenshot failure and browser errors do not expose text, URL, company IDs or files",async()=>{
  const page={
    url:()=>original,
    evaluate:async()=>{throw Error(
      "private email user@example.ru company INN 7725104641");
    },
    screenshot:async()=>assert.fail("screenshot must not happen")
  };
  const out=await captureSabyFleetPanelScreenshot(page,{
    originalUrl:original,expected:220,targetPath:pretendPath
  });
  assert.deepEqual(out,{status:"capture_failed"});
  assert.doesNotMatch(JSON.stringify(out),/user@|7725104641|private/);
});

test("image capture is strictly opt-in, runs after legally verified collection, and doesn't enter JSON",()=>{
  const smokeText=await fs.readFile(file("scripts/saby-smoke.js"),"utf8");
  const browserText=await fs.readFile(file("src/sabyBrowser.js"),"utf8");
  assert.match(smokeText,/args\.includes\("--fleet-panel-screenshot"\)/);
  assert.match(smokeText,/--result и --public-identity-fallback/);
  assert.match(smokeText,/SABY_FLEET_SNAPSHOT_OPT_IN="true"/);
  assert.match(browserText,/settings\.fleetScreenshotPath/);
  assert.match(browserText,/settings\.publicIdentityFallback===true/);
  assert.match(browserText,/fleetProgress\.side_panel_observed===true/);
  assert.match(browserText,/fleetProgress\.scroll_at_end===true/);
  assert.match(browserText,/captureSabyFleetPanelScreenshot\(page/);
  assert.match(browserText,/result\.trucks\.status==="review"/);
  assert.doesNotMatch(smokeText,/JSON\.stringify\(\{\s*source[\s\S]*fleet_panel_png/);
});
