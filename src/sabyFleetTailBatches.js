// Continue a proven, incrementally expanding first-party truck DOM list
// after ONE successful three-dot click (40->102 on the real v22 run).
// The controller may click at most 3 more times, ONLY when each next
// full ordered truck prefix is independently re-read and the browser
// revalidates the same exact contractor/card ID, same truck count,
// exhausted row scrollbar and the stationary three-dot control.
// No clicking in standard production Stage12.
import {appendSabyTruckWindow} from "./sabyFleetWindows.js";

const bounded=(x,max)=>Number.isSafeInteger(x)&&x>=0?
  Math.min(x,max):null;
const reasons=new Set([
  "exact_count","invalid_setup","company_changed","panel_not_found",
  "invalid_rows","unanchored_window","ambiguous_overlap",
  "count_exceeded","scroll_unavailable","scroll_not_advanced",
  "scroll_limit","tail_not_ready","click_not_extended",
  "post_click_window_invalid","post_click_window_unchanged",
  "click_limit","time_limit"
]);

export function safeSabyFleetTailBatchReport(raw={}){
  return {
    status:raw?.status==="complete"?"complete":"incomplete",
    reason:reasons.has(raw?.reason)?raw.reason:"invalid_setup",
    rows_before:bounded(raw?.rows_before,5000),
    rows_after:bounded(raw?.rows_after,5000),
    extra_clicks:bounded(raw?.extra_clicks,3),
    additional_scroll_moves:bounded(raw?.additional_scroll_moves,48),
    rounds:bounded(raw?.rounds,3),
    tail_checks:bounded(raw?.tail_checks,3),
    last_click_status:[
      "rows_extended","rows_replaced","rows_unchanged","panel_closed",
      "target_missing","target_ambiguous","target_not_at_end",
      "target_not_pointer","target_blocked","click_failed",
      "company_changed","invalid_rows","not_eligible"
    ].includes(raw?.last_click_status)?
      raw.last_click_status:"not_attempted"
  };
}

export async function collectSabyFleetTailBatches({
  expected,initialRows,readWindow,advanceScroll,observeTail,
  clickTail,sameCompany,wait=async()=>{},now=()=>Date.now(),
  maxExtraClicks=3,maxScrollMoves=48,maxMovesPerRound=20,
  maxMs=85000
}={}){
  const valid=Number.isSafeInteger(expected)&&expected>1&&expected<=5000&&
    Array.isArray(initialRows)&&initialRows.length>=1&&
    initialRows.length<expected&&
    [readWindow,advanceScroll,observeTail,clickTail,sameCompany,wait,now]
      .every(x=>typeof x==="function");
  let rows=Array.isArray(initialRows)?[...initialRows]:[];
  const startCount=rows.length;
  let extraClicks=0,scrollMoves=0,rounds=0,tailChecks=0;
  let lastClickStatus="not_attempted";
  const result=(reason,completed=false)=>({
    ...safeSabyFleetTailBatchReport({
      status:completed?"complete":"incomplete",reason,
      rows_before:startCount,rows_after:rows.length,
      extra_clicks:extraClicks,additional_scroll_moves:scrollMoves,
      rounds,tail_checks:tailChecks,last_click_status:lastClickStatus
    }),
    rows
  });
  if(!valid)return result("invalid_setup");
  // Validate even the first already-stored prefix through the same
  // conservative assembler. A synthetic/invalid baseline can never be
  // promoted to a complete fleet by a later click.
  if(appendSabyTruckWindow([],rows,expected).status!=="advanced")
    return result("invalid_rows");
  const deadline=now()+Math.min(95000,Math.max(1000,maxMs));
  const clickLimit=Math.min(3,Math.max(0,Math.floor(maxExtraClicks)));
  const moveLimit=Math.min(48,Math.max(1,Math.floor(maxScrollMoves)));
  const roundLimit=Math.min(24,Math.max(1,Math.floor(maxMovesPerRound)));

  for(let round=0;round<clickLimit;round++){
    if(now()>=deadline)return result("time_limit");
    if(!sameCompany())return result("company_changed");
    rounds++;
    // Following a successful click, the scroller grows and is no
    // longer at its end (v22: 523 / 1893). Move to the NEW end.
    // Read after EVERY small scroll, and prove prefix continuity
    // even if lazy DOM rows appear during that scroll.
    let atEnd=false;
    for(let move=0;move<=roundLimit;move++){
      if(now()>=deadline)return result("time_limit");
      if(!sameCompany())return result("company_changed");
      const panel=await readWindow();
      if(panel?.routeChanged===true||!sameCompany())
        return result("company_changed");
      if(panel?.opened!==true||panel?.scroll?.available!==true)
        return result("panel_not_found");
      const combined=appendSabyTruckWindow(rows,panel.rows,expected);
      if(combined.status==="invalid")
        return result(["unanchored_window","ambiguous_overlap",
          "count_exceeded"].includes(combined.reason)?
            combined.reason:"invalid_rows");
      if(combined.status==="advanced")rows=combined.rows;
      if(rows.length===expected)return result("exact_count",true);
      if(panel.scroll.at_end===true){
        atEnd=true;break;
      }
      if(move>=roundLimit||scrollMoves>=moveLimit)
        return result("scroll_limit");
      const scrolled=await advanceScroll();
      if(scrolled?.routeChanged===true||!sameCompany())
        return result("company_changed");
      if(scrolled?.opened!==true||
         scrolled?.scroll?.available!==true)
        return result("scroll_unavailable");
      if(scrolled.scroll.moved!==true)
        return result("scroll_not_advanced");
      scrollMoves++;
      await wait(300);
    }
    if(!atEnd)return result("scroll_limit");
    if(!sameCompany())return result("company_changed");
    // Never click from cached v21/v22 coordinates. The real tail
    // must be independently observed at THIS expanded size and
    // pass all the existing nonanimated three-dot interaction checks.
    tailChecks++;
    const tail=await observeTail(rows.length);
    if(!sameCompany())return result("company_changed");
    if(now()>=deadline)return result("time_limit");
    if(tail?.status!=="observed"||
       tail?.sample_before?.truck_row_count!==rows.length||
       tail?.sample_after?.truck_row_count!==rows.length||
       tail?.truck_row_count_changed!==false)
      return result("tail_not_ready");
    const outcome=await clickTail(rows,tail);
    lastClickStatus=String(outcome?.status||"");
    if(!sameCompany())return result("company_changed");
    if(outcome?.click_attempted===true)extraClicks++;
    if(outcome?.status!=="rows_extended")
      return result("click_not_extended");
    if(extraClicks>clickLimit)
      return result("click_limit");
    // probeSabyFleetTailClick is intentionally value-free; read the
    // new full DOM again and prove all old records are a prefix.
    const after=await readWindow();
    if(after?.routeChanged===true||!sameCompany())
      return result("company_changed");
    if(after?.opened!==true)
      return result("panel_not_found");
    const merged=appendSabyTruckWindow(rows,after.rows,expected);
    if(merged.status==="invalid")
      return result("post_click_window_invalid");
    if(merged.status!=="advanced")
      return result("post_click_window_unchanged");
    rows=merged.rows;
    if(rows.length===expected)return result("exact_count",true);
  }
  return result("click_limit");
}
