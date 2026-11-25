import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {selectSabySmokeTarget} from "../src/sabySmokeSelection.js";
import {sabyEligibleRows} from "../src/sabyEnrichment.js";

const buyer=(inn,name)=>({
  "ИНН":inn,"Организация":name,"Телефон":"","Электронная почта":"",
  "__evidence":{source_urls:["https://example.org"]}
});
const source=()=>({
  direct_buyers:[
    buyer("4704062064","АО Выборгтеплоэнерго"),
    buyer("7727218041","АО Азот-Взрыв"),
    buyer("4703006839","АО Выборжец")
  ],
  intermediaries:[buyer("7802131219","ООО Интерлизинг")],
  leasing:[],statistics:[{region:"Ленинградская область"}],
  qualification_review:[{name:"not for Saby"}]
});

test("exact INN selects Azot regardless of original and retry queue offsets",()=>{
  const base=source();
  base.direct_buyers[0].__evidence.saby={
    inn:"4704062064",collection:{contacts:"collected",trucks:"verified"},
    trucks:{count:10,vehicles:[{model:"DAF XF",year:2020}]}
  };
  const order=sabyEligibleRows(base).eligible.map(x=>x.row["ИНН"]);
  assert.equal(order.includes("7727218041"),true);
  const found=selectSabySmokeTarget(base,"7727218041");
  assert.equal(found.inn,"7727218041");
  assert.equal(found.section,"direct_buyers");
  assert.equal(found.result.direct_buyers.length,1);
  assert.equal(found.result.direct_buyers[0]["Организация"],"АО Азот-Взрыв");
  assert.equal(found.result.intermediaries.length,0);
  assert.equal(found.result.leasing.length,0);
  assert.deepEqual(found.result.statistics,[]);
  assert.equal("qualification_review" in found.result,false);
  assert.notEqual(found.result.direct_buyers[0],base.direct_buyers[1]);
  found.result.direct_buyers[0]["Телефон"]="79991110000";
  assert.equal(base.direct_buyers[1]["Телефон"],"");
  assert.equal(base.direct_buyers.length,3);
});

test("target can be an eligible leasing or intermediary record",()=>{
  const base=source();
  base.leasing.push(buyer("7702070139","ООО Лизинг"));
  assert.equal(selectSabySmokeTarget(base,"7802131219").section,"intermediaries");
  const picked=selectSabySmokeTarget(base,"7702070139");
  assert.equal(picked.section,"leasing");
  assert.equal(picked.result.leasing.length,1);
});

test("same INN in multiple sections fails closed instead of selecting a wrong card",()=>{
  const base=source();
  base.leasing.push(buyer("7727218041","АО Другое"));
  assert.throws(()=>selectSabySmokeTarget(base,"7727218041"),/найден 2 раз/);
});

test("missing or malformed INN fails closed without any company",()=>{
  const base=source();
  for(const inn of ["","abc","123456789","7727218041x"," 7727218041x "])
    assert.throws(()=>selectSabySmokeTarget(base,inn));
  assert.throws(()=>selectSabySmokeTarget(base,"7707083893"),/найден 0 раз/);
});

test("known phone without email remains eligible; complete intermediary cannot be forced into the smoke",()=>{
  const base=source();
  base.intermediaries[0]["Телефон"]="78123456789";
  assert.equal(selectSabySmokeTarget(base,"7802131219").section,"intermediaries");
  base.intermediaries[0]["Электронная почта"]="office@example.org";
  assert.throws(()=>selectSabySmokeTarget(base,"7802131219"),/не входит/);
});

test("empty company name cannot be selected",()=>{
  const base=source();
  base.direct_buyers[1]["Организация"]="";
  assert.throws(()=>selectSabySmokeTarget(base,"7727218041"),/не входит/);
});

test("CLI requires exact INN option with a source result, limit 1, and no offset",()=>{
  const script=fs.readFileSync(new URL("../scripts/saby-smoke.js",import.meta.url),"utf8");
  assert.match(script,/option\(args,"target-inn"\)/);
  assert.match(script,/selectSabySmokeTarget\(base,rawTargetInn\)/);
  assert.match(script,/env\.SABY_MAX_COMPANIES!=="1"\|\|offset!==0/);
  assert.match(script,/mode:"exact_inn"/);
  assert.match(script,/\[SABY_SMOKE_TARGET\]/);
  assert.doesNotMatch(script,/unlink\(|writeFile\([^\n]*checkpoints\.sqlite/);
});
