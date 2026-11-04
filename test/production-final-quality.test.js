import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { finalizeProductionResearch } from "../src/productionFinalQuality.js";
import { deterministicQualificationDecision, actionableUnqualifiedLead } from "../src/pipeline.js";
import { buildWorkbookBuffer } from "../src/xlsx.js";

const make=(id,name,notes,extra={})=>({
  __canonical_id:id, "Организация":name,"ИНН":extra.inn||"",
  "Основание":extra.grade+" — old decision","Телефон":extra.phone||"79991234567",
  "Руководитель / ЛПР":"Руководитель сохранён",
  "Выручка последнего подтвержденного года":35000000, "Численность":32,
  "Город/район":"Смоленская область",
  "Техника/сегмент":extra.segment||"Тяжёлая автомобильная логистика и полуприцепы",
  "Следующее действие":"Договориться о встрече",
  __comment:"Original first-column CRM comment",
  __final_grade:extra.grade,
  __evidence:{source_urls:extra.urls||["https://example.org/"+id],notes,facts:[]}
});
const run=(data)=>finalizeProductionResearch(data,{
  qualify:deterministicQualificationDecision,isActionable:actionableUnqualifiedLead
});
const empty=()=>({direct_buyers:[],intermediaries:[],leasing:[],
  statistics:[{"Показатель":"Население","Значение":10000}],qualification_review:[],
  qualification_excluded:[]});
const noteA="Компания эксплуатирует собственный парк тягачей и полуприцепов Schmitz Cargobull.";
const noteC="Компания перерабатывает зерно и отгружает готовую продукцию сельхозпокупателям.";

test("production final gate updates stale qualification after contacts without changing verified CRM data",()=>{
 const input=empty();
 input.direct_buyers.push(make("k101","ООО Перевозчик",[noteA],{grade:"C",inn:"6732114166"}));
 input.direct_buyers.push(make("k102","ООО Зерновая компания",[noteC],{grade:"C",inn:""}));
 const snapshot=structuredClone(input);
 const {result,report}=run(input);
 assert.deepEqual(input,snapshot,"finalization must be detached and non-mutating");
 assert.equal(report.original_row_count,2);
 assert.equal(report.originals_lost,0);
 assert.deepEqual(report.grades,{A:1,B:0,C:1});
 assert.equal(result.direct_buyers.find(x=>x.__canonical_id==="k101").__final_grade,"A");
 assert.equal(result.direct_buyers.find(x=>x.__canonical_id==="k101").__a_rule,"direct_ownership_or_fleet");
 assert.equal(result.direct_buyers[0]["Телефон"],"79991234567");
 assert.equal(result.direct_buyers[0]["Руководитель / ЛПР"],"Руководитель сохранён");
 assert.equal(result.direct_buyers[0]["Выручка последнего подтвержденного года"],35000000);
 assert.equal(result.direct_buyers[0]["Следующее действие"],"Договориться о встрече");
 assert.equal(result.direct_buyers[1]["ИНН"],"","missing INN never causes automatic removal");
 assert.equal(result.statistics[0]["Значение"],10000);
 assert.equal(report.web_search_calls,0);
 assert.equal(report.openai_calls,0);
 assert.equal(report.reviewed_source_manifest_used,false);
 assert.equal(report.transitions.length,1);
});

