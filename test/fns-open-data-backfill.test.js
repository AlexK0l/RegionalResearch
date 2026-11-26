import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {archiveNameKey,planFnsOpenData,applyFnsOpenData,combineFnsOpenDataTargets} from "../src/fnsOpenDataBackfill.js";
const inn="4706000909",otherInn="7810165652",ogrn="1024701329377";
const name='АО "ПРИМЕР"',full='АКЦИОНЕРНОЕ ОБЩЕСТВО "ПРИМЕР"';
const row=(id,org=name,extra={})=>({__canonical_id:id,"Организация":org,"ИНН":"","Город/район":"Кировск","Численность":"",...extra});
const cp=rows=>({version:1,source_mode:"saby",phase:"saby",region:"Ленинградская область",
  final_result:{direct_buyers:rows,intermediaries:[],leasing:[],statistics:[]},
  independent_inn_backfill_outcomes:{existing:{status:"review",reason:"registry_name_search_incomplete"}}});
const source=kind=>{
  const prefix="https://file.nalog.ru/opendata/7707329152-"+(kind==="sshr"?"sshr2019":"rsmp")+"/";
  const version=kind==="sshr"?"20200408":"12052026";
  return {kind,url:prefix+"data-"+(kind==="sshr"?"20261025":"10112026")+"-structure-"+version+".zip",
    schema_url:prefix+"structure-"+version+".xsd",release:kind==="sshr"?"2026-10-25":"2026-11-10",
    report_year:2025,bytes:100,sha256:"a".repeat(64),schema_sha256:"b".repeat(64)};
};
const record=(extra={})=>({inn,ogrn:"",full_name:full,short_name:"",region_code:"",region_name:"",
  localities:[],employees:0,as_of:"2025-12-31",document_id:"fixture",member:"fixture.xml",...extra});
function archive(kind,groups,overflow={}){
  return {source:source(kind),stats:{legal_records:1},hits:{by_inn:{},by_ogrn:{},by_name:{},by_name_region:{},...groups},
    overflow:{by_inn:[],by_ogrn:[],by_name:[],by_name_region:[],...overflow}};
}
const opts={sourceId:"p",childId:"c"};
test("exact INN and registered name fill numeric zero, preserve old values and parent",()=>{
  const checkpoint=cp([row("a",name,{"ИНН":inn,"Телефон":"123"}),row("b","АО ДРУГОЙ",{"ИНН":otherInn,"Численность":17}),row("c","АО НЕИЗВЕСТНЫЙ")]);
  const before=JSON.stringify(checkpoint);
  assert.equal(planFnsOpenData(checkpoint).staff.length,1);
  const out=applyFnsOpenData(checkpoint,[archive("sshr",{by_inn:{[inn]:[record()]}})],opts);
  const [a,b,c]=out.snapshot.final_result.direct_buyers;
  assert.equal(a["Численность"],0);
  assert.equal(a["Телефон"],"123");
  assert.equal(b["Численность"],17);
  assert.equal(c["ИНН"],"");
  assert.equal(a.__evidence.fns_open_data_staff.report_year,2025);
  assert.match(a.__comment,/2025/);
  assert.equal(out.stats.employees_added,1);
  assert.equal(out.stats.inn_added,0);
  assert.deepEqual(out.snapshot.independent_inn_backfill_outcomes,checkpoint.independent_inn_backfill_outcomes);
  assert.equal(JSON.stringify(checkpoint),before);
});
test("conflicting headcounts, legal forms, duplicates and source conflicts cannot write",()=>{
  const checkpoint=cp([row("a",name,{"ИНН":inn})]);
  for(const a of [
    archive("sshr",{by_inn:{[inn]:[record(),record({employees:8})]}}),
    archive("sshr",{by_inn:{[inn]:[record({full_name:"ООО ПРИМЕР"})]}}),
    archive("sshr",{by_inn:{[inn]:[record()]}},{by_inn:[inn]})
  ]){
    const out=applyFnsOpenData(checkpoint,[a],opts);
    assert.equal(out.stats.employees_added,0);
    assert.equal(out.stats.employees_conflict,1);
  }
  assert.equal(planFnsOpenData(cp([row("a",name,{"ИНН":inn}),row("b",name,{"ИНН":inn})])).staff.length,0);
  assert.equal(planFnsOpenData(cp([row("a",name,{"ИНН":inn,__evidence:{legal_identity_conflicts:["x"]}})])).staff.length,0);
});
test("MSP locality and saved OGRN prioritize candidates but never assign an INN",()=>{
  const checkpoint=cp([row("a",name,{"ОГРН":ogrn})]);
  const r=record({ogrn,short_name:name,region_code:"47",region_name:"Ленинградская обл.",localities:["Кировск"],as_of:"2026-11-10"});
  const out=applyFnsOpenData(checkpoint,[archive("rsmp",{by_name:{[archiveNameKey(name)]:[r]},by_ogrn:{[ogrn]:[r]}})],opts);
  const c=out.snapshot.fns_open_data_candidates.a.records[0];
  assert.equal(c.region_locality_match,true);
  assert.equal(c.saved_ogrn_match,true);
  assert.equal(c.status,"candidate_only");
  assert.equal(out.snapshot.final_result.direct_buyers[0]["ИНН"],"");
  assert.equal(out.stats.candidate_rows,1);
  assert.equal(out.stats.inn_added,0);
});
test("reject nonofficial source",()=>{
  const a=archive("sshr",{});a.source.url="https://example.org/data.zip";
  assert.throws(()=>applyFnsOpenData(cp([row("a")]),[a],opts),/SOURCE_INVALID/);
});
test("Python scanner reads documented XML, retains zero, skips individuals and wrong report year",()=>{
  const scanner=fileURLToPath(new URL("../scripts/fns-open-data-scan.py",import.meta.url));
  const fixture=fileURLToPath(new URL("./fns-open-data-scanner-fixture.py",import.meta.url));
  const r=spawnSync(process.env.REGIONALRESEARCH_PYTHON||(process.platform==="win32"?"python":"python3"),[fixture,scanner],
    {encoding:"utf8",timeout:30000,maxBuffer:1024*1024});
  assert.equal(r.status,0,r.stderr);
  const out=JSON.parse(r.stdout);
  assert.equal(out.sshr.hits.by_inn[inn][0].employees,0);
  assert.equal(out.sshr.stats.invalid_records,1);
  assert.equal(out.rsmp.stats.skipped_non_legal,1);
  assert.equal(out.rsmp.hits.by_ogrn[ogrn][0].region_code,"47");
  assert.equal(out.rsmp.hits.by_name[archiveNameKey(name)].length,1);
  assert.equal(out.rsmp.hits.by_name_region[archiveNameKey(name)].length,1);
  assert.equal(out.batch.regional_key_mode,"region_name_v1");
  assert.ok(out.batch.overflow.by_name.includes(archiveNameKey(name)));
  assert.equal(out.batch.hits.by_name_region["ленинградская область|"+archiveNameKey(name)][0].inn,inn);
  assert.equal(out.batch.hits.by_name_region["вологодская область|"+archiveNameKey(name)][0].inn,otherInn);
  assert.equal(out.batch.overflow.by_name_region.length,0);
  assert.equal(out.range.archive_mode,"http_range");
  assert.match(out.range.sha256,/^[a-f0-9]{64}$/);
  assert.ok(out.range.range_requests>1);
  assert.equal(out.recovered_range.sha256,out.range.sha256);
  assert.equal(out.recovered_range.range_retries,1);
  assert.ok(out.recovered_range.requested_bytes>out.recovered_range.bytes);
});

