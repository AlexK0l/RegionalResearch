// The live VPS 2026-11-26 showed an exact accordion navigation title,
// but no mounted transport summary anywhere in the detail DOM. This path
// opens only that exact control on an independently verified card. It
// does not assume that a navigation title means the fleet has loaded.
import {compareSabyVerifiedFleetDetail} from "./sabyFleetRouteContinuity.js";
import {SABY_VEHICLE_CATEGORIES,isSabyVehicleCategory} from "./sabyVehicleInventory.js";

const NAV_TITLE='[data-qa="row"] [data-qa="cell"] .contractor-Dialog-Accordion__item .contractor-Dialog-Accordion__title';
const CAPTION='.controls-StackTemplate-content .controls-StackTemplate__caption [title="Автопарк"]';

// The generic row/cell structure is from the actual VPS. The visible
// inner control, not the virtual grid row (which may have zero size),
// must be unique. An exact independent total is optional for navigation
// but mandatory for claiming any reconciled all-category inventory.
export function scanSabyFleetNavigationDOM(){
  const norm=t=>String(t||"").replace(/\s+/g," ").trim();
  const visible=e=>{
    if(!e?.getBoundingClientRect)return false;
    const r=e.getBoundingClientRect(),s=getComputedStyle(e);
    return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden"&&s.opacity!=="0";
  };
  const items=[...document.querySelectorAll(
    '[data-qa="row"] [data-qa="cell"] .contractor-Dialog-Accordion__item'
  )].filter(e=>visible(e)&&[...e.querySelectorAll('.contractor-Dialog-Accordion__title')]
    .some(h=>visible(h)&&norm(h.textContent)==="Автопарк компании"));
  if(items.length!==1)return {status:items.length?"ambiguous":"missing",total:null};
  const titles=[...items[0].querySelectorAll('.contractor-Dialog-Accordion__title')].filter(visible);
  if(titles.length!==1||norm(titles[0].textContent)!=="Автопарк компании")
    return {status:"ambiguous",total:null};
  const counts=[...items[0].querySelectorAll('.contractor-Dialog-Accordion__counter .controls-DecoratorNumber')].filter(visible);
  const t=norm(counts[0]?.textContent).replace(/\s/g,"");
  const n=Number(t);
  const total=counts.length===1&&/^\d{1,5}$/.test(t)&&n>=1&&n<=35000&&
    norm(counts[0].getAttribute("title")).replace(/\s/g,"")===t+"всего"?n:null;
  return {status:"found",total};
}

// Match the SAME Wasaby drawer/list and group headers already used by
// readSabyFleetTree. IDs are discovered, not assumed. Never infer a
// category from a model label or count a footer as a vehicle/category.
export function scanSabyVehicleDrawerIndexDOM(categories){
  const norm=t=>String(t||"").replace(/\s+/g," ").trim();
  const visible=e=>{
    const r=e.getBoundingClientRect(),s=getComputedStyle(e);
    return r.width>230&&r.height>260&&r.right>innerWidth*.6&&
      s.display!=="none"&&s.visibility!=="hidden";
  };
  const panels=[...document.querySelectorAll(".controls-StackTemplate-content")]
    .filter(e=>visible(e)&&[...e.querySelectorAll(".controls-StackTemplate__caption [title]")]
      .some(h=>h.getAttribute("title")==="Автопарк"));
  if(panels.length!==1)return {status:panels.length?"ambiguous":"missing"};
  const lists=[...panels[0].querySelectorAll(".controls-ListViewV")];
  if(lists.length!==1)return {status:"list_not_unique"};
  const roots=[...lists[0].querySelectorAll('[data-qa="item"][item-key]:not([item-parent-key])')];
  const groups=[];
  for(const e of roots){
    const key=e.getAttribute("item-key");
    if(/^node-footer--\d{1,9}$/.test(key||""))continue;
    const title=e.querySelector(".controls-fontsize-2xl");
    if(!title||!/^-\d{1,9}$/.test(key||""))return {status:"unrecognized_root"};
    const category=norm(title.textContent);
    if(!categories.includes(category))return {status:"unknown_category"};
    const counters=[...e.querySelectorAll(".controls-DecoratorNumber")];
    const countText=norm(counters[0]?.textContent).replace(/\s/g,"");
    if(counters.length!==1||!/^\d{1,5}$/.test(countText))return {status:"invalid_count"};
    groups.push({key,category,count:Number(countText)});
  }
  return {status:"observed",groups};
}

