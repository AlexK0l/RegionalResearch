// Exact real 2026-11-26 summary tile DOM; separate navigation total.
// Wasaby renders invisible-tile-item-* measurement clones. Never count them.
import {compareSabyVerifiedFleetDetail} from "./sabyFleetRouteContinuity.js";
import {isSabyVehicleCategory,parseSabyVehicleModel,verifiedSabyVehicleFleet} from "./sabyVehicleInventory.js";
import {readSabyFleetTree,collectSabyFleetTree} from "./sabyFleetTree.js";
export function scanSabyVehicleSummaryDOM(){
  const clean=t=>String(t||"").replace(/\s+/g," ").trim();
  const visible=e=>{
    if(!e?.getBoundingClientRect)return false;
    const r=e.getBoundingClientRect(),s=getComputedStyle(e);
    return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden"&&s.opacity!=="0";
  };
  const one=(e,selector)=>{
    const items=[...e.querySelectorAll(selector)].filter(visible);
    return items.length===1?items[0]:null;
  };
  const widget=one(document,'[data-qa="contractorCard-transport"]');
  if(!widget||clean(one(widget,'[data-qa="contractorCard-transport__header"]')?.textContent)!=="Автопарк компании")return {status:"missing"};
  const nav=one(document,'[data-qa="row"][data-name="transport"][item-key="transport"] [data-qa="cell"] .contractor-Dialog-Accordion__item');
  if(!nav||clean(one(nav,'.contractor-Dialog-Accordion__title')?.textContent)!=="Автопарк компании")return {status:"review"};
  const totalNode=one(nav,'.contractor-Dialog-Accordion__counter .controls-DecoratorNumber');
  const total=clean(totalNode?.textContent).replace(/\s/g,"");
  if(!/^\d{1,5}$/.test(total)||clean(totalNode?.getAttribute("title")).replace(/\s+/g,"")!==total+"всего")return {status:"review"};
  const items=one(widget,'[data-qa="items-container"].controls-TileView');
  if(!items)return {status:"review"};
  const tiles=[...items.querySelectorAll(':scope > [data-qa="item"][item-key]')]
    .filter(e=>!String(e.getAttribute("item-key")||"").startsWith("invisible-tile-item-")&&visible(e));
  const groups=[];
  for(const tile of tiles){
    const key=tile.getAttribute("item-key");
    if(!/^\d{1,9}$/.test(key||""))return {status:"review"};
    const inner=one(tile,'.contractorCard-transport__tileContainer');
    if(!inner)return {status:"review"};
    const category=clean(one(inner,'[data-qa="contractorCard-transport_header"]')?.textContent);
    const count=clean(one(inner,'[data-qa="contractorCard-transport_counter"]')?.textContent).replace(/\s/g,"");
    if(!/^\d{1,5}$/.test(count))return {status:"review"};
    const labels=[...inner.querySelectorAll('[data-qa="contractorCard-transport_title"]')].filter(visible).map(el=>{
      const title=clean(el.getAttribute("title")),text=clean(el.textContent);
      return title&&title===text?title:"";
    });
    groups.push({key,category,count:Number(count),labels});
  }
  return {status:"observed",total:Number(total),groups};
}
export function validateSabyVehicleSummary(raw){
  if(raw?.status!=="observed"||!Number.isSafeInteger(raw.total)||raw.total<1||raw.total>35000||
     !Array.isArray(raw.groups)||!raw.groups.length||raw.groups.length>7)return null;
  const used=new Set(),keys=new Set(),groups=[];let sum=0;
  for(const g of raw.groups){
    if(!isSabyVehicleCategory(g?.category)||used.has(g.category)||keys.has(g.key)||!/^\d{1,9}$/.test(g.key||"")||
       !Number.isSafeInteger(g.count)||g.count<1||g.count>5000||!Array.isArray(g.labels)||g.labels.length>g.count)return null;
    used.add(g.category);keys.add(g.key);sum+=g.count;
    const rows=g.labels.map(parseSabyVehicleModel);
    groups.push({key:g.key,category:g.category,count:g.count,vehicles:rows.length===g.count&&rows.every(Boolean)?rows:null});
  }
  return sum===raw.total?{count:sum,groups}:null;
}
const signature=s=>JSON.stringify(s.groups.map(g=>[g.key,g.category,g.count]).sort((a,b)=>a[0].localeCompare(b[0])));
export async function readSabyVehicleSummary(page,originalUrl){
  const same=()=>compareSabyVerifiedFleetDetail(originalUrl,page?.url?.()).ok===true;
  if(!same())return null;
  try{const raw=await page.evaluate(scanSabyVehicleSummaryDOM);return same()?validateSabyVehicleSummary(raw):null;}
  catch{return null;}
}
// Complete small fleets need one DOM read. For longer lists, use
// existing scoped tree/footer protocol and one exact tile disclosure.
export async function collectSabyVehicleInventory(page,{
  originalUrl,quick=false,wait=ms=>new Promise(r=>setTimeout(r,ms)),
  readSummary=readSabyVehicleSummary,readTree=readSabyFleetTree,collectTree=collectSabyFleetTree,now=()=>Date.now()
}={}){
  const same=()=>compareSabyVerifiedFleetDetail(originalUrl,page?.url?.()).ok===true;
  const missing={status:"missing",fleet:null,trucks:null,drawerOpened:false};
  if(!same())return missing;
  const raw=await readSummary(page,originalUrl);
  if(!same()||!raw)return missing;
  const s=structuredClone(raw);let opened=false;
  const outcome=()=>{
    if(!same())return missing;
    const fleet=verifiedSabyVehicleFleet({status:"verified",count:s.count,groups:s.groups});
    const group=s.groups.find(g=>g.category==="Грузовые");
    const trucks=group?.vehicles?{status:"verified",count:group.count,vehicles:group.vehicles}:null;
    return {status:fleet?"verified":"partial",fleet,trucks,drawerOpened:opened};
  };
  if(s.groups.every(g=>g.vehicles)||quick)return outcome();
  const deadline=now()+175000,pending=s.groups.filter(g=>!g.vehicles);
  try{
    const caption=page.locator('.controls-StackTemplate-content .controls-StackTemplate__caption [title="Автопарк"]');
    const n=await caption.count();
    if(n>1||!same())return outcome();
    opened=n===1&&await caption.isVisible();
    if(!opened){
      const live=await readSummary(page,originalUrl);
      if(!live||signature(live)!==signature(s)||live.count!==s.count||!same())return outcome();
      const target=page.locator('[data-qa="contractorCard-transport"] [data-qa="item"][item-key="'+pending[0].key+'"] .contractorCard-transport__tileContainer');
      if(await target.count()!==1||!await target.isVisible()||!same())return outcome();
      await target.click({timeout:4000});opened=true;
    }
    for(const g of pending){
      if(!same()||now()>=deadline)return outcome();
      let seed=null;
      for(let i=0;i<20&&now()<deadline;i++){
        if(!same())return missing;
        const x=await readTree(page,{expected:g.count,category:g.category});
        if(!same())return missing;
        if(x?.status==="observed"&&(x.rows?.length>0||x.hasMore===true)){seed=x;break;}
        if(!["tree_missing","truck_category_missing","read_failed"].includes(x?.reason)&&x?.status!=="observed")break;
        if(i<19)await wait(400);
      }
      if(!seed)continue;
      const r=await collectTree(page,{expected:g.count,category:g.category,originalUrl,initialSnapshot:seed,read:readTree,wait,maxMs:Math.max(1000,deadline-now())});
      if(!same())return missing;
      if(r?.status==="complete"&&r.expected===g.count&&r.vehicles?.length===g.count)g.vehicles=r.vehicles;
    }
  }catch{/* No speculative second click. */}
  return outcome();
}
