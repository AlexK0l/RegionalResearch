import test from "node:test";
import assert from "node:assert/strict";
import { postInnDedupe, deterministicQualificationDecision, actionableUnqualifiedLead } from "../src/pipeline.js";
import { finalizeProductionResearch } from "../src/productionFinalQuality.js";

const row=(id, note)=>({
 __canonical_id:id,
 "Организация":"ООО «Перевозки Смоленск»",
 "ИНН":"6732114166",
 "Основание":"A — парк",
 "Город/район":"Смоленская область",
 "Техника/сегмент":"грузовые полуприцепы",
 __final_grade:"A",
 __evidence:{source_urls:["https://official.example/"+id],notes:[note],facts:[]}
});
test("post-INN legitimate identity merge keeps both IDs and full absorbed original as lineage",()=>{
 const inp={
  direct_buyers:[
    row("k11","Компания эксплуатирует собственный парк тягачей и полуприцепов Schmitz."),
    row("k12","Компания эксплуатирует собственный парк тягачей и полуприцепов Krone.")],
  intermediaries:[],leasing:[],qualification_review:[],statistics:[]
 };
 const archive=structuredClone(inp.direct_buyers[1]);
 const out=postInnDedupe(inp,"Смоленская область",{merges:[]});
 assert.equal(out.records.length,1);
 const merged=out.records[0].row;
 assert.deepEqual(new Set(merged.__merged_canonical_ids),new Set(["k11","k12"]));
 assert.equal(merged.__merged_original_records.length,1);
 assert.deepEqual(merged.__merged_original_records[0],archive);
 assert.deepEqual(new Set(merged.__evidence.source_urls),new Set([
   "https://official.example/k11","https://official.example/k12"
 ]));
 const passed=finalizeProductionResearch({direct_buyers:[merged],intermediaries:[],leasing:[],
   statistics:[],qualification_review:[],qualification_excluded:[]},{
     qualify:deterministicQualificationDecision,isActionable:actionableUnqualifiedLead
   });
 assert.equal(passed.report.source_id_lineage_count,2);
 assert.equal(passed.report.reviewed_alias_groups_from_pipeline.length,1);
 assert.equal(passed.report.reviewed_alias_groups_from_pipeline[0].absorbed_count,1);
 assert.equal(passed.report.new_alias_merges,0);
});

test("identity checks still refuse to merge distinct registered names despite matching INN",()=>{
 const a=row("k1","Компания эксплуатирует полуприцепы.");
 const b=row("k2","Компания эксплуатирует полуприцепы.");
 b["Организация"]="ООО «Другая юридическая компания»";
 const out=postInnDedupe({direct_buyers:[a,b],intermediaries:[],leasing:[]},
   "Смоленская область",{merges:[]});
 assert.equal(out.records.length,2);
 assert.equal(out.records.every(r=>!r.row.__merged_canonical_ids),true);
});
