import test from "node:test";
import assert from "node:assert/strict";
import {runCheckpointedSabyStage12} from "../src/sabyCheckpointIntegration.js";
import {runGirBoStage,girboStageSettings} from "../src/girBoStage.js";
import {createGirBoLookup,createGirBoRequestGate,retryDelay} from "../src/girBoLookup.js";
import {REVENUE_FIELD} from "../src/preSabyFinancials.js";

const inn="4706000909",ogrn="1024701329377",kpp="470601001";
const short='АО "ПРИМЕР"',full='АКЦИОНЕРНОЕ ОБЩЕСТВО "ПРИМЕР"';
const date="2026-04-01",sum=1234567;
const bfo={period:"2025",isCb:false,knd:"0710099",bfoPeriodTypes:[12],
  actualBfoDate:date,actualCorrectionDate:date,actualCorrectionNumber:2,gainSum:sum};
const search=()=>({content:[{id:123,inn:"<strong>"+inn+"</strong>",shortName:short,ogrn,statusCode:"ACTIVE",bfo:{...bfo}}],
  totalElements:1,number:0,first:true,last:true});
const reports=()=>[{id:456,...bfo,publishedCorrectionNumber:2,publishedCorrectionDate:date,
  organizationInfo:{inn,kpp,fullName:full},typeCorrections:[{type:12,correction:{
    id:789,periodType:12,knd:"0710099",correctionVersion:2,
    bfoOrganizationInfo:{id:789,bfoId:456,inn,kpp,fullName:full},
    financialResult:{id:789,okud:"0710002",current2110:sum,previous2110:12345}}}]}];
const fixture=()=>({direct_buyers:[{__canonical_id:"a","Организация":short,"ИНН":inn,
  [REVENUE_FIELD]:"","Численность":14,"Телефон":"123",__evidence:{source_urls:["https://example.org/"]}},
  {__canonical_id:"b","Организация":"АО ДРУГОЙ","ИНН":"7810165652",[REVENUE_FIELD]:55}],
  intermediaries:[],leasing:[],statistics:[]});
const env={GIRBO_STAGE_ENABLED:"true",SABY_STAGE12_ENABLED:"false",GIRBO_STAGE_MAX_COMPANIES:"5"};
const fakeLookup=(visits=[])=>({requests:2,search:async i=>{visits.push(i);return search();},reports:async()=>reports()});

