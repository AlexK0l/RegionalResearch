// One-company, headed Saby fleet tree drawer opener.
// The v26 VPS showed a first click changed only the SAME company's
// UI route, after which the old helper prohibited a second click at
// stale saved coordinates. The tree never started: fleet_tree=null.
// This opener reads the real Wasaby tree before and after clicking and
// ALWAYS re-locates the unique current preview tile for any retry.
// Never click when an already-visible drawer may be merely hydrating.
const fixedReasons=new Set([
  "panel_ready","panel_unrecognized","preview_click_unavailable",
  "detail_changed","panel_not_observed","invalid_setup"
]);
const result=(opened,reason,clicks,polls,titleSeen)=>({
  opened,reason:fixedReasons.has(reason)?reason:"invalid_setup",
  clicks,polls,titleSeen
});

export async function openSabyVerifiedFleetTreePanel({
  expected,readTree,readPreview,clickPreview,
  panelVisible,sameCompany,wait=async()=>{},
  maxClicks=2,pollsPerClick=20,pollMs=400
}={}){
  let clicks=0,polls=0,titleSeen=false;
  const finish=(opened,reason)=>result(
    opened,reason,clicks,polls,titleSeen);
  if(!Number.isSafeInteger(expected)||expected<1||expected>5000||
     [readTree,readPreview,clickPreview,panelVisible,sameCompany,wait]
       .some(x=>typeof x!=="function"))
    return finish(false,"invalid_setup");
  const clickLimit=Math.min(2,Math.max(1,Math.floor(maxClicks)||2));
  const pollLimit=Math.min(25,Math.max(1,Math.floor(pollsPerClick)||20));
  const pause=Math.min(1000,Math.max(100,Math.floor(pollMs)||400));

  // Tree and panel-caption reads occur only inside an independently
  // verified first-party company detail. An unexpected change fails
  // closed even if a previous read looked valid.
  const inspect=async()=>{
    if(!sameCompany())return "detail_changed";
    let tree;
    try{tree=await readTree();}
    catch{return "panel_unrecognized";}
    polls++;
    if(!sameCompany())return "detail_changed";
    if(tree?.status==="observed"){
      if(tree?.expected!==expected)return "panel_unrecognized";
      titleSeen=true;
      return "panel_ready";
    }
    // A wrong company/category/count or ambiguous Saby tree is not
    // permission to toggle the drawer a second time.
    if(["multiple_tree_panels","truck_count_mismatch",
        "truck_category_ambiguous","invalid_group_key",
        "footer_ambiguous"].includes(tree?.reason))
      return "panel_unrecognized";
    let present=false;
    try{present=await panelVisible();}
    catch{return "panel_unrecognized";}
    if(!sameCompany())return "detail_changed";
    titleSeen||=present===true;
    return "pending";
  };

  const initial=await inspect();
  if(initial==="panel_ready")return finish(true,"panel_ready");
  if(initial!=="pending")return finish(false,initial);
  for(let attempt=0;attempt<clickLimit;attempt++){
    if(!sameCompany())return finish(false,"detail_changed");
    if(!titleSeen){
      // A SPA UI-only route change is safe ONLY after the original
      // identity/opaque-ID guard, and ONLY with a fresh, unique target
      // belonging to the same 220-truck preview. Coordinates are NEVER
      // reused from the previous page state.
      let live;
      try{live=await readPreview();}
      catch{return finish(false,"preview_click_unavailable");}
      if(!sameCompany())return finish(false,"detail_changed");
      if(live?.status!=="found"||live?.count!==expected||
         !live.rect||!Number.isFinite(live.rect.x)||
         !Number.isFinite(live.rect.y)||
         !Number.isFinite(live.rect.w)||
         !Number.isFinite(live.rect.h)||
         live.rect.w<110||live.rect.h<85)
        return finish(false,"preview_click_unavailable");
      try{
        const accepted=await clickPreview(live);
        if(accepted!==true)return finish(false,
          sameCompany()?"preview_click_unavailable":"detail_changed");
      }catch{return finish(false,"preview_click_unavailable");}
      clicks++;
      if(!sameCompany())return finish(false,"detail_changed");
    }
    for(let n=0;n<pollLimit;n++){
      if(n>0)await wait(pause);
      const observed=await inspect();
      if(observed==="panel_ready")return finish(true,"panel_ready");
      if(observed!=="pending")return finish(false,observed);
    }
    // A known visible "Автопарк" drawer must never be toggled
    // closed merely because its category list is still hydrating.
    if(titleSeen)return finish(false,"panel_unrecognized");
    if(attempt+1<clickLimit)await wait(pause);
  }
  return finish(false,"panel_not_observed");
}
