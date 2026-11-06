import test from "node:test";
import assert from "node:assert/strict";
import {
  planAutonomousDiscoveryCoverage, autonomousDiscoveryPrompt,
  filterAutonomousDiscoveryFindings
} from "../src/autonomousDiscoveryCoverage.js";

const sectors = [
  {key:"cargo",label:"heavy cargo logistics",pattern:/cargo|freight|trailer/i},
  {key:"grain",label:"grain haulage",pattern:/grain/i}
];
const record = (name, note, urls = [], extra = {}) => ({
  "Организация":name, "ИНН": "6732114166", "Город/район":"region",
  "Основание":"C — preliminary cargo", "Техника/сегмент":"cargo",
  __evidence:{source_urls:urls, notes:[note],identity_verification:{
    inn:"6732114166",source_urls:["https://registry.example.org/one"]
  }},...extra
});
const current = rows => ({direct_buyers:rows,intermediaries:[],leasing:[]});
const grade = ({row}) =>
  /own semitrailer|signed trailer purchase/i.test(row.__evidence?.notes?.[0] || "")
    ? {grade:"A"} : {grade:"C"};
const sourceFamily = url =>
  url.includes("tender") ? "procurement" :
  url.includes("court") ? "court" : "official";

test("autonomous evidence planner relies on current rows, not archived company IDs or counts", () => {
  const observed = current([
    record("Company One","grain processed",["https://grain.example.org/one"]),
    record("Company Two","grain processed",["https://grain.example.org/two"]),
    record("Company Three","grain processed",["https://grain.example.org/three"]),
    record("Company Four","grain processed",["https://grain.example.org/four"])
  ]);
  const plan=planAutonomousDiscoveryCoverage({
    current:observed,sectors,gradeForRow:grade,
    classifySource:sourceFamily,maxPasses:2,
    undercoveredGeography:[{scope:"North district",count:0}]
  });
  assert.equal(plan.historical_jobs_read,0);
  assert.equal(plan.named_company_targets,0);
  assert.equal(plan.sectors.find(s=>s.key==="grain").strong,0);
  assert.equal(plan.passes.length,2);
  assert.equal(plan.passes.some(p=>p.key==="grain"),true);
  assert.ok(plan.passes.every(p=>p.geography==="North district"));
  assert.doesNotMatch(JSON.stringify(plan),/6732114166|Company One/);
});

test("source diversity and strong evidence prevent gratuitous paid re-search", () => {
  const observed=current([
    record("Carrier A","own semitrailer freight",["https://tender.example.org/own"]),
    record("Carrier B","signed trailer purchase",["https://court.example.org/contract"]),
    record("Carrier C","own semitrailer freight",["https://fleet.example.org/company"])
  ]);
  const plan=planAutonomousDiscoveryCoverage({
    current:observed,sectors:[sectors[0]],gradeForRow:grade,
    classifySource:sourceFamily,maxPasses:2
  });
  assert.equal(plan.sectors[0].strong,3);
  assert.equal(plan.passes.length,0);
});

test("empty sectors are measurable gaps, capped by the same two-pass allowance", () => {
  const plan=planAutonomousDiscoveryCoverage({
    current:current([]),sectors,maxPasses:2
  });
  assert.equal(plan.passes.length,2);
  assert.equal(plan.current_seen_organizations,0);
  assert.ok(plan.passes.every(p=>p.reason==="current_run_evidence_gap"));
});
test("a sector with one strong company is not mistaken for complete coverage", () => {
  const plan=planAutonomousDiscoveryCoverage({
    current:current([record("Only Carrier","own semitrailer freight",
      ["https://carrier.example.org/one"])]),
    sectors:[sectors[0]],gradeForRow:grade,classifySource:sourceFamily,maxPasses:2
  });
  assert.equal(plan.sectors[0].count,1);
  assert.equal(plan.passes.length,1);
});

test("autonomous prompt has no exact company, INN, prior-run dependency or blind A promotion", () => {
  const prompt=autonomousDiscoveryPrompt({region:"Example Region",
    pass:{sector:"grain haulage",observed:{
      companies:7,stronger_evidence:1,source_families:["official"]
    }},
    alreadyFound:["Known Company"]});
  assert.match(prompt,/web|источник|документ|проверит/i);
  assert.match(prompt,/Known Company/);
  assert.doesNotMatch(prompt,/6732114166/);
  assert.match(prompt,/не означает эксплуатацию полуприцепа/i);
});

test("only new topic-aligned source-backed commercial candidates enter identity stage", () => {
  const existing=current([record("Known Carrier","grain freight",["https://grain.example.org/known"])]);
  const findings=filterAutonomousDiscoveryFindings({
    current:existing,sector:sectors[1],
    isCommercial: row=>!row["Организация"].startsWith("Ministry"),
    response:{
      direct_buyers:[
        record("Known Carrier","grain freight",["https://grain.example.org/known"]),
        record("New Grain Carrier","grain hauling",["https://grain.example.org/carrier"],{
          "Телефон":"79991110000", "Email":"test@carrier.example.org",
          "Руководитель / ЛПР":"some director"
        }),
        record("New Grain Carrier","grain hauling",["https://grain.example.org/two"]),
        record("New Grain Carrier","grain hauling",["https://grain.example.org/two"]),
        record("Off Topic","metal recycling",["https://metal.example.org/plant"],{
          "Техника/сегмент":"metal"
        }),
        record("No Specific URL","grain hauling",[]),
        record("Ministry of Grain","grain handling",["https://gov.example.org/agency"])
      ],
      intermediaries:[],leasing:[]
    }
  });
  assert.equal(findings.accepted,2);
  assert.equal(findings.rejected.duplicate_current,1);
  assert.equal(findings.rejected.duplicate_new,1);
  assert.equal(findings.rejected.off_topic,1);
  assert.equal(findings.rejected.no_specific_source,1);
  assert.equal(findings.rejected.noncommercial,1);
  const found=findings.result.direct_buyers[0];
  assert.equal(found["Телефон"],undefined);
  assert.equal(found["Руководитель / ЛПР"],undefined);
  assert.equal(found.__evidence.identity_verification,undefined);
  assert.equal(found.__autonomous_coverage.identity_reverified,false);
  assert.equal(findings.historical_jobs_read,0);
  assert.equal(findings.inherited_prior_inn,0);
});

test("no fabricated discovery from malformed links, notes or missing sector", () => {
  const response=current([
    record("Broken","grain hauling",["https://turn123search8"]),
    record("No notes","grain hauling",["https://grain.example.org/one"],{
      __evidence:{source_urls:["https://grain.example.org/one"],notes:[]}
    })
  ]);
  const filtered=filterAutonomousDiscoveryFindings({
    response,current:current([]),sector:sectors[1]
  });
  assert.equal(filtered.accepted,0);
  assert.equal(filtered.rejected.no_specific_source,2);
});

test("same legal name with different new source is kept for identity, not name-deduped", () => {
  const a=record("ООО Совпадающее имя","grain transport",
    ["https://one.example.org/evidence"]);
  const b=record("ООО Совпадающее имя","grain transport",
    ["https://two.example.org/evidence"],{"ИНН":"7701122334"});
  const plan=filterAutonomousDiscoveryFindings({
    response:current([b]),current:current([a]),sector:sectors[1]
  });
  assert.equal(plan.accepted,1);
  assert.equal(plan.rejected.duplicate_current,0);
  assert.equal(plan.result.direct_buyers[0].__evidence.identity_verification,undefined);
  assert.equal(plan.result.direct_buyers[0].__autonomous_coverage.identity_reverified,false);
});