const validTotal=n=>Number.isSafeInteger(n)&&n>=1&&n<=35000;
export function validateSabyVehicleDrawerIndex(raw,total){
  if(raw?.status!=="observed"||!validTotal(total)||
     !Array.isArray(raw.groups)||!raw.groups.length||raw.groups.length>7)return null;
  const keys=new Set(),categories=new Set(),groups=[];let sum=0;
  for(const g of raw.groups){
    if(!/^-\d{1,9}$/.test(g?.key||"")||keys.has(g.key)||
       !isSabyVehicleCategory(g.category)||categories.has(g.category)||
       !Number.isSafeInteger(g.count)||g.count<1||g.count>5000)return null;
    keys.add(g.key);categories.add(g.category);sum+=g.count;
    // Vehicle rows must still pass the existing two-read exact tree
    // validator, including unique IDs, ordered prefix and exact counts.
    groups.push({key:g.key,category:g.category,count:g.count,vehicles:null});
  }
  return sum===total?{count:total,groups}:null;
}
const drawerReasons=new Set(["missing","ambiguous","list_not_unique","unrecognized_root","unknown_category","invalid_count","observed","read_failed"]);
const safeNav=x=>({status:["found","missing","ambiguous"].includes(x?.status)?x.status:"unavailable",
  total:x?.status==="found"&&validTotal(x.total)?x.total:null});
const readNavigation=page=>page.evaluate(scanSabyFleetNavigationDOM);
const readDrawerIndex=page=>page.evaluate(scanSabyVehicleDrawerIndexDOM,SABY_VEHICLE_CATEGORIES);
const captionVisible=async page=>{
  const el=page.locator(CAPTION).filter({visible:true}),n=await el.count();
  return n===1?"visible":n>1?"ambiguous":"missing";
};
const clickNavigation=async(page,{sameCompany,markAttempt})=>{
  const target=page.locator(NAV_TITLE).filter({hasText:/^Автопарк компании$/u,visible:true});
  if(await target.count()!==1||!await target.isVisible()||!sameCompany())return false;
  markAttempt();
  await target.click({timeout:4000});
  return true;
};

// Used ONLY by full all-category collection after the existing exact
// heading lookup. A positive menu total must reconcile with the whole
// drawer index; individual rows are collected by the existing tree reader.
// Bounded, one menu click at most; never re-toggle an open drawer.
export async function recoverSabyVehicleNavigation(page,{
  originalUrl,readSummary,wait=ms=>new Promise(r=>setTimeout(r,ms)),
  readNav=readNavigation,readIndex=readDrawerIndex,readCaption=captionVisible,
  openNav=clickNavigation,onDiagnostic,maxPolls=20
}={}){
  const same=()=>compareSabyVerifiedFleetDetail(originalUrl,page?.url?.()).ok===true;
  let attempted=false,opened=false,nav={status:"unavailable",total:null},total=null,indexStatus="missing",sum=null,polls=0;
  const finish=(reason,summary=null,drawerOpened=false)=>{
    try{onDiagnostic?.({reason,navigation_attempted:attempted,drawer_seen:opened,
      navigation_status:nav.status,announced_count:total,drawer_status:indexStatus,
      category_sum:sum,polls});}catch{}
    return {summary,drawerOpened,navigationAttempted:attempted};
  };
  if(!same()||typeof readSummary!=="function")return finish("navigation_route_guard");
  try{
    nav=safeNav(await readNav(page));total=nav.total;
    if(!same())return finish("navigation_route_guard");
    const initial=await readCaption(page);
    if(!same())return finish("navigation_route_guard");
    if(initial==="ambiguous")return finish("navigation_drawer_ambiguous");
    opened=initial==="visible";
    if(!opened){
      if(nav.status!=="found")return finish("navigation_target_unavailable");
      const clicked=await openNav(page,{sameCompany:same,markAttempt:()=>{attempted=true;}});
      if(!clicked)return finish("navigation_click_unavailable");
      attempted=true;
    }
    if(!same())return finish("navigation_route_guard");
    const limit=Math.max(1,Math.min(20,Math.floor(maxPolls)||20));
    for(let i=0;i<limit;i++){
      if(i>0)await wait(400);
      if(!same())return finish("navigation_route_guard");
      polls++;
      // A navigation item can reveal an ordinary summary instead of
      // opening a drawer. Use the original exact summary validator.
      const summary=await readSummary();
      if(!same())return finish("navigation_route_guard");
      if(summary){
        if(total!==null&&summary.count!==total)return finish("navigation_total_changed");
        return finish("navigation_summary_ready",summary,false);
      }
      nav=safeNav(await readNav(page));
      if(!same())return finish("navigation_route_guard");
      if(nav.total!==null){
        if(total!==null&&total!==nav.total)return finish("navigation_total_changed");
        total=nav.total;
      }
      const caption=await readCaption(page);
      if(!same())return finish("navigation_route_guard");
      if(caption==="ambiguous")return finish("navigation_drawer_ambiguous");
      if(caption!=="visible")continue;
      opened=true;
      const index=await readIndex(page);
      if(!same())return finish("navigation_route_guard");
      indexStatus=drawerReasons.has(index?.status)?index.status:"read_failed";
      if(indexStatus==="observed"&&Array.isArray(index.groups)&&index.groups.length<=7&&
         index.groups.every(g=>Number.isSafeInteger(g?.count)&&g.count>=1&&g.count<=5000))
        sum=index.groups.reduce((n,g)=>n+g.count,0);
      else sum=null;
      const value=validateSabyVehicleDrawerIndex(index,total);
      if(value)return finish("navigation_drawer_ready",value,true);
    }
    return finish("navigation_unresolved");
  }catch{return finish("navigation_interaction_failed");}
}
