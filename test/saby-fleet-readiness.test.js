import test from "node:test";
import assert from "node:assert/strict";
import {recoverSabyFleetHeading} from "../src/sabyFleetReadiness.js";
import {tryEarlySabyPostRouteProof} from "../src/sabyPostRouteIdentity.js";
import {scanSabyTruckPreview,quickSabyFleetFromPreview} from "../src/sabyBrowser.js";

const url="https://profile.saby.ru/page/contractor-info?id=12345678-1234-1234-1234-123456789abc";
function fixture({mountAt=500,count=1,drift=false,passive=false}={}){
  let same=true,reads=0,waits=0;
  const positions=[],selectors=[],heading={name:"Автопарк компании"};
  const el={scrollTop:300,scrollHeight:1200,clientHeight:200};
  const locator={count:async()=>count,isVisible:async()=>true,
    async evaluate(fn,arg){
      const before=el.scrollTop,out=fn(el,arg);
      if(el.scrollTop!==before){positions.push(el.scrollTop);if(drift)same=false;}
      return out;
    }};
  return {page:{locator(s){selectors.push(s);return locator;}},heading,
    readHeading:async()=>{reads++;return (passive&&reads>=2)||el.scrollTop>=mountAt?heading:null;},
    sameCompany:()=>same,wait:async()=>{waits++;},positions,selectors,
    stats:()=>({reads,waits,top:el.scrollTop})};
}
test("late-mounted fleet heading succeeds without a scroll or navigation",async()=>{
  const x=fixture({passive:true,mountAt:10000});
  const r=await recoverSabyFleetHeading(x.page,x);
  assert.equal(r.status,"hydrated");
  assert.equal(r.heading,x.heading);
  assert.equal(r.scrollSteps,0);
  assert.deepEqual(x.selectors,[]);
  assert.deepEqual(x.positions,[]);
});
test("full recovery reveals lazy fleet in the observed unique contractor viewer",async()=>{
  const x=fixture();
  const r=await recoverSabyFleetHeading(x.page,x);
  assert.equal(r.status,"revealed");
  assert.equal(r.heading,x.heading);
  assert.equal(r.scrollSteps,3);
  assert.deepEqual(x.positions,[0,250,500]);
  assert.equal(x.selectors.length,1);
  assert.match(x.selectors[0],/contractorCard-dialog-Stack/);
  assert.match(x.selectors[0],/controls-Scroll__content/);
  assert.equal(x.stats().top,500);
});
test("ambiguous viewer is never scrolled; absent heading restores original position",async()=>{
  const a=fixture({count:2,mountAt:10000});
  assert.equal((await recoverSabyFleetHeading(a.page,a)).status,"scroller_unavailable");
  assert.deepEqual(a.positions,[]);
  const b=fixture({mountAt:10000});
  const r=await recoverSabyFleetHeading(b.page,b);
  assert.equal(r.status,"heading_not_found");
  assert.equal(r.scrollSteps,5);
  assert.equal(b.stats().top,300);
});
test("a changed private route stops recovery, including scroll restoration",async()=>{
  const x=fixture({drift:true,mountAt:10000});
  const r=await recoverSabyFleetHeading(x.page,x);
  assert.equal(r.status,"card_changed");
  assert.equal(r.heading,null);
  assert.deepEqual(x.positions,[0]);
});
const prior={reason:"private_route_changed",route_change_reason:"non_ui_query_changed",
  route_delta:{status:"observed",non_ui_removed:1,non_ui_added:0,
    non_ui_values_changed:0,ui_values_changed:0}};
