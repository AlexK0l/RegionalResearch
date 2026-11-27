// Exact real 2026-11-26 summary tile DOM; separate navigation total.
// Wasaby renders invisible-tile-item-* measurement clones. Never count them.
import {compareSabyVerifiedFleetDetail} from "./sabyFleetRouteContinuity.js";
import {isSabyVehicleCategory,parseSabyVehicleModel,verifiedSabyVehicleFleet,verifiedSabyVehiclePartial} from "./sabyVehicleInventory.js";
import {readSabyFleetTree,collectSabyFleetTree} from "./sabyFleetTree.js";
import {recoverSabyVehicleNavigation} from "./sabyVehicleNavigation.js";
export function scanSabyVehicleSummaryDOM(root=document){
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
  // Failure details are structural counts only. Do not export raw text,
  // HTML, titles, identifiers or URLs from an authenticated card.
  const failure=(status,reason,root,selector)=>{
    const nodes=root&&selector?[...root.querySelectorAll(selector)]:[];
    return {status,reason,node_count:nodes.length,visible_count:nodes.filter(visible).length};
  };
  const widgetSelector='[data-qa="contractorCard-transport"]';
  const headerSelector='[data-qa="contractorCard-transport__header"]';
  const navSelector='[data-qa="row"][data-name="transport"][item-key="transport"] [data-qa="cell"] .contractor-Dialog-Accordion__item';
  const navTitleSelector='.contractor-Dialog-Accordion__title';
  const totalSelector='.contractor-Dialog-Accordion__counter .controls-DecoratorNumber';
  const listSelector='[data-qa="items-container"].controls-TileView';
  const widget=one(root,widgetSelector);
  if(!widget)return failure("missing","widget_not_unique",root,widgetSelector);
  const header=one(widget,headerSelector);
  if(!header)return failure("missing","widget_header_not_unique",widget,headerSelector);
  if(clean(header.textContent)!=="Автопарк компании")return failure("missing","widget_heading_mismatch");
  // VPS has the same exact visible accordion title in a generic row,
  // without the transport-specific row markers. Keep the unique title
  // and independent total proof; do not rely on the virtual row geometry.
  const precise=[...root.querySelectorAll(navSelector)].filter(visible);
  const generic='[data-qa="row"] [data-qa="cell"] .contractor-Dialog-Accordion__item';
  const matches=[...root.querySelectorAll(generic)].filter(e=>visible(e)&&
    [...e.querySelectorAll(navTitleSelector)].some(h=>visible(h)&&clean(h.textContent)==="Автопарк компании"));
  if(precise.length>1||matches.length>1||(precise.length===1&&matches.length===1&&precise[0]!==matches[0]))
    return failure("review","navigation_not_unique",root,generic);
  const nav=precise[0]||matches[0];
  if(!nav)return failure("review","navigation_not_unique",root,generic);
  const navTitle=one(nav,navTitleSelector);
  if(!navTitle)return failure("review","navigation_title_not_unique",nav,navTitleSelector);
  if(clean(navTitle.textContent)!=="Автопарк компании")return failure("review","navigation_heading_mismatch");
  const totalNode=one(nav,totalSelector);
  if(!totalNode)return failure("review","total_not_unique",nav,totalSelector);
  const total=clean(totalNode.textContent).replace(/\s/g,"");
  if(!/^\d{1,5}$/.test(total))return failure("review","total_text_invalid");
  if(clean(totalNode.getAttribute("title")).replace(/\s+/g,"")!==total+"всего")return failure("review","total_title_mismatch");
  const items=one(widget,listSelector);
  if(!items)return failure("review","list_not_unique",widget,listSelector);
  const tiles=[...items.querySelectorAll(':scope > [data-qa="item"][item-key]')]
    .filter(e=>!String(e.getAttribute("item-key")||"").startsWith("invisible-tile-item-")&&visible(e));
  if(!tiles.length)return failure("review","real_tiles_missing",items,':scope > [data-qa="item"][item-key]');
  const groups=[];
  for(const tile of tiles){
    const key=tile.getAttribute("item-key");
    if(!/^\d{1,9}$/.test(key||""))return failure("review","tile_key_invalid");
    const innerSelector='.contractorCard-transport__tileContainer';
    const categorySelector='[data-qa="contractorCard-transport_header"]';
    const countSelector='[data-qa="contractorCard-transport_counter"]';
    const inner=one(tile,innerSelector);
    if(!inner)return failure("review","tile_container_not_unique",tile,innerSelector);
    const categoryNode=one(inner,categorySelector),countNode=one(inner,countSelector);
    if(!categoryNode)return failure("review","category_not_unique",inner,categorySelector);
    if(!countNode)return failure("review","category_count_not_unique",inner,countSelector);
    const category=clean(categoryNode.textContent);
    const count=clean(countNode.textContent).replace(/\s/g,"");
    if(!/^\d{1,5}$/.test(count))return failure("review","category_count_invalid");
    const labels=[...inner.querySelectorAll('[data-qa="contractorCard-transport_title"]')].filter(visible).map(el=>{
      const title=clean(el.getAttribute("title")),text=clean(el.textContent);
      return title&&title===text?title:"";
    });
    groups.push({key,category,count:Number(count),labels});
  }
  return {status:"observed",total:Number(total),groups};
}
const DOM_REASONS=new Set([
  "widget_not_unique","widget_header_not_unique","widget_heading_mismatch",
  "navigation_not_unique","navigation_title_not_unique","navigation_heading_mismatch",
  "total_not_unique","total_text_invalid","total_title_mismatch","list_not_unique",
  "real_tiles_missing","tile_key_invalid","tile_container_not_unique","category_not_unique",
  "category_count_not_unique","category_count_invalid"
]);
const ROUTE_REASONS=new Set(["stable_card_id_missing","company_card_id_changed",
  "not_same_first_party_detail","detail_path_changed","unknown_query_changed",
  "unsafe_query_change","unsafe_fragment_change","non_ui_query_changed"]);
