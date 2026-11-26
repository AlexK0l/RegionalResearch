import test from "node:test";
import assert from "node:assert/strict";
import {sabyEligibleRows,sabyWorkGaps,sabyFleetCoverage,applySabyEnrichment} from "../src/sabyEnrichment.js";
import {decorateCompanyBasisForExport} from "../src/companyBasisNarrative.js";
const url="https://profile.saby.ru/page/contractor-info?id=12345678-1234-1234-1234-123456789abc";
const row=(inn,name)=>({"ИНН":inn,"Организация":name,"Основание":"B — подтверждено",
  "Телефон":"74951234567","Электронная почта":"office@example.ru",
  "Выручка последнего подтвержденного года":1000000,"Численность":12,
  __comment:"Деятельность: перевозка грузов",__evidence:{notes:[],source_urls:[]}});
const fleet=(r,vehicles)=>applySabyEnrichment(r,{
  source:"SABY",source_url:url,collected_at:"2026-11-26T12:00:00Z",
  identity:{verified:true,inn:r["ИНН"],name:r["Организация"],kpp:"770101001"},
  trucks:{status:"verified",count:vehicles.length,vehicles},contacts:{status:"missing"}
},{transport:true});
test("fleet report distinguishes exact positives, zero, missing, invalid and duplicate rows by sheet",()=>{
  const a=row("7707083893","ООО Альфа"),b=row("7702070139","ООО Бета"),
    c=row("7710140679","ООО Гамма"),d=row("","ООО Без ИНН"),
    dup1=row("7725104641","ООО Дельта"),dup2=row("7725104641","ООО Дельта");
  fleet(a,[{model:"КАМАЗ 5490",year:2020},{model:"КАМАЗ 5490",year:2020}]);
  fleet(b,[]);
  const db={direct_buyers:[a,d],intermediaries:[b,dup1],leasing:[c,dup2]};
  const plan=sabyEligibleRows(db,{includeAll:true,allCompanyFleets:true});
  const gaps=new Map(plan.eligible.map(entry=>[entry,sabyWorkGaps(entry)]));
  const out=sabyFleetCoverage(db,plan,gaps);
  assert.deepEqual({...out,by_sheet:undefined},{target:6,eligible:3,invalid:1,duplicate:2,
    positive:1,zero:1,unknown:4,vehicles:2,by_sheet:undefined});
  assert.equal(out.by_sheet.direct_buyers.positive,1);
  assert.equal(out.by_sheet.intermediaries.zero,1);
  assert.equal(out.by_sheet.leasing.unknown,2);
  // Coverage can reuse the already validated immutable per-visit count.
  assert.deepEqual(sabyFleetCoverage(db,plan),out);
});
test("existing commercial notes expose verified full fleets without workbook schema changes",()=>{
  const a=row("7707083893","ООО Альфа"),b=row("7702070139","ООО Бета"),
    c=row("7710140679","ООО Гамма");
  fleet(a,[{model:"КАМАЗ 5490",year:2020},{model:"КАМАЗ 5490",year:2020}]);
  fleet(b,[]);
  c.__evidence.saby={source_url:url,inn:c["ИНН"],collection:{trucks:"review"},
    trucks:{count:1,vehicles:[{model:"НЕПОДТВЕРЖДЁННЫЙ"}]}};
  const db={direct_buyers:[],intermediaries:[a,c],leasing:[b],statistics:[]};
  const original=structuredClone(db);
  const out=decorateCompanyBasisForExport(db);
  assert.deepEqual(db,original);
  assert.match(out.intermediaries[0].__comment,/Saby: подтверждённый грузовой автопарк — 2 шт\.: КАМАЗ 5490 \(2020 г\.\) — 2 шт\./);
  assert.match(out.leasing[0].__comment,/Saby: подтверждённый грузовой автопарк — 0 шт\./);
  assert.doesNotMatch(out.intermediaries[1].__comment,/подтверждённый грузовой автопарк|НЕПОДТВЕРЖДЁННЫЙ/);
  assert.equal(decorateCompanyBasisForExport(out).intermediaries[0].__comment,out.intermediaries[0].__comment);
  assert.equal(out.intermediaries[0].__evidence.saby.trucks.vehicles.length,2);
});
