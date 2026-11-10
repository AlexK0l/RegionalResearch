import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {sabyNetworkKppCandidates,watchSabyKppNetwork} from "../src/sabyKppNetwork.js";

const inn="6700018766",kpp="670001001";
const found=(payload)=>sabyNetworkKppCandidates(payload,inn);

test("extract INN+KPP together in one exact legal company object only",()=>{
  assert.deepEqual(found({body:{
    Data:{List:[{INN:inn,KPP:kpp,Name:"Сапк, АО"}]}
  }}),[kpp]);
  assert.deepEqual(found({
    parties:[{ИНН:inn},{КПП:kpp}]
  }),[]);
  assert.deepEqual(found({
    parties:[{inn:"6700018767",kpp},{inn,kpp:"670001002"}]
  }),["670001002"]);
  assert.deepEqual(found({inn:"67000187660",kpp}),[]);
  assert.deepEqual(found({inn,kpp:"67000100"}),[]);
  assert.deepEqual(found({inn,kpp:670001001}),[]);
});

test("nested Saby RPC response JSON strings are parsed strictly in memory",()=>{
  const response={
    rpc:{Result:JSON.stringify({rows:[{Инн:inn,Кпп:kpp}]})},
    unrelated:{INN:"7707083893",KPP:"770701001"}
  };
  assert.deepEqual(found(response),[kpp]);
  assert.deepEqual(found(JSON.stringify(response)),[kpp]);
});

test("separate branch KPPs remain ambiguous and are not selected by KPP collector",()=>{
  assert.deepEqual(found([
    {INN:inn,KPP:kpp},
    {INN:inn,KPP:"670001002"}
  ]),["670001001","670001002"]);
});

const fakeResponse=(url,payload,{
  resourceType="xhr",status=200,contentType="application/json"
}={})=>({
  request:()=>({resourceType:()=>resourceType}),
  url:()=>url,status:()=>status,
  headers:()=>({"content-type":contentType,"content-length":"120"}),
  body:async()=>Buffer.from(JSON.stringify(payload))
});

test("only first-party JSON network responses contribute INN/KPP hints",async()=>{
  const page=new EventEmitter();
  const watcher=watchSabyKppNetwork(page,inn);
  for(const url of [
    "https://attacker.tld/api",
    "https://profile.saby.ru.evil.example/api",
    "http://profile.saby.ru/api"
  ])page.emit("response",fakeResponse(url,{INN:inn,KPP:"670001099"}));
  page.emit("response",fakeResponse(
    "https://profile.saby.ru/api",{INN:inn,KPP:kpp}));
  page.emit("response",fakeResponse(
    "https://api.saby.ru/api",{INN:inn,KPP:kpp},{status:401}));
  page.emit("response",fakeResponse(
    "https://profile.saby.ru/api",{INN:inn,KPP:kpp},{resourceType:"image"}));
  page.emit("response",fakeResponse(
    "https://profile.saby.ru/api",{INN:inn,KPP:kpp},{contentType:"image/png"}));
  const result=await watcher.snapshot();
  assert.deepEqual(result,{kpps:[kpp],responses:1,parsed:1});
  watcher.stop();
  assert.equal(page.listenerCount("response"),0);
});

test("network JSON parser accepts no raw strings or credentials as a KPP hint",async()=>{
  const page=new EventEmitter();
  const watcher=watchSabyKppNetwork(page,inn);
  page.emit("response",fakeResponse("https://profile.saby.ru/api",
    {Account:{password:"my-secret",phone:"79990000000"},
      Data:{INN:inn,KPP:kpp}}));
  const result=await watcher.snapshot();
  assert.deepEqual(result.kpps,[kpp]);
  assert.deepEqual(Object.keys(result).sort(),["kpps","parsed","responses"]);
  assert.equal(JSON.stringify(result).includes("my-secret"),false);
  assert.equal(JSON.stringify(result).includes("79990000000"),false);
  watcher.stop();
});
