import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {decorateCompanyBasisForExport} from "../src/companyBasisNarrative.js";

const generic={
  A:"A — Конкретный evidence-note одновременно подтверждает прицепную/полуприцепную технику и факт сделки, владения, эксплуатации, ремонта или лизинга.",
  B:"B — В evidence одновременно подтверждены целевой груз/процесс и тяжелая автологистика или эксплуатационный сигнал.",
  C:"C — Подтверждён действующий целевой производственный/грузовой процесс коммерческого грузовладельца; собственная техника или перевозчик пока не установлены."
};
function company(grade, extras={}){
  return {
    "Организация":"ООО «Тест»",
    "Основание":generic[grade],
    "ИНН":"7707083893",
    "Наличие транспорта":"",
    "Итоговый коэффициент":32,
    "__final_grade":grade,
    "__comment":"Сайт/источник: https://sample.example/about\n"+
      "ИНН: 7707083893\n"+
      "Деятельность: Перевозка щебня и песка\n"+
      "Холдинг/УК/группа: не подтверждено\nEmail: info@example.org",
    "__evidence":{notes:[],source_urls:["https://sample.example/about"]},
    ...extras
  };
}
const wrap=(rows,intermediaries=[],leasing=[])=>({
  direct_buyers:rows,intermediaries,leasing,statistics:[{Показатель:"Тест",Значение:1}],
  final_quality_gate:{grades:{A:1,B:0,C:0}}
});

test("A: actual purchase of a semitrailer replaces a generic A; source is cited in D note",()=>{
  const src="По договору от 12.06.2025 ООО «Тест» приобрело "+
    "самосвальный полуприцеп ТОНАР 9523 для перевозки щебня. "+
    "Источник: https://zakupki.example/purchase/42";
  const row=company("A",{
    __a_evidence:src,
    __a_rule:"direct_procurement",
    __evidence:{
      notes:[src],source_urls:["https://zakupki.example/purchase/42"],
      inline_note_provenance:[{
        note_index:0,source_url:"https://zakupki.example/purchase/42"
      }]
    }
  });
  const input=wrap([row]),snapshot=structuredClone(input);
  const out=decorateCompanyBasisForExport(input);
  const after=out.direct_buyers[0];
  assert.equal(after.__final_grade,"A");
  assert.match(after["Основание"],/^A — По договору от 12.06.2025/);
  assert.match(after["Основание"],/ТОНАР 9523/);
  assert.doesNotMatch(after["Основание"],/evidence-note|https?:/);
  assert.match(after.__basis_comment,/самосвальный полуприцеп ТОНАР 9523/);
  assert.match(after.__basis_comment,/Источник утверждения: https:\/\/zakupki\.example\/purchase\/42/);
  assert.match(after.__comment,/Краткое основание:/);
  assert.equal(after["Итоговый коэффициент"],32);
  assert.deepEqual(input,snapshot,"source must remain bit-for-bit unchanged");
  assert.deepEqual(decorateCompanyBasisForExport(out),out,"repeat export idempotent");
});

test("B: different companies get different reasons, not the same grade boilerplate",()=>{
  const carrier=company("B",{
    "Организация":"ООО «КарьерТранс»",
    __evidence:{
      notes:[
        "Официальный сайт подтверждает регулярную доставку щебня собственными "+
        "самосвалами с карьера. https://quarry.example/delivery"
      ],
      source_urls:["https://quarry.example/delivery"]
    }
  });
  const wood=company("B",{
    "Организация":"ООО «Щеповоз»",
    __evidence:{
      notes:[
        "Подписан контракт на перевозку древесной щепы и опилок автопоездами "+
        "в 2026 году. https://wood.example/contract"
      ],
      source_urls:["https://wood.example/contract"]
    }
  });
  const out=decorateCompanyBasisForExport(wrap([carrier,wood]));
  assert.match(out.direct_buyers[0]["Основание"],/доставку щебня/);
  assert.match(out.direct_buyers[1]["Основание"],/древесной щепы/);
  assert.notEqual(out.direct_buyers[0]["Основание"],
    out.direct_buyers[1]["Основание"]);
  assert.match(out.direct_buyers[1].__basis_comment,/https:\/\/wood\.example\/contract/);
});

test("C: cargo operations are described without inventing ownership or lease",()=>{
  const row=company("C",{
    __evidence:{
      notes:["На предприятии действует производство комбикормов, "+
        "переработка зерна и отгрузка продукции аграриям. "+
        "https://agro.example/production"],
      source_urls:["https://agro.example/production"]
    }
  });
  const out=decorateCompanyBasisForExport(wrap([row]));
  assert.match(out.direct_buyers[0]["Основание"],/^C — На предприятии действует производство/);
  assert.doesNotMatch(out.direct_buyers[0]["Основание"],/приобрело полуприцеп|собственн.*полуприцеп/);
  assert.match(out.direct_buyers[0].__basis_comment,/Источник утверждения:/);
});

test("missing narrative and source never create a fictitious claim",()=>{
  const row=company("A",{
    __a_evidence:"",
    __comment:"Деятельность: перевозка щебня и песка",
    __evidence:{notes:["identity: ИНН найден","Источник: https://only.example/path"],
      source_urls:["https://only.example/path"]}
  });
  const out=decorateCompanyBasisForExport(wrap([row]));
  assert.equal(out.direct_buyers[0]["Основание"],generic.A);
  assert.match(out.direct_buyers[0].__basis_comment,
    /Индивидуальное подтверждающее утверждение не сохранено/);
  assert.match(out.direct_buyers[0].__basis_comment,
    /точная привязка факта не подтверждена/);
  assert.doesNotMatch(out.direct_buyers[0].__basis_comment,
    /приобрело.*полуприцеп/i);
});

test("already specific descriptions remain unchanged while adding explanation notes",()=>{
  const row=company("C",{
    "Основание":"C — На официальном сайте подтверждена переработка льна в Волхове; свой парк не установлен.",
    __evidence:{notes:[],source_urls:["https://flax.example/about"]}
  });
  const out=decorateCompanyBasisForExport(wrap([],[],[row]));
  assert.equal(out.leasing[0]["Основание"],row["Основание"]);
  assert.match(out.leasing[0].__basis_comment,/переработка льна в Волхове/);
  assert.equal(out.leasing[0].__final_grade,"C");
});

test("exporter attaches basis notes to D/H without changing five-sheet layout or F",()=>{
  const exporter=fs.readFileSync(
    new URL("../scripts/export-reference-xlsx.py",import.meta.url),"utf8");
  const js=fs.readFileSync(
    new URL("../src/referenceWorkbookExport.js",import.meta.url),"utf8");
  assert.match(exporter,/if h=='Основание':/);
  assert.match(exporter,/row\.get\('__basis_comment'\)/);
  assert.match(exporter,/put_note\(ws\.cell\(ri,ci\),basis_note,/);
  assert.match(js,/decorateCompanyBasisForExport\(result \|\| \{\}\)/);
  assert.match(exporter,/SHEETS=\['Прямые покупатели','Лизинг','Посредники','Статистика','Легенда цветов'\]/);
});
