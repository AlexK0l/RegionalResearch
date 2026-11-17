import test from "node:test";
import assert from "node:assert/strict";
import {CATALOG,BANDS,calculatePriority13,applyPriorityStage13,EXPLANATION_FIELD}
  from "../src/priorityStage13.js";

const empty={c:"",d:"",revenue:"",staff:""};
const calc=fields=>calculatePriority13({...empty,...fields});
test("catalog has precisely 33 green and 24 white manufacturer/model pairs",()=>{
  assert.equal(CATALOG.length,57);
  assert.equal(CATALOG.filter(x=>x.tier==="green").length,33);
  assert.equal(CATALOG.filter(x=>x.tier==="white").length,24);
  assert.equal(new Set(CATALOG.map(x=>x.brand+"|"+x.model)).size,57);
  assert.deepEqual(BANDS,{none:[0,19],ordinary:[20,39],white:[40,69],green:[70,100]});
});
test("testPriorityLogic: exact catalog pairs, both body groups, and no partial matching",()=>{
  const cases=[
    ["green tipper","ТОНАР 959500 (2021 г.) — 2 шт.","green"],
    ["green heavy trailer","АЛСА 948412 (2021 г.) — 1 шт.","green"],
    ["green livestock","ТОНАР 982620 (2024 г.) — 1 шт.","green"],
    ["green walking floor","KNAPEN K100 — 1 шт.","green"],
    ["white curtain trailer","KRONE SD (2007 г.) — 1 шт.","white"],
    ["white MAZ subtype","МАЗ 975800-2012 (2020 г.) — 1 шт.","white"],
    ["white Schmitz star","SCHMITZ SCB*S3B (2020 г.) — 1 шт.","white"],
    ["unknown MAZ subtype","МАЗ 975800-999 (2020 г.) — 1 шт.","none"],
    ["unknown Bonum subtype","BONUM 914295-02 (2023 г.) — 2 шт.","none"],
    ["not a trailer","KAMAZ 5320 — 1 шт.","none"]
  ];
  for(const [label,line,tier] of cases){
    assert.equal(calc({c:"TORGBOX: "+line}).tier,tier,label);
  }
  assert.equal(calc({c:"ТОНАР 959500 — 0 шт."}).tier,"none");
  assert.equal(calc({c:"полуприцеп без обозначения модели — 2 шт."}).tier,"ordinary");
  assert.equal(calc({c:"Saby (грузовые): KRONE SD (2010 г.) — 2 шт."}).tier,"none");
  assert.equal(calc({c:"TORGBOX: KRONE SD — 2 шт.; Saby (грузовые): KAMAZ 5490 — 4 шт."}).tier,"white");
  assert.equal(calc({c:"Saby (грузовые): KAMAZ 5490 — 4 шт.; MAZ 5551 — 1 шт."}).warnings.length,0);
});
test("basis D matches only actual evidence and does not parse the segment suffix",()=>{
  assert.equal(calc({d:"В реестровых данных зафиксирован WIELTON NW-3 в залоге"}).tier,"green");
  assert.equal(calc({d:"Подтверждена эксплуатация полуприцепа"}).tier,"ordinary");
  assert.equal(calc({d:"Собственный полуприцеп не подтверждён"}).tier,"none");
  assert.equal(calc({d:"Зерновые; сегмент: ТОНАР 959500 полуприцеп"}).tier,"none");
  assert.equal(calc({d:"Самосвальный грузовик КАМАЗ"}).tier,"none");
  assert.equal(calc({d:"Договор на полуприцеп завершён"}).tier,"none");
});
test("strict priority bands cannot cross regardless of revenue/staff/tractor",()=>{
  const highest={revenue:"3 млрд",staff:300};
  assert.ok(calc({c:"ТОНАР 959500 — 1 шт."}).score>
    calc({...highest,c:"KRONE SD — 6 шт.\nседельный тягач — 1 шт."}).score);
  assert.ok(calc({c:"KRONE SD — 1 шт."}).score>
    calc({...highest,c:"полуприцеп — 6 шт.\nседельный тягач — 1 шт."}).score);
  assert.ok(calc({c:"полуприцеп — 1 шт."}).score>
    calc({...highest,c:"седельный тягач — 1 шт."}).score);
  for(const [tier,band] of Object.entries(BANDS)){
    for(const result of [
      calc({c:tier==="green"?"ТОНАР 959500":tier==="white"?"KRONE SD":
        tier==="ordinary"?"полуприцеп":"КАМАЗ",...highest}),
      calc({c:tier==="green"?"ТОНАР 959500":tier==="white"?"KRONE SD":
        tier==="ordinary"?"полуприцеп":"КАМАЗ"})
    ]){
      assert.equal(result.tier,tier);
      assert.ok(result.score>=band[0]&&result.score<=band[1]);
    }
  }
});
test("no double count from C and D, exact revenue thresholds and staff",()=>{
  const v=calc({c:"ТОНАР 959500 — 2 шт.",
    d:"Подтверждены 2 самосвальных полуприцепа",revenue:300000000,staff:51});
  assert.match(v.explanation,/минимум полуприцепов без двойного учёта C\/D\/источников: 2/);
  assert.match(v.explanation,/выручка Q: .* = 12\/20/);
  assert.match(v.explanation,/сотрудники V: 51 чел. = 6\/10/);
  assert.equal(v.score,70+Math.round(30*(12+6+4)/60));
});
test("stage13 changes only buyer final coefficient and virtual AK, idempotently",()=>{
  const base={direct_buyers:[{
    "Организация":"ООО Эксплуатация",
    "Наличие транспорта":"ТОНАР 959500 — 2 шт.",
    "Основание":"A — эксплуатация прицепной техники",
    "Расчётный коэффициент":17,
    "Телефон":"79991234567",
    "Выручка последнего подтвержденного года":330000000,
    "Численность":130,
    "__final_grade":"A",
    "__comment":"Evidence"
  }],intermediaries:[{"Организация":"Посредник"}],
  leasing:[{"Организация":"Лизинг"}],statistics:[{"Показатель":"Население"}]};
  const before=structuredClone(base);
  const first=applyPriorityStage13(base);
  assert.equal(first.processed,1);
  assert.equal(first.changed,1);
  assert.equal(first.tiers.green,1);
  assert.ok(base.direct_buyers[0]["Итоговый коэффициент"]>=70);
  assert.match(base.direct_buyers[0][EXPLANATION_FIELD],/КАТЕГОРИЯ: ЗЕЛЁНЫЙ СПИСОК/);
  for(const [key,value] of Object.entries(before.direct_buyers[0]))
    assert.deepEqual(base.direct_buyers[0][key],value,"original "+key+" unchanged");
  assert.deepEqual(base.intermediaries,before.intermediaries);
  assert.deepEqual(base.leasing,before.leasing);
  assert.deepEqual(base.statistics,before.statistics);
  assert.equal(applyPriorityStage13(base).changed,0);
});