test("live source-only journals, auction lots and farm implements cannot stay in A",()=>{
 const input=empty();
 input.direct_buyers.push(make("k529","Журнал «ЛесПромИнформ»",[
   "Роль — информационный discovery-канал; журнал является справочником, не покупателем техники."
 ],{grade:"C"}));
 input.direct_buyers.push(make("k252","ООО «ЭНЕРГОМАСТЕР»",[
   "Источник → лот по продаже залогового имущества → собственник/должник ООО «ЭНЕРГОМАСТЕР» → конкретный прицеп 86122В и VIN X9H86122BB0000048."
 ],{grade:"A"}));
 input.direct_buyers.push(make("k239","ООО «МП»",[
   "Договор №30205964: полуприцеп для раздачи кормов тракторный ПРКТ-10-02."
 ],{grade:"A",segment:"корма и сельское хозяйство"}));
 const {result,report}=run(input);
 assert.equal(result.direct_buyers.some(x=>x.__canonical_id==="k529"),false);
 assert.equal(result.direct_buyers.some(x=>x.__canonical_id==="k252"),false);
 assert.equal(result.direct_buyers.some(x=>x.__canonical_id==="k239"&&x.__final_grade==="A"),false);
 assert.equal(report.originals_lost,0);
 assert.equal(result.qualification_review.length+result.qualification_excluded.length+
   result.direct_buyers.length,3);
});

test("unresolved shared INN quarantines BOTH legal persons instead of assigning it twice",()=>{
 const input=empty();
 input.direct_buyers.push(make("k1","ООО Первое",[noteA],{grade:"A",inn:"6732114166"}));
 input.direct_buyers.push(make("k2","ООО Другое",[noteA],{grade:"A",inn:"6732114166"}));
 const {result,report}=run(input);
 assert.equal(result.direct_buyers.length,0);
 assert.equal(result.qualification_review.length,2);
 assert.equal(report.shared_inn_conflict_records,2);
 assert.equal(report.originals_lost,0);
 assert.deepEqual(result.qualification_review.map(r=>r["ИНН"]),["6732114166","6732114166"]);
 assert.equal(result.qualification_review[0].__quality_gate.outcome,"REVIEW");
});

test("rejects malformed INN and missing source WITHOUT losing prospective buyers",()=>{
 const input=empty();
 input.direct_buyers.push(make("k3","ООО Доставка",[noteA],{grade:"A",inn:"1111111111",urls:[]}));
 const {result,report}=run(input);
 assert.equal(result.direct_buyers.length,0);
 assert.equal(result.qualification_review.length,1);
 assert.ok(report.flags[0].reasons.includes("invalid_inn_checksum"));
 assert.ok(report.flags[0].reasons.includes("missing_source_url"));
 assert.equal(result.qualification_review[0].__evidence.notes[0],noteA);
 assert.equal(result.qualification_review[0]["Телефон"],"79991234567");
});

test("structured facts are counted only when a real source URL is attached",()=>{
 const input=empty();
 const row=make("k12","ООО Лесная доставка",[
   noteA+" ([Компания](https://example.com/delivery))"
 ],{grade:"A"});
 row.__evidence.facts=[
   {kind:"financial",statement:"выручка 35000000",source_url:"https://example.com/finance"},
   {kind:"logistics",statement:"лесовозы",source_url:""},
   {kind:"legal_identity",value:"6732114166",sources:["https://example.com/ogrn"]}
 ];
 input.direct_buyers.push(row);
 const {result,report}=run(input);
 assert.equal(report.inline_note_citations,1);
 assert.equal(report.already_structured_source_facts,2);
 assert.equal(result.direct_buyers[0].__evidence.facts.length,3);
 assert.equal(result.direct_buyers[0].__evidence.inline_note_provenance[0].automatic_qualification_proof,false);
});

