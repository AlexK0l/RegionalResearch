import test from "node:test";
import assert from "node:assert/strict";
import {createSabyVisitPublicVerifier} from "../src/sabyPublicRegisteredIdentity.js";
import {sabyBrowserSettings} from "../src/sabyBrowser.js";
test("only independent source-name rejection is reused for identical identifiers during one visit",async()=>{
  let calls=0,reused=0;
  const inn="1650017638",kpp="165001001";
  const reject={status:"review",official_inn:inn,official_kpp:kpp,
    diagnostic:{independent_bridge_attempted:true,independent_bridge_verified:false,
      independent_bridge_reason:"independent_registered_name_mismatch"}};
  const read=createSabyVisitPublicVerifier(async()=>{calls++;return reject;},()=>reused++);
  await read({},inn,kpp,"Name");
  await read({},inn,kpp,"Name");
  assert.equal(calls,1);assert.equal(reused,1);
  await read({},inn,kpp,"Other");
  await read({},inn,"165001002","Name");
  assert.equal(calls,3);
  const fresh=createSabyVisitPublicVerifier(async()=>{calls++;return reject;});
  await fresh({},inn,kpp,"Name");
  assert.equal(calls,4);
});
test("positive and transient or title-specific public observations are never cached",async()=>{
  for(const result of [{status:"verified"},{status:"review",reason:"public_page_unavailable"},
    {status:"review",official_inn:"1650017638",official_kpp:"165001001",diagnostic:{
      independent_bridge_attempted:true,independent_bridge_verified:false,
      independent_bridge_reason:"independent_short_name_mismatch"}}]){
    let calls=0;const read=createSabyVisitPublicVerifier(async()=>{calls++;return result;});
    await read({},"1650017638","165001001","Name");
    await read({},"1650017638","165001001","Name");
    assert.equal(calls,2);
  }
});
test("history optimization defaults on only for full production pass, explicit false still works",()=>{
  assert.equal(sabyBrowserSettings({}).reuseCatalogHistory,false);
  assert.equal(sabyBrowserSettings({SABY_FULL_CARD_PASS_ENABLED:"true"}).reuseCatalogHistory,true);
  assert.equal(sabyBrowserSettings({SABY_FULL_CARD_PASS_ENABLED:"true",SABY_SMOKE_ONLY:"true"}).reuseCatalogHistory,false);
  assert.equal(sabyBrowserSettings({SABY_FULL_CARD_PASS_ENABLED:"true",SABY_REUSE_CATALOG_HISTORY_ENABLED:"false"}).reuseCatalogHistory,false);
});
