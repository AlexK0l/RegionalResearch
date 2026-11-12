// Conservative ordered collection of virtualized Saby truck list windows.
// Never use a set of vehicle models: identical model/year rows can represent
// distinct trucks. Stitch ONLY attested contiguous DOM windows; if the
// boundary is uncertain, leave the whole fleet unverified.
import {isSabyTruckVehicleLabel} from "./sabyVehicleLabels.js";

const signature=row=>JSON.stringify([row?.model,row?.year??null]);
const match=(a,b)=>signature(a)===signature(b);
const same=(a,b)=>a.length===b.length&&a.every((v,i)=>match(v,b[i]));
const validRows=(rows,expected)=>Array.isArray(rows)&&
  rows.length<=expected&&rows.every(row=>
    row&&isSabyTruckVehicleLabel(row.model)&&
    (row.year===null || row.year===undefined ||
      (Number.isInteger(row.year)&&row.year>=1900&&row.year<=
        new Date().getUTCFullYear()+1)));

export function appendSabyTruckWindow(current,incoming,expected) {
  if(!Number.isSafeInteger(expected)||expected<1||expected>5000 ||
     !validRows(current,expected)||!validRows(incoming,expected))
    return {status:"invalid",reason:"invalid_rows",rows:current};
  if(!incoming.length)return {status:"unchanged",reason:"empty_window",rows:current};
  if(!current.length)return {status:"advanced",rows:[...incoming],
    added:incoming.length};
  // Non-virtualized lists can progressively append rows; preserve their
  // exact order, including repeated model/year values.
  if(incoming.length>=current.length &&
     current.every((v,i)=>match(v,incoming[i])))
    return incoming.length===current.length?
      {status:"unchanged",reason:"same_window",rows:current}:
      {status:"advanced",added:incoming.length-current.length,
        rows:[...incoming]};
  // A window already present in the accumulated list proves nothing new.
  for(let i=0;i<=current.length-incoming.length;i++){
    if(incoming.every((v,j)=>match(current[i+j],v)))
      return {status:"unchanged",reason:"same_window",rows:current};
  }
  // A moving viewport must overlap the PREVIOUS tail. Multiple possible
  // boundary offsets (e.g. many identical model rows) cannot be safely
  // disambiguated without stable row identifiers/indices: stay deferred.
  const overlaps=[];
  for(let k=2;k<=Math.min(current.length,incoming.length);k++) {
    if(current.slice(-k).every((v,i)=>match(v,incoming[i])))
      overlaps.push(k);
  }
  const extending=overlaps.filter(k=>k<incoming.length);
  if(extending.length!==1)
    return {status:"invalid",reason:extending.length?
      "ambiguous_overlap":"unanchored_window",rows:current};
  const overlap=extending[0];
  const next=[...current,...incoming.slice(overlap)];
  if(next.length>expected)
    return {status:"invalid",reason:"count_exceeded",rows:current};
  return {status:"advanced",rows:next,
    added:incoming.length-overlap};
}

/**
 * Browser interaction is injected, making no assumptions about Saby's
 * specific scrollbar DOM. A missing/ambiguous window or nonmoving scroller
 * is NEVER interpreted as a zero or complete fleet.
 */
export async function collectSabyTruckWindows({
  expected,readWindow,advanceScroll,wait=async()=>{},
  maxWindows=48,maxMs=60000,now=()=>Date.now(),
  maxStaleScrolls=6,maxScrollMoves=96
}={}) {
  if(!Number.isSafeInteger(expected)||expected<1||expected>5000||
     typeof readWindow!=="function"||typeof advanceScroll!=="function")
    return {status:"incomplete",reason:"invalid_setup",
      rows:[],windows:0,scrollMoves:0,staleScrollMoves:0,
      totalStaleScrollMoves:0};
  const until=now()+Math.max(1000,Math.min(90000,maxMs));
  const windowLimit=Math.max(1,Math.min(96,Math.floor(maxWindows)));
  const moveLimit=Math.max(1,Math.min(128,Math.floor(maxScrollMoves)));
  const staleLimit=Math.max(0,Math.min(12,Math.floor(maxStaleScrolls)));
  let rows=[],windows=0,scrollMoves=0,staleScrollMoves=0;
  let totalStaleScrollMoves=0;
  const result=(status,reason)=>({
    status,reason,rows,windows,scrollMoves,staleScrollMoves,
    totalStaleScrollMoves
  });
  while(windows<windowLimit && scrollMoves<=moveLimit && now()<until) {
    let progress=false;
    // A first scroll can move a panel without changing its rendered 40
    // vehicles. For example, a lazy loader may update only near the end.
    // Inspect the complete window after EACH move, then allow a bounded
    // number of additional short scrolls if it is still exactly unchanged.
    // A changed-but-noncontiguous window is always rejected immediately.
    for(let poll=0;poll<5&&now()<until;poll++){
      const panel=await readWindow();
      if(panel?.routeChanged===true)
        return result("incomplete","detail_changed");
      if(panel?.opened===true) {
        const merged=appendSabyTruckWindow(rows,panel.rows,expected);
        if(merged.status==="invalid")
          return result("incomplete",merged.reason);
        if(merged.status==="advanced"){
          rows=merged.rows;
          windows++;
          progress=true;
          staleScrollMoves=0;
          break;
        }
      }
      if(poll<4)await wait(350);
    }
    if(rows.length===expected)
      return result("complete","exact_count");
    if(!progress){
      if(!rows.length)return result("incomplete","window_not_updated");
      staleScrollMoves++;
      totalStaleScrollMoves++;
      if(staleScrollMoves>staleLimit)
        return result("incomplete","window_not_updated");
    }
    if(scrollMoves>=moveLimit)
      return result("incomplete","bounded_limit");
    const scroll=await advanceScroll();
    if(scroll?.routeChanged===true)
      return result("incomplete","detail_changed");
    if(scroll?.opened!==true||scroll?.scroll?.moved!==true)
      return result("incomplete","scroll_not_advanced");
    scrollMoves++;
    await wait(450);
  }
  return result("incomplete","bounded_limit");
}