test("review and excluded queues survive finalization and are visible in Excel",()=>{
 const input=empty();
 input.direct_buyers.push(make("k41","ООО Грузовик",[noteA],{grade:"A"}));
 const review=make("k42","ООО Требуется проверка",[
   "Вакансия водителя категории Е без упоминания конкретного прицепа."
 ],{grade:""});
 review.__decision="manual_review";
 input.qualification_review.push(review);
 input.qualification_excluded.push(make("k43","Журнал отрасли",[
   "Справочник логистических компаний региона."
 ],{grade:""}));
 const {result,report}=run(input);
 assert.equal(result.qualification_review.length,1);
 assert.equal(result.qualification_excluded.length,1);
 assert.equal(report.original_row_count,3);
 assert.equal(report.originals_lost,0);
 const buffer=buildWorkbookBuffer(result);
 const wb=XLSX.read(buffer,{type:"buffer",cellComments:true});
 assert.deepEqual(wb.SheetNames,[
   "Прямые покупатели","Посредники","Лизинг","Статистика",
   "Статистика по цветам","Легенда","REVIEW","EXCLUDED"
 ]);
 assert.equal(XLSX.utils.sheet_to_json(wb.Sheets.REVIEW).length,1);
 assert.equal(XLSX.utils.sheet_to_json(wb.Sheets.EXCLUDED).length,1);
 const active=XLSX.utils.sheet_to_json(wb.Sheets["Прямые покупатели"]);
 assert.equal(active.length,1);
 assert.ok(wb.Sheets["Прямые покупатели"].B2.c);
 assert.equal(result.qualification_review[0]["Телефон"],"79991234567");
});

test("one canonical ID in two sections never results in two active CRM prospects",()=>{
 const input=empty();
 input.direct_buyers.push(make("k22","ООО Дубль",[noteA],{grade:"A"}));
 input.intermediaries.push(make("k22","ООО Дубль",[noteA],{grade:"A"}));
 const {result,report}=run(input);
 assert.equal(result.direct_buyers.length+result.intermediaries.length,0);
 assert.equal(result.qualification_review.length,2);
 assert.equal(report.duplicated_canonical_id_records,2);
 assert.equal(report.originals_lost,0);
});


test("v8 seven CURRENT review + 148 HISTORICAL reviews stay distinct, with two excluded",()=>{
 const input=empty();
 input.direct_buyers.push(make("k479","ООО Зерновая компания",[noteC],{grade:"C"}));
 input.qualification_review=Array.from({length:148},(_,i)=>
   make("historical"+i,"Исторический кандидат "+i,["Нет достаточных сведений."],{grade:""}));
 input.qualification_review_v5_archived=structuredClone(input.qualification_review);
 input.qualification_review_v8=Array.from({length:7},(_,i)=>
   make("review_v8_"+i,"Текущий кандидат "+i,["Нет достаточных сведений."],{grade:""}));
 input.qualification_excluded_v8=Array.from({length:2},(_,i)=>
   make("excluded_v8_"+i,"Информационный канал "+i,["Лишь информационный канал."],{grade:""}));
 const snapshot=structuredClone(input);
 const {result,report}=run(input);
 assert.equal(report.original_row_count,10);
 assert.equal(report.historical_review_records_preserved,148);
 assert.equal(report.current_review_records_at_input,7);
 assert.equal(report.review_records,7);
 assert.equal(report.excluded_records,2);
 assert.equal(report.review_queue_mode,"explicit_replay_current_vs_historical");
 assert.deepEqual(result.qualification_review.map(r=>r.__canonical_id),
   input.qualification_review_v8.map(r=>r.__canonical_id));
 assert.deepEqual(result.qualification_review_v5_archived,
   input.qualification_review_v5_archived);
 assert.equal(result.qualification_excluded.length,2);
 assert.equal(report.originals_lost,0);
 assert.deepEqual(input,snapshot);
 const again=run(result);
 assert.equal(again.report.review_records,7);
 assert.equal(again.report.historical_review_records_preserved,148);
});

test("selected A note cites only its OWN inline URL, never a company-wide first URL",()=>{
 const input=empty();
 input.direct_buyers.push(make("k1","ООО Тягач",[
   "ООО Тягач предлагает доставку грузов ([seller](https://seller.example/any)).",
   noteA+" ([lease contract](https://court.example/contract1))"
 ],{grade:"A",urls:["https://seller.example/any","https://court.example/contract1"]}));
 const {result,report}=run(input);
 assert.equal(report.a_claim_source_linked,1);
 const row=result.direct_buyers[0];
 assert.equal(row.__evidence.selected_a_provenance.source_url,"https://court.example/contract1");
 assert.equal(row.__evidence.selected_a_provenance.method,"exact_same_evidence_note");
 assert.equal(row.__evidence.selected_a_provenance.sources_rechecked,false);
});