test("generic quality A statement is NOT independent evidence of a semi-trailer",()=>{
  const generic="A — Конкретный evidence-note одновременно подтверждает прицепную/полуприцепную технику и факт сделки, владения, эксплуатации, ремонта или лизинга.";
  const none=calc({d:generic,notes:["Подтверждена покупка трактора Беларус 1221.3. https://example.org/doc"]});
  assert.equal(none.tier,"none");
  assert.match(none.explanation,/только обобщённую оценку A/);
  const ordinary=calc({d:generic,notes:["A — документ подтверждает аренду полуприцепа и тягача. https://example.org/doc"]});
  assert.equal(ordinary.tier,"ordinary");
  assert.equal(ordinary.warnings.length,0);
});
test("exact sourced model matches in evidence notes, including known brand and spelling aliases",()=>{
  const generic="A — Конкретный evidence-note одновременно подтверждает прицепную/полуприцепную технику и факт сделки, владения, эксплуатации, ремонта или лизинга.";
  for(const [note,tier,name] of [
    ["В судебном акте подтверждено, что фирме принадлежит полуприцеп Schmitz Cargobull 9084. https://example.org/decision","white","SCHMITZ 9084"],
    ["Компания эксплуатирует полуприцеп Schmitz SKO24. https://example.org/lease","white","SCHMITZ SKO24"],
    ["Компания в лизинге приобрела полуприцеп Schmitz Cargobull SKO 24/L. https://example.org/lease","white","SCHMITZ SKO24"],
    ["Судебным актом подтверждена аренда полуприцепа KRONE SD. https://example.org/lease","white","KRONE SD"],
    ["В реестре зарегистрирован GRUNWALD 9453-0000010-50 в собственности компании. https://example.org/registry","green","GRUNWALD 9453-0000010-50"]
  ]){
    const res=calc({d:generic,notes:[note]});
    assert.equal(res.tier,tier,note);
    assert.match(res.models,new RegExp(name.replace(/[.*+?^$()|[\]{}]/g,"\\$&")));
  }
});
test("bare brand, partial model, speculative source, missing provenance and expired deal cannot promote group",()=>{
  const generic="A — Конкретный evidence-note одновременно подтверждает прицепную/полуприцепную технику и факт сделки, владения, эксплуатации, ремонта или лизинга.";
  for(const note of [
    "Ожидается, что KRONE SD пригодится для перевозок. https://example.org/forecast",
    "Подтверждён договор аренды полуприцепа BONUM 914295-02. https://example.org/lease",
    "В реестре зарегистрирована модель KRONE SDP27. https://example.org/doc",
    "Подтверждено наличие GRUNWALD 9453-0000010-50", // no same-note URL
    "В договоре аренды полуприцепа KRONE SD завершён срок. https://example.org/old",
    "Полуприцеп KRONE SD не подтверждён регистрационными сведениями. https://example.org/registry"
  ]){
    assert.equal(calc({d:generic,notes:[note]}).tier,"none",note);
  }
  assert.equal(calc({d:generic,notes:["В 2026 году приобретён полуприцеп GRUNWALD 9453-0000010-50. https://example.org/lease"]}).tier,"green");
  assert.equal(calc({d:generic,notes:["В 2026 году приобретён полуприцеп 9453-0000010-50. https://example.org/lease"]}).tier,"ordinary",
    "trailer without manufacturer must not enter green group");
});
test("evidence is not double counted and never alters existing buyer fields",()=>{
  const row={"Организация":"Sample",
    "Основание":"A — Конкретный evidence-note одновременно подтверждает прицепную/полуприцепную технику и факт сделки, владения, эксплуатации, ремонта или лизинга.",
    "__evidence":{notes:[
      "В лизинге находится полуприцеп KRONE SD. https://example.org/source",
      "В лизинге находится полуприцеп KRONE SD. https://example.org/source"
    ]},
    "Наличие транспорта":"Saby (грузовые): KAMAZ 5490 — 7 шт.",
    "Выручка последнего подтвержденного года":100000000,
    "Численность":12,"Телефон":"79991112233"};
  const input={direct_buyers:[row],intermediaries:[],leasing:[],statistics:[]};
  const original=structuredClone(row);
  const report=applyPriorityStage13(input);
  assert.equal(report.tiers.white,1);
  assert.equal(report.warnings,0);
  assert.equal(report.version,2);
  assert.match(row[EXPLANATION_FIELD],/источников: 1/);
  assert.equal(row["Телефон"],original["Телефон"]);
  assert.deepEqual(row.__evidence,original.__evidence);
  assert.equal(applyPriorityStage13(input).changed,0);
});
