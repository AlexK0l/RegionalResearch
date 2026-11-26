// A conflicting phone must have entity-specific evidence. A model's
// boolean "confirmed" alone cannot authorize sharing it between companies.
import {normalizeRussianPhone,validHttpUrl} from "./researchCostPolicy.js";
import {parsePhoneEntries} from "./phoneExport.js";

const validInn=value=>/^(?:\d{10}|\d{12})$/.test(String(value??"").trim())?String(value).trim():"";
const text=value=>typeof value==="string"?value.trim():"";
export function phoneConflictKey(rowId,inn,phone){
  const id=text(rowId),legal=validInn(inn),normalized=normalizeRussianPhone(phone);
  return id&&legal&&normalized?JSON.stringify([id,legal,normalized]):"";
}
function exactInnInExcerpt(excerpt,inn){
  return new RegExp("(?:^|[^0-9])"+inn+"(?:[^0-9]|$)","u").test(excerpt);
}
export function assessPhoneConflictProof(raw,{rowId,inn,phone}={}){
  const expectedInn=validInn(inn),expectedPhone=normalizeRussianPhone(phone),id=text(rowId);
  if(!raw||!id||!expectedInn||!expectedPhone||validInn(raw.inn)!==expectedInn||
    normalizeRussianPhone(raw.phone)!==expectedPhone||typeof raw.confirmed!=="boolean")return null;
  const base={row_id:id,inn:expectedInn,phone:expectedPhone,note:text(raw.note).slice(0,300)};
  if(!raw.confirmed)return {...base,status:"not_confirmed",reason:"no_attributed_phone_found"};
  const source=text(raw.source_url),excerpt=text(raw.evidence_excerpt).slice(0,1200);
  if(!validHttpUrl(source)||!exactInnInExcerpt(excerpt,expectedInn)||
    !parsePhoneEntries(excerpt).some(entry=>entry.phone===expectedPhone))
    return {...base,status:"unproven",reason:"missing_exact_inn_phone_source_excerpt"};
  return {...base,status:"confirmed",source_url:source,evidence_excerpt:excerpt};
}
export function restorePhoneConflictProof(raw,target){
  if(!raw||raw.row_id!==target.rowId||
    phoneConflictKey(raw.row_id,raw.inn,raw.phone)!==phoneConflictKey(target.rowId,target.inn,target.phone))return null;
  if(raw.status==="confirmed"){
    const checked=assessPhoneConflictProof({...raw,confirmed:true},target);
    return checked?.status==="confirmed"?checked:null;
  }
  if(raw.status==="not_confirmed"||raw.status==="unproven"){
    return {row_id:raw.row_id,inn:raw.inn,phone:raw.phone,status:raw.status,
      note:text(raw.note).slice(0,300),reason:raw.status==="not_confirmed"?
        "no_attributed_phone_found":"missing_exact_inn_phone_source_excerpt"};
  }
  return null;
}
