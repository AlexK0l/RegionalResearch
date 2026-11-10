// Saby identity audit: evidence comparison ONLY. This module never decides
// whether to copy contacts, vehicles or other CRM data into the research.
// A matching INN in a search row is not proof of identity in the detail card.
import {sabyInn, sabyNameTokens, sabyNameMatches} from "./sabyEnrichment.js";

const compact=value=>String(value??"").normalize("NFKC")
  .replace(/\s+/g," ").trim();
const lineList=text=>String(text||"").slice(0,135000)
  .split(/[\r\n]+/).map(compact).filter(Boolean);
const fieldLimit=value=>compact(value).slice(0,250);
const legalTypes=[
  ["ПАО",/^(?:ПАО|ПУБЛИЧНОЕ\s+АКЦИОНЕРНОЕ\s+ОБЩЕСТВО)\b/i],
  ["ОАО",/^(?:ОАО|ОТКРЫТОЕ\s+АКЦИОНЕРНОЕ\s+ОБЩЕСТВО)\b/i],
  ["ЗАО",/^(?:ЗАО|ЗАКРЫТОЕ\s+АКЦИОНЕРНОЕ\s+ОБЩЕСТВО)\b/i],
  ["ООО",/^(?:ООО|ОБЩЕСТВО\s+С\s+ОГРАНИЧЕННОЙ\s+ОТВЕТСТВЕННОСТЬЮ)\b/i],
  ["АО",/^(?:АО|АКЦИОНЕРНОЕ\s+ОБЩЕСТВО)\b/i],
  ["ИП",/^(?:ИП|ИНДИВИДУАЛЬНЫЙ\s+ПРЕДПРИНИМАТЕЛЬ)\b/i]
];
export function auditLegalForm(name) {
  const text=compact(name).replace(/^[«"']+|[»"']+$/g,"");
  for(const [type,re] of legalTypes)
    if(re.test(text))return type;
  const suffix=/,\s*(ООО|ПАО|АО|ОАО|ЗАО|ИП)\s*$/i.exec(text);
  return suffix?suffix[1].toUpperCase():"";
}
export function auditCompareName(expected,observed) {
  const left=sabyNameTokens(expected),right=sabyNameTokens(observed);
  if(!left.length)return "source_name_invalid";
  if(!right.length)return "not_available";
  const formA=auditLegalForm(expected),formB=auditLegalForm(observed);
  if(formA&&formB&&formA!==formB)return "legal_form_conflict";
  if(sabyNameMatches(expected,observed))return "normalized_equal";
  const acronym=left.map(x=>x[0]).join("");
  if(right.length===1 && left.length>1 &&
     right[0].replace(/[^a-zа-я0-9]/giu,"")===acronym)
    return "initials_candidate";
  if(right.join("").length<left.join("").length &&
     (right.length===1 || left.some(t=>t.startsWith(right[0]))))
    return "short_name_candidate";
  if(right.some(t=>left.includes(t)))return "partial_overlap";
  return "different";
}
const parseField=(lines,start,end,forms)=>{
  // This list is always fixed internal label strings, never user input.
  const labels=forms.join("|");
  const re=new RegExp("^(?:"+labels+")(?:\\s*[:：]\\s*(.*))?$","i");
  for(let i=start;i<Math.min(end,lines.length);i++){
    const found=re.exec(lines[i]);
    if(!found)continue;
    const value=compact(found[1]||lines[i+1]||"");
    if(!value || value.length>250)continue;
    return value;
  }
  return "";
};
// Require a real "Реквизиты" section and labelled title/INN fields in the
// SAME bounded block. Generic mentions elsewhere are not identity evidence.
export function auditExtractRequisites(text) {
  const lines=lineList(text),records=[];
  for(let i=0;i<lines.length && records.length<10;i++){
    if(!/^(?:Реквизиты|Регистрационные данные)$/i.test(lines[i]))continue;
    const end=Math.min(lines.length,i+55);
    const name=parseField(lines,i+1,Math.min(end,i+32),[
      "Название","Полное название","Полное наименование",
      "Юридическое наименование","Наименование организации"
    ]);
    const inn=parseField(lines,i+1,end,["ИНН"]);
    const kpp=parseField(lines,i+1,end,["КПП"]);
    const ogrn=parseField(lines,i+1,end,["ОГРН"]);
    // A navigation tab labelled "Реквизиты" is not a section. Require a
    // name or exact-length registration identifier inside the block.
    if(!name && !sabyInn(inn))continue;
    records.push({name:fieldLimit(name),inn:sabyInn(inn),
      kpp:/^\d{9}$/.test(kpp)?kpp:"",
      ogrn:/^(?:\d{13}|\d{15})$/.test(ogrn)?ogrn:""});
  }
  return [...new Map(records.map(r=>[JSON.stringify(r),r])).values()];
}
export function auditLabelledInns(text) {
  const lines=lineList(text).slice(0,100);
  const inns=new Set();
  for(let i=0;i<lines.length;i++){
    let m=/^ИНН(?:\s*[:：№#-])?\s*(\d{10}|\d{12})$/i.exec(lines[i]);
    if(m)inns.add(m[1]);
    if(/^ИНН(?:\s*[:：№#-])?$/i.test(lines[i])){
      m=/^(\d{10}|\d{12})$/.exec(lines[i+1]||"");
      if(m)inns.add(m[1]);
    }
  }
  return [...inns];
}
export function auditSearchName(rowText,inn) {
  const first=String(rowText||"").split(/[\r\n|·]/,1)[0];
  const result=fieldLimit(first);
  return result===String(inn)?"":result;
}
export function auditSelectSearchResult(candidates,inn,expectedName) {
  const rows=(Array.isArray(candidates)?candidates:[]).filter(row=>
    new RegExp("(?:^|\\D)"+String(inn)+"(?!\\d)").test(String(row?.text||"")));
  const names=rows.map(row=>auditSearchName(row.text,inn)).filter(Boolean);
  const exact=rows.filter(row=>auditCompareName(expectedName,
    auditSearchName(row.text,inn))==="normalized_equal");
  if(exact.length===1)return {row:exact[0],kind:"exact_name",
    count:rows.length,names};
  if(exact.length>1)return {row:null,kind:"ambiguous_exact",
    count:rows.length,names};
  if(rows.length===1)return {row:rows[0],kind:"unique_inn",
    count:rows.length,names};
  return {row:null,kind:rows.length?"ambiguous":"not_found",
    count:rows.length,names};
}
const statusInn=(expected,observed)=>{
  if(!sabyInn(expected))return "invalid_source";
  if(!observed)return "not_available";
  return observed===expected?"exact":"mismatch";
};
export function auditCompareIdentity(source,observation) {
  const inn=sabyInn(source?.["ИНН"]);
  const name=fieldLimit(source?.["Организация"]);
  const observed=observation||{};
  const requisites=Array.isArray(observed.requisites) ? observed.requisites : [];
  const matching=requisites.filter(r=>r.inn===inn);
  const rec=matching.length===1 ? matching[0] :
    requisites.length===1 ? requisites[0] : null;
  const detailInns=Array.isArray(observed.detailInns)?observed.detailInns:[];
  const detailInn=detailInns.length===1 ? detailInns[0] : "";
  const title=fieldLimit(observed.title);
  const searchName=fieldLimit(observed.searchName);
  const reqName=fieldLimit(rec?.name);
  const result={
    source_inn:String(source?.["ИНН"]??"").trim(),
    source_name:name,
    saby_search_inn:observed.searchCount>0 ? inn : "",
    saby_search_name:searchName,
    saby_search_names:(observed.searchNames||[]).slice(0,12).map(fieldLimit),
    saby_search_count:Number(observed.searchCount||0),
    saby_search_selection:String(observed.searchSelection||""),
    saby_title_name:title,
    saby_title_candidates:(observed.headings||[]).slice(0,12).map(fieldLimit),
    saby_detail_inn:detailInn,
    saby_detail_inns:detailInns.slice(0,12),
    saby_requisites_name:reqName,
    saby_requisites_inn:String(rec?.inn||""),
    saby_requisites_kpp:String(rec?.kpp||""),
    saby_requisites_candidates:requisites.slice(0,10),
    saby_detail_route:String(observed.route||""),
    requisites_surface:String(observed.requisitesSurface||""),
    search_name_relation:auditCompareName(name,searchName),
    title_relation:auditCompareName(name,title),
    requisites_relation:auditCompareName(name,reqName),
    detail_inn_relation:detailInns.length>1?"multiple":
      statusInn(inn,detailInn),
    requisites_inn_relation:requisites.length>1 && matching.length!==1 ?
      "multiple" : statusInn(inn,String(rec?.inn||"")),
    result:"review",
    reason:"insufficient_evidence"
  };
  if(!inn||!sabyNameTokens(name).length){
    result.result="source_invalid";result.reason="source_inn_or_name_invalid";
  } else if(observed.failure){
    result.result="error";result.reason=String(observed.failure).slice(0,120);
  } else if(!result.saby_search_count){
    result.result="not_found";result.reason="search_no_exact_inn";
  } else if(!observed.opened){
    result.result="ambiguous";result.reason="detail_not_opened";
  } else if(result.detail_inn_relation==="mismatch" ||
      result.requisites_inn_relation==="mismatch"){
    result.result="conflict";result.reason="inn_mismatch";
  } else if(result.detail_inn_relation==="multiple" ||
      result.requisites_inn_relation==="multiple"){
    result.reason="multiple_inns_in_detail";
  } else if(result.requisites_inn_relation==="exact" &&
      result.requisites_relation==="normalized_equal" &&
      result.detail_inn_relation==="exact"){
    result.result="verified";result.reason="full_requisites_and_title_inn";
  } else if(result.requisites_inn_relation==="exact" &&
      ["different","legal_form_conflict"].includes(result.requisites_relation)){
    result.result="conflict";result.reason="registered_name_mismatch";
  } else if(result.detail_inn_relation==="exact" &&
      result.title_relation==="normalized_equal"){
    result.reason="title_only_no_full_requisites";
  } else if(result.detail_inn_relation==="exact" &&
      ["short_name_candidate","initials_candidate"].includes(result.title_relation)){
    result.reason="short_title_without_registered_proof";
  } else if(result.detail_inn_relation==="not_available"){
    result.reason="detail_inn_not_verified";
  } else {
    result.reason="title_or_requisites_unverified";
  }
  return result;
}