test("unattributed A remains A with a visible soft-warning, NEVER borrow a company URL",()=>{
 const input=empty();
 input.direct_buyers.push(make("k1","ООО Тягач",[
   "Сайт организации: https://seller.example/profile; подтверждает только адрес компании.",
   noteA
 ],{grade:"A",urls:["https://seller.example/profile"]}));
 const {result,report}=run(input);
 assert.equal(report.grades.A,1);
 assert.equal(report.review_records,0);
 assert.equal(report.a_claim_source_missing,1);
 assert.equal(report.a_claim_attribution_review.length,1);
 assert.equal(result.direct_buyers[0].__evidence.selected_a_provenance.source_url,"");
 assert.equal(result.direct_buyers[0].__evidence.selected_a_provenance.status,"missing_claim_source");
});

test("two different URLs in the SAME positive note are flagged ambiguous, not assigned arbitrarily",()=>{
 const input=empty();
 input.direct_buyers.push(make("k1","ООО Тягач",[
   noteA+" https://court.example/case1 and https://court.example/case2"
 ],{grade:"A"}));
 const {result,report}=run(input);
 assert.equal(report.a_claim_source_ambiguous,1);
 assert.equal(report.a_claim_source_linked,0);
 assert.equal(result.direct_buyers[0].__evidence.selected_a_provenance.source_url,"");
});

test("A source can be attributed from an EXACT same-claim sourced fact, not a loose keyword match",()=>{
 const input=empty();
 const row=make("k1","ООО Тягач",[noteA],{grade:"A"});
 row.__evidence.facts=[{statement:noteA,source_url:"https://example.org/verified-contract"},
   {statement:"Another trailer transaction",source_url:"https://example.org/unrelated"}];
 input.direct_buyers.push(row);
 const {result,report}=run(input);
 assert.equal(report.a_claim_source_linked,1);
 assert.equal(result.direct_buyers[0].__evidence.selected_a_provenance.source_url,
   "https://example.org/verified-contract");
 assert.equal(result.direct_buyers[0].__evidence.selected_a_provenance.method,
   "matching_structured_fact_statement");
});


test("full legacy v8 with nine exact duplicated current-queue records normalizes 488 to 479 + 7 + 2",()=>{
 const input=empty();
 const company=make("base","ООО Производитель",[noteC],{grade:"C"});
 input.direct_buyers.push(company);
 const review=Array.from({length:7},(_,i)=>make("r"+i,"Текущий "+i,["Требует проверки."],{grade:""}));
 const excluded=Array.from({length:2},(_,i)=>make("x"+i,"Исключённый "+i,["Только информационный источник."],{grade:""}));
 for(const row of review) {row.__replay_v8={status:"REVIEW"};row.__final_qualification_status="REVIEW";}
 for(const row of excluded) {row.__replay_v8={status:"EXCLUDED"};row.__final_qualification_status="EXCLUDED";}
 input.direct_buyers.push(...structuredClone(review),...structuredClone(excluded));
 input.qualification_review_v8=review;
 input.qualification_excluded_v8=excluded;
 input.qualification_review=Array.from({length:148},(_,i)=>
   make("old"+i,"Архив "+i,["Старая проверка."],{grade:""}));
 input.qualification_review_v5_archived=structuredClone(input.qualification_review);
 const before=structuredClone(input);
 const {result,report}=run(input);
 assert.equal(report.input_commercial_array_rows,10);
 assert.equal(report.duplicated_current_queue_rows_collapsed,9);
 assert.equal(report.original_row_count,10);
 assert.equal(report.active_commercial_records,1);
 assert.equal(report.review_records,7);
 assert.equal(report.excluded_records,2);
 assert.equal(report.historical_review_records_preserved,148);
 assert.equal(result.direct_buyers.length,1);
 assert.equal(result.qualification_review_v5_archived.length,148);
 assert.deepEqual(input,before);
 const repeat=run(result);
 assert.equal(repeat.report.duplicated_current_queue_rows_collapsed,0);
 assert.equal(repeat.report.original_row_count,10);
});

