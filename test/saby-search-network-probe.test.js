import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {spawnSync} from "node:child_process";
import vm from "node:vm";
import {fileURLToPath} from "node:url";
import {
  firstPartySabyUrl,safeSabyTransportClass,
  blankSabyNetworkCounts,updateSabyNetworkCounts,
  safeSabyRequestDiagnostic,sabySearchUiStructure
} from "../scripts/saby-search-network-probe.js";

const INN="4718000935";
const clean=obj=>{
  const encoded=JSON.stringify(obj);
  assert.doesNotMatch(encoded,/4718000935|secret|cookie|private-id|https?:\/\//);
  return obj;
};

test("Saby network probe trusts only exact first-party HTTPS/WSS domains",()=>{
  assert.equal(firstPartySabyUrl("https://profile.saby.ru/page/company-list-prof"),true);
  assert.equal(firstPartySabyUrl("https://online.sbis.ru/api"),true);
  assert.equal(firstPartySabyUrl("wss://profile.saby.ru/ws"),true);
  assert.equal(firstPartySabyUrl("https://profile.saby.ru.attacker.example/api"),false);
  assert.equal(firstPartySabyUrl("http://profile.saby.ru/api"),false);
  assert.equal(firstPartySabyUrl("file:///etc/passwd"),false);
});

test("Saby request evidence detects exact INN only in first-party async transport",()=>{
  const found=safeSabyTransportClass(
    "https://profile.saby.ru/service/?secret=private-id",
    "POST","fetch","request to "+INN,INN);
  assert.deepEqual(clean(found),{
    firstParty:true,asyncRequest:true,kind:"post",hasInn:true
  });
  assert.equal(safeSabyTransportClass(
    "https://profile.saby.ru/service?q="+INN+"7",
    "GET","xhr","",INN).hasInn,false);
  assert.equal(safeSabyTransportClass(
    "https://evil.example/?token="+INN,
    "POST","xhr",INN,INN).hasInn,false);
  assert.equal(safeSabyTransportClass(
    "https://profile.saby.ru/app.js",
    "GET","script",INN,INN).hasInn,false);
});

test("Saby network counters report categories without leaking request details",()=>{
  const page=new EventEmitter();
  const tracker=safeSabyRequestDiagnostic(page,INN);
  tracker.setPhase("submit");
  const request={
    url:()=> "https://profile.saby.ru/service/?secret=private-id",
    resourceType:()=> "xhr",
    method:()=> "POST",
    postData:()=> JSON.stringify({query:INN,cookie:"secret"})
  };
  page.emit("request",request);
  page.emit("response",{request:()=>request,status:()=>200});
  page.emit("requestfinished",request);
  tracker.setPhase("results");
  const bad={
    url:()=> "https://sub.sbis.ru/path?secret=private-id",
    resourceType:()=> "fetch",
    method:()=> "POST",
    postData:()=> JSON.stringify({query:INN})
  };
  page.emit("request",bad);
  page.emit("response",{request:()=>bad,status:()=>429});
  page.emit("requestfailed",bad);
  const external={
    url:()=> "https://attacker.example/x?inn="+INN,
    resourceType:()=> "fetch",
    method:()=> "POST",
    postData:()=> INN
  };
  page.emit("request",external);
  page.emit("pageerror",new Error("secret from private website"));
  const snapshot=clean(tracker.summary());
  assert.equal(snapshot.submit.async_requests,1);
  assert.equal(snapshot.submit.async_requests_with_inn,1);
  assert.equal(snapshot.submit.async_responses,1);
  assert.equal(snapshot.results.requests,1);
  assert.equal(snapshot.results.http_429,1);
  assert.equal(snapshot.results.failed_requests,1);
  assert.equal(snapshot.external_requests,1);
  assert.equal(snapshot.in_flight,0);
  assert.equal(snapshot.page_errors,1);
});

test("Saby search DOM probe is function-serializable and outputs structural counts",async()=>{
  const inn=INN;
  const selectorValues={
    '[aria-busy="true"]': [{}],
    '[role="progressbar"]':[{}],
    ".controls-LoadingIndicator":[],
    '[data-qa*="spinner" i]':[],
    '[role="option"]':[],
    '[role="row"]':[{},{}],
    "body *":[{},{},{}]
  };
  const doc={
    activeElement:{value:inn},
    querySelectorAll:selector=> (selectorValues[selector]||[])
      .map(x=>({isConnected:true,getClientRects:()=>[{}],...x}))
  };
  const page={
    evaluate:fn=>vm.runInNewContext("("+fn.toString()+")("+JSON.stringify(inn)+")",{
      document:doc,getComputedStyle:()=>({
        display:"block",visibility:"visible"
      })
    })
  };
  const value=clean(await sabySearchUiStructure(page,inn));
  assert.deepEqual(JSON.parse(JSON.stringify(value)),{
    spinner_aria_busy:1,spinner_progressbar:1,spinner_controls:0,
    spinner_data_qa:0,active_input_exact:true,
    visible_options:0,visible_rows:2,body_dom_nodes:3
  });
});

test("Saby network CLI help and invalid arguments do not open browser",()=>{
  const cli=fileURLToPath(new URL(
    "../scripts/saby-search-network-probe.js",import.meta.url));
  const help=spawnSync(process.execPath,[cli,"--help"],{
    encoding:"utf8",timeout:15000
  });
  assert.equal(help.status,0,help.stderr);
  assert.match(help.stdout,/Read-only/);
  const malformed=spawnSync(process.execPath,[cli,"--inn=1234"],{
    encoding:"utf8",timeout:15000
  });
  assert.equal(malformed.status,1);
  assert.match(malformed.stdout,/INVALID_PROBE_INN/);
  assert.doesNotMatch(malformed.stdout,/password|token|https?:\/\//);
});

test("standalone Saby network probe never performs data export or captures raw traffic",async()=>{
  const fs=await import("node:fs");
  const code=fs.readFileSync(
    new URL("../scripts/saby-search-network-probe.js",import.meta.url),
    "utf8");
  assert.match(code,/withSabyBrowser\(/);
  assert.match(code,/autoLogin:false/);
  assert.match(code,/submitSabyCompanySearch\(/);
  assert.doesNotMatch(code,/saveCheckpoint\(|runSabyStage12\(|readSabyFinancials\(/);
  assert.doesNotMatch(code,/\.screenshot\(|\.writeFile\(|\.content\(/);
  assert.doesNotMatch(code,/console\.log\(request\.|console\.log\(response\./);
});