const capped=n=>Number.isSafeInteger(n)&&n>=0&&n<=35000?n:null;
function inspectSabyVehicleSummary(raw){
  const fail=(reason,extra={})=>({value:null,diagnostic:{reason,...extra}});
  if(raw?.status!=="observed")return fail(DOM_REASONS.has(raw?.reason)?raw.reason:"summary_not_observed",{
    node_count:capped(raw?.node_count),visible_count:capped(raw?.visible_count)
  });
  if(!Number.isSafeInteger(raw.total)||raw.total<1||raw.total>35000)return fail("invalid_total");
  if(!Array.isArray(raw.groups)||!raw.groups.length||raw.groups.length>7)return fail("invalid_group_count");
  const used=new Set(),keys=new Set(),groups=[];let sum=0;
  for(const g of raw.groups){
    if(!isSabyVehicleCategory(g?.category))return fail("unsupported_category");
    if(used.has(g.category)||keys.has(g.key))return fail("duplicate_category_or_key");
    if(!/^\d{1,9}$/.test(g.key||""))return fail("tile_key_invalid");
    if(!Number.isSafeInteger(g.count)||g.count<1||g.count>5000)return fail("category_count_invalid");
    if(!Array.isArray(g.labels)||g.labels.length>g.count)return fail("excess_or_invalid_model_labels");
    used.add(g.category);keys.add(g.key);sum+=g.count;
    const rows=g.labels.map(parseSabyVehicleModel);
    groups.push({key:g.key,category:g.category,count:g.count,vehicles:rows.length===g.count&&rows.every(Boolean)?rows:null});
  }
  if(sum!==raw.total)return fail("category_total_mismatch",{announced_count:raw.total,category_sum:sum,groups:groups.length});
  const incomplete=groups.filter(g=>!g.vehicles).length;
  return {value:{count:sum,groups},diagnostic:{reason:incomplete?"summary_partial":"summary_complete",
    announced_count:sum,groups:groups.length,incomplete_groups:incomplete}};
}
export function validateSabyVehicleSummary(raw){return inspectSabyVehicleSummary(raw).value;}
const signature=s=>JSON.stringify(s.groups.map(g=>[g.key,g.category,g.count]).sort((a,b)=>a[0].localeCompare(b[0])));
const notify=(onDiagnostic,diagnostic)=>{try{onDiagnostic?.(diagnostic);}catch{/* Diagnostics cannot affect collection. */}};
function routeDiagnostic(report,reason){
  return {reason,route_reason:ROUTE_REASONS.has(report?.reason)?report.reason:"other_route_guard"};
}
export async function readSabyVehicleSummary(page,originalUrl,{onDiagnostic}={}){
  const guard=()=>compareSabyVerifiedFleetDetail(originalUrl,page?.url?.());
  const before=guard();
  if(!before.ok){notify(onDiagnostic,routeDiagnostic(before,"route_guard_before"));return null;}
  try{
    const raw=await page.evaluate(scanSabyVehicleSummaryDOM);
    const after=guard();
    if(!after.ok){notify(onDiagnostic,routeDiagnostic(after,"route_guard_after"));return null;}
    const {value,diagnostic}=inspectSabyVehicleSummary(raw);
    notify(onDiagnostic,diagnostic);
    return value;
  }catch{notify(onDiagnostic,{reason:"summary_evaluate_failed"});return null;}
}
// Complete small fleets need one DOM read. For longer lists, use
// existing scoped tree/footer protocol and one exact tile disclosure.
export async function collectSabyVehicleInventory(page,{
  originalUrl,quick=false,wait=ms=>new Promise(r=>setTimeout(r,ms)),
  readSummary=readSabyVehicleSummary,readTree=readSabyFleetTree,collectTree=collectSabyFleetTree,now=()=>Date.now(),
  recoverSummary=null,pollAfterHeading=false,openNavigation=false,
  recoverNavigation=recoverSabyVehicleNavigation,onDiagnostic
}={}){
  const guard=()=>compareSabyVerifiedFleetDetail(originalUrl,page?.url?.());
  const same=()=>guard().ok===true;
  const missing={status:"missing",fleet:null,partial:null,trucks:null,drawerOpened:false,navigationAttempted:false};
  const initial=guard();
  if(!initial.ok){notify(onDiagnostic,routeDiagnostic(initial,"route_guard_before"));return missing;}
  const read=()=>readSummary(page,originalUrl,{onDiagnostic});
  let raw=await read();
  // Only after the existing full path found its exact heading: the title
  // may precede asynchronously mounted category tiles and counters.
  // No extra visit, scroll or click; quick contact-first reads never wait.
  if(!raw&&!quick&&pollAfterHeading){
    for(let i=0;i<3&&!raw&&same();i++){
      await wait(350);
      if(!same())return missing;
      raw=await read();
    }
  }
  if(!raw&&!quick&&recoverSummary&&same()){
    // Reuse the bounded, exact scoped profile scroller. Search for the
    // reconciled summary itself, not just a possibly early heading.
    const recovery=await recoverSummary(page,{readHeading:read,sameCompany:same,wait});
    raw=recovery?.heading||null;
  }
  let opened=false;
  if(!raw&&!quick&&openNavigation&&same()){
    const recovery=await recoverNavigation(page,{
      originalUrl,wait,onDiagnostic,readSummary:()=>readSummary(page,originalUrl)
    });
    missing.navigationAttempted=recovery?.navigationAttempted===true;
    raw=recovery?.summary||null;
    opened=recovery?.drawerOpened===true;
  }
  if(!same()||!raw)return missing;
  const s=structuredClone(raw);
  const outcome=()=>{
    if(!same())return missing;
    const fleet=verifiedSabyVehicleFleet({status:"verified",count:s.count,groups:s.groups});
    const group=s.groups.find(g=>g.category==="Грузовые");
    const trucks=group?.vehicles?{status:"verified",count:group.count,vehicles:group.vehicles}:null;
    const partial=fleet?null:verifiedSabyVehiclePartial({
      status:"partial",announced_count:s.count,
      categories:s.groups.map(({category,count})=>({category,count})),
      groups:s.groups.filter(g=>g.vehicles)
    });
    return {status:fleet?"verified":"partial",fleet,partial,trucks,drawerOpened:opened,
      navigationAttempted:missing.navigationAttempted};
  };
  if(s.groups.every(g=>g.vehicles)||quick)return outcome();
  const deadline=now()+175000,pending=s.groups.filter(g=>!g.vehicles);
  try{
    const caption=page.locator('.controls-StackTemplate-content .controls-StackTemplate__caption [title="Автопарк"]');
    const n=await caption.count();
    if(n>1||!same())return outcome();
    const visibleDrawer=n===1&&await caption.isVisible();
    // For an index acquired from the open drawer, losing the caption
    // is a failed read, not permission to click a stale summary tile.
    if(opened&&!visibleDrawer)return outcome();
    opened=visibleDrawer;
    if(!opened){
      const live=await read();
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
        if(x?.status==="observed"&&(x.rows?.length>0||x.hasMore===true)){
          // For navigation-discovered categories, the actual tree group
          // must remain the same structural group from the index.
          if(/^-/u.test(g.key)&&x.groupKey!==g.key)break;
          seed=x;break;
        }
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
