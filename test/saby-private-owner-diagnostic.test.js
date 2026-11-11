import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  summarizeSabyPrivateOwnerStructure,diagnoseSabyPrivateOwnerStructure
} from "../src/sabyPrivateOwnerDiagnostic.js";

const inn="7725104641";
const searchTitle='ДСК "Автобан", АО';
const detailUrl="https://profile.saby.ru/page/contractor-info";

test("private owner diagnostics contain only allowlisted counts, not names or registration data",()=>{
  const input={
    headings:[
      {title:searchTitle,has_scoped_inn:false},
      {title:"Автобан-Дорстрой, ООО",has_scoped_inn:false},
      {title:"Секретное ООО",has_scoped_inn:true}
    ],
    visible_text_chars:14420,
    main_regions:1,heading_count:3,h1_count:1,
    visible_inn_labels:28,visible_kpp_labels:0,
    requisites_label_leaves:0,requisites_role_controls:0,
    related_company_headings:2,
    public_same_inn_profile_links:0,
    public_distinct_kpp_links:0,
    raw_body:"username: secret42, manager@example.com",
    private_url:detailUrl,
    private_inn:inn
  };
  const out=summarizeSabyPrivateOwnerStructure(input,searchTitle);
  assert.equal(out.status,"observed_not_verified");
  assert.equal(out.visible_inn_labels,28);
  assert.equal(out.visible_kpp_labels,0);
  assert.equal(out.selected_name_in_headings,true);
  assert.equal(out.selected_heading_scoped_inn,false);
  assert.equal(out.requisites_role_controls,0);
  assert.equal(out.related_company_headings,2);
  assert.equal(out.public_distinct_kpp_links,0);
  const data=JSON.stringify(out);
  assert.doesNotMatch(data,/secret42|manager@example|7725104641|Автобан|Дорстрой|profile\.saby\.ru/);
  assert.deepEqual(Object.keys(out),[
    "status","visible_text_chars","main_regions","heading_count",
    "h1_count","visible_inn_labels","visible_kpp_labels",
    "requisites_label_leaves","requisites_role_controls",
    "related_company_headings","public_same_inn_profile_links",
    "public_distinct_kpp_links",
    "selected_name_in_headings","selected_heading_count",
    "selected_heading_scoped_inn",
    "selected_heading_scoped_inn_count","detail_region_observed"
  ]);
});

test("matching short search title AND scoped INN is an observation, not identity verification",()=>{
  const report=summarizeSabyPrivateOwnerStructure({
    headings:[
      {title:searchTitle,has_scoped_inn:true},
      {title:searchTitle,has_scoped_inn:false}
    ],
    visible_text_chars:700,main_regions:1,
    visible_inn_labels:1,visible_kpp_labels:0,
    public_same_inn_profile_links:1,public_distinct_kpp_links:1
  },searchTitle);
  assert.equal(report.selected_heading_count,2);
  assert.equal(report.selected_heading_scoped_inn,true);
  assert.equal(report.selected_heading_scoped_inn_count,1);
  assert.equal(report.public_distinct_kpp_links,1);
  assert.equal(report.status,"observed_not_verified");
  assert.equal(Object.hasOwn(report,"verified"),false);
});

test("private owner probe never visits other pages, requests contacts or changes Saby",async()=>{
  let evaluates=0;
  const page={
    url:()=>detailUrl,
    evaluate:async(_callback,args)=>{
      evaluates++;
      assert.equal(args.inn,inn);
      return {headings:[{title:searchTitle,has_scoped_inn:true}],
        heading_count:1,visible_text_chars:280,
        visible_inn_labels:1,visible_kpp_labels:0,
        public_same_inn_profile_links:1,
        public_distinct_kpp_links:1};
    }
  };
  const out=await diagnoseSabyPrivateOwnerStructure(page,inn,searchTitle);
  assert.equal(evaluates,1);
  assert.equal(out.selected_name_in_headings,true);
  assert.equal(out.selected_heading_scoped_inn,true);
  assert.equal(out.public_distinct_kpp_links,1);
  assert.equal(out.status,"observed_not_verified");

  const wrong={
    url:()=> "https://malicious.example/page/contractor-info",
    evaluate:async()=>{throw Error("MUST NOT read unknown origin");}
  };
  const fail=await diagnoseSabyPrivateOwnerStructure(wrong,inn,searchTitle);
  assert.equal(fail.status,"not_private_detail");
  assert.equal(evaluates,1);
});

test("Stage12 invokes read-only private structure report for unresolved KPP or changed route in explicit opt-in mode",()=>{
  const browser=fs.readFileSync(
    new URL("../src/sabyBrowser.js",import.meta.url),"utf8");
  assert.match(browser,/\["no_scoped_inn_kpp","private_route_changed"\]\.includes\(publicFallbackFailureReason\)/);
  assert.match(browser,/diagnoseSabyPrivateOwnerStructure\(/);
  assert.match(browser,/\[SABY_PRIVATE_OWNER_DIAG\]/);
  assert.match(browser,/auditSearchName\(rows\[0\]\?\.text,inn\)/);
  assert.match(browser,/publicFallback=settings\.publicIdentityFallback===true/);
  assert.match(browser,/return \{inn,name:outcome\.verifiedName,verified:true\}/);
});
