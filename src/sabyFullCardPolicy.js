// Preserve legacy visit history and derive a bounded two-attempt budget
// per unresolved SECTION. Do not infer completion from an attempted task.
// New masks are an immutable record of the sections requested on each
// committed card visit, including failed navigation/identity visits.
import {SABY_LEGACY_PHASES,SABY_FULL_CARD_PHASES} from "./sabyPassCursor.js";
export const FULL_CARD_SECTIONS=Object.freeze(["contacts","financials","trucks"]);
const fail=()=>{throw Error("SABY_FULL_CARD_CURSOR_INVALID");};
const blank=()=>({contacts:0,financials:0,trucks:0});
const record=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
function maskOf(value){
  if(!record(value)||Object.keys(value).sort().join(",")!=="contacts,financials,trucks"||
     !FULL_CARD_SECTIONS.every(k=>typeof value[k]==="boolean")||
     !FULL_CARD_SECTIONS.some(k=>value[k]))fail();
  return Object.fromEntries(FULL_CARD_SECTIONS.map(k=>[k,value[k]]));
}
export function fullCardLedger(state,{migrating=false}={}){
  const ids=new Set(state.planned_inns),attempted=new Set(state.attempted);
  const counts=new Map(state.planned_inns.map(id=>[id,blank()]));
  // Old contact visits count as contact attempts only. Opportunistic
  // visible-only details are NOT full attempts. A v2 explicit combined
  // attestation can consume the first full details visit for that section.
  // A legacy details_retry visit did allow another full detail attempt;
  // retain that bound (including unsuccessful searches).
  for(const [id,c] of counts){
    const seen=phase=>attempted.has(phase+":"+id);
    const combined=state.combined_detail_attempts?.[id];
    c.contacts=Number(seen("contacts"))+Number(seen("contact_retry"));
    for(const k of ["financials","trucks"]){
      c[k]=Number(seen("details")||combined?.[k]===true)+Number(seen("details_retry"));
    }
  }
  const source=state.full_card_attempts;
  if(!record(source))fail();
  const masks={};
  for(const key of attempted){
    const [phase,id,...rest]=key.split(":");
    if(rest.length||!ids.has(id))fail();
    if(SABY_LEGACY_PHASES.includes(phase))continue;
    if(migrating||!SABY_FULL_CARD_PHASES.includes(phase))fail();
    const mask=maskOf(source[key]);
    const c=counts.get(id);
    for(const section of FULL_CARD_SECTIONS){
      c[section]+=Number(mask[section]);
      if(c[section]>2)fail();
    }
    masks[key]=mask;
  }
  if(Object.keys(source).some(k=>!Object.hasOwn(masks,k)))fail();
  state.full_card_attempts=masks;
  return counts;
}
export function fullCardNeeds(gaps,phase,counts){
  const eligible=Object.fromEntries(FULL_CARD_SECTIONS.map(k=>[k,Boolean(gaps[k]&&counts[k]<2)]));
  // Finish first full attempts across the plan before pure retries. A
  // migrated company with one old contact visit and unattempted details
  // can fold its contact retry into that first full details visit.
  if(phase==="full"&&!FULL_CARD_SECTIONS.some(k=>eligible[k]&&counts[k]===0))
    return {contacts:false,financials:false,trucks:false};
  return {...eligible,optimized:true,combinedDetails:true,fullCard:true};
}
export function commitFullCardVisit(state,counts,key,sections){
  const [phase,id,...rest]=key.split(":");
  const c=counts.get(id);
  if(rest.length||!SABY_FULL_CARD_PHASES.includes(phase)||!c||
     Object.hasOwn(state.full_card_attempts,key))fail();
  const mask=maskOf(Object.fromEntries(FULL_CARD_SECTIONS.map(k=>[k,sections[k]===true])));
  if(FULL_CARD_SECTIONS.some(k=>mask[k]&&c[k]>=2))fail();
  for(const k of FULL_CARD_SECTIONS)c[k]+=Number(mask[k]);
  state.full_card_attempts[key]=mask;
}