test("versioned queue ID with DIFFERENT contact or company cannot be silently collapsed",()=>{
 const input=empty();
 const r=make("duplicate","ООО Проверить",["Требует проверки."],{grade:""});
 r.__replay_v8={status:"REVIEW"};
 input.direct_buyers.push(r);
 input.qualification_review_v8=[{...structuredClone(r),"Телефон":"79990000000"}];
 input.qualification_excluded_v8=[];
 assert.throws(()=>run(input),/conflicting commercial and current queue snapshot/);
});


test("synthetic full-scale 488 records, 492 source IDs, current vs historic queues and A-citation gaps",()=>{
 // This test intentionally contains NO client records or private data:
 // it checks full-volume production mechanics only, not per-company findings.
 const input=empty();
 const row=(i,grade)=>{
   const id="s"+String(i).padStart(6,"0");
   const aProof=i<=20;
   const note=grade==="A"
     ? noteA+(aProof?" ([case](https://official.example/"+id+"))":"")
     : "Компания выращивает зерно и выполняет отгрузку сельхозпродукции.";
   const result=make(id,"ООО «Синтетическая организация "+i+"»",[note],{
      grade,inn:"",urls:["https://official.example/"+id]});
   if(i===1)result.__merged_canonical_ids=[id,"s_absorbed1","s_absorbed2","s_absorbed3","s_absorbed4"];
   return result;
 };
 for(let i=1;i<=479;i++) {
   const grade=i<=64?"A":i<=135?"B":"C";
   input.direct_buyers.push(row(i,grade));
 }
 const currentReview=Array.from({length:7},(_,i)=>{
   const r=row(480+i,"");
   r.__final_grade="";
   r.__replay_v8={status:"REVIEW"};
   r.__final_qualification_status="REVIEW";
   return r;
 });
 const currentExcluded=Array.from({length:2},(_,i)=>{
   const r=row(487+i,"");
   r.__final_grade="";
   r.__replay_v8={status:"EXCLUDED"};
   r.__final_qualification_status="EXCLUDED";
   return r;
 });
 input.direct_buyers.push(...structuredClone(currentReview),...structuredClone(currentExcluded));
 input.qualification_review_v8=currentReview;
 input.qualification_excluded_v8=currentExcluded;
 input.qualification_review=Array.from({length:148},(_,i)=>
   make("history"+i,"Исторический источник "+i,["Только старое исследование."],{grade:""}));
 input.qualification_review_v5_archived=structuredClone(input.qualification_review);
 const {result,report}=finalizeProductionResearch(input,{
   qualify:({row})=>({
     decision:"include",grade:row.__final_grade,
     reason:"Verified synthetic fixture",
     aEvidence:row.__final_grade==="A"?row.__evidence.notes[0]:"",
     aRule:row.__final_grade==="A"?"direct_ownership_or_fleet":""
   }),
   isActionable:()=>false
 });
 assert.equal(report.input_commercial_array_rows,488);
 assert.equal(report.duplicated_current_queue_rows_collapsed,9);
 assert.equal(report.original_row_count,488);
 assert.equal(report.active_commercial_records,479);
 assert.equal(report.review_records,7);
 assert.equal(report.excluded_records,2);
 assert.equal(report.historical_review_records_preserved,148);
 assert.equal(report.source_id_lineage_count,492);
 assert.equal(report.a_claim_source_linked,20);
 assert.equal(report.a_claim_source_missing,44);
 assert.equal(report.a_claim_source_ambiguous,0);
 assert.deepEqual(report.grades,{A:64,B:71,C:344});
 assert.equal(report.originals_lost,0);
 assert.equal(report.openai_calls,0);
 assert.equal(report.web_search_calls,0);
 assert.equal(result.direct_buyers.length,479);
 assert.equal(result.qualification_review_v5_archived.length,148);
});

