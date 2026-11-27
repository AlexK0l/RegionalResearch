// Saby contractor vehicle widget: REAL Wasaby tree identifiers.
// User provided a Chrome recording and a 2026-11-12 DOM snapshot:
//  item-key="-3"                      => category "Грузовые 220"
//  item-parent-key="-3"               => its independent vehicle records
//  item-key="node-footer--3"          => this category's footer
//  [data-qa="navigation-button"] with CHILD [title="Ещё"].
// Category IDs are dynamic. Never assume -3, click anonymous dots,
// count VIN text leaves as vehicles or deduplicate equal model/year labels.
//
// This module is called ONLY from explicit one-company headed Saby smoke.
import {sabyCardRoute} from "./sabyCard.js";
import {compareSabyVerifiedFleetDetail}
  from "./sabyFleetRouteContinuity.js";
import {isSabyTruckVehicleLabel}
  from "./sabyVehicleLabels.js";
import {isSabyVehicleCategory} from "./sabyVehicleInventory.js";

const reasons=new Set([
  "complete","invalid_setup","wrong_company","tree_missing",
  "multiple_tree_panels","truck_category_missing",
  "truck_category_ambiguous","truck_count_mismatch",
  "invalid_group_key","invalid_item_key","duplicate_item_key",
  "invalid_model","invalid_row_count","row_prefix_changed",
  "footer_missing","footer_ambiguous","footer_not_collapsed",
  "button_missing","click_failed","no_growth","click_limit",
  "time_limit","read_failed","category_collapsed","category_state_conflict"
]);
const limited=(n,max)=>Number.isSafeInteger(n)&&n>=0?
  Math.min(n,max):null;
export function safeSabyFleetTreeReport(raw={}){
  return {
    status:raw?.status==="complete"?"complete":"incomplete",
    reason:reasons.has(raw?.reason)?raw.reason:"invalid_setup",
    expected:limited(raw?.expected,5000),
    rows:limited(raw?.rows,5000),
    clicks:limited(raw?.clicks,24),
    samples:limited(raw?.samples,450),
    same_company:raw?.same_company===true
  };
}
export function sabyFleetTreeFooterKey(groupKey){
  return /^-\d{1,9}$/.test(String(groupKey||""))?
    "node-footer-"+groupKey:null;
}

export function parseSabyFleetTreeRow(raw) {
  const key=String(raw?.key||"");
  const label=String(raw?.label||"").replace(/\s+/g," ").trim();
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(key)||
     key.startsWith("node-footer"))
    return null;
  if(!isSabyTruckVehicleLabel(label))return null;
  const match=label.match(/^(.+?)[,;]\s*((?:19|20)\d{2})(?:\s*г\.?)?$/u);
  const model=match?match[1].trim():label;
  if(!isSabyTruckVehicleLabel(model))return null;
  return {key,model,year:match?Number(match[2]):null};
}

// Strict ordered prefix by unique Saby item IDs. Repeated model-year
// strings are distinct vehicles when their keys differ.
export function validateSabyFleetTreeSnapshot(
  snapshot,{expected,previousRows=[],previousGroupKey=null,category="Грузовые"}={}
){
  if(snapshot?.status!=="observed")
    return {status:"invalid",reason:reasons.has(snapshot?.reason)?
      snapshot.reason:"tree_missing"};
  if(!Number.isSafeInteger(expected)||expected<1||expected>5000)
    return {status:"invalid",reason:"invalid_setup"};
  if(!isSabyVehicleCategory(category)||(snapshot.category??"Грузовые")!==category)
    return {status:"invalid",reason:"truck_category_ambiguous"};
  if(snapshot.expected!==expected)
    return {status:"invalid",reason:"truck_count_mismatch"};
  if(!sabyFleetTreeFooterKey(snapshot.groupKey))
    return {status:"invalid",reason:"invalid_group_key"};
  if(previousGroupKey!==null&&previousGroupKey!==snapshot.groupKey)
    return {status:"invalid",reason:"invalid_group_key"};
  if(!Array.isArray(snapshot.rows)||snapshot.rows.length>expected)
    return {status:"invalid",reason:"invalid_row_count"};
  if(snapshot.expanderState==="collapsed"&&(snapshot.rows.length||snapshot.hasMore===true))
    return {status:"invalid",reason:"category_state_conflict"};
  const ids=new Set(),rows=[];
  for(const raw of snapshot.rows){
    const row=parseSabyFleetTreeRow(raw);
    if(!row)return {status:"invalid",reason:"invalid_model"};
    if(ids.has(row.key))
      return {status:"invalid",reason:"duplicate_item_key"};
    ids.add(row.key);
    rows.push(row);
  }
  if(rows.length<previousRows.length)
    return {status:"invalid",reason:"row_prefix_changed"};
  for(let i=0;i<previousRows.length;i++){
    const left=previousRows[i],right=rows[i];
    if(left?.key!==right.key||left?.model!==right.model||
       (left?.year??null)!==(right.year??null))
      return {status:"invalid",reason:"row_prefix_changed"};
  }
  return {status:"valid",rows,groupKey:snapshot.groupKey,
    hasMore:snapshot.hasMore===true,
    footerKey:snapshot.footerKey};
}

