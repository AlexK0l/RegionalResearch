// Exact source categories, not inferred classes from a model label.
import {isSabyTruckVehicleLabel} from "./sabyVehicleLabels.js";
export const SABY_VEHICLE_CATEGORIES=Object.freeze(["Легковые","Коммерческие","Грузовые","Автобусы","Спецтехника","Прицепы","Мотоциклы"]);
export const isSabyVehicleCategory=v=>SABY_VEHICLE_CATEGORIES.includes(v);
export function parseSabyVehicleModel(raw){
  const label=String(raw||"").replace(/\s+/g," ").trim();
  if(!isSabyTruckVehicleLabel(label))return null;
  const match=label.match(/^(.+?)[,;]\s*((?:19|20)\d{2})(?:\s*г\.?)?$/u);
  const model=match?match[1].trim():label,year=match?Number(match[2]):null;
  if(!isSabyTruckVehicleLabel(model)||year!==null&&year>new Date().getUTCFullYear()+1)return null;
  return {model,year};
}
export function verifiedSabyVehicleFleet(raw){
  if(raw?.status!=="verified"||!Number.isSafeInteger(raw.count)||raw.count<1||raw.count>35000||
     !Array.isArray(raw.groups)||!raw.groups.length||raw.groups.length>7)return null;
  const used=new Set(),groups=[];let sum=0;
  for(const g of raw.groups){
    if(!isSabyVehicleCategory(g?.category)||used.has(g.category)||
       !Number.isSafeInteger(g.count)||g.count<1||g.count>5000||
       !Array.isArray(g.vehicles)||g.vehicles.length!==g.count)return null;
    used.add(g.category);sum+=g.count;
    const vehicles=[];
    for(const v of g.vehicles){
      const model=String(v?.model||"").replace(/\s+/g," ").trim(),year=v?.year??null;
      if(!isSabyTruckVehicleLabel(model)||year!==null&&(!Number.isInteger(year)||year<1900||year>new Date().getUTCFullYear()+1))return null;
      vehicles.push({model,year});
    }
    groups.push({category:g.category,count:g.count,vehicles});
  }
  if(sum!==raw.count)return null;
  groups.sort((a,b)=>SABY_VEHICLE_CATEGORIES.indexOf(a.category)-SABY_VEHICLE_CATEGORIES.indexOf(b.category));
  return {status:"verified",count:sum,groups};
}


// A partial observation retains only complete individual groups, not a
// guessed inventory. The advertised total is kept as source metadata.
export function verifiedSabyVehiclePartial(raw){
  if(raw?.status!=="partial"||!Number.isSafeInteger(raw.announced_count)||
     raw.announced_count<1||raw.announced_count>35000||
     !Array.isArray(raw.categories)||!raw.categories.length||raw.categories.length>7||
     !Array.isArray(raw.groups)||raw.groups.length>7)return null;
  const counts=new Map();let total=0;
  for(const g of raw.categories){
    if(!isSabyVehicleCategory(g?.category)||counts.has(g.category)||
       !Number.isSafeInteger(g.count)||g.count<1||g.count>5000)return null;
    counts.set(g.category,g.count);total+=g.count;
  }
  if(total!==raw.announced_count)return null;
  const seen=new Set(),groups=[];
  for(const g of raw.groups){
    if(counts.get(g?.category)!==g?.count||seen.has(g.category))return null;
    const validated=verifiedSabyVehicleFleet({status:"verified",count:g.count,groups:[g]});
    if(!validated)return null;
    seen.add(g.category);
    groups.push({...validated.groups[0],
      ...(typeof g.observed_at==="string"&&Number.isFinite(Date.parse(g.observed_at))?
        {observed_at:g.observed_at}:{})});
  }
  const order=(a,b)=>SABY_VEHICLE_CATEGORIES.indexOf(a.category)-SABY_VEHICLE_CATEGORIES.indexOf(b.category);
  return {status:"partial",announced_count:total,
    categories:[...counts].map(([category,count])=>({category,count})).sort(order),
    groups:groups.sort(order)};
}

// Do not promote observations from separate visits to a verified whole.
// Carry a previously completed category only if the newly reconciled
// summary still announces its exact count; label its own observation date.
// Count changes make old categories ineligible for the current inventory.
export function mergeSabyVehiclePartial(fresh,prior,observedAt){
  const current=verifiedSabyVehiclePartial(fresh),old=verifiedSabyVehiclePartial(prior);
  if(!current)return old;
  const groups=current.categories.flatMap(g=>{
    const live=current.groups.find(x=>x.category===g.category);
    if(live)return [{...live,observed_at:observedAt}];
    const saved=old?.groups.find(x=>x.category===g.category&&x.count===g.count);
    return saved?[saved]:[];
  });
  return {...current,groups};
}
export function sabyVehicleSnapshotAgrees(whole,partial){
  if(!whole||!partial||whole.count!==partial.announced_count||
     whole.groups.length!==partial.categories.length)return false;
  const multiset=g=>JSON.stringify(g.vehicles.map(v=>JSON.stringify([v.model,v.year])).sort());
  return partial.categories.every(g=>{
    const old=whole.groups.find(x=>x.category===g.category);
    const live=partial.groups.find(x=>x.category===g.category);
    return old?.count===g.count&&(!live||multiset(live)===multiset(old));
  });
}
