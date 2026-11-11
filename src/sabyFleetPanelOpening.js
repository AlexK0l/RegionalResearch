// Saby's contractor fleet side panel hydrates asynchronously. A preview
// click does not imply the panel has appeared. This helper only coordinates
// bounded waits; it cannot verify a legal entity or any vehicle inventory.
// All injected browser reads are first-party and performed separately.
export async function openSabyFleetPanelWithHydration({
  clickPreview,
  readPanel,
  observePanel=async()=>({}),
  wait=async()=>{},
  maxClicks=2,
  pollsPerClick=20,
  pollMs=400
}={}) {
  const fail=(reason,clicks,polls,titleSeen)=>({
    opened:false,reason,clicks,polls,titleSeen
  });
  if(typeof clickPreview!=="function"||typeof readPanel!=="function"||
     typeof observePanel!=="function"||typeof wait!=="function")
    return fail("invalid_setup",0,0,false);

  const clickLimit=Math.max(1,Math.min(2,Math.floor(maxClicks)||2));
  const pollLimit=Math.max(1,Math.min(25,Math.floor(pollsPerClick)||20));
  const delayMs=Math.max(100,Math.min(1000,Math.floor(pollMs)||400));
  let clicks=0,polls=0,titleSeen=false;
  for(let attempt=0;attempt<clickLimit;attempt++) {
    // "false" means the original contractor-detail URL changed, or the
    // independently verified preview target is no longer usable. Never
    // click at outdated coordinates after a navigation.
    const clicked=await clickPreview();
    if(clicked===false) return fail("preview_click_unavailable",clicks,polls,titleSeen);
    clicks++;
    for(let poll=0;poll<pollLimit;poll++) {
      // Do not conclude that the panel is absent from a single immediate
      // DOM read: an Saby panel may hydrate several seconds after a click.
      const panel=await readPanel();
      polls++;
      if(panel?.routeChanged===true)
        return fail("detail_changed",clicks,polls,titleSeen);
      if(panel?.opened===true)
        return {opened:true,reason:"panel_ready",panel,
          clicks,polls,titleSeen};
      if(poll%3===0||poll===pollLimit-1) {
        const observed=await observePanel();
        if(observed?.fleet_panel_title===true||
           (typeof observed?.truck_category_labels==="number"&&
            observed.truck_category_labels>1))
          titleSeen=true;
      }
      if(poll<pollLimit-1)await wait(delayMs);
    }
    // When there is evidence of an already open panel but its precise
    // headings/count are not recognized, a second click may CLOSE it.
    // Stop instead: an unrecognized panel is not proof of an empty fleet.
    if(titleSeen)
      return fail("panel_unrecognized",clicks,polls,titleSeen);
    if(attempt+1<clickLimit)await wait(delayMs);
  }
  return fail("panel_not_observed",clicks,polls,titleSeen);
}
