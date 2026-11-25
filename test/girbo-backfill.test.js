import test from "node:test";
import assert from "node:assert/strict";
import {planGirBoBackfill,selectGirBoOrganization,selectGirBoAnnualReport,verifyGirBoPdfText,runGirBoBackfill} from "../src/girBoBackfill.js";
import {REVENUE_FIELD} from "../src/preSabyFinancials.js";
const inn="4706000909",ogrn="1024701329377",kpp="470601001";
const short='АО "ПРИМЕР"',full='АКЦИОНЕРНОЕ ОБЩЕСТВО "ПРИМЕР"';
const row=(id,extra={})=>({__canonical_id:id,"Организация":short,"ИНН":inn,[REVENUE_FIELD]:"","Численность":15,...extra});
const cp=rows=>({version:1,source_mode:"saby",phase:"saby",region:"Тестовая область",
  final_result:{direct_buyers:rows,intermediaries:[],leasing:[],statistics:[]},
  fns_open_data_candidates:{other:{records:[]}}});
const search=()=>({content:[{id:123,inn:"<strong>"+inn+"</strong>",shortName:short,ogrn}],
  totalElements:1,number:0,first:true,last:true});
const reports=()=>[{id:456,period:"2025",isCb:false,knd:"0710099",publishedCorrectionNumber:2,
  publishedCorrectionDate:"2026-04-01",gainSum:1234567,
  organizationInfo:{inn,kpp,fullName:full},typeCorrections:[{type:12,correction:{
    id:789,periodType:12,knd:"0710099",correctionVersion:2,
    bfoOrganizationInfo:{id:789,bfoId:456,inn,kpp,fullName:full},
    financialResult:{id:789,okud:"0710002",current2110:1234567,previous2110:12345}}}]}];
const pdf=()=>[
  "Информация из Государственного информационного ресурса бухгалтерской (финансовой) отчетности",
  "Номер выгрузки информации 0710099_"+inn+"_2025_002_20261125_12345678-1234-1234-1234-123456789abc",
  "ИНН     "+inn,"КПП     "+kpp,"Единица измерения     Тыс. руб.",
  "\fИНН     "+inn,"КПП     "+kpp,"Форма по ОКУД    0710002",
  "Отчет о финансовых результатах",
  "Код строки       За 2025 г.        За 2024 г.",
  "  5.1    Выручка     2110     1 234 567      12 345",
  "Расходы  2120     1 000 000      10 000","\f"
].join("\n");
const candidate=()=>selectGirBoAnnualReport(row("a"),selectGirBoOrganization(row("a"),search()),reports(),{year:2025});
test("exact official search and published annual correction; incomplete or conflicting results rejected",()=>{
  assert.equal(candidate().status,"candidate");
  assert.equal(selectGirBoOrganization(row("a"),{...search(),totalElements:21}).reason,"search_response_incomplete");
  assert.equal(selectGirBoOrganization(row("a",{"ОГРН":"1024701479571"}),search()).reason,"search_identity_unproven");
  const r=reports();r[0].typeCorrections[0].correction.bfoOrganizationInfo.inn="7810165652";
  assert.equal(selectGirBoAnnualReport(row("a"),selectGirBoOrganization(row("a"),search()),r,{year:2025}).reason,"report_identity_unproven");
  const newer=reports();newer[0].publishedCorrectionNumber=3;
  assert.equal(selectGirBoAnnualReport(row("a"),selectGirBoOrganization(row("a"),search()),newer,{year:2025}).reason,"published_annual_report_unproven");
});
test("PDF binds exact INN/KPP, correction, year, unit and line 2110 current/previous values",()=>{
  const c=candidate(),out=verifyGirBoPdfText(c,pdf());
  assert.equal(out.status,"verified");
  assert.equal(out.revenue_rub,1234567000);
  for(const broken of [
    pdf().replaceAll(inn,"7810165652"),
    pdf().replace("_2025_002_","_2024_002_"),
    pdf().replace("_2025_002_","_2025_001_"),
    pdf().replace("Тыс. руб.","Млн. руб."),
    pdf().replace("1 234 567      12 345","12 345      1 234 567"),
    pdf().replace("За 2025 г.        За 2024 г.","За 2024 г.        За 2025 г."),
    pdf().replace("2110","2120"),
    pdf().replace("1 234 567","1 234 566"),
  ])assert.notEqual(verifyGirBoPdfText(c,broken).status,"verified");
});
test("select latest annual not intermediate period; no null-to-zero conversion",()=>{
  const r=reports();
  const interim=structuredClone(r[0]);interim.period="2026";interim.typeCorrections[0].type=9;
  const out=selectGirBoAnnualReport(row("a"),selectGirBoOrganization(row("a"),search()),[interim,...r],{year:2025});
  assert.equal(out.year,2025);
  r[0].typeCorrections[0].correction.financialResult.current2110=null;
  assert.equal(selectGirBoAnnualReport(row("a"),selectGirBoOrganization(row("a"),search()),r,{year:2025}).reason,"revenue_2110_unavailable");
});
test("save only verified revenue, keep other cells and immutable parent, no repeated completed work",async()=>{
  const checkpoint=cp([row("a"),row("b",{"ИНН":"7810165652",[REVENUE_FIELD]:125}),row("c",{"ИНН":""})]);
  const before=JSON.stringify(checkpoint),saved=[];
  const out=await runGirBoBackfill({checkpoint,sourceId:"p",childId:"c",year:2025,
    lookup:{search:async()=>search(),reports:async()=>reports(),pdf:async()=>({text:pdf(),sha256:"a".repeat(64)})},
    onCheckpoint:async s=>saved.push(s)});
  assert.equal(out.stats.added,1);
  assert.equal(out.snapshot.final_result.direct_buyers[0][REVENUE_FIELD],1234567000);
  assert.equal(out.snapshot.final_result.direct_buyers[0]["Численность"],15);
  assert.equal(out.snapshot.final_result.direct_buyers[1][REVENUE_FIELD],125);
  assert.deepEqual(out.snapshot.fns_open_data_candidates,checkpoint.fns_open_data_candidates);
  assert.equal(JSON.stringify(checkpoint),before);
  assert.equal(planGirBoBackfill(out.snapshot,{year:2025}).eligible,0);
  assert.equal(saved.length,2);
});
test("duplicates and source conflicts excluded; transport failure leaves target pending",async()=>{
  assert.equal(planGirBoBackfill(cp([row("a"),row("b")]),{year:2025}).eligible,0);
  assert.equal(planGirBoBackfill(cp([row("a",{__evidence:{legal_identity_conflicts:["conflict"]}})]),{year:2025}).eligible,0);
  const checkpoint=cp([row("a")]);
  const out=await runGirBoBackfill({checkpoint,sourceId:"p",childId:"c",year:2025,
    lookup:{search:async()=>{throw Error("GIRBO_RATE_LIMITED");},reports:async()=>[],pdf:async()=>({})},
    onCheckpoint:async()=>{}});
  assert.equal(out.stats.stop_reason,"GIRBO_RATE_LIMITED");
  assert.equal(out.stats.pending,1);
  assert.equal(out.stats.added,0);
});