export async function readSabyFleetTree(page,{expected,discoverCount=false,category="Грузовые"}={}){
  // Discovery is explicit and never supplies an inferred zero. The
  // exact same visible drawer/category/row checks still apply.
  const discover=discoverCount===true&&expected===undefined;
  if(!isSabyVehicleCategory(category)||(!discover&&(!Number.isSafeInteger(expected)||expected<1||expected>5000))||
     sabyCardRoute(page?.url?.())!=="detail")
    return {status:"invalid",reason:"invalid_setup"};
  try {
    return await page.evaluate(({expected,discover,category})=>{
      const norm=t=>String(t||"").replace(/\s+/g," ").trim();
      const visible=e=>{
        if(!e?.getBoundingClientRect)return false;
        const r=e.getBoundingClientRect(),st=getComputedStyle(e);
        if(st.display==="none"||st.visibility==="hidden"||st.visibility==="collapse"||
           st.opacity==="0"||r.width<=0||r.height<=0)return false;
        // Exact transport popup observed in both source snapshots:
        // the application may resize/reposition it on different screens.
        // Keep the historical geometry guard for untyped legacy panels.
        if(r.width>230&&r.height>260&&r.right>innerWidth*.6)return true;
        return Boolean(e.closest?.('[templateforlog="ContractorCard/Cards/transportCard:All"]'))&&
          r.right>0&&r.left<innerWidth&&r.bottom>0&&r.top<innerHeight;
      };
      // Summary tiles also say "Грузовые 220", but only this
      // right-hand template with caption "Автопарк" owns the tree.
      const panels=[...document.querySelectorAll(
        ".controls-StackTemplate-content"
      )].filter(e=>visible(e)&&[...e.querySelectorAll(
        ".controls-StackTemplate__caption [title]"
      )].some(h=>h.getAttribute("title")==="Автопарк"));
      if(!panels.length)
        return {status:"invalid",reason:"tree_missing",detail:"panel_not_visible_or_missing"};
      if(panels.length!==1)
        return {status:"invalid",reason:"multiple_tree_panels"};
      const panel=panels[0];
      const lists=[...panel.querySelectorAll(".controls-ListViewV")];
      if(lists.length!==1)
        return {status:"invalid",reason:"tree_missing",detail:lists.length?"list_ambiguous":"list_missing"};
      const list=lists[0];
      const categories=[...list.querySelectorAll(
        '[data-qa="item"][item-key]:not([item-parent-key])'
      )].filter(e=>{
        const title=e.querySelector(".controls-fontsize-2xl");
        return title&&norm(title.textContent)===category;
      });
      if(!categories.length)
        return {status:"invalid",reason:"truck_category_missing"};
      if(categories.length!==1)
        return {status:"invalid",reason:"truck_category_ambiguous"};
      const group=categories[0],key=group.getAttribute("item-key");
      if(!/^-\d{1,9}$/.test(key||""))
        return {status:"invalid",reason:"invalid_group_key"};
      const countNodes=[...group.querySelectorAll(".controls-DecoratorNumber")];
      const countText=norm(countNodes[0]?.textContent).replace(/\s+/g,"");
      const announced=Number(countText);
      if(countNodes.length!==1||!/^\d{1,5}$/.test(countText)||
         announced<1||announced>5000||(!discover&&announced!==expected))
        return {status:"invalid",reason:"truck_count_mismatch"};
      // The exact negative numeric group key was validated above.
      // Let the browser select only its children instead of repeatedly
      // materializing all categories' thousands of vehicle DOM handles.
      const vehicleEls=[...list.querySelectorAll(
        '[data-qa="item"][item-parent-key="'+key+'"][item-key]'
      )];
      const rows=[];
      for(const element of vehicleEls){
        // First direct model child only: gray VIN and GRZ metadata
        // are separate children inside the SAME vehicle row.
        const content=element.querySelector(
          ".controls-margin_left-2xs.controls-padding_left-3xl"
        );
        const first=content?.querySelector(":scope > div:first-child");
        rows.push({
          key:element.getAttribute("item-key"),
          label:norm(first?.textContent)
        });
      }
      const footerKey="node-footer-"+key;
      const footers=[...list.querySelectorAll(
        '[data-qa="item"][item-key="'+footerKey+'"]'
      )];
      if(footers.length>1)
        return {status:"invalid",reason:"footer_ambiguous"};
      const footer=footers[0]||null;
      const button=footer?.querySelector('[data-qa="navigation-button"]');
      const hasMore=Boolean(button&&button.querySelector(
        '[title="Ещё"]'
      )&&button.classList.contains("controls-BigSeparator__collapsed"));
      // Both state classes were confirmed on the same live Saby
      // transportCard:All drawer, before and after a manual collapse.
      // Absence of rows alone is NOT evidence that a group is collapsed.
      let expanderState="unknown";
      if(panel.closest('[templateforlog="ContractorCard/Cards/transportCard:All"]')&&
         group.classList.contains("controls-Tree__item")&&
         group.querySelectorAll(".controls-fontsize-2xl").length===1){
        const expanders=[...group.querySelectorAll('[data-qa="item-expander"]')];
        if(expanders.length===1){
          const el=expanders[0],cls=el.classList,r=el.getBoundingClientRect(),css=getComputedStyle(el);
          const collapsed=cls.contains("controls-TreeGrid__row-expander_collapsed")&&
            cls.contains("controls-TreeGrid__row-expander_hiddenNode_default_collapsed");
          const expanded=cls.contains("controls-TreeGrid__row-expander_expanded")&&
            cls.contains("controls-TreeGrid__row-expander_hiddenNode_default_expanded");
          const contradictory=collapsed&&(
            cls.contains("controls-TreeGrid__row-expander_expanded")||
            cls.contains("controls-TreeGrid__row-expander_hiddenNode_default_expanded"))||
            expanded&&(cls.contains("controls-TreeGrid__row-expander_collapsed")||
            cls.contains("controls-TreeGrid__row-expander_hiddenNode_default_collapsed"));
          if(r.width>0&&r.height>0&&css.display!=="none"&&css.visibility==="visible"&&
             css.opacity!=="0"&&collapsed!==expanded&&!contradictory)
            expanderState=collapsed?"collapsed":"expanded";
        }
      }
      return {status:"observed",expected:announced,groupKey:key,
        category,footerKey,rows,hasMore,expanderState};
    },{expected,discover,category});
  }catch {
    return {status:"invalid",reason:"read_failed"};
  }
}