test("LLC with individual INN is held in REVIEW without rewriting identity",()=>{
 const data=empty();
 const row=make("k_bad","ООО «Плодородие»",[noteA],{grade:"A"});
 row["ИНН"]="673110458304";data.direct_buyers.push(row);
 const {result,report}=run(data);
 assert.equal(result.direct_buyers.length,0);
 assert.equal(result.qualification_review.length,1);
 assert.ok(result.qualification_review[0].__quality_gate.issues.includes("llc_with_individual_inn"));
 assert.equal(result.qualification_review[0]["ИНН"],"673110458304");
 assert.equal(report.originals_lost,0);
});

test("an active merged survivor with a conflicting verified queue INN is quarantined",()=>{
 const input=empty();
 const active=make("k10","ООО «Агро-Форс»",[noteC],{grade:"C"});
 active["ИНН"]="6732114166";
 active.__merged_canonical_ids=["k10","k11"];
 const foreign=make("k11","ООО «Кроношпан»",[noteC],{grade:""});
 foreign["ИНН"]="6732222073";
 input.direct_buyers.push(active);input.qualification_review.push(foreign);
 const {result,report}=run(input);
 assert.equal(result.direct_buyers.length,0);
 assert.equal(result.qualification_review.length,2);
 assert.equal(report.verified_cross_queue_inn_conflict_records,1);
 assert.equal(result.qualification_review.some(r=>r.__canonical_id==="k10" &&
   r.__quality_gate.issues.includes("cross_queue_lineage_inn_conflict")),true);
 assert.equal(report.originals_lost,0);
});

test("quarantined A does not inflate claim-to-source statistics of active A",()=>{
 const input=empty();
 const active=make("k_conflict","ООО «Транспорт»",[noteA+" ([Договор](https://example.org/lease))"],{
  grade:"A",urls:["https://example.org/lease"]
 });
 active["ИНН"]="6732114166";active.__merged_canonical_ids=["k_conflict","k_other"];
 const reviewed=make("k_other","ООО «Другое»",[noteC],{grade:""});
 reviewed["ИНН"]="6732222073";input.direct_buyers.push(active);input.qualification_review.push(reviewed);
 const {result,report}=run(input);
 assert.equal(result.direct_buyers.length,0);
 assert.equal(report.grades.A,0);
 assert.equal(report.a_claim_source_linked,0);
 assert.equal(report.a_claim_source_missing,0);
 assert.equal(report.a_claim_attribution_review.length,0);
});

test("checksum-invalid competing INN under same canonical ID quarantines active lead",()=>{
 const x=empty();
 const main=make("k_same","ООО «СтройАльянс»",[noteC],{grade:"C"});
 const q=make("k_same","ООО «СтройАльянс»",[noteC],{grade:""});
 main["ИНН"]="6732114166";
 q["ИНН"]="6732197636"; // source states numeric, checksum invalid
 x.direct_buyers.push(main); x.qualification_review.push(q);
 const {result,report}=run(x);
 assert.equal(result.direct_buyers.length,0);
 assert.equal(result.qualification_review.length,2);
 assert.equal(report.unverified_cross_queue_inn_conflict_records,1);
 assert.equal(report.output_canonical_id_collision_groups,1);
 assert.ok(result.qualification_review.some(r=>r.__quality_gate?.issues?.includes(
  "cross_queue_canonical_invalid_inn_collision")));
 assert.equal(report.originals_lost,0);
});
test("queue-only canonical ID collision is reported without destroying either source record",()=>{
 const x=empty();
 const q=make("k_same","ООО «Континент»",[noteC],{grade:""});
 const e=structuredClone(q);
 q["ИНН"]="6732114166";e["ИНН"]="6732114166";
 x.qualification_review.push(q);x.qualification_excluded.push(e);
 const {result,report}=run(x);
 assert.equal(report.output_canonical_id_collision_groups,1);
 assert.equal(report.output_canonical_id_collisions[0].records.length,2);
 assert.equal(result.qualification_review.length,1);
 assert.equal(result.qualification_excluded.length,1);
});

