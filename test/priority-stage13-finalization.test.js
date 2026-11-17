import test from "node:test";
import assert from "node:assert/strict";
import {
  priority13AICandidates,priority13InputHash,applyPriorityStage13
} from "../src/priorityStage13.js";
import {extractStage13ModelInventory} from "../src/priorityStage13Inventory.js";
import {
  stage13CommercialRole,stage13RouteCommercialRoles,
  stage13PopulateExplicitEmails,finalizeStage13CommercialOutput
} from "../src/priorityStage13Finalize.js";

function row(name,a="",notes=[],fields={}){
  return {"Организация":name,"Итоговый коэффициент":0,
    "Основание":"A — Конкретный evidence-note одновременно подтверждает прицепную/полуприцепную технику и факт сделки, владения, эксплуатации, ремонта или лизинга.",
    "__a_evidence":a,__evidence:{notes,source_urls:[]},...fields};
}
function sample(){
  return {direct_buyers:[
    row("ООО «АБСОЛЮТ ЛИЗИНГ»",
      "A — ООО «АБСОЛЮТ ЛИЗИНГ» указано лизингодателем по договору на V-TRAILER VTPP31. (https://xfirm.ru/company/6732243122)",[
        "Источник прямо разделяет роли: ООО «АБСОЛЮТ ЛИЗИНГ» — лизингодатель, ООО «ТМГ ИНДУСТРИЯ» — лизингополучатель."
      ]),
    row("ООО «ВВС ЛИЗИНГ»",
      "A — ООО «ВВС ЛИЗИНГ» указано лизингодателем по действующим договорам ООО «ВОЯЖ». (https://xfirm.ru/company/6713013363)"),
    row("ООО «КАРКАДЕ»",
      "A — ООО «КАРКАДЕ» проводит торги по реализации полуприцепа ТОНАР 9989.",[
        "Роль: лизингодатель/реализатор возвратной техники; не конечный эксплуатант груза."
      ]),
    row("ПАО «Лизинговая компания «Европлан»",
      "A — ПАО «Лизинговая компания «Европлан» указано лизингодателем по договору с ООО «АКВАЛЬ». (https://xfirm.ru/company/6726019443)"),
    row("ООО «АгроТехЛизинг»","",[
      "Роль классифицирована как intermediaries: найдено предложение техники, но не подтверждена собственная эксплуатация."
    ]),
    row("ООО «ТМГ ИНДУСТРИЯ»",
      "A — ООО «ТМГ ИНДУСТРИЯ» указано лизингополучателем по договору с ООО «АБСОЛЮТ ЛИЗИНГ» на полуприцеп. (https://xfirm.ru/company/6732243122)"),
    row("ООО «Вилия»",
      "A — ООО «Вилия» приобрело полуприцеп по договору лизинга у Европлана."),
    row("ООО «АгроЛизингЛес»","",[
      "В договоре АО «ДРУГОЕ» названо лизингодателем, наша фирма лизингополучатель."
    ])
  ],intermediaries:[row("ООО «Уже посредник»")],
    leasing:[row("ООО «А-ЛИЗИНГ»")],statistics:[{"Показатель":"Всего"}]};
}
test("four clearly identified lessors move to Leasing, explicit intermediary moves to Intermediaries",()=>{
  const data=sample(),original=structuredClone(data);
  const result=stage13RouteCommercialRoles(data);
  assert.equal(result.moved_count,5);
  assert.deepEqual(result.final,{direct_buyers:3,intermediaries:2,leasing:5});
  assert.equal(result.preserved_count,original.direct_buyers.length+
    original.intermediaries.length+original.leasing.length);
  assert.deepEqual(result.moved.map(x=>x.to),
    ["leasing","leasing","leasing","leasing","intermediaries"]);
  assert.ok(data.direct_buyers.some(x=>x["Организация"]==="ООО «ТМГ ИНДУСТРИЯ»"));
  assert.ok(data.direct_buyers.some(x=>x["Организация"]==="ООО «Вилия»"));
  assert.ok(data.direct_buyers.some(x=>x["Организация"]==="ООО «АгроЛизингЛес»"));
  assert.equal(stage13RouteCommercialRoles(data).moved_count,0);
});
test("lessor named in OTHER company's evidence never moves the lessee",()=>{
  assert.equal(stage13CommercialRole(row("ООО «ТМГ ИНДУСТРИЯ»",
    "A — ООО «АБСОЛЮТ ЛИЗИНГ» — лизингодатель, ТМГ — лизингополучатель.")),null);
  assert.equal(stage13CommercialRole(row("ООО «АгроЛизингЛес»",
    "A — ООО «ДРУГОЕ» указано лизингодателем.")),null);
});
test("existing leasing entry is deduplicated by exact INN and evidence survives",()=>{
  const data={direct_buyers:[
    row("ООО «АБСОЛЮТ ЛИЗИНГ»",
      "ООО «АБСОЛЮТ ЛИЗИНГ» указано лизингодателем.",
      ["Документ о лизинге."],{"ИНН":"1234567890"})
  ],leasing:[
    row("ООО «АБСОЛЮТ ЛИЗИНГ»","",["Карточка реквизитов."],{"ИНН":"1234567890"})
  ],intermediaries:[]};
  const result=stage13RouteCommercialRoles(data);
  assert.equal(data.leasing.length,1);
  assert.equal(data.direct_buyers.length,0);
  assert.equal(result.deduplicated_count,1);
  assert.equal(data.leasing[0].__evidence.notes.length,2);
});
test("legacy company-site note recovers only exact same-company domain",()=>{
  const name="ООО «Трансснип»";
  const note="Сайт организации: парк транспортных средств включает шторные полуприцепы Schmitz SCS и полуприцепы Schmitz SCO 24; адрес — г. Смоленск.";
  const r=row(name,note,[note],{
    "__evidence":{notes:[note],source_urls:[
      "https://www.transsnip.ru/","https://www.tks.ru/db/carrier/1522/",
      "https://profile.saby.ru/page/contractor-info?id=1"
    ]}
  });
  const got=priority13AICandidates(r);
  assert.deepEqual(got.map(x=>x.model_text),["Schmitz SCS","Schmitz SCO 24"]);
  assert.ok(got.every(x=>x.evidence_eligible));
  assert.ok(got.every(x=>x.source_attribution==="company_site_domain_correlated"));
  assert.ok(got.every(x=>x.source_url==="https://www.transsnip.ru/"));
  assert.ok(got.every(x=>x.source_status==="company_website_correlated_not_live_verified"));
});
test("saved OpenAI type results for Transsnip become usable without another API call",()=>{
  const note="Сайт организации: парк транспортных средств включает шторные полуприцепы Schmitz SCS и полуприцепы Schmitz SCO 24.";
  const r=row("ООО «Трансснип»",note,[note],{
    "__evidence":{notes:[note],source_urls:["https://www.transsnip.ru/"]}
  });
  const fingerprint=priority13InputHash(r);
  r.__priority13_ai={version:1,input_hash:fingerprint,results:[
    {source:"evidence",index:0,model_text:"Schmitz SCS",
      kind:"semi_trailer",confidence:"high",model_quote:"Schmitz SCS"},
    {source:"evidence",index:0,model_text:"Schmitz SCO 24",
      kind:"semi_trailer",confidence:"high",model_quote:"Schmitz SCO 24"}
  ]};
  const before=structuredClone(r),result={direct_buyers:[r]};
  const score=applyPriorityStage13(result);
  assert.equal(score.openai_calls,0);
  assert.equal(score.tiers.ordinary,1);
  assert.ok(r["Итоговый коэффициент"]>=20&&r["Итоговый коэффициент"]<=39);
  assert.equal(priority13InputHash(r),fingerprint);
  assert.deepEqual(before.__evidence,r.__evidence);
});
test("unrelated URLs and company names never establish ownership of a model",()=>{
  const note="Сайт организации: парк транспортных средств включает полуприцеп Schmitz SCS.";
  const fake=row("ООО «Трансснип»",note,[note],{
    "__evidence":{notes:[note],source_urls:[
      "https://www.other-company.ru/","https://www.tks.ru/"]}
  });
  assert.equal(priority13AICandidates(fake)[0].evidence_eligible,false);
  const unlabeled=row("ООО «Трансснип»",
    "Schmitz SCS приобретён организацией",[
      "Schmitz SCS приобретён организацией"],{
      "__evidence":{notes:["Schmitz SCS приобретён организацией"],
        source_urls:["https://www.transsnip.ru/"]}
    });
  assert.equal(priority13AICandidates(unlabeled)[0].evidence_eligible,false);
});
test("explicit email field is present in all three sections without guessing",()=>{
  const d={direct_buyers:[
    row("ООО Раз",null,[],{__comment:"Email: SALES@CORP.RU\nPhone: 79991234567"}),
    row("ООО Два",null,[],{"ИНН":"1234567890",
      "__evidence":{notes:[],email:"contact@corp.ru"}})
  ],leasing:[row("ООО Три",null,[],{})],intermediaries:[row("ООО Четыре",null,[],{
    "Электронная почта":"a@firm.ru"
  })]};
  const s=stage13PopulateExplicitEmails(d);
  assert.equal(s.total,4);assert.equal(s.filled,3);assert.equal(s.created,3);
  assert.equal(d.direct_buyers[0]["Электронная почта"],"sales@corp.ru");
  assert.equal(d.direct_buyers[1]["Электронная почта"],"contact@corp.ru");
  assert.equal(d.leasing[0]["Электронная почта"],"");
  assert.equal(d.intermediaries[0]["Электронная почта"],"a@firm.ru");
});
test("commercial postprocessing never drops rows or changes scoring, phone or documents",()=>{
  const d=sample(),before=structuredClone(d);
  const r=finalizeStage13CommercialOutput(d);
  assert.equal(r.paid_calls,0);
  assert.equal(r.saby_calls,0);
  assert.equal(d.direct_buyers.length,3);
  const totals=Object.values(r.roles.final).reduce((a,b)=>a+b,0);
  assert.equal(totals,10);
  const original=before.direct_buyers.find(x=>x["Организация"]==="ООО «ТМГ ИНДУСТРИЯ»");
  const after=d.direct_buyers.find(x=>x["Организация"]==="ООО «ТМГ ИНДУСТРИЯ»");
  assert.equal(after["Итоговый коэффициент"],original["Итоговый коэффициент"]);
  assert.deepEqual(after.__evidence,original.__evidence);
});

test("lessee with own name and a different lessor in the SAME selected proof stays a direct buyer",()=>{
  const r=row("ООО «ТМГ ИНДУСТРИЯ»",
    "A — ООО «ТМГ ИНДУСТРИЯ» выступает лизингополучателем по договору, где ООО «АБСОЛЮТ ЛИЗИНГ» указано лизингодателем.");
  assert.equal(stage13CommercialRole(r),null);
});