test("early recovery delegates to the unchanged full proof with fresh scoped identity",async()=>{
  const assessment={ok:false,reason:"legal_name_not_verified",detail:{hasScopedInn:true}};
  let reads=0,proofs=0;
  const expected={ok:true,identity:{verified:true,inn:"7707083893",name:"ООО Альфа"}};
  const out=await tryEarlySabyPostRouteProof({url:()=>url},"7707083893","ООО Альфа",{
    priorFailure:prior,selectedSearchTitle:"Альфа",
    readCard:async()=>{reads++;return assessment;},
    verifyPostRoute:async(_p,inn,name,got,opts)=>{
      proofs++;assert.equal(inn,"7707083893");assert.equal(name,"ООО Альфа");
      assert.equal(got,assessment);assert.equal(opts.priorFailure,prior);
      assert.equal(opts.selectedSearchTitle,"Альфа");return expected;
    }
  });
  assert.equal(out,expected);assert.equal(reads,1);assert.equal(proofs,1);
});
test("early proof refuses ineligible transitions, stale routes and missing scoped INN",async()=>{
  let route=url,proofs=0;
  const page={url:()=>route};
  const opts={priorFailure:prior,readCard:async()=>({reason:"legal_name_not_verified",
    detail:{hasScopedInn:false}}),verifyPostRoute:async()=>{proofs++;}};
  assert.equal(await tryEarlySabyPostRouteProof(page,"7707083893","ООО Альфа",opts),null);
  assert.equal(await tryEarlySabyPostRouteProof(page,"7707083893","ООО Альфа",{
    ...opts,priorFailure:{...prior,route_delta:{...prior.route_delta,non_ui_added:1}}
  }),null);
  assert.equal(await tryEarlySabyPostRouteProof(page,"7707083893","ООО Альфа",{
    ...opts,readCard:async()=>{route=url.replace("12345678-","22345678-");
      return {reason:"legal_name_not_verified",detail:{hasScopedInn:true}};}
  }),null);
  assert.equal(proofs,0);
});
test("a positive unique count tile with excess labels can open only the full tree path",()=>{
  const oldDoc=globalThis.document,oldStyle=globalThis.getComputedStyle,oldWidth=globalThis.innerWidth;
  const leaf=(text)=>({textContent:text,innerText:text,children:[],
    getBoundingClientRect:()=>({x:20,y:20,left:20,width:80,height:20})});
  const head=leaf("Грузовые 1"),model=leaf("КАМАЗ 5490"),extra=leaf("Другой ярлык");
  const tile={textContent:"Грузовые 1 КАМАЗ 5490 Другой ярлык",
    innerText:"Грузовые 1 КАМАЗ 5490 Другой ярлык",children:[head,model,extra],
    getBoundingClientRect:()=>({x:10,y:10,left:10,width:200,height:100}),
    querySelectorAll:()=>[head,model,extra]};
  for(const el of tile.children)el.parentElement=tile;
  try{
    globalThis.document={querySelectorAll:()=>[head,model,extra,tile]};
    globalThis.getComputedStyle=()=>({display:"block",visibility:"visible"});
    globalThis.innerWidth=1440;
    assert.equal(scanSabyTruckPreview({nonVehiclePattern:"nevermatch"}).status,"missing");
    const preview=scanSabyTruckPreview({nonVehiclePattern:"nevermatch",allowCountOnly:true});
    assert.equal(preview.status,"found");
    assert.equal(preview.count,1);
    assert.deepEqual(preview.rows,[]);
    assert.equal(quickSabyFleetFromPreview(preview,url,url).status,"missing");
    head.textContent=head.innerText="Грузовые 0";
    tile.textContent=tile.innerText="Грузовые 0 КАМАЗ 5490 Другой ярлык";
    assert.equal(scanSabyTruckPreview({nonVehiclePattern:"nevermatch",allowCountOnly:true}).status,"missing");
  }finally{
    if(oldDoc===undefined)delete globalThis.document;else globalThis.document=oldDoc;
    if(oldStyle===undefined)delete globalThis.getComputedStyle;else globalThis.getComputedStyle=oldStyle;
    if(oldWidth===undefined)delete globalThis.innerWidth;else globalThis.innerWidth=oldWidth;
  }
});
