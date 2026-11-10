import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {
  verifiedInnChecksum,buildMissingInnRecoveryQueue
} from "../src/sabyMissingInnRecovery.js";

const good="6700018766",other="7707083893",personal="500100732259";

test("Russian 10/12-digit INN checksum verification rejects malformed candidates",()=>{
  for(const value of [good,other,personal])assert.equal(verifiedInnChecksum(value),true);
  for(const value of ["","1234567890","0000000000","500100732250",
    "6700018767","x"+good])assert.equal(verifiedInnChecksum(value),false);
});

test("full source without checkpoint_id works and leaves evidence untouched",()=>{
  const original={direct_buyers:[
    {"Организация":"ООО АЛЬФА","ИНН":"",
      __comment:"Справка. Подтвержденный ИНН: "+good,
      __evidence:{source_urls:["https://saby.ru/profile/"+good+"-670001001",
        "https://example.com/path?token=my-private-token"],
        notes:["ИНН: "+good]}},
    {"Организация":"ООО БЕТА","ИНН":"",
      __evidence:{notes:["Проверить ИНН: "+other+" — не подтвержден"]}},
    {"Организация":"ООО ГАММА","ИНН":"",
      __evidence:{notes:["ИНН: "+personal]}},
    {"Организация":"ООО ГАММА","ИНН":other}
  ],intermediaries:[],leasing:[]};
  const copy=structuredClone(original);
  const report=buildMissingInnRecoveryQueue(original);
  assert.deepEqual(original,copy);
  assert.equal(report.summary.total_source_rows,4);
  assert.equal(report.summary.missing_inn,3);
  assert.equal(report.summary.auto_filled,0);
  assert.equal(report.summary.web_requests,0);
  assert.equal(report.rows.length,3);
  const alpha=report.rows[0];
  assert.equal(alpha.organization,"ООО АЛЬФА");
  assert.equal(alpha.candidates.length,1);
  assert.equal(alpha.candidates[0].inn,good);
  assert.equal(alpha.candidates[0].checksum_valid,true);
  assert.equal(alpha.decision,"independent_registry_confirmation_required");
  assert.equal(alpha.verified_inn,"");
  assert.equal(alpha.candidates[0].sources.some(x=>
    x.kind==="saby_public_profile_link"),true);
  assert.equal(JSON.stringify(report).includes("my-private-token"),false);
  const beta=report.rows[1];
  assert.equal(beta.candidates.length,1);
  assert.equal(beta.candidates[0].rejected_claim,true);
  assert.equal(beta.decision,"external_registry_search_required");
  const gamma=report.rows[2];
  assert.equal(gamma.decision,"conflicting_candidate_inns");
  assert.deepEqual(gamma.candidates.map(c=>c.inn).sort(),
    [personal,other].sort());
  assert.equal(gamma.candidates.some(c=>c.existing_owners.length>0),true);
});

test("same-name candidate with an existing INN is only possible duplicate",()=>{
  const raw={direct_buyers:[
    {"Организация":"ООО Тест","ИНН":""},
    {"Организация":"ООО Тест","ИНН":good}
  ],intermediaries:[],leasing:[]};
  const report=buildMissingInnRecoveryQueue(raw);
  assert.equal(report.rows.length,1);
  assert.equal(report.rows[0].candidates[0].inn,good);
  assert.equal(report.rows[0].decision,"possible_duplicate_or_related_company");
  assert.equal(report.rows[0].candidates[0].sources[0].kind,
    "same_normalized_name_in_other_source_row");
});

test("missing INN without hints cannot be falsely resolved",()=>{
  const raw={final_result:{direct_buyers:[
    {"Организация":"Группа неустановленных компаний","ИНН":""}
  ],intermediaries:[],leasing:[]}};
  const report=buildMissingInnRecoveryQueue(raw);
  assert.equal(report.rows[0].decision,"external_registry_search_required");
  assert.deepEqual(report.rows[0].candidates,[]);
});

test("standalone queue CLI creates JSON/XLSX/ZIP without modifying source",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"saby-missing-inn-"));
  try {
    const source=path.join(dir,"result.json");
    const prefix=path.join(dir,"queue");
    const raw={direct_buyers:[{"Организация":"Без реквизитов","ИНН":""}],
      intermediaries:[],leasing:[]};
    const bytes=JSON.stringify(raw);
    fs.writeFileSync(source,bytes);
    const cli=fileURLToPath(new URL(
      "../scripts/saby-missing-inn-queue.js",import.meta.url));
    const cmd=()=>spawnSync(process.execPath,[
      cli,"--result="+source,"--out-prefix="+prefix
    ],{encoding:"utf8",timeout:30000,
      env:{...process.env,SAT_PYTHON_BIN:process.env.SAT_PYTHON_BIN||"python"}});
    const result=cmd();
    assert.equal(result.status,0,result.stdout+"\n"+result.stderr);
    assert.equal(fs.readFileSync(source,"utf8"),bytes);
    assert.equal(JSON.parse(fs.readFileSync(prefix+".json","utf8")).summary.missing_inn,1);
    assert.ok(fs.statSync(prefix+".xlsx").size>2000);
    assert.ok(fs.statSync(prefix+".zip").size>2000);
    const second=cmd();
    assert.equal(second.status,1);
    assert.equal(fs.readFileSync(source,"utf8"),bytes);
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
