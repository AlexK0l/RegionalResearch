import test from "node:test";
import assert from "node:assert/strict";
import {
 REVENUE_FIELD,STAFF_FIELD,
 validatePreSabyFinancialFact,applyPreSabyFinancialFacts,preSabyFinancialCoverage
} from "../src/preSabyFinancials.js";

const company=()=>({"Организация":"ООО «Карьер»","ИНН":"6732001114",
  [REVENUE_FIELD]:"",[STAFF_FIELD]:"",
  __evidence:{source_urls:["https://example.org/old"],notes:[]}});
const evidence=(field,value,excerpt,year="")=>({
  field,value,year,
  source_url:"https://report.example.org/company/6732001114",
  evidence_excerpt:excerpt
});
const revenue=(value="1200000000",year="2025")=>
  evidence(REVENUE_FIELD,value,"ИНН: 6732001114. Выручка за "+year+" год — 1,2 млрд руб.",year);
const staff=evidence(STAFF_FIELD,"124","ИНН 6732001114, среднесписочная численность 124 сотрудников.");

test("stage 10 stores verified numeric revenue/headcount and auditable source before Saby",()=>{
  const row=company();
  const out=applyPreSabyFinancialFacts(row,{financial_facts:[revenue(),staff]});
  assert.deepEqual(out.applied.map(x=>x.field),[REVENUE_FIELD,STAFF_FIELD]);
  assert.equal(row[REVENUE_FIELD],1200000000);
  assert.equal(row[STAFF_FIELD],124);
  assert.equal(typeof row[REVENUE_FIELD],"number");
  assert.equal(typeof row[STAFF_FIELD],"number");
  assert.equal(row.__evidence.pre_saby_financial_facts[0].year,"2025");
  assert.equal(row.__evidence.pre_saby_financial_facts[0].inn,"6732001114");
  assert.equal(row.__evidence.source_urls.length,2);
  assert.deepEqual(preSabyFinancialCoverage({direct_buyers:[row]}),{
    total:1,revenue_present:1,revenue_missing:0,employees_present:1,
    employees_missing:0,stage10_source_backed_revenue:1,stage10_source_backed_employees:1
  });
});

test("wrong INN, quoted third-party INN, invented number and missing year are rejected",()=>{
  const bad=[
    evidence(STAFF_FIELD,"124","ИНН 6732001115. Численность 124 сотрудников."),
    evidence(STAFF_FIELD,"124","ИНН 6732001114. ИНН 6732001115. Численность 124 сотрудников."),
    evidence(STAFF_FIELD,"124","ИНН 6732001114. Численность 999 сотрудников."),
    evidence(REVENUE_FIELD,"1200000000","ИНН 6732001114. Выручка 1,2 млрд рублей."),
    evidence(REVENUE_FIELD,"1200000000","ИНН 6732001114. 2024 год. Выручка 1,2 млрд рублей.","2027"),
    {...revenue(),source_url:"https://malicious.example.org.evil.local/"},
    {...staff,value:"124.5"},
    {...revenue(),value:"1,2 млрд"},
    {...staff,evidence_excerpt:"Численность 124; нет юридического ИНН"},
    {...staff,source_url:"http://report.example.org/1"}
  ];
  for(const fact of bad)
    assert.equal(validatePreSabyFinancialFact(company(),fact,2026),null,JSON.stringify(fact));
});

test("latest verified revenue year wins; conflicting same-year data is not silently chosen",()=>{
  const row=company();
  const old=evidence(REVENUE_FIELD,"500000000",
    "ИНН 6732001114, выручка 2024 г. 500000000 рублей","2024");
  const out=applyPreSabyFinancialFacts(row,{financial_facts:[old,revenue()]});
  assert.equal(out.applied.length,1);
  assert.equal(row[REVENUE_FIELD],1200000000);
  const other=company();
  const conflict=evidence(REVENUE_FIELD,"1200000001",
    "ИНН 6732001114, 2025, выручка 1200000001 рублей","2025");
  assert.equal(applyPreSabyFinancialFacts(other,{financial_facts:[revenue(),conflict]}).applied.length,0);
  assert.equal(other[REVENUE_FIELD],"");
});

test("existing pre-Saby financial figures are preserved; missing placeholders can be filled",()=>{
  const row=company();
  row[REVENUE_FIELD]=6000000000;
  row[STAFF_FIELD]="не найдено";
  const out=applyPreSabyFinancialFacts(row,{financial_facts:[revenue(),staff]});
  assert.deepEqual(out.applied.map(f=>f.field),[STAFF_FIELD]);
  assert.equal(row[REVENUE_FIELD],6000000000);
  assert.equal(row[STAFF_FIELD],124);
  assert.equal(applyPreSabyFinancialFacts(row,{financial_facts:[staff]}).applied.length,0);
  assert.equal(row.__evidence.pre_saby_financial_facts.length,1);
});

test("legacy unsourced field values are never trusted as new verified facts",()=>{
  const row=company();
  row[REVENUE_FIELD]=100000;
  row[STAFF_FIELD]=10;
  assert.deepEqual(applyPreSabyFinancialFacts(row,{financial_facts:[]}).applied,[]);
  const coverage=preSabyFinancialCoverage({direct_buyers:[row]});
  assert.equal(coverage.revenue_present,1);
  assert.equal(coverage.stage10_source_backed_revenue,0);
});

test("Saby is only a supplement: existing stage-10 values win, missing fields may be filled",async()=>{
  const {applySabyEnrichment}=await import("../src/sabyEnrichment.js");
  const row=company();
  applyPreSabyFinancialFacts(row,{financial_facts:[revenue(),staff]});
  const saby={identity:{inn:"6732001114",name:"ООО «Карьер»",verified:true},
    source:"SABY",source_url:"https://profile.saby.ru/page/contractor-info?id=company-1",
    collected_at:"2026-11-20T08:00:00.000Z",
    contacts:{status:"collected",phones:[],emails:[]},trucks:{status:"missing"},
    financials:{status:"collected",revenue_rub:500000000,revenue_year:2024,employees:6},errors:[]};
  assert.equal(applySabyEnrichment(row,saby).status,"ok");
  assert.equal(row[REVENUE_FIELD],1200000000);
  assert.equal(row[STAFF_FIELD],124);
  assert.equal(row.__evidence.saby.financials.revenue_rub,500000000);
  const incomplete=company();
  incomplete[REVENUE_FIELD]="не найдено";
  incomplete[STAFF_FIELD]="12 человек";
  assert.equal(applySabyEnrichment(incomplete,saby).status,"ok");
  assert.equal(incomplete[REVENUE_FIELD],500000000);
  assert.equal(incomplete[STAFF_FIELD],6);
});

test("pipeline budgets stay unchanged and source-backed figures checkpoint before Saby",async()=>{
  const {readFile}=await import("node:fs/promises");
  const source=await readFile(new URL("../src/pipeline.js",import.meta.url),"utf8");
  assert.match(source,/applyPreSabyFinancialFacts\(row,result\)/);
  assert.match(source,/pre_saby_financial_stats:preSabyFinancialStats/);
  assert.ok(source.indexOf("pre_saby_financial_stats:preSabyFinancialStats")<
    source.indexOf("const sabyOutcome = await runCheckpointedSabyStage12"));
  assert.match(source,/financial_facts: \{ type: "array"/);
  assert.match(source,/const ENRICHMENT_BATCH_MAX_TOOL_CALLS = Math.max\(1, Math.min\(3, Number\(process.env.OPENAI_ENRICHMENT_BATCH_MAX_TOOL_CALLS \|\| 1\)\)\)/);
});