test("final gate holds A when selected claim explicitly denies trailer evidence", () => {
  const input=empty();
  const claim="Это прямое подтверждение отраслевого процесса и площадки, но источник не фиксирует конкретные автомобильные перевозки, тягачи или прицепную технику.";
  input.direct_buyers.push(make("k-neg-a","ООО «Кубаньмасло»",[claim],{
    grade:"A",inn:"7113021283",segment:"Рапсовое масло; производство и отгрузка растительного сырья"
  }));
  const {result,report}=finalizeProductionResearch(input,{
    qualify:()=>({decision:"include",grade:"A",aEvidence:claim,aRule:"direct_operation",
      reason:"auto classifier selected weak positive claim"}),
    isActionable:()=>true
  });
  assert.equal(result.direct_buyers.length,0);
  assert.equal(result.qualification_review.length,1);
  assert.ok(report.flags[0].reasons.includes("A_selected_claim_explicitly_disclaims_trailer_evidence"));
  assert.equal(result.qualification_review[0]["ИНН"],"7113021283");
});

test("final gate does not hold A for a direct sourced trailer-fleet claim", () => {
  const input=empty();
  const claim="Официальный сайт подтверждает, что компания эксплуатирует собственный парк тягачей и полуприцепов Schmitz.";
  input.direct_buyers.push(make("k-pos-a","ООО «Перевозчик»",[claim],{
    grade:"A",inn:"6732114166",segment:"Собственный парк полуприцепов"
  }));
  const {result}=finalizeProductionResearch(input,{
    qualify:()=>({decision:"include",grade:"A",aEvidence:claim,aRule:"direct_ownership_or_fleet",
      reason:"confirmed own fleet"}),
    isActionable:()=>true
  });
  assert.equal(result.direct_buyers.length,1);
  assert.equal(result.qualification_review.length,0);
});

test("regional job category page cannot substantiate a grade A legal entity", () => {
  const input=empty();
  const note="Вакансия работодателя категории CE с полуприцепом. ([Источник](https://smolensk.hh.ru/vacancies/voditel_kategorii_e))";
  input.direct_buyers.push(make("k-gen-hh","ООО Региональный перевозчик",[note],{grade:"A"}));
  const {result,report}=finalizeProductionResearch(input,{
    qualify:()=>({decision:"include",grade:"A",aEvidence:note,
      aRule:"direct_driver_operation",reason:"specific driver claim"}),
    isActionable:()=>true
  });
  assert.equal(result.direct_buyers.length,0);
  assert.equal(result.qualification_review.length,1);
  assert.ok(report.flags[0].reasons.includes("A_claim_cites_generic_discovery_page"));
});

test("specific vacancy and entity site remain valid grade A links", () => {
  const sources=[
    "https://smolensk.hh.ru/vacancy/123456789",
    "https://carrier.example.org/own-trailer-fleet"
  ];
  for(const [i,source] of sources.entries()){
    const input=empty();
    const note="Собственная эксплуатация полуприцепа и тягача. ([Источник]("+source+"))";
    input.direct_buyers.push(make("k-good-"+i,"ООО Проверенный перевозчик",[note],{grade:"A"}));
    const {result}=finalizeProductionResearch(input,{
      qualify:()=>({decision:"include",grade:"A",aEvidence:note,
        aRule:"direct_ownership_or_fleet",reason:"direct fleet note"}),
      isActionable:()=>true
    });
    assert.equal(result.direct_buyers.length,1);
    assert.equal(result.qualification_review.length,0);
  }
});