test("production boundary enriches before disabled Saby, persists only verified finance, never repeats same object",async()=>{
  const result=fixture(),row=result.direct_buyers[0],visits=[],writes=[];
  const options={result,env,girboLookupFactory:()=>fakeLookup(visits),
    persistCheckpoint:async(phase,patch)=>writes.push({phase,patch:structuredClone(patch)})};
  const first=await runCheckpointedSabyStage12(options);
  assert.equal(first.stats.enabled,false);
  assert.equal(result.direct_buyers[0],row);
  assert.equal(row[REVENUE_FIELD],sum*1000);
  assert.equal(row["Численность"],14);
  assert.equal(row["Телефон"],"123");
  assert.equal(result.direct_buyers[1][REVENUE_FIELD],55);
  assert.equal(row.__evidence.girbo_finance_backfill.source,"GIR_BO");
  assert.equal(writes.at(-1).patch.final_result.direct_buyers[0][REVENUE_FIELD],sum*1000);
  const finance=writes.find(w=>w.patch.girbo_backfill_outcomes?.a);
  assert.equal(finance.patch.girbo_backfill_outcomes.a.status,"verified");
  await runCheckpointedSabyStage12(options);
  assert.deepEqual(visits,[inn]);
});
test("disabled by default; review ledger survives resume and no duplicate calls",async()=>{
  assert.equal(girboStageSettings({}).enabled,false);
  const result=fixture(),visited=[];
  assert.deepEqual(await runGirBoStage({result,env:{}}),{enabled:false});
  let outcomes;
  await runGirBoStage({result,env,year:2025,lookupFactory:()=>({search:async i=>{visited.push(i);return {...search(),content:[],totalElements:0};},reports:async()=>[]}),
    persistCheckpoint:async(_phase,p)=>{outcomes=p.girbo_backfill_outcomes;}});
  assert.equal(outcomes.a.status,"review");
  const resumed=await runGirBoStage({result:structuredClone(result),env,year:2025,priorOutcomes:outcomes,
    lookupFactory:()=>{throw Error("review must not repeat");},persistCheckpoint:async()=>{}});
  assert.equal(resumed.scheduled,0);
  assert.deepEqual(visited,[inn]);
});
test("source transport failure retains pending and lets Saby-disabled stage finish",async()=>{
  const result=fixture(),patches=[];
  const out=await runCheckpointedSabyStage12({result,env,
    girboLookupFactory:()=>({search:async()=>{throw Error("GIRBO_RATE_LIMITED");},reports:async()=>[]}),
    persistCheckpoint:async(_phase,p)=>patches.push(structuredClone(p))});
  assert.equal(out.stats.enabled,false);
  assert.equal(result.direct_buyers[0][REVENUE_FIELD],"");
  const state=patches.filter(p=>p.girbo_backfill_stats).at(-1);
  assert.equal(state.girbo_backfill_stats.pending,1);
  assert.equal(state.girbo_backfill_stats.stop_reason,"GIRBO_RATE_LIMITED");
  assert.deepEqual(state.girbo_backfill_outcomes,{});
});
test("storage failures and cancellation propagate",async()=>{
  await assert.rejects(runGirBoStage({result:fixture(),env,lookupFactory:()=>fakeLookup(),
    persistCheckpoint:async()=>{throw Error("disk full");}}),/disk full/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(runGirBoStage({result:fixture(),env,signal:controller.signal,
    persistCheckpoint:async()=>{}}),/JOB_CANCELLED/);
});
test("shared gate serializes concurrent requests and respects cooldown without issuing a new request",async()=>{
  let time=10000,active=0,maxActive=0;
  const starts=[];
  const gate=createGirBoRequestGate({now:()=>time,wait:async ms=>{time+=ms;}});
  const f=async()=>{starts.push(time);active++;maxActive=Math.max(active,maxActive,active);
    await Promise.resolve();active--;};
  await Promise.all([gate.run(f),gate.run(f),gate.run(f)]);
  assert.deepEqual(starts,[10000,11500,13000]);
  assert.equal(maxActive,1);
  gate.cooldown("GIRBO_RATE_LIMITED",retryDelay("3600",time));
  await assert.rejects(gate.run(f),/GIRBO_CIRCUIT_OPEN/);
  assert.equal(starts.length,3);
});
test("real transport wrapper refuses redirects/rate-limit and does not log identifiers",async()=>{
  const gate=createGirBoRequestGate({spacingMs:0});
  const diag=[];
  let requests=0;
  const lookup=createGirBoLookup({gate,maxRequests:3,metric:(n,p)=>diag.push({n,p}),
    fetchImpl:async()=>{requests++;return new Response("",{status:429,headers:{"Retry-After":"1800"}});}});
  await assert.rejects(lookup.search(inn),/GIRBO_RATE_LIMITED/);
  const other=createGirBoLookup({gate,fetchImpl:async()=>{requests++;throw Error("must not run");}});
  await assert.rejects(other.search(inn),/GIRBO_CIRCUIT_OPEN/);
  assert.equal(requests,1);
  assert.equal(lookup.requests,1);
  assert.equal(other.requests,0);
  assert.equal(diag[0].p.http_status,429);
  assert.equal(JSON.stringify(diag).includes(inn),false);
  const redirect=createGirBoLookup({gate:createGirBoRequestGate({spacingMs:0}),
    metric:()=>{},fetchImpl:async()=>new Response("",{status:302,headers:{Location:"https://elsewhere.example/"}})});
  await assert.rejects(redirect.search(inn),/GIRBO_HTTP_UNAVAILABLE/);
});
