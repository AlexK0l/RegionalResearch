import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  SABY_NON_VEHICLE_LABEL_PATTERN,isSabyTruckVehicleLabel
} from "../src/sabyVehicleLabels.js";
import {appendSabyTruckWindow} from "../src/sabyFleetWindows.js";
import {safeSabyFleetTailBatchReport}
  from "../src/sabyFleetTailBatches.js";

test("Saby truck model labels may have an unknown year, distinct VIN and GRZ are NOT vehicles",()=>{
  const vehicles=[
    "КАМАЗ K3340, 2025",
    "КАМАЗ K3340, 2025",
    "КАМАЗ K3456",
    "КРАЗ 6437, 2008",
    "МАЗ 5340, 2013",
    "НЕФАЗ 4208-11-13, 2009",
    "SANY SYG5450THB 56C 10, 2024",
    "SCANIA P, 2020",
    "MAN TGS",
    "ГАЗ 3307, 2012"
  ];
  for(const value of vehicles)
    assert.equal(isSabyTruckVehicleLabel(value),true,value);
  const metadata=[
    "VIN: EXAMPLEVIN00000001","Vin EXAMPLEVIN00000001",
    "ВИН: EXAMPLEVIN00000001",
    "ГРЗ ТС: А123АА 190","ГРЗ: А123АА 190",
    "Госномер: А123АА 190","Гос. номер: А123АА 190",
    "Регистрационный знак: А123АА",
    "Номер шасси: EXAMPLEVIN",
    "ПТС: 77ТТ123456","СТС: 77ТТ123456",
    "Автопарк","Грузовые 220","Автобусы 23",
    "Спецтехника 222","Показать ещё","Загрузить ещё",
    "Ещё","Всего 220","...",
    "2025",""
  ];
  for(const value of metadata)
    assert.equal(isSabyTruckVehicleLabel(value),false,value);
  assert.equal(isSabyTruckVehicleLabel(null),false);
  assert.equal(isSabyTruckVehicleLabel(42),false);
});

test("a realistic multi-line Saby panel yields one row per truck, NOT one per VIN or plate",()=>{
  const visibleLeaves=[
    "КАМАЗ K3340, 2025",
    "VIN: EXAMPLEVIN00000001",
    "КАМАЗ K3340, 2025",
    "VIN: EXAMPLEVIN00000002",
    "КАМАЗ K3456",
    "КРАЗ 6437, 2008",
    "МАЗ 5340, 2013",
    "НЕФАЗ 4208-11-13, 2009",
    "VIN: EXAMPLEVIN00000003",
    "ГРЗ ТС: А123АА 190",
    "SCANIA P, 2021",
    "SCANIA P, 2021",
    "SCANIA P, 2020",
    "..."
  ];
  const labels=visibleLeaves.filter(isSabyTruckVehicleLabel);
  assert.deepEqual(labels,[
    "КАМАЗ K3340, 2025","КАМАЗ K3340, 2025",
    "КАМАЗ K3456","КРАЗ 6437, 2008","МАЗ 5340, 2013",
    "НЕФАЗ 4208-11-13, 2009",
    "SCANIA P, 2021","SCANIA P, 2021","SCANIA P, 2020"
  ]);
  const rows=labels.map(label=>{
    const m=label.match(/^(.+?)[,;]\s*((?:19|20)\d{2})$/u);
    return m?{model:m[1],year:Number(m[2])}:
      {model:label,year:null};
  });
  assert.equal(rows.length,9);
  assert.equal(rows[2].year,null);
  assert.deepEqual(rows[0],rows[1]);
  assert.deepEqual(rows[6],rows[7]);
  assert.equal(appendSabyTruckWindow([],rows,220).status,"advanced");
  const next=[...rows,{model:"SCANIA G",year:2022}];
  assert.equal(appendSabyTruckWindow(rows,next,220).rows.length,10);
});

test("fleet assembler rejects any VIN pseudo-vehicle, even if counted as the 220th item",()=>{
  const cars=Array.from({length:219},(_,i)=>({
    model:"КАМАЗ 43118",year:2020+i%5
  }));
  assert.equal(appendSabyTruckWindow([],cars,220).status,"advanced");
  const withMetadata=[
    ...cars,{model:"VIN: FAKE_220TH_TRUCK",year:null}
  ];
  const r=appendSabyTruckWindow(cars,withMetadata,220);
  assert.equal(r.status,"invalid");
  assert.equal(r.reason,"invalid_rows");
  const valid=[...cars,{model:"КАМАЗ K3456",year:null}];
  const good=appendSabyTruckWindow(cars,valid,220);
  assert.equal(good.status,"advanced");
  assert.equal(good.rows.length,220);
});

test("same metadata exclusion source is passed to ALL page readers and tail click geometry",()=>{
  const source=new RegExp(SABY_NON_VEHICLE_LABEL_PATTERN,"iu");
  assert.equal(source.test("VIN: MOCK"),true);
  assert.equal(source.test("ГРЗ ТС: MOCK"),true);
  assert.equal(source.test("КАМАЗ K3456"),false);
  const browser=fs.readFileSync(
    new URL("../src/sabyBrowser.js",import.meta.url),"utf8");
  const tail=fs.readFileSync(
    new URL("../src/sabyFleetTailDiagnostic.js",import.meta.url),"utf8");
  const interaction=fs.readFileSync(
    new URL("../src/sabyFleetTailInteraction.js",import.meta.url),"utf8");
  for(const text of [browser,tail,interaction]){
    assert.match(text,/SABY_NON_VEHICLE_LABEL_PATTERN/);
    assert.match(text,/new RegExp\(nonVehiclePattern,"iu"\)/);
    assert.match(text,/excluded\.test\(/);
    assert.doesNotMatch(text,/page\.evaluate\([^)]*eval\(/);
  }
  assert.match(tail,/vehicleLabel\(norm\(e\.textContent\)\)/);
  assert.match(interaction,/vehicleLabel\(norm\(e\.textContent\)\)/);
  assert.match(browser,/if\(!vehicleLabel\(t\)\)continue/);
  assert.match(browser,/if\(vehicleLabel\(model\)\)rows\.push/);
});

test("failed next-tail observation prints only fixed sanitized counters",()=>{
  const report=safeSabyFleetTailBatchReport({
    status:"incomplete",reason:"tail_not_ready",
    rows_before:90,rows_after:90,extra_clicks:0,
    additional_scroll_moves:3,rounds:1,tail_checks:1,
    last_tail:{
      status:"observed",waited_ms:11000,
      sample_before:{
        status:"observed",truck_row_count:90,
        small_dot_candidates:3,three_dot_cluster:true,
        gap_height:40,dot_pointer_cursor:true,
        private_vin:"SECRET_VIN_EXAMPLE"
      },
      sample_after:{
        status:"observed",truck_row_count:90,
        small_dot_candidates:3,three_dot_cluster:true,
        gap_height:40,dot_pointer_cursor:true,
        private_model:"PRIVATE_KAMAZ_MODEL"
      }
    },
    company_name:"PRIVATE_COMPANY",
    source_url:"https://profile.saby.ru/SECRET"
  });
  assert.equal(report.last_tail.status,"observed");
  assert.equal(report.last_tail.sample_before.truck_row_count,90);
  assert.equal(report.last_tail.sample_after.three_dot_cluster,true);
  assert.equal(report.last_tail.waited_ms,11000);
  assert.doesNotMatch(JSON.stringify(report),
    /SECRET|PRIVATE|VIN_EXAMPLE|COMPANY|source_url/);
});
