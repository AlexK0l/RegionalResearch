import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  safeNetworkEndpoint,safeResponseBody,compareSabyNetwork
} from "../src/sabyNetworkProbe.js";

test("network probe does not expose query values or raw API paths",()=>{
  const url="https://profile.saby.ru/api/entity/12345?inn=6027087063&token=private-SECRET";
  const safe=safeNetworkEndpoint(url);
  assert.deepEqual(Object.keys(safe).sort(),["host","route"]);
  assert.equal(safe.host,"profile.saby.ru");
  assert.match(safe.route,/^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(safe).includes("6027087063"));
  assert.ok(!JSON.stringify(safe).includes("SECRET"));
  assert.equal(safeNetworkEndpoint("https://saby.ru.evil.test/api"),null);
  assert.equal(safeNetworkEndpoint("http://profile.saby.ru/api"),null);
  assert.equal(safeNetworkEndpoint("file:///etc/passwd"),null);
  assert.equal(safeNetworkEndpoint(url.replace("private-SECRET","replacement")).route,safe.route);
});

test("JSON response classification persists no phones, names or emails",()=>{
  const body=JSON.stringify({
    phone:"79991234567",email:"secret@example.ru",
    vehicle:"Грузовые",error:null,person:"Confidential Person"
  });
  const result=safeResponseBody(Buffer.from(body),"application/json; charset=utf-8");
  assert.equal(result.type,"json");
  assert.equal(result.json_root,"object");
  assert.equal(result.contact_marker,true);
  assert.equal(result.fleet_marker,true);
  assert.equal(result.phone_key,true);
  assert.equal(result.vehicle_key,true);
  const text=JSON.stringify(result);
  for(const forbidden of ["79991234567","secret@example.ru","Confidential Person","Грузовые"])
    assert.ok(!text.includes(forbidden));
  assert.match(result.sha256_16,/^[a-f0-9]{16}$/);
});

test("binary bodies report only length and hash, not binary contents",()=>{
  const result=safeResponseBody(Buffer.from([0,1,2,3]),"application/octet-stream");
  assert.equal(result.bytes,4);
  assert.equal(result.type,"binary");
  assert.equal(result.contact_marker,false);
  assert.equal(result.fleet_marker,false);
});

test("comparison flags different safe API routes and statuses",()=>{
  const a={endpoints:[{
    host:"profile.saby.ru",route:"abc",type:"fetch",method:"POST",
    count:1,status_counts:{"403":1},signals:{contact_marker:false}
  }]};
  const b={endpoints:[{
    host:"profile.saby.ru",route:"abc",type:"fetch",method:"POST",
    count:1,status_counts:{"200":1},signals:{contact_marker:true}
  },{
    host:"profile.saby.ru",route:"new",type:"xhr",method:"GET",
    count:1,status_counts:{"200":1},signals:{}
  }]};
  const diff=compareSabyNetwork(a,b);
  assert.equal(diff.only_left.length,0);
  assert.equal(diff.only_right.length,1);
  assert.equal(diff.differences.length,1);
  assert.deepEqual(diff.differences[0].status_left,{"403":1});
  assert.deepEqual(diff.differences[0].status_right,{"200":1});
});

test("probe tests three modes and produces no copied source files",()=>{
  const script=readFileSync(new URL("../scripts/saby-diagnose-network.js",import.meta.url),"utf8");
  for(const token of [
    "headless_shell","headless_chromium","headed_chromium",
    "SABY_BROWSER_CHANNEL","collectSabyCompany","safeSabySectionDiagnostic",
    "safeResponseBody","compareSabyNetwork","flag:\"wx\",mode:0o600"
  ])assert.ok(script.includes(token),token);
  assert.doesNotMatch(script,/\.storageState\(|\.har\b|\.saveAs\(|process\.env\.OPENAI_API_KEY/);
});
