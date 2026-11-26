import test from "node:test";
import assert from "node:assert/strict";
import {scanSabyFleetNavigationDOM,scanSabyVehicleDrawerIndexDOM,validateSabyVehicleDrawerIndex,recoverSabyVehicleNavigation} from "../src/sabyVehicleNavigation.js";
const url="https://profile.saby.ru/page/contractor-info?id=12345678-1234-1234-1234-123456789abc";
const groups=[{key:"-1",category:"Легковые",count:1},{key:"-2",category:"Коммерческие",count:1}];
const index=()=>({status:"observed",groups:structuredClone(groups)});
function fake({total=2,alreadyOpen=false,changeRoute=false,readSummary,readIndex}={}){
  let opened=alreadyOpen,clicks=0,route=url;
  const diag=[];
  const page={url:()=>route};
  const options={originalUrl:url,wait:async()=>{},maxPolls:3,
    readNav:async()=>({status:"found",total}),
    readCaption:async()=>opened?"visible":"missing",
    openNav:async(_p,{markAttempt})=>{markAttempt();clicks++;opened=true;if(changeRoute)route=url.replace("12345678","22345678");return true;},
    readSummary:readSummary|| (async()=>null),
    readIndex:readIndex|| (async()=>index()),onDiagnostic:x=>diag.push(x)};
  return {page,options,diag,get clicks(){return clicks;}};
}
test("navigation opens exact menu once and reconciles the existing drawer index with a positive independent total",async()=>{
  const f=fake(),r=await recoverSabyVehicleNavigation(f.page,f.options);
  assert.equal(f.clicks,1);assert.equal(r.drawerOpened,true);assert.equal(r.navigationAttempted,true);
  assert.deepEqual(r.summary,validateSabyVehicleDrawerIndex(index(),2));
  assert.equal(f.diag.at(-1).reason,"navigation_drawer_ready");
  assert.equal(f.diag.at(-1).category_sum,2);
});
test("already open drawer is never toggled; route changes discard every new fact",async()=>{
  const a=fake({alreadyOpen:true}),r=await recoverSabyVehicleNavigation(a.page,a.options);
  assert.equal(a.clicks,0);assert.equal(r.drawerOpened,true);
  const b=fake({changeRoute:true}),bad=await recoverSabyVehicleNavigation(b.page,b.options);
  assert.equal(bad.summary,null);assert.equal(b.clicks,1);assert.equal(b.diag.at(-1).reason,"navigation_route_guard");
});
test("absent or inconsistent independent total and unknown or duplicate groups never prove a whole fleet",async()=>{
  for(const total of [null,0,3]){
    const f=fake({total}),r=await recoverSabyVehicleNavigation(f.page,f.options);
    assert.equal(r.summary,null);assert.equal(f.clicks,1);assert.equal(f.diag.at(-1).polls,3);
  }
  for(const mutate of [x=>x.groups[1].key="-1",x=>x.groups[1].category="Легковые",
    x=>x.groups[1].category="Unrecognized",x=>x.groups[1].count=0,x=>x.groups[1].count=2]){
    const x=index();mutate(x);assert.equal(validateSabyVehicleDrawerIndex(x,2),null);
  }
});
test("navigation may reveal an exact summary instead of a drawer",async()=>{
  let reads=0;
  const expected={count:2,groups:[]}; // injected already-validated summary
  const f=fake({readSummary:async()=>++reads===2?expected:null,readIndex:async()=>({status:"missing"})});
  const r=await recoverSabyVehicleNavigation(f.page,f.options);
  assert.equal(r.summary,expected);assert.equal(r.drawerOpened,false);assert.equal(f.clicks,1);
});
test("navigation rejects total changes and does not click ambiguous or absent controls",async()=>{
  const f=fake();
  let reads=0;
  const result=await recoverSabyVehicleNavigation(f.page,{...f.options,
    readNav:async()=>({status:"found",total:++reads===1?2:3})});
  assert.equal(result.summary,null);assert.equal(f.diag.at(-1).reason,"navigation_total_changed");
  for(const status of ["ambiguous","missing"]){
    const a=fake(),r=await recoverSabyVehicleNavigation(a.page,{...a.options,readNav:async()=>({status,total:null})});
    assert.equal(r.summary,null);assert.equal(a.clicks,0);
  }
});
test("generic navigation scanner and drawer index use exact scoped real-source structures",()=>{
  const oldDoc=globalThis.document,oldStyle=globalThis.getComputedStyle,oldWidth=globalThis.innerWidth;
  const node=(text="",attrs={},children={})=>({textContent:text,getAttribute:k=>attrs[k]??null,
    querySelectorAll:s=>children[s]||[],querySelector:s=>children[s]?.[0]||null,
    getBoundingClientRect:()=>({width:300,height:300,right:1400})});
  const nav=title=>node("",{},{
    '.contractor-Dialog-Accordion__title':[node("Автопарк компании")],
    '.contractor-Dialog-Accordion__counter .controls-DecoratorNumber':[node("2",{title})]
  });
  const item=g=>node("",{"item-key":g.key},{
    ".controls-fontsize-2xl":[node(g.category)],".controls-DecoratorNumber":[node(String(g.count))]
  });
  const panel=node("",{},{
    ".controls-StackTemplate__caption [title]":[node("",{title:"Автопарк"})],
    ".controls-ListViewV":[node("",{},{
      '[data-qa="item"][item-key]:not([item-parent-key])':[
        ...groups.map(item),node("",{"item-key":"node-footer--1"})
      ]
    })]
  });
  const fixture=navs=>node("",{},{
    '[data-qa="row"] [data-qa="cell"] .contractor-Dialog-Accordion__item':navs,
    ".controls-StackTemplate-content":[panel]
  });
  try{
    globalThis.getComputedStyle=()=>({display:"flex",visibility:"visible",opacity:"1"});
    globalThis.innerWidth=1440;
    globalThis.document=fixture([nav("2 всего")]);
    assert.deepEqual(scanSabyFleetNavigationDOM(),{status:"found",total:2});
    assert.deepEqual(scanSabyVehicleDrawerIndexDOM(["Легковые","Коммерческие"]),index());
    globalThis.document=fixture([nav("2")]);
    assert.deepEqual(scanSabyFleetNavigationDOM(),{status:"found",total:null});
    globalThis.document=fixture([nav("2 всего"),nav("2 всего")]);
    assert.deepEqual(scanSabyFleetNavigationDOM(),{status:"ambiguous",total:null});
    assert.equal(scanSabyVehicleDrawerIndexDOM(["Грузовые"]).status,"unknown_category");
  }finally{
    if(oldDoc===undefined)delete globalThis.document;else globalThis.document=oldDoc;
    if(oldStyle===undefined)delete globalThis.getComputedStyle;else globalThis.getComputedStyle=oldStyle;
    if(oldWidth===undefined)delete globalThis.innerWidth;else globalThis.innerWidth=oldWidth;
  }
});