// Set a category state using ONLY the live observed expander selector.
// Navigation and count/category proof are independently rechecked before
// every action. Unknown/ambiguous layouts do not authorize any click.
// A caller must treat "clicked" as an action, never as proof of new rows.
export async function setSabyFleetCategoryExpanded(page,{
  originalUrl,category,expected,groupKey,expanded,read=readSabyFleetTree,
  timeoutMs=2500
}={}){
  const same=()=>compareSabyVerifiedFleetDetail(originalUrl,page?.url?.()).ok===true;
  if(!same())return "wrong_company";
  if(!isSabyVehicleCategory(category)||!Number.isSafeInteger(expected)||expected<1||expected>5000||
     !sabyFleetTreeFooterKey(groupKey)||typeof expanded!=="boolean"||
     typeof read!=="function"||typeof page?.locator!=="function")return "unavailable";
  const wanted=expanded?"expanded":"collapsed",from=expanded?"collapsed":"expanded";
  try{
    const snapshot=await read(page,{expected,category});
    if(!same())return "wrong_company";
    if(snapshot?.status!=="observed"||snapshot.category!==category||
       snapshot.expected!==expected||snapshot.groupKey!==groupKey||
       !Array.isArray(snapshot.rows)||snapshot.rows.length>expected||
       (snapshot.expanderState==="collapsed"&&(snapshot.rows.length||snapshot.hasMore===true)))
      return "unavailable";
    if(snapshot.expanderState===wanted)return "already";
    if(snapshot.expanderState!==from)return "unavailable";
    const panel=page.locator('[templateforlog="ContractorCard/Cards/transportCard:All"] '+
      '.controls-StackTemplate-content:has(.controls-StackTemplate__caption [title="Автопарк"])')
      .filter({visible:true});
    if(await panel.count()!==1)return "unavailable";
    const list=panel.locator(".controls-ListViewV");
    if(await list.count()!==1)return "unavailable";
    const categoryText=new RegExp("^\\s*"+category+"\\s*$","u");
    const countText=new RegExp("^\\s*"+String(expected).split("").join("\\s*")+"\\s*$","u");
    const group=list.locator('[data-qa="item"][item-key="'+groupKey+'"].controls-Tree__item:not([item-parent-key])')
      .filter({has:page.locator(".controls-fontsize-2xl").filter({hasText:categoryText})})
      .filter({has:page.locator(".controls-DecoratorNumber").filter({hasText:countText})});
    if(await group.count()!==1)return "unavailable";
    const target=group.locator('[data-qa="item-expander"].controls-TreeGrid__row-expander_'+from+
      '.controls-TreeGrid__row-expander_hiddenNode_default_'+from+
      ':not(.controls-TreeGrid__row-expander_'+wanted+')'+
      ':not(.controls-TreeGrid__row-expander_hiddenNode_default_'+wanted+')');
    if(await target.count()!==1||!await target.isVisible())return "unavailable";
    if(!same())return "wrong_company";
    // The state-specific locator cannot toggle a control that already
    // transitioned to the desired state. No force/coordinates/JS click.
    await target.click({timeout:Math.max(1,Math.min(2500,timeoutMs))});
    return same()?"clicked":"wrong_company";
  }catch{return same()?"click_failed":"wrong_company";}
}

