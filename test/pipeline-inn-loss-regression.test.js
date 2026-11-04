import test from "node:test";
import assert from "node:assert/strict";
import { applyFinalInnItems } from "../src/pipeline.js";
import { finalizeProductionResearch } from "../src/productionFinalQuality.js";

function make(id, inn="") {
  return {
    __canonical_id:id, "Организация":"ООО «Точный перевозчик»",
    "ИНН":inn,"Город/район":"Смоленская область",
    "Техника/сегмент":"Полуприцеп Schmitz",
    "Основание":"B — тяжелая логистика",
    __evidence:{
      source_urls:["https://carrier.example.org/fleet"],
      notes:["Официальный парк грузовой техники."],
      ...(inn ? {identity_verification:{
        inn,method:"final_inn_web",source_urls:["https://egrul.nalog.ru/download/record"]
      }} : {})
    }
  };
}
const response=(id,inn="",urls=[])=>({
  items:[{id,confirmed_inn:inn,source_urls:urls,note:"Источник проверен по наименованию"}]
});

test("empty late search cannot delete an already verified INN",()=>{
  const row=make("k101","6732114166");
  const before=structuredClone(row.__evidence.identity_verification);
  const recovered=applyFinalInnItems(new Map([["k101",row]]),response("k101"));
  assert.equal(recovered,0);
  assert.equal(row["ИНН"],"6732114166");
  assert.deepEqual(row.__evidence.identity_verification,before);
  assert.equal(row.__evidence.legal_identity_conflicts,undefined);
});

test("new checksum-valid INN without its entity source is not silently accepted",()=>{
  const row=make("k102","");
  const recovered=applyFinalInnItems(new Map([["k102",row]]),
    response("k102","6732114166",[]));
  assert.equal(recovered,0);
  assert.equal(row["ИНН"],"");
  assert.equal(row.__evidence.identity_verification,undefined);
});

test("new sourced INN fills missing field and keeps real source provenance",()=>{
  const row=make("k103","");
  const url="https://official.example.org/company/6732114166";
  const recovered=applyFinalInnItems(new Map([["k103",row]]),
    response("k103","6732114166",[url]));
  assert.equal(recovered,1);
  assert.equal(row["ИНН"],"6732114166");
  assert.equal(row.__evidence.identity_verification.method,"final_inn_web");
  assert.deepEqual(row.__evidence.identity_verification.source_urls,[url]);
});

test("conflicting INN does not overwrite known identity and sends legal dispute to REVIEW",()=>{
  const row=make("k104","6732114166");
  const url="https://official.example.org/company/6732132711";
  const recovered=applyFinalInnItems(new Map([["k104",row]]),
    response("k104","6732132711",[url]));
  assert.equal(recovered,0);
  assert.equal(row["ИНН"],"6732114166");
  assert.equal(row.__evidence.identity_verification.inn,"6732114166");
  const conflict=row.__evidence.legal_identity_conflicts[0];
  assert.equal(conflict.existing_inn,"6732114166");
  assert.equal(conflict.proposed_inn,"6732132711");
  assert.equal(conflict.status,"manual_review_required");

  const input={direct_buyers:[row],intermediaries:[],leasing:[],
    qualification_review:[],qualification_excluded:[],statistics:[]};
  const {result,report}=finalizeProductionResearch(input,{
    qualify:()=>({decision:"include",grade:"B",reason:"valid heavy logistics"}),
    isActionable:()=>true
  });
  assert.equal(result.direct_buyers.length,0);
  assert.equal(result.qualification_review.length,1);
  assert.equal(result.qualification_review[0]["ИНН"],"6732114166");
  assert.ok(report.flags[0].reasons.includes("unresolved_legal_identity_conflict"));
  assert.equal(report.originals_lost,0);
});

test("previous invalid raw INN is archived when replaced, not overwritten without a trace",()=>{
  const row=make("k105","не установлен");
  const first=applyFinalInnItems(new Map([["k105",row]]),response("k105"));
  assert.equal(first,0);
  assert.equal(row["ИНН"],"не установлен");
  const second=applyFinalInnItems(new Map([["k105",row]]),response(
    "k105","6732114166",["https://official.example.org/company/6732114166"]));
  assert.equal(second,1);
  assert.equal(row["ИНН"],"6732114166");
  assert.ok(row.__evidence.notes.some(x=>x.includes('не установлен')));
});
