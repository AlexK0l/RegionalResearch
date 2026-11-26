import test from "node:test";
import assert from "node:assert/strict";
import {scanSabyVehicleSummaryDOM,validateSabyVehicleSummary,collectSabyVehicleInventory,readSabyVehicleSummary} from "../src/sabyVehicleSummary.js";
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

test("live summary diagnostics distinguish structure, reconciliation and route without private DOM data",async()=>{
  const diag=[];
  const opts={onDiagnostic:d=>diag.push(d)};
  const page={url:()=>url,evaluate:async()=>({status:"review",reason:"navigation_not_unique",node_count:2,visible_count:0,secret:"PRIVATE"})};
  assert.equal(await readSabyVehicleSummary(page,url,opts),null);
  assert.deepEqual(diag.pop(),{reason:"navigation_not_unique",node_count:2,visible_count:0});
  page.evaluate=async()=>({...raw(),total:3});
  assert.equal(await readSabyVehicleSummary(page,url,opts),null);
  assert.deepEqual(diag.pop(),{reason:"category_total_mismatch",announced_count:3,category_sum:2,groups:2});
  page.evaluate=async()=>{throw Error("PRIVATE");};
  assert.equal(await readSabyVehicleSummary(page,url,opts),null);
  assert.deepEqual(diag.pop(),{reason:"summary_evaluate_failed"});
  page.url=()=>url.replace("12345678-","22345678-");
  assert.equal(await readSabyVehicleSummary(page,url,opts),null);
  assert.deepEqual(diag.pop(),{reason:"route_guard_before",route_reason:"company_card_id_changed"});
});
test("a ready heading can precede summary hydration, bounded passive retry keeps all proof gates",async()=>{
  let reads=0,waits=0;
  const p={url:()=>url,locator:()=>assert.fail("no click or scroll")};
  const options={originalUrl:url,pollAfterHeading:true,wait:async ms=>{assert.equal(ms,350);waits++;},
    readSummary:async()=>++reads>=3?validateSabyVehicleSummary(raw()):null};
  assert.equal((await collectSabyVehicleInventory(p,options)).fleet.count,2);
  assert.equal(waits,2);assert.equal(reads,3);
  reads=waits=0;
  assert.equal((await collectSabyVehicleInventory(p,{...options,quick:true})).fleet,null);
  assert.equal(waits,0);assert.equal(reads,1);
  reads=waits=0;
  const missing=await collectSabyVehicleInventory(p,{...options,readSummary:async()=>{reads++;return null;}});
  assert.equal(missing.fleet,null);assert.equal(waits,3);assert.equal(reads,4);
  let current=url;reads=0;
  const changed=await collectSabyVehicleInventory({url:()=>current},{...options,
    readSummary:async()=>{reads++;return null;},wait:async()=>{current=url.replace("12345678-","22345678-");}});
  assert.equal(changed.fleet,null);assert.equal(reads,1);
});
test("scanner distinguishes a missing widget from an ambiguous hidden widget",()=>{
  const oldDoc=globalThis.document,oldStyle=globalThis.getComputedStyle;
  try{
    const invisible={getBoundingClientRect:()=>({width:0,height:0})};
    globalThis.document={querySelectorAll:()=>[invisible,invisible]};
    globalThis.getComputedStyle=()=>({display:"none",visibility:"hidden",opacity:"0"});
    assert.deepEqual(scanSabyVehicleSummaryDOM(),{status:"missing",reason:"widget_not_unique",node_count:2,visible_count:0});
  }finally{
    if(oldDoc===undefined)delete globalThis.document;else globalThis.document=oldDoc;
    if(oldStyle===undefined)delete globalThis.getComputedStyle;else globalThis.getComputedStyle=oldStyle;
  }
});

test("a mounted summary accepts the observed generic navigation row only with independent exact total",()=>{
  const oldDoc=globalThis.document,oldStyle=globalThis.getComputedStyle;
  const node=(text="",attrs={},children={})=>({textContent:text,getAttribute:k=>attrs[k]??null,
    querySelectorAll:s=>children[s]||[],getBoundingClientRect:()=>({width:100,height:25})});
  const a=raw();
  const list=node("",{}, {':scope > [data-qa="item"][item-key]':a.groups.map(g=>node("",{"item-key":g.key},{
    ".contractorCard-transport__tileContainer":[node("",{},{
      '[data-qa="contractorCard-transport_header"]':[node(g.category)],
      '[data-qa="contractorCard-transport_counter"]':[node(String(g.count))],
      '[data-qa="contractorCard-transport_title"]':g.labels.map(x=>node(x,{title:x}))
    })]
  }))});
  const widget=node("",{},{
    '[data-qa="contractorCard-transport__header"]':[node("Автопарк компании")],
    '[data-qa="items-container"].controls-TileView':[list]
  });
  const nav=title=>node("",{},{
    '.contractor-Dialog-Accordion__title':[node("Автопарк компании")],
    '.contractor-Dialog-Accordion__counter .controls-DecoratorNumber':[node("2",{title})]
  });
  const setDoc=items=>{globalThis.document=node("",{},{
    '[data-qa="contractorCard-transport"]':[widget],
    '[data-qa="row"] [data-qa="cell"] .contractor-Dialog-Accordion__item':items
  });};
  try{
    globalThis.getComputedStyle=()=>({display:"flex",visibility:"visible",opacity:"1"});
    setDoc([nav("2 всего")]);assert.deepEqual(scanSabyVehicleSummaryDOM(),a);
    setDoc([nav("2")]);assert.equal(scanSabyVehicleSummaryDOM().reason,"total_title_mismatch");
    setDoc([nav("2 всего"),nav("2 всего")]);assert.equal(scanSabyVehicleSummaryDOM().reason,"navigation_not_unique");
  }finally{
    if(oldDoc===undefined)delete globalThis.document;else globalThis.document=oldDoc;
    if(oldStyle===undefined)delete globalThis.getComputedStyle;else globalThis.getComputedStyle=oldStyle;
  }
});
test("full navigation recovery uses exact existing tree collector and never clicks a missing summary tile",async()=>{
  const p={url:()=>url,locator:s=>({count:async()=>{assert.match(s,/caption/);return 1;},isVisible:async()=>true})};
  let recoveries=0,trees=0;
  const options={originalUrl:url,openNavigation:true,readSummary:async()=>null,
    recoverNavigation:async()=>{recoveries++;return {navigationAttempted:true,drawerOpened:true,
      summary:{count:2,groups:raw().groups.map((g,i)=>({key:"-"+(i+1),category:g.category,count:1,vehicles:null}))}};},
    readTree:async(_p,{category,expected})=>({status:"observed",expected,category,
      groupKey:category==="Легковые"?"-1":"-2",rows:[{key:"1",label:"MODEL, 2023"}]}),
    collectTree:async(_p,{expected})=>{trees++;return {status:"complete",expected,vehicles:[{model:"MODEL",year:2023}]};}
  };
  const r=await collectSabyVehicleInventory(p,options);
  assert.equal(r.fleet.count,2);assert.equal(r.navigationAttempted,true);assert.equal(trees,2);
  const q=await collectSabyVehicleInventory(p,{...options,quick:true});
  assert.equal(q.fleet,null);assert.equal(recoveries,1);
  const wrong=await collectSabyVehicleInventory(p,{...options,readTree:async(_p,{category,expected})=>
    ({status:"observed",expected,category,groupKey:"-99",rows:[{key:"1",label:"MODEL"}]})});
  assert.equal(wrong.fleet,null);assert.equal(trees,2);
});
