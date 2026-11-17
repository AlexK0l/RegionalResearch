import test from "node:test";
import assert from "node:assert/strict";
import {buildPostSabyRemediation} from "../src/postSabyRemediation.js";

const sourceUrl="https://profile.saby.ru/page/contractor-info?id=trusted";
const base=(name,inn,id,saby=null)=>({
  "Организация":name,"ИНН":inn,"Основание":"A — тест",
  "Электронная почта":"","Телефон":"",
  __canonical_id:id,__final_grade:"A",
  __comment:"Email: HQ@company.example",
  __evidence:{
    source_urls:["https://company.example/requisites"],
    notes:["ИНН не подтверждён"],
    ...(saby?{saby}: {})
  }
});
const sample=()=>{
  const full={inn:"7707083893",source_url:sourceUrl,
    collection:{contacts:"collected",trucks:"verified"},
    emails:["sales@example.ru"],trucks:{count:2,vehicles:[{model:"KAMAZ"},{model:"MAZ"}]}};
  const partial={inn:"7707083894",source_url:sourceUrl,
    collection:{contacts:"collected",trucks:"review"},
    emails:["office@example.ru"]};
  return {
    region:"Любая область",
    final_quality_gate:{a_claim_attribution_review:[{
      canonical_id:"k2",organization:"ООО Есть частичные данные",
      a_rule:"direct_ownership_or_fleet",status:"missing_claim_source",
      selected_a_evidence:"C — доказан грузопоток, но не владение полуприцепом"
    }]},
    final_result:{
      direct_buyers:[
        base("ООО Без ИНН","","k1"),
        base("ООО Есть частичные данные","7707083894","k2",partial),
        base("ООО Полностью подтверждено","7707083893","k3",full),
        base("ООО Не найдено в Saby","7707083895","k4")
      ],
      intermediaries:[],leasing:[],statistics:[]
    }
  };
};

test("post-Saby work queues are readonly, factual and preserve identity uncertainty",()=>{
  const source=sample(),snapshot=JSON.stringify(source);
  const r=buildPostSabyRemediation(source);
  assert.equal(JSON.stringify(source),snapshot);
  assert.equal(r.region,"Любая область");
  assert.equal(r.summary.commercial_rows,4);
  assert.equal(r.summary.missing_inn,1);
  assert.equal(r.summary.a_claims_missing_source,1);
  assert.equal(r.summary.a_claims_highest_risk,1);
  assert.equal(r.summary.saby_partial,1);
  assert.equal(r.summary.saby_unverified_or_absent,2,
    "missing INN must not masquerade as Saby-not-captured firm");
  assert.equal(r.saby_not_captured.length,2);
  assert.equal(r.summary.companies_with_email,4);
  assert.equal(r.summary.rows_auto_changed,0);
  assert.equal(r.summary.openai_calls,0);
  assert.equal(r.summary.saby_calls,0);
  assert.equal(r.a_claim_source_review[0].priority,"highest");
  assert.equal(r.a_claim_source_review[0].auto_reclassified,false);
  assert.equal(r.saby_partial[0].reason,"fleet_missing");
  assert.equal(r.saby_partial[0].email,
    "hq@company.example; office@example.ru");
  assert.equal(r.saby_partial[0].vehicles,null);
  assert.equal(r.saby_not_captured.some(x=>x.organization==="ООО Полностью подтверждено"),false);
});

test("untrusted Saby identity cannot be promoted as a verified company card",()=>{
  const source=sample();
  source.final_result.direct_buyers[1].__evidence.saby.inn="0000000000";
  const r=buildPostSabyRemediation(source);
  assert.equal(r.saby_partial.length,1);
  assert.equal(r.saby_partial[0].reason,
    "saby_identity_or_source_not_verified");
  assert.equal(r.saby_partial[0].saby_source_url,"");
  assert.equal(r.saby_partial[0].trucks,"untrusted");
});

test("intermediary with contact data does not require its own fleet",()=>{
  const source=sample();
  const inter=base("ООО Посредник","7707083896","k5",{
    inn:"7707083896",source_url:sourceUrl,
    collection:{contacts:"collected",trucks:"review"}
  });
  source.final_result.intermediaries.push(inter);
  const r=buildPostSabyRemediation(source);
  assert.equal(r.summary.saby_partial,1,
    "intermediary contact section is sufficient");
  assert.equal(r.summary.commercial_rows,5);
});

test("invalid input is rejected; report never fills an INN from name or source URL",()=>{
  assert.throws(()=>buildPostSabyRemediation({}),TypeError);
  const source=sample();
  source.final_result.direct_buyers[0].__evidence.notes=[
    "В контракте есть ИНН 7707083893, но он принадлежит контрагенту"
  ];
  const r=buildPostSabyRemediation(source);
  assert.equal(source.final_result.direct_buyers[0]["ИНН"],"");
  assert.equal(r.missing_inn[0].verified_inn,"");
  assert.equal(r.summary.rows_auto_changed,0);
});
