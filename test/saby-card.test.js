import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  sabyCardRoute, assessSabyCardEvidence,
  safeCardDiagnostic, verifySabyCard
} from "../src/sabyCard.js";

import {safeSabySectionDiagnostic} from "../src/sabyBrowser.js";

const INN="6027087063";
const NAME="ООО «Дорстройсервис»";
const DETAIL="https://profile.saby.ru/page/contractor-info?anchor=about&tab=all&page=public";
const LIST="https://profile.saby.ru/page/company-list-prof";
const snapshot = (opts={}) => ({
  headings:["Дорстройсервис, ООО"],
  introLines:["Компании","Дорстройсервис, ООО","ИНН 6027087063"],
  bodyLabeledInn:true,scopedLabeledInn:true,scopedExactInn:true,
  detailContentPresent:true,contactSectionPresent:false,
  ...opts
});

test("Saby archived company route is recognized only on exact profile HTTPS origin",()=>{
  assert.equal(sabyCardRoute(DETAIL),"detail");
  assert.equal(sabyCardRoute(LIST),"list");
  assert.equal(sabyCardRoute("https://profile.saby.ru/page/contractor-info/123"),"detail");
  for(const url of [
    "http://profile.saby.ru/page/contractor-info",
    "https://profile.saby.ru.evil.org/page/contractor-info",
    "https://profile.saby.ru/page/company-list-prof",
    "https://sso.sbis.ru/auth-online/"
  ]) assert.notEqual(sabyCardRoute(url),"detail");
});

test("realistic contractor detail can verify INN/name without Контакты section",()=>{
  const result=assessSabyCardEvidence(DETAIL,INN,NAME,snapshot());
  assert.equal(result.ok,true);
  assert.equal(result.verifiedName,"Дорстройсервис, ООО");
  assert.equal(result.detail.contactSectionPresent,false);
  assert.equal(result.reason,"verified");
});

test("a result-list occurrence of the same INN and name is never a verified card",()=>{
  const result=assessSabyCardEvidence(LIST,INN,NAME,snapshot());
  assert.equal(result.ok,false);
  assert.equal(result.reason,"not_detail_page");
});

test("wrong INN or unrendered detail never creates a verified company",()=>{
  let evidence=snapshot({scopedExactInn:false,scopedLabeledInn:false,bodyLabeledInn:false});
  assert.equal(assessSabyCardEvidence(DETAIL,INN,NAME,evidence).reason,
    "inn_not_verified");
  evidence=snapshot({detailContentPresent:false});
  assert.equal(assessSabyCardEvidence(DETAIL,INN,NAME,evidence).reason,
    "detail_not_rendered");
});

test("Saby name must match exactly after legal form normalization",()=>{
  const result=assessSabyCardEvidence(DETAIL,INN,NAME,snapshot({
    headings:["ООО Дорстройсервис-Регион"],
    introLines:["ООО Дорстройсервис-Регион","ИНН 6027087063"]
  }));
  assert.equal(result.ok,false);
  assert.equal(result.reason,"legal_name_not_verified");
});

test("a non-detail page does not invoke DOM scan",async()=>{
  const page={url:()=>LIST,evaluate:()=>{throw Error("should not inspect search result");}};
  const result=await verifySabyCard(page,INN,NAME);
  assert.equal(result.ok,false);
  assert.equal(result.reason,"not_detail_page");
});

test("diagnostics never expose company identifiers or original DOM text",()=>{
  const check=assessSabyCardEvidence(DETAIL,INN,NAME,snapshot());
  const diagnostic=safeCardDiagnostic(check,{clicked:true,navigationObserved:true});
  const encoded=JSON.stringify(diagnostic);
  assert.equal(diagnostic.route,"detail");
  assert.equal(diagnostic.hasInn,true);
  assert.equal(diagnostic.hasName,true);
  assert.equal(diagnostic.navigationObserved,true);
  assert.ok(!encoded.includes(INN));
  assert.ok(!encoded.includes("Дорстройсервис"));
  assert.ok(!encoded.includes("profile.saby.ru"));
  const browser=readFileSync(new URL("../src/sabyBrowser.js",import.meta.url),"utf8");
  assert.match(browser,/\[SABY_CARD_DIAG\]/);
  assert.match(browser,/verifySabyCard\(/);
  assert.doesNotMatch(browser,/verifyOpenCard\(/);
});

test("Saby section diagnostics contain only booleans even if the DOM returns private data",async()=>{
  const page={
    url:()=>DETAIL,
    getByText:()=>({async count(){return 0;}}),
    evaluate:async()=>({
      mentions_contacts:true,mentions_phones:true,
      mentions_fleet:true,mentions_trucks:true,
      has_tel_link:true,has_mail_link:true,substantive_page:true,
      raw_phones:"79000000000",private_company:NAME,source_url:DETAIL
    })
  };
  const diag=await safeSabySectionDiagnostic(page);
  assert.deepEqual(diag,{
    route:"detail",exact_contacts_heading:false,exact_fleet_heading:false,
    mentions_contacts:true,mentions_phones:true,
    mentions_fleet:true,mentions_trucks:true,
    has_tel_link:true,has_mail_link:true,substantive_page:true
  });
  assert.ok(!JSON.stringify(diag).includes("79000000000"));
  assert.ok(!JSON.stringify(diag).includes(NAME));
  assert.ok(!JSON.stringify(diag).includes("profile.saby.ru"));
});

test("Saby section diagnostics refuse to inspect non-detail pages",async()=>{
  const page={
    url:()=>LIST,
    getByText:()=>{throw Error("not a detail page");},
    evaluate:()=>{throw Error("must not inspect content");}
  };
  assert.deepEqual(await safeSabySectionDiagnostic(page),{route:"list"});
});
