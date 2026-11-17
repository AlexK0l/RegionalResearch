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
    ["green tipper","TONАР 959500 (2021 г.) — 2 шт.","green"],
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
  assert.equal(calc({c:"Saby (грузовые): KRONE SD (2010 г.) — 2 шт."}).tier,"white");
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
  assert.match(v.explanation,/минимум полуприцепов без двойного учёта C\/D: 2/);
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
