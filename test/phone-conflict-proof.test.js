import test from "node:test";
import assert from "node:assert/strict";
import {phoneConflictKey,assessPhoneConflictProof,restorePhoneConflictProof} from "../src/phoneConflictProof.js";
const target={rowId:"k1",inn:"7707083893",phone:"79001234567"};
const response={confirmed:true,inn:target.inn,phone:"8 (900) 123-45-67",
  source_url:"https://carrier.example.org/contacts",
  evidence_excerpt:"ООО Тест, ИНН 7707083893, телефон +7 (900) 123-45-67",note:"Контакты"};
test("verified phone conflict requires source excerpt with matching full INN and number",()=>{
  const proof=assessPhoneConflictProof(response,target);
  assert.equal(proof.status,"confirmed");
  assert.equal(proof.phone,target.phone);
  assert.equal(proof.source_url,response.source_url);
  assert.deepEqual(restorePhoneConflictProof(proof,target),proof);
});
test("bare confirmed boolean cannot transfer a conflicted number",()=>{
  assert.equal(assessPhoneConflictProof({...response,source_url:""},target).status,"unproven");
  assert.equal(assessPhoneConflictProof({...response,evidence_excerpt:"Телефон +7 (900) 123-45-67"},target).status,"unproven");
  assert.equal(assessPhoneConflictProof({...response,evidence_excerpt:"ИНН 7707083893, телефон +7 900 123 45 68"},target).status,"unproven");
  assert.equal(assessPhoneConflictProof({...response,inn:"7707083894"},target),null);
  assert.equal(assessPhoneConflictProof({...response,phone:"79001234568"},target),null);
});
test("completed negative or insufficient evidence survives resume, but cannot become positive",()=>{
  for(const result of [{...response,confirmed:false},{...response,evidence_excerpt:"no evidence"}]){
    const proof=assessPhoneConflictProof(result,target);
    assert.notEqual(proof.status,"confirmed");
    assert.deepEqual(restorePhoneConflictProof(proof,target),proof);
    assert.equal(restorePhoneConflictProof({...proof,status:"confirmed"},target),null);
  }
});
test("canonical ID, legal INN and phone all participate in the durable key",()=>{
  const proof=assessPhoneConflictProof(response,target);
  for(const changed of [{rowId:"k2"},{inn:"7707083894"},{phone:"79001234568"}]){
    const another={...target,...changed};
    assert.notEqual(phoneConflictKey(another.rowId,another.inn,another.phone),phoneConflictKey(target.rowId,target.inn,target.phone));
    assert.equal(restorePhoneConflictProof(proof,another),null);
  }
  assert.equal(restorePhoneConflictProof(proof,{rowId:"",inn:"",phone:""}),null);
});
