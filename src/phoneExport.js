// The export contract for the existing Excel "Телефон" column.
//
// Visible cells may contain ONLY numbers, optionally followed by a department
// explicitly stated by a source. No URLs, sites, Saby labels, e-mail, names,
// provenance notes, or free-form descriptions. All provenance remains in the
// established company comment / __evidence; no new XLSX columns.
//
// This module is deliberately pure: exports never modify their source JSON.
import { normalizeRussianPhone } from "./researchCostPolicy.js";

const PHONE_PATTERN = /(?<!\d)(?:\+7|7|8)(?:[\s().-]*\d){10}(?!\d)/g;
const LOCAL_PATTERN = /(?<!\d)(?:\(\d{3}\)|\d{3})(?:[\s().-]*\d){7}(?!\d)/g;
const KNOWN_DEPARTMENTS = [
  ["отдел продаж",/отдел\s+продаж|sales\s+department/i],
  ["отдел закупок",/отдел\s+закупок/i],
  ["отдел снабжения",/отдел\s+снабжения/i],
  ["отдел логистики",/отдел\s+логистики/i],
  ["транспортный отдел",/транспортн(?:ый|ого)\s+отдел/i],
  ["коммерческий отдел",/коммерческ(?:ий|ого)\s+отдел/i],
  ["отдел кадров",/отдел\s+кадров/i],
  ["бухгалтерия",/бухгалтер(?:ия|ии)|accounting/i],
  ["приёмная",/при[её]мн(?:ая|ой)|reception/i],
  ["диспетчерская",/диспетчерск(?:ая|ой)/i],
  ["сервисный отдел",/сервисн(?:ый|ого)\s+отдел/i],
  ["отдел поддержки",/отдел\s+поддержки|техническ(?:ая|ой)\s+поддержк/i],
  ["склад",/(?:^|[\s:])склад(?:$|[\s:.,;])/i],
  ["отдел аренды",/отдел\s+аренды/i],
  ["отдел по работе с клиентами",/отдел\s+по\s+работе\s+с\s+клиентами/i],
  ["секретариат",/секретариат/i],
  ["юридический отдел",/юридическ(?:ий|ого)\s+отдел/i]
];
const PHONE_CONTEXT = /тел(?:ефон)?\.?|факс|моб\.?|контакт|phone|call/i;
const INN_CONTEXT = /(?:^|\W)(?:инн|огрн|кпп|inn)(?:\W|$)/i;

export function explicitPhoneDepartment(text) {
  const value=String(text || "").slice(0,250);
  const found=KNOWN_DEPARTMENTS.filter(([,matcher])=>matcher.test(value));
  return found.length===1 ? found[0][0] : "";
}

function segmentCandidates(segment) {
  const matches=[];
  for (const match of segment.matchAll(PHONE_PATTERN)) {
    const phone=normalizeRussianPhone(match[0]);
    if (phone) matches.push({phone,at:match.index,length:match[0].length});
  }
  // Local ten-digit numbers are ambiguous with an INN: accept only a phone
  // context, or when a whole cell is itself a formatted number.
  if (!matches.length &&
      (PHONE_CONTEXT.test(segment) ||
       (!INN_CONTEXT.test(segment) &&
        /^[\s()+\d.-]{10,26}$/.test(segment)))) {
    for (const match of segment.matchAll(LOCAL_PATTERN)) {
      const phone=normalizeRussianPhone(match[0]);
      if(phone)matches.push({phone,at:match.index,length:match[0].length});
    }
  }
  return matches;
}

export function parsePhoneEntries(value) {
  if (value == null || value === "") return [];
  const segments=(Array.isArray(value)?value:[value])
    .flatMap(part=>String(part ?? "").split(/[;\r\n]+/));
  const entries=new Map();
  const disputedDepartments=new Set();
  for (const raw of segments) {
    const segment=raw.trim();
    if (!segment) continue;
    const candidates=segmentCandidates(segment);
    if (!candidates.length) continue;
    const department=explicitPhoneDepartment(segment);
    for(const {phone} of candidates) {
      const prior=entries.get(phone);
      if(!prior) {
        entries.set(phone,{phone,department});
      } else if (prior.department!==department) {
        // Once different labels are seen, do not assign any department later.
        if(prior.department && department) {
          prior.department="";
          disputedDepartments.add(phone);
        } else if(department && !prior.department &&
                  !disputedDepartments.has(phone)) prior.department=department;
      }
    }
  }
  return [...entries.values()];
}

export function formatPhoneCell(value) {
  return parsePhoneEntries(value)
    .map(({phone,department})=>phone+(department?" ("+department+")":""))
    .join("; ");
}

// Saby's contact section can have a department on the immediately preceding
// line. Trust this only when that line contains JUST a known department label.
export function extractSabyPhoneDetails(text) {
  const lines=String(text || "").split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const found=[];
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    const current=parsePhoneEntries(line);
    if(!current.length)continue;
    const localDepartment=explicitPhoneDepartment(line);
    let previousDepartment="";
    if(!localDepartment && i>0) {
      const prev=lines[i-1];
      if(prev.length<=65 && !parsePhoneEntries(prev).length &&
         !/https?:|@|инн|огрн|кпп|контакты\s+связанных/i.test(prev)) {
        previousDepartment=explicitPhoneDepartment(prev);
      }
    }
    for(const e of current)found.push({
      phone:e.phone,department:localDepartment||previousDepartment||""
    });
  }
  const result=new Map();
  const disputedDepartments=new Set();
  for(const entry of found) {
    const prior=result.get(entry.phone);
    if(!prior)result.set(entry.phone,{...entry});
    else if(prior.department&&entry.department&&prior.department!==entry.department) {
      prior.department="";
      disputedDepartments.add(entry.phone);
    } else if(!prior.department&&entry.department&&!disputedDepartments.has(entry.phone)){
      prior.department=entry.department;
    }
  }
  return [...result.values()];
}

export function sanitizedPhoneWorkbookData(result) {
  if (!result || typeof result!=="object") return result;
  const out={...result};
  for(const section of ["direct_buyers","intermediaries","leasing"]){
    if(!Array.isArray(result[section]))continue;
    out[section]=result[section].map(row=>row && typeof row==="object" ?
      {...row,"Телефон":formatPhoneCell(row["Телефон"])}:row);
  }
  return out;
}