test("regional candidates survive nationwide name overflow and a single-source retry",()=>{
  const checkpoint=cp([row("a",name)]);
  const r=record({ogrn,short_name:name,region_code:"47",region_name:"Ленинградская область",
    localities:["Кировск"],as_of:"2026-11-10"});
  const key=archiveNameKey(name);
  const first=applyFnsOpenData(checkpoint,[archive("rsmp",{by_name_region:{[key]:[r]}},{by_name:[key]})],opts);
  assert.equal(first.stats.candidate_region_locality_rows,1);
  assert.equal(first.stats.candidate_overflow_rows,1);
  const second=applyFnsOpenData(first.snapshot,[archive("sshr",{})],{sourceId:"c",childId:"d"});
  assert.equal(second.snapshot.fns_open_data_sources.length,2);
  assert.equal(second.snapshot.fns_open_data_candidates.a.records[0].inn,inn);
  assert.equal(second.snapshot.final_result.direct_buyers[0]["ИНН"],"");
});

test("batch scanner deduplicates targets while preserving separate region/name overflow",()=>{
  const first=cp([row("a",name)]),second={...cp([row("b",name)]),region:"Вологодская область"};
  const combined=combineFnsOpenDataTargets([first,second].map(c=>planFnsOpenData(c).targets));
  assert.equal(combined.names.length,1);
  assert.equal(combined.regional_targets.length,2);
  const key=archiveNameKey(name),a="ленинградская область",b="вологодская область";
  const r1=record({ogrn,short_name:name,region_name:"Ленинградская обл.",localities:["Кировск"],as_of:"2026-11-10"});
  const r2={...r1,inn:otherInn,region_name:"Вологодская область",region_code:"35"};
  const shared={...archive("rsmp",{by_name_region:{[a+"|"+key]:[r1],[b+"|"+key]:[r2]}},
    {by_name:[key],by_name_region:[b+"|"+key]}),regional_key_mode:"region_name_v1",regional_keys:[a,b].sort()};
  const one=applyFnsOpenData(first,[shared],opts),two=applyFnsOpenData(second,[shared],opts);
  assert.equal(one.snapshot.fns_open_data_candidates.a.records[0].inn,inn);
  assert.equal(two.snapshot.fns_open_data_candidates.b.records[0].inn,otherInn);
  assert.equal(one.snapshot.final_result.direct_buyers[0]["ИНН"],"");
  assert.equal(two.snapshot.final_result.direct_buyers[0]["ИНН"],"");
  assert.throws(()=>applyFnsOpenData(first,[{...shared,regional_keys:[b]}],opts),/BATCH_REGION_MISSING/);
  assert.throws(()=>applyFnsOpenData(first,[{...shared,hits:{...shared.hits,by_name_region:{[a+"|"+key]:[r2]}}}],opts),/BATCH_REGION_MISMATCH/);
  assert.throws(()=>combineFnsOpenDataTargets(Array(7).fill(combined)),/BATCH_LIMIT/);
});
test("batch deduplicates shared exact INNs and does not transfer an employee count between different legal names",()=>{
  const a=cp([row("a",name,{"ИНН":inn})]);
  const b={...cp([row("b","АО ДРУГОЙ",{"ИНН":inn})]),region:"Вологодская область"};
  const combined=combineFnsOpenDataTargets([a,b].map(c=>planFnsOpenData(c).targets));
  assert.deepEqual(combined.inns,[inn]);
  const shared={...archive("sshr",{by_inn:{[inn]:[record()]}}),
    regional_key_mode:"region_name_v1",regional_keys:["вологодская область","ленинградская область"]};
  assert.equal(applyFnsOpenData(a,[shared],opts).stats.employees_added,1);
  assert.equal(applyFnsOpenData(b,[shared],opts).stats.employees_added,0);
});
