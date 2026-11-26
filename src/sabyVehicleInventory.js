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
