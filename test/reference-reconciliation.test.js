import test from "node:test";
import assert from "node:assert/strict";
import {reconcileReference,checkedInn,normalizedLegalName} from "../src/referenceReconciliation.js";
const make=(id,name,inn,value="",evidence={})=>({
 __canonical_id:id,"Организация":name,"ИНН":inn,
 "Телефон":value,__evidence:{source_urls:["https://source.example/case"],notes:[],...evidence}
});
const build=(arr=[])=>({direct_buyers:arr,intermediaries:[],leasing:[],qualification_review:[],qualification_excluded:[]});
test("checksum-valid same-INN+same-name fact can carry a missing phone with historical provenance",()=>{
 const inn="6732114166";
 assert.equal(checkedInn(inn),inn);
 const old=make("old","Общество с ограниченной ответственностью «Перевозки»",inn,"79991234567",{
  identity_observed_facts:[{field:"Телефон",value:"79991234567",inn,
    source_url:"https://source.example/case",excerpt:"ООО Перевозки ИНН 6732114166 телефон +7 999 123 45 67"}]
 });
 const current=make("new","ООО «Перевозки»",inn);
 const oldInput=build([old]),currInput=build([current]);
 const {result,report}=reconcileReference(currInput,oldInput,{referenceAsOf:"2026-11-02"});
 assert.equal(report.safe_exact_identity_pairs,1);
 assert.equal(report.historical_fields_carried,1);
 assert.equal(result.direct_buyers[0]["Телефон"],"79991234567");
 assert.equal(result.direct_buyers[0].__evidence.historical_carry_forward[0].live_rechecked,false);
 assert.equal(result.direct_buyers[0].__evidence.historical_carry_forward[0].reference_as_of,"2026-11-02");
 assert.equal(currInput.direct_buyers[0]["Телефон"],"");
});
test("unsourced historical fields are suggestions, not filled CRM values",()=>{
 const old=make("a","ООО Перевозки","6732114166","79991234567");
 const current=make("b","ООО Перевозки","6732114166");
 const {result,report}=reconcileReference(build([current]),build([old]));
 assert.equal(result.direct_buyers[0]["Телефон"],"");
 assert.equal(report.historical_fields_not_carried,1);
 assert.equal(report.unverified_fields_auto_restored,0);
});
test("equal names with different INN or same INN with mismatched legal name are not merged",()=>{
 const old=make("a","ООО Перевозки","6732114166","79991234567");
 const newer=make("b","ООО Перевозки","6732222073");
 const x=reconcileReference(build([newer]),build([old]));
 assert.equal(x.report.safe_exact_identity_pairs,0);
 assert.equal(x.report.old_records_auto_added,0);
 assert.equal(x.report.same_legal_name_different_inn,1);
 const y=reconcileReference(build([make("z","ООО Совсем другая","6732114166")]),build([old]));
 assert.equal(y.report.safe_exact_identity_pairs,0);
 assert.equal(y.report.ambiguous_identity_records,1);
});
test("old-only rows are audit backlog, never injected into new commercial or REVIEW",()=>{
 const old=make("v8","ООО Прежний клиент","6732114166");
 const x=reconcileReference(build([]),build([old]));
 assert.equal(x.report.reference_only_or_unresolved_records,1);
 assert.equal(x.report.reference_review[0].reason,"absent_from_all_new_queues");
 assert.equal(x.result.direct_buyers.length,0);
 assert.equal(x.result.qualification_review.length,0);
});
