// Evidence-conservative carry-forward from a user-supplied earlier regional export.
// An earlier run is NEVER a source of new legal identities or CRM prospects.
// Only an exact checksum-valid INN AND the same normalized legal name can
// transfer a missing field. Each field needs its own old same-INN excerpt+URL.
// All transferred values are explicitly marked historical, not live-verified.
const SECTIONS = ["direct_buyers", "intermediaries", "leasing"];
const FIELDS = ["Телефон", "Руководитель / ЛПР",
  "Управляющая компания", "Выручка последнего подтвержденного года", "Численность"];
const value = x => String(x ?? "").trim();
const present = x => value(x) !== "" &&
  !/^(?:н\/д|не найден|не установлен|не подтвержден|нет данных)/i.test(value(x));
const normalize = x => value(x).toLowerCase().replace(/ё/g,"е")
  .replace(/[^a-zа-я0-9]+/gu,"");
export function normalizedLegalName(raw) {
  const txt = value(raw).toLowerCase().replace(/ё/g,"е")
    .replace(/общество с ограниченной ответственностью|публичное акционерное общество|открытое акционерное общество|закрытое акционерное общество|акционерное общество|индивидуальный предприниматель/gu, " ")
    .replace(/[^a-zа-я0-9]+/gu," ")
    .replace(/(?:^|\s)(?:ооо|ао|пао|оао|зао|ип)(?=\s|$)/gu, " ");
  return txt.replace(/[^a-zа-я0-9]+/gu,"");
}
export function checkedInn(raw) {
  const inn = value(raw).replace(/\s/g,"");
  if (!/^(?:\d{10}|\d{12})$/.test(inn)) return "";
  const digits = [...inn].map(Number);
  const check = (index,weights) => weights.reduce((n,w,i)=>n+w*digits[i],0)%11%10 === digits[index];
  if (inn.length===10) return check(9,[2,4,10,3,5,9,4,6,8])?inn:"";
  return check(10,[7,2,4,10,3,5,9,4,6,8]) &&
    check(11,[3,7,2,4,10,3,5,9,4,6,8])?inn:"";
}
const isUrl = raw => {
  try {const u=new URL(value(raw));return ["http:","https:"].includes(u.protocol) && u.hostname.includes(".");}
  catch{return false;}
};
const rowsOf = obj => SECTIONS.flatMap(sheet => (obj?.[sheet] || []).map(row=>({sheet,row})));
const queueRows = obj => [
  ...(obj?.qualification_review_v8 || obj?.qualification_review || []).map(row=>({status:"REVIEW",row})),
  ...(obj?.qualification_excluded_v8 || obj?.qualification_excluded || []).map(row=>({status:"EXCLUDED",row}))
];
function indexByInn(entries) {
 const map=new Map();
 for(const entry of entries){
  const inn=checkedInn(entry.row?.["ИНН"]); if(!inn)continue;
  if(!map.has(inn))map.set(inn,[]);
  map.get(inn).push(entry);
 }
 return map;
}
function provenanceForValue(oldRow, inn, field, expected) {
 const ev=oldRow?.__evidence || {};
 const urls=new Set((ev.source_urls || []).filter(isUrl));
 const observed=Array.isArray(ev.identity_observed_facts)?ev.identity_observed_facts:[];
 for(const fact of observed) {
   if(fact?.field!==field||value(fact.inn)!==inn||!isUrl(fact.source_url)||
      !urls.has(fact.source_url)||!present(fact.value))continue;
   const same = field==="Телефон"
     ? value(fact.value).replace(/\D/g,"")===value(expected).replace(/\D/g,"")
     : normalize(fact.value)===normalize(expected);
   if(!same)continue;
   const quote=value(fact.excerpt);
   const quoteDigits=quote.replace(/\D/g,"");
   if(!quoteDigits.includes(inn))continue;
   const quotedValue = field==="Телефон" ||
     field==="Выручка последнего подтвержденного года" || field==="Численность"
      ? quoteDigits.includes(value(expected).replace(/\D/g,""))
      : normalize(quote).includes(normalize(expected));
   if(!quotedValue)continue;
   return {field,value:expected,inn,source_url:fact.source_url,
     excerpt:quote.slice(0,500),method:"historical_same_inn_source_excerpt",
     live_rechecked:false};
 }
 return null;
}
/**
 * @returns {{result: object, report: object}} Cloned current result + audit.
 * The earlier baseline is never mutated, and unmatched baseline leads never
 * automatically re-enter commercial/REVIEW/EXCLUDED queues of the new run.
 */