test("regional procurement listings and all-region dump truck directories are discovery, not A", () => {
  for(const url of [
    "https://www.b2b-center.ru/search/smolenskaya-oblast/polupricepy/",
    "https://samosval.info/doska-obyavleniy/trebuyutsya-samosvaly-i-tonary/smolenskaya-oblast/"
  ]) {
    const input=empty(),note="Эксплуатация собственного парка полуприцепов. ([Источник]("+url+"))";
    input.direct_buyers.push(make("k-generic","ООО Перевозчик",[note],{grade:"A"}));
    const {result}=finalizeProductionResearch(input,{
      qualify:()=>({decision:"include",grade:"A",aEvidence:note,
        aRule:"direct_ownership_or_fleet",reason:"sourced"}),
      isActionable:()=>true
    });
    assert.equal(result.direct_buyers.length,0);
    assert.equal(result.qualification_review.length,1);
  }
});

test("2026-11-04 Smolensk negative-A or hypothetical selected claim enters REVIEW", () => {
  const claims = [
    "Тип транспорта указан как «одиночка»; подтверждения собственного парка или полуприцепов нет.",
    "КДМ и дорожные работы относятся к тяжёлой автомобильной эксплуатации и могут формировать потребность в специализированной прицепной технике.",
    "Подтверждения закупки, лизинга, ремонта или эксплуатации конкретных полуприцепов в найденных материалах нет.",
    "Требование категории СЕ и работа на грузовом транспорте являются сильными сигналами потребности в тягачах и полуприцепах.",
    "Указаны лицензии Росприроднадзора, однако конкретный парк или прицепная техника в источнике не приведены.",
    "Релевантный карьерный парк подтверждён, но прицепная техника САТ непосредственно не зафиксирована.",
    "Завершённое внедрение телематики является точкой выхода на закупку/обновление грузовой и прицепной техники.",
    "Пеллеты пригодны для перевозки в биг-бэгах; подтверждения собственного парка или конкретного полуприцепа в источнике нет.",
    "Источник подтверждает организацию, но не содержит достаточной детализации по собственному автопарку или прицепной технике."
  ];
  for (const [index, claim] of claims.entries()) {
    const input = empty();
    input.direct_buyers.push(make("k-live-negative-" + index, "ООО «Кандидат»", [claim], {
      grade: "A", inn: "6732114166", phone: "79991234567"
    }));
    const {result, report} = finalizeProductionResearch(input, {
      qualify: () => ({decision: "include", grade: "A", aEvidence: claim,
        aRule: "direct_ownership_or_fleet", reason: "injected preliminary A"}),
      isActionable: () => true
    });
    assert.equal(result.direct_buyers.length, 0, claim);
    assert.equal(result.qualification_review.length, 1, claim);
    assert.equal(result.qualification_review[0]["ИНН"], "6732114166");
    assert.equal(result.qualification_review[0]["Телефон"], "79991234567");
    assert.ok(report.flags[0].reasons.includes(
      "A_selected_claim_explicitly_disclaims_trailer_evidence"), claim);
  }
});

test("positive ownership A survives only a missing-specific-model caveat", () => {
  const claim = "Компания эксплуатирует собственный парк полуприцепов Krone, но точная модель полуприцепа не указана.";
  const input = empty();
  input.direct_buyers.push(make("k-live-positive", "ООО «Перевозчик»", [claim], {
    grade: "A", inn: "6732114166"
  }));
  const {result} = finalizeProductionResearch(input, {
    qualify: () => ({decision: "include", grade: "A", aEvidence: claim,
      aRule: "direct_ownership_or_fleet", reason: "confirmed own fleet"}),
    isActionable: () => true
  });
  assert.equal(result.direct_buyers.length, 1);
  assert.equal(result.qualification_review.length, 0);
});
