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

const reasons=new Set([
  "complete","invalid_setup","wrong_company","tree_missing",
  "multiple_tree_panels","truck_category_missing",
  "truck_category_ambiguous","truck_count_mismatch",
  "invalid_group_key","invalid_item_key","duplicate_item_key",
  "invalid_model","invalid_row_count","row_prefix_changed",
  "footer_missing","footer_ambiguous","footer_not_collapsed",
  "button_missing","click_failed","no_growth","click_limit",
  "time_limit","read_failed"
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
  snapshot,{expected,previousRows=[],previousGroupKey=null}={}
){
  if(snapshot?.status!=="observed")
    return {status:"invalid",reason:reasons.has(snapshot?.reason)?
      snapshot.reason:"tree_missing"};
  if(!Number.isSafeInteger(expected)||expected<1||expected>5000)
    return {status:"invalid",reason:"invalid_setup"};
  if(snapshot.expected!==expected)
    return {status:"invalid",reason:"truck_count_mismatch"};
  if(!sabyFleetTreeFooterKey(snapshot.groupKey))
    return {status:"invalid",reason:"invalid_group_key"};
  if(previousGroupKey!==null&&previousGroupKey!==snapshot.groupKey)
    return {status:"invalid",reason:"invalid_group_key"};
  if(!Array.isArray(snapshot.rows)||snapshot.rows.length>expected)
    return {status:"invalid",reason:"invalid_row_count"};
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

export async function readSabyFleetTree(page,{expected}={}){
  if(!Number.isSafeInteger(expected)||expected<1||expected>5000||
     sabyCardRoute(page?.url?.())!=="detail")
    return {status:"invalid",reason:"invalid_setup"};
  try {
    return await page.evaluate(({expected})=>{
      const norm=t=>String(t||"").replace(/\s+/g," ").trim();
      const visible=e=>{
        if(!e?.getBoundingClientRect)return false;
        const r=e.getBoundingClientRect(),st=getComputedStyle(e);
        return r.width>230&&r.height>260&&st.display!=="none"&&
          st.visibility!=="hidden"&&r.right>innerWidth*.6;
      };
      // Summary tiles also say "Грузовые 220", but only this
      // right-hand template with caption "Автопарк" owns the tree.
      const panels=[...document.querySelectorAll(
        ".controls-StackTemplate-content"
      )].filter(e=>visible(e)&&[...e.querySelectorAll(
        ".controls-StackTemplate__caption [title]"
      )].some(h=>h.getAttribute("title")==="Автопарк"));
      if(!panels.length)
        return {status:"invalid",reason:"tree_missing"};
      if(panels.length!==1)
        return {status:"invalid",reason:"multiple_tree_panels"};
      const panel=panels[0];
      const lists=[...panel.querySelectorAll(".controls-ListViewV")];
      if(lists.length!==1)
        return {status:"invalid",reason:"tree_missing"};
      const list=lists[0];
      const categories=[...list.querySelectorAll(
        '[data-qa="item"][item-key]:not([item-parent-key])'
      )].filter(e=>{
        const title=e.querySelector(".controls-fontsize-2xl");
        return title&&norm(title.textContent)==="Грузовые";
      });
      if(!categories.length)
        return {status:"invalid",reason:"truck_category_missing"};
      if(categories.length!==1)
        return {status:"invalid",reason:"truck_category_ambiguous"};
      const group=categories[0],key=group.getAttribute("item-key");
      if(!/^-\d{1,9}$/.test(key||""))
        return {status:"invalid",reason:"invalid_group_key"};
      const countText=norm(group.querySelector(
        ".controls-DecoratorNumber"
      )?.textContent).replace(/\s+/g,"");
      const announced=Number(countText);
      if(!/^\d{1,5}$/.test(countText)||announced!==expected)
        return {status:"invalid",reason:"truck_count_mismatch"};
      const vehicleEls=[...list.querySelectorAll(
        '[data-qa="item"][item-parent-key][item-key]'
      )].filter(el=>el.getAttribute("item-parent-key")===key);
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
        '[data-qa="item"][item-key]'
      )].filter(el=>el.getAttribute("item-key")===footerKey);
      if(footers.length>1)
        return {status:"invalid",reason:"footer_ambiguous"};
      const footer=footers[0]||null;
      const button=footer?.querySelector('[data-qa="navigation-button"]');
      const hasMore=Boolean(button&&button.querySelector(
        '[title="Ещё"]'
      )&&button.classList.contains("controls-BigSeparator__collapsed"));
      return {status:"observed",expected:announced,groupKey:key,
        footerKey,rows,hasMore};
    },{expected});
  }catch {
    return {status:"invalid",reason:"read_failed"};
  }
}

/**
 * Bounded authorized expansion using exact Saby tree identifiers.
 * Vehicle keys stay internal; final XLSX receives model and year only.
 */
export async function collectSabyFleetTree(page,{
  expected,originalUrl,wait=ms=>new Promise(r=>setTimeout(r,ms)),
  now=()=>Date.now(),maxClicks=20,maxMs=175000,
  maxPolls=14,pollMs=300,read=readSabyFleetTree
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
  if(!Number.isSafeInteger(expected)||expected<1||expected>5000||
     typeof wait!=="function"||typeof now!=="function"||
     typeof read!=="function"||!page?.locator||!sameCompany()){
    reason="wrong_company";return report();
  }
  const deadline=now()+Math.min(180000,Math.max(1000,maxMs));
  const limit=Math.min(24,Math.max(1,Math.floor(maxClicks)));
  const polls=Math.min(25,Math.max(1,Math.floor(maxPolls)));
  for(let round=0;round<=limit;round++){
    if(!sameCompany()){reason="wrong_company";break;}
    if(now()>=deadline){reason="time_limit";break;}
    const raw=await read(page,{expected});samples++;
    const verified=validateSabyFleetTreeSnapshot(raw,{
      expected,previousRows:rows,previousGroupKey:groupKey
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
      const update=await read(page,{expected});samples++;
      const checked=validateSabyFleetTreeSnapshot(update,{
        expected,previousRows:rows,previousGroupKey:groupKey
      });
      if(checked.status!=="valid"){
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