export function reconcileReference(current, reference, { referenceAsOf = "" } = {}) {
 if(!current || !reference || SECTIONS.some(s=>!Array.isArray(current[s])||!Array.isArray(reference[s])))
   throw new TypeError("Both sources must include complete final_result commercial arrays");
 const result=structuredClone(current), newRows=rowsOf(result);
 // Full legacy v8 exports may repeat the SAME current REVIEW/EXCLUDED rows
 // inside commercial arrays. They are not historical commercial prospects.
 const legacyCurrentQueues=(Array.isArray(reference.qualification_review_v8) ||
   Array.isArray(reference.qualification_excluded_v8));
 const legacyQueued=new Map(legacyCurrentQueues
   ? queueRows(reference).map(x=>[value(x.row.__canonical_id),x.row]) : []);
 let baselineQueueDuplicatesCollapsed=0;
 const oldRows=rowsOf(reference).filter(({row})=>{
   const id=value(row.__canonical_id),queue=legacyQueued.get(id);
   if(!queue||JSON.stringify(queue)!==JSON.stringify(row))return true;
   baselineQueueDuplicatesCollapsed++;return false;
 });
 const oldByInn=indexByInn(oldRows), newByInn=indexByInn(newRows);
 const allNewByInn=indexByInn([...newRows,...queueRows(result).map(x=>({sheet:x.status,row:x.row}))]);
 const oldOnly=[], ambiguous=[], carried=[], unavailable=[], identityConflicts=[];
 let paired=0, sameInn=0, oldCommercialWithoutInn=0;
 for(const {sheet:oldSheet,row:oldRow} of oldRows) {
   const inn=checkedInn(oldRow?.["ИНН"]);
   if(!inn){oldCommercialWithoutInn++;continue;}
   const candidates=newByInn.get(inn)||[];
   const sameName=candidates.filter(c=>normalizedLegalName(c.row["Организация"]) &&
     normalizedLegalName(c.row["Организация"])===normalizedLegalName(oldRow["Организация"]));
   if(candidates.length) sameInn++;
   if((oldByInn.get(inn)||[]).length!==1||candidates.length!==1||sameName.length!==1){
     const other=allNewByInn.get(inn)||[];
     const reason=other.length===0?"absent_from_all_new_queues":
       other.every(x=>x.sheet==="REVIEW"||x.sheet==="EXCLUDED")?"now_only_review_or_excluded":
       candidates.length?"same_inn_legal_name_or_count_conflict":"unresolved_identity";
     const item={inn,old_name:value(oldRow["Организация"]),old_sheet:oldSheet,
       old_canonical_id:value(oldRow.__canonical_id),reason,
       new_names:other.map(x=>value(x.row["Организация"])),
       old_source_urls:(oldRow.__evidence?.source_urls||[]).filter(isUrl).slice(0,5)};
     oldOnly.push(item);
     if(reason!=="absent_from_all_new_queues" && reason!=="now_only_review_or_excluded") ambiguous.push(item);
     continue;
   }
   paired++;
   const newRow=sameName[0].row;
   for(const field of FIELDS) {
     if(!present(oldRow[field])||present(newRow[field]))continue;
     const matched=provenanceForValue(oldRow,inn,field,oldRow[field]);
     if(!matched) {
       unavailable.push({inn,organization:value(newRow["Организация"]),field,
         old_value:oldRow[field],reason:"no_exact_old_same_inn_field_source"});
       continue;
     }
     newRow[field]=oldRow[field];
     newRow.__evidence ||= {};
     newRow.__evidence.historical_carry_forward ||= [];
     const event={...matched,reference_as_of:referenceAsOf||"unspecified",
       reference_canonical_id:value(oldRow.__canonical_id),review_currentness:true};
     newRow.__evidence.historical_carry_forward.push(event);
     newRow.__evidence.source_urls ||= [];
     if(!newRow.__evidence.source_urls.includes(matched.source_url))
       newRow.__evidence.source_urls.push(matched.source_url);
     carried.push({inn,organization:value(newRow["Организация"]),field,
       value:oldRow[field],source_url:matched.source_url,reference_as_of:referenceAsOf||"unspecified"});
   }
   // Email is kept inside evidence and has the same exact-excerpt guard.
   const oldEmail=oldRow.__evidence?.email,newEmail=newRow.__evidence?.email;
   if(present(oldEmail)&&!present(newEmail)) {
     const e=provenanceForValue(oldRow,inn,"Email",oldEmail);
     if(e){
       newRow.__evidence ||= {};
       newRow.__evidence.email=oldEmail;
       newRow.__evidence.historical_carry_forward ||= [];
       newRow.__evidence.historical_carry_forward.push({...e,
         reference_as_of:referenceAsOf||"unspecified",review_currentness:true});
       newRow.__evidence.source_urls ||= [];
       if(!newRow.__evidence.source_urls.includes(e.source_url))
         newRow.__evidence.source_urls.push(e.source_url);
       // A newly recovered, sourced email must not leave a stale "not found"
       // value in the first-column Excel note.
       const oldComment=value(newRow.__comment);
       if(oldComment && /^Email:/m.test(oldComment)) {
         newRow.__comment=oldComment.replace(/^Email:.*$/m,"Email: "+oldEmail);
       }
       carried.push({inn,organization:value(newRow["Организация"]),field:"Email",
         value:oldEmail,source_url:e.source_url,reference_as_of:referenceAsOf||"unspecified"});
     }
   }
 }
 const oldNameIndex=new Map();
 for(const {row} of oldRows){const key=normalizedLegalName(row["Организация"]);if(!key)continue;
   if(!oldNameIndex.has(key))oldNameIndex.set(key,[]);
   oldNameIndex.get(key).push(row);
 }
 for(const {sheet,row} of newRows){
   const key=normalizedLegalName(row["Организация"]);
   const inn=checkedInn(row["ИНН"]);
   if(!key||!inn)continue;
   for(const older of oldNameIndex.get(key)||[]){
     const previous=checkedInn(older["ИНН"]);
     if(previous&&previous!==inn)identityConflicts.push({
       name:value(row["Организация"]),new_inn:inn,old_inn:previous,
       old_canonical_id:value(older.__canonical_id),new_canonical_id:value(row.__canonical_id)});
   }
 }
 const count=(r)=>SECTIONS.reduce((sum,s)=>sum+r[s].length,0);
 const report={
  reference_as_of:referenceAsOf||"unspecified",source_rechecked:false,
  paid_api_calls:0,commercial_before:count(current),commercial_after:count(result),
  current_review_before:(current.qualification_review||[]).length,
  current_review_after:(result.qualification_review||[]).length,
  current_excluded_before:(current.qualification_excluded||[]).length,
  current_excluded_after:(result.qualification_excluded||[]).length,
  old_commercial_records:oldRows.length,
  baseline_current_queue_duplicates_collapsed:baselineQueueDuplicatesCollapsed,
  old_commercial_without_valid_inn:oldCommercialWithoutInn,
  same_inn_compared:sameInn,safe_exact_identity_pairs:paired,
  historical_fields_carried:carried.length,historical_field_carry:carried,
  historical_fields_not_carried:unavailable.length,historical_field_review:unavailable,
  reference_only_or_unresolved_records:oldOnly.length,reference_review:oldOnly,
  ambiguous_identity_records:ambiguous.length,ambiguous_identity_review:ambiguous,
  same_legal_name_different_inn:identityConflicts.length,identity_conflicts:identityConflicts,
  old_records_auto_added:0,unverified_fields_auto_restored:0,
  matching_rule:"checksum_valid_inn_plus_exact_normalized_legal_name_and_unique_pair",
  field_rule:"exact_same_inn_observed_fact_excerpt_and_existing_source_url; no live verification"
 };
 return {result,report};
}