/**
 * Bounded authorized expansion using exact Saby tree identifiers.
 * Vehicle keys stay internal; final XLSX receives model and year only.
 */
export async function collectSabyFleetTree(page,{
  expected,originalUrl,wait=ms=>new Promise(r=>setTimeout(r,ms)),
  now=()=>Date.now(),maxClicks=20,maxMs=175000,
  maxPolls=14,pollMs=300,read=readSabyFleetTree,initialSnapshot=null,category="Грузовые"
}={}){
  let samples=0,clicks=0,rows=[],groupKey=null,status="incomplete",
    reason="invalid_setup";
  const sameCompany=()=>sabyCardRoute(page?.url?.())==="detail"&&
    compareSabyVerifiedFleetDetail(originalUrl,page.url()).ok===true;
  const report=()=>({
    ...safeSabyFleetTreeReport({status,reason,expected,rows:rows.length,
      clicks,samples,same_company:sameCompany()}),
    // Private in-memory records only. Never place them in log progress.
    vehicles:status==="complete"?
      rows.map(({model,year})=>({model,year})):null
  });
  if(!isSabyVehicleCategory(category)||!Number.isSafeInteger(expected)||expected<1||expected>5000||
     typeof wait!=="function"||typeof now!=="function"||
     typeof read!=="function"||!page?.locator||!sameCompany()){
    reason="wrong_company";return report();
  }
  if(initialSnapshot!==null){
    const seed=validateSabyFleetTreeSnapshot(initialSnapshot,{expected,category});
    if(seed.status!=="valid"){reason=seed.reason;return report();}
    rows=seed.rows;groupKey=seed.groupKey;
    // Do not accept even a complete seed without an independent fresh
    // read confirming its category, count and ordered prefix.
  }
  const deadline=now()+Math.min(180000,Math.max(1000,maxMs));
  const limit=Math.min(24,Math.max(1,Math.floor(maxClicks)));
  const polls=Math.min(25,Math.max(1,Math.floor(maxPolls)));
  for(let round=0;round<=limit;round++){
    if(!sameCompany()){reason="wrong_company";break;}
    if(now()>=deadline){reason="time_limit";break;}
    const raw=await read(page,{expected,category});samples++;
    const verified=validateSabyFleetTreeSnapshot(raw,{
      expected,previousRows:rows,previousGroupKey:groupKey,category
    });
    if(verified.status!=="valid"){reason=verified.reason;break;}
    rows=verified.rows;groupKey=verified.groupKey;
    if(rows.length===expected){
      if(sameCompany()){reason="complete";status="complete";}
      else reason="wrong_company";
      break;
    }
    if(round===limit){reason="click_limit";break;}
    if(!verified.hasMore){reason="footer_missing";break;}
    const footerKey=sabyFleetTreeFooterKey(groupKey);
    if(footerKey!==verified.footerKey){reason="invalid_group_key";break;}
    // In the REAL HTML, title="Ещё" belongs to the CHILD of
    // the navigation button, never to the button itself.
    const selector='[data-qa="item"][item-key="'+footerKey+'"] '+
      '[data-qa="navigation-button"].controls-BigSeparator__collapsed'+
      ':has([title="Ещё"])';
    const locator=page.locator(selector);
    const count=await locator.count().catch(()=>0);
    if(count!==1){reason="button_missing";break;}
    if(!sameCompany()){reason="wrong_company";break;}
    try{
      await locator.click({timeout:6500});clicks++;
    }catch{reason="click_failed";break;}
    if(!sameCompany()){reason="wrong_company";break;}
    let grown=false,invalid=null;
    for(let p=0;p<polls;p++){
      if(now()>=deadline){reason="time_limit";break;}
      await wait(Math.max(100,Math.min(900,pollMs)));
      if(!sameCompany()){reason="wrong_company";break;}
      const update=await read(page,{expected,category});samples++;
      const checked=validateSabyFleetTreeSnapshot(update,{
        expected,previousRows:rows,previousGroupKey:groupKey,category
      });
      if(checked.status!=="valid"){
        // Wasaby may temporarily unmount the list during an accepted
        // footer update. Keep the existing poll deadline, exact count,
        // group ID and ordered prefix; never click again during the
        // remount. A real contradiction is still immediately fatal.
        if(["tree_missing","read_failed"].includes(checked.reason))continue;
        invalid=checked.reason;break;
      }
      if(checked.rows.length>rows.length){
        rows=checked.rows;
        grown=true;break;
      }
    }
    if(invalid){reason=invalid;break;}
    if(!sameCompany()){reason="wrong_company";break;}
    if(!grown){if(reason==="time_limit")break;
      reason="no_growth";break;}
  }
  return report();
}


