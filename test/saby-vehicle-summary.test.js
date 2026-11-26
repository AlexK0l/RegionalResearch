import test from "node:test";
import assert from "node:assert/strict";
import {scanSabyVehicleSummaryDOM,validateSabyVehicleSummary,collectSabyVehicleInventory} from "../src/sabyVehicleSummary.js";
import {validateSabyFleetTreeSnapshot} from "../src/sabyFleetTree.js";
const url="https://profile.saby.ru/page/contractor-info?id=12345678-1234-1234-1234-123456789abc";
const raw=()=>({status:"observed",total:2,groups:[{key:"1",category:"Легковые",count:1,labels:["PEUGEOT PARTNER VP, 2023"]},{key:"2",category:"Коммерческие",count:1,labels:["PEUGEOT BOXER, 2024"]}]});
test("real nontruck category summary confirms two vehicles without opening another panel",async()=>{
  const r=await collectSabyVehicleInventory({url:()=>url,locator:()=>assert.fail("no click")},{originalUrl:url,readSummary:async()=>validateSabyVehicleSummary(raw())});
  assert.equal(r.status,"verified");assert.equal(r.trucks,null);assert.equal(r.fleet.count,2);
  assert.deepEqual(r.fleet.groups,[{category:"Легковые",count:1,vehicles:[{model:"PEUGEOT PARTNER VP",year:2023}]},{category:"Коммерческие",count:1,vehicles:[{model:"PEUGEOT BOXER",year:2024}]}]);
});
test("absence, changed total, duplicate categories, unknown labels and keys never yield complete inventory",()=>{
  for(const mut of [a=>a.total=3,a=>a.groups[1].category=a.groups[0].category,a=>a.groups[1].key=a.groups[0].key,a=>a.groups[1].category="Неизвестно",a=>a.groups[1].key="invisible-tile-item-5"]){
    const a=raw();mut(a);assert.equal(validateSabyVehicleSummary(a),null);
  }
  const a=raw();a.groups[0].labels=["VIN: MOCK"];assert.equal(validateSabyVehicleSummary(a).groups[0].vehicles,null);
  assert.equal(validateSabyVehicleSummary({status:"observed",total:0,groups:[]}),null);
});
test("same source category retains duplicate models as separate records; different category cannot supply rows",()=>{
  const a={status:"observed",expected:2,category:"Коммерческие",groupKey:"-7",rows:[{key:"1",label:"PEUGEOT BOXER, 2024"},{key:"2",label:"PEUGEOT BOXER, 2024"}]};
  assert.equal(validateSabyFleetTreeSnapshot(a,{expected:2,category:"Коммерческие"}).rows.length,2);
  assert.equal(validateSabyFleetTreeSnapshot(a,{expected:2,category:"Грузовые"}).status,"invalid");
});
test("eleven hidden measurement clones cannot inflate the source count",()=>{
  const oldDoc=globalThis.document,oldStyle=globalThis.getComputedStyle;
  const node=(text="",attrs={},children={})=>({textContent:text,getAttribute:k=>attrs[k]??null,querySelectorAll:s=>children[s]||[],getBoundingClientRect:()=>({width:100,height:25})});
  const item=g=>node("",{"item-key":g.key},{".contractorCard-transport__tileContainer":[node("",{},{
    '[data-qa="contractorCard-transport_header"]':[node(g.category)],
    '[data-qa="contractorCard-transport_counter"]':[node(String(g.count))],
    '[data-qa="contractorCard-transport_title"]':g.labels.map(x=>node(x,{title:x}))
  })]});
  const [a,b]=raw().groups;
  const list=node("",{}, {':scope > [data-qa="item"][item-key]':[item(a),item(b),...Array.from({length:11},(_,i)=>item({...b,key:"invisible-tile-item-"+i}))]});
  const widget=node("",{}, {'[data-qa="contractorCard-transport__header"]':[node("Автопарк компании")],'[data-qa="items-container"].controls-TileView':[list]});
  const nav=node("",{}, {'.contractor-Dialog-Accordion__title':[node("Автопарк компании")],'.contractor-Dialog-Accordion__counter .controls-DecoratorNumber':[node("2",{title:"2 всего"})]});
  try{
    globalThis.document=node("",{}, {'[data-qa="contractorCard-transport"]':[widget],
      '[data-qa="row"][data-name="transport"][item-key="transport"] [data-qa="cell"] .contractor-Dialog-Accordion__item':[nav]});
    globalThis.getComputedStyle=()=>({display:"block",visibility:"visible",opacity:"1"});
    assert.deepEqual(scanSabyVehicleSummaryDOM(),raw());
  }finally{if(oldDoc===undefined)delete globalThis.document;else globalThis.document=oldDoc;if(oldStyle===undefined)delete globalThis.getComputedStyle;else globalThis.getComputedStyle=oldStyle;}
});
test("one drawer disclosure for incomplete category; changing company discards all new facts",async()=>{
  const a=raw();a.total=3;a.groups[1].count=2;
  const summary=validateSabyVehicleSummary(a);let clicks=0,route=url;
  const page={url:()=>route,locator:s=>({count:async()=>s.includes("caption")?0:1,isVisible:async()=>true,click:async()=>{assert.match(s,/item-key="2"/);clicks++;}})};
  const opts={originalUrl:url,readSummary:async()=>summary,readTree:async(_p,{category})=>({status:"observed",category,expected:2,groupKey:"-7",rows:[{key:"1",label:"PEUGEOT BOXER, 2024"}],hasMore:true}),
    collectTree:async(_p,{category})=>{assert.equal(category,"Коммерческие");return {status:"complete",expected:2,vehicles:[{model:"PEUGEOT BOXER",year:2024},{model:"ГАЗ 3302",year:2019}]};}};
  const r=await collectSabyVehicleInventory(page,opts);assert.equal(r.fleet.count,3);assert.equal(clicks,1);
  const fail=await collectSabyVehicleInventory(page,{...opts,collectTree:async()=>{route=url.replace("12345678-","22345678-");return {status:"complete",expected:2,vehicles:[]};}});
  assert.equal(fail.fleet,null);
});


test("incomplete category retains independently verified nontruck group and advertised total",async()=>{
  const a=raw();a.total=3;a.groups[1].count=2;
  const r=await collectSabyVehicleInventory({url:()=>url,locator:()=>assert.fail("quick must not open")},{
    originalUrl:url,quick:true,readSummary:async()=>validateSabyVehicleSummary(a)});
  assert.equal(r.fleet,null);
  assert.equal(r.partial.announced_count,3);
  assert.deepEqual(r.partial.groups,[{category:"Легковые",count:1,vehicles:[{model:"PEUGEOT PARTNER VP",year:2023}]}]);
});
test("full category read can recover a lazily mounted exact summary, quick read never scrolls",async()=>{
  let recover=0;
  const opts={originalUrl:url,readSummary:async()=>null,
    recoverSummary:async()=>{recover++;return {heading:validateSabyVehicleSummary(raw())};}};
  const p={url:()=>url};
  assert.equal((await collectSabyVehicleInventory(p,{...opts,quick:true})).fleet,null);
  assert.equal(recover,0);
  assert.equal((await collectSabyVehicleInventory(p,opts)).fleet.count,2);
  assert.equal(recover,1);
});
