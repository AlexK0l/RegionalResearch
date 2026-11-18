import test from "node:test";
import assert from "node:assert/strict";
import {
  stage13CommercialRole, finalizeStage13CommercialOutput
} from "../src/priorityStage13Finalize.js";

function company(name,evidence="",extra={}){
  return {
    "Организация":name,"ИНН":"",
    "Электронная почта":"","Основание":"A — сохранённый договор лизинга",
    "__a_evidence":evidence,
    "__evidence":{source_urls:["https://example.org/court"],notes:[]},
    ...extra
  };
}
const cases=[
  ["ООО «Интерлизинг»",
    "A — ООО «Интерлизинг» выступало лизингодателем по договору передачи полуприцепа."],
  ["ООО «КОНТРОЛ ЛИЗИНГ»",
    "A — ООО «КОНТРОЛ ЛИЗИНГ» прямо указано лизингодателем по договору полуприцепа."],
  ["ООО «ЛИЗИНГОВОЕ АГЕНТСТВО»",
    "A — ООО «ЛИЗИНГОВОЕ АГЕНТСТВО» прямо указано лизингодателем полуприцепа."],
  ["ООО «ЛК АЛ» / группа «Альфа-Лизинг»",
    "A — ООО «ЛК АЛ» выступало лизингодателем по договору полуприцепа."]
];

test("four independently attributed saved lessors move to leasing",()=>{
  const direct=cases.map(([name,evidence])=>company(name,evidence));
  const keep=company("ООО «Региональфа»",
    "A — ООО «Региональфа» выступало лизингополучателем. "+
    "ООО «Интерлизинг» выступало лизингодателем.");
  const result={direct_buyers:[...direct,keep],intermediaries:[],leasing:[]};
  for(const row of direct)
    assert.equal(stage13CommercialRole(row)?.channel,"leasing",row["Организация"]);
  assert.equal(stage13CommercialRole(keep),null);
  const outcome=finalizeStage13CommercialOutput(result);
  assert.equal(outcome.roles.moved_count,4);
  assert.equal(outcome.roles.deduplicated_count,0);
  assert.equal(result.direct_buyers.length,1);
  assert.equal(result.leasing.length,4);
  assert.deepEqual(result.leasing.map(x=>x["Организация"]),
    cases.map(x=>x[0]));
  assert.deepEqual(result.leasing[0].__evidence.source_urls,["https://example.org/court"]);
  assert.equal(finalizeStage13CommercialOutput(result).roles.moved_count,0);
});

test("leasing brand name without row-bound evidence cannot move automatically",()=>{
  assert.equal(stage13CommercialRole(company("АО «Сбербанк Лизинг»")),null);
  assert.equal(stage13CommercialRole(company("ООО «Ленобллизинг»")),null);
  const row=company("ООО «Транспорт Сервис»",
    "A — ООО «Транспорт Сервис» является лизингополучателем. "+
    "ООО «Контрагент» выступало лизингодателем.");
  assert.equal(stage13CommercialRole(row),null);
  const other=company("ООО «Контрагент»",
    "A — ООО «Транспорт Сервис» является лизингополучателем. "+
    "ООО «Контрагент» выступало лизингодателем.");
  assert.equal(stage13CommercialRole(other)?.channel,"leasing");
});