/**
 * Read a genuinely open same-company drawer when the preview tile was
 * absent, not a speculative click target. Count comes ONLY from the
 * unique exact structural truck header. Missing category/count is
 * unknown, never zero. The normal collector re-reads and locks the
 * discovered count, group and ordered prefix before any footer click.
 */
export async function recoverSabyFleetFromOpenDrawer(page,{
  originalUrl,read=readSabyFleetTree,collect=collectSabyFleetTree,
  wait,maxClicks,maxMs
}={}){
  const same=()=>compareSabyVerifiedFleetDetail(originalUrl,page?.url?.()).ok===true;
  const incomplete=(reason,expected=null)=>({
    ...safeSabyFleetTreeReport({reason,expected,same_company:same()}),vehicles:null
  });
  if(!same())return incomplete("wrong_company");
  let snapshot;
  try{snapshot=await read(page,{discoverCount:true});}
  catch{return incomplete("read_failed");}
  if(!same())return incomplete("wrong_company");
  const expected=snapshot?.expected;
  const checked=validateSabyFleetTreeSnapshot(snapshot,{expected});
  if(checked.status!=="valid")return incomplete(checked.reason);
  // Use the existing semantic full collector: no new panel opener,
  // no arbitrary controls, no alternative route/identity acceptance.
  const result=await collect(page,{expected,originalUrl,read,wait,maxClicks,maxMs,
    initialSnapshot:snapshot});
  if(!same())return incomplete("wrong_company",expected);
  if(result?.status!=="complete"||result.expected!==expected||
     !Array.isArray(result.vehicles)||result.vehicles.length!==expected)
    return {...safeSabyFleetTreeReport(result),status:"incomplete",vehicles:null};
  return result;
}
