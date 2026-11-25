// Pure, offline Saby data policy. Browser DOM is untrusted; do not change a CRM
// row until legal identity and the source have both passed validation.
import { normalizeRussianPhone } from "./researchCostPolicy.js";
import { formatPhoneCell, parsePhoneEntries, explicitPhoneDepartment } from "./phoneExport.js";
import { mergeCompanyEmail,companyEmailCell } from "./emailContact.js";
import { validSabyFinancialEvidence } from "./sabyFinancials.js";

const LEGAL_WORDS = new Set([
  "ооо", "ао", "пао", "оао", "зао", "ип", "общество", "с",
  "ограниченной", "ответственностью", "акционерное",
  "публичное", "открытое", "закрытое", "индивидуальный",
  "предприниматель"
]);

export function sabyInn(value) {
  const inn = String(value ?? "").trim();
  return /^(?:\d{10}|\d{12})$/.test(inn) ? inn : "";
}

export function sabyNameTokens(name) {
  return (String(name ?? "").normalize("NFKC").toLowerCase()
    .replace(/ё/g, "е").match(/[a-zа-я0-9]+/gu) || [])
    .filter(token => !LEGAL_WORDS.has(token));
}

export function sabyNameMatches(expected, observed) {
  const source = sabyNameTokens(expected);
  const actual = sabyNameTokens(observed);
  return source.length > 0 && actual.length === source.length &&
    source.every((token, index) => token === actual[index]);
}

// The first line of a Saby search row is the legal name; subsequent lines
// may contain city, CEO, activity. Do not confuse "Альфа" with "Альфа-Трейд".
export function sabySearchResultMatches(expected, candidateText, inn) {
  const prefix = String(candidateText || "").split(String(inn), 1)[0];
  const firstLine = prefix.split(/[\n\r|·]/, 1)[0].trim();
  return sabyNameMatches(expected, firstLine);
}

export function isSabyProfileUrl(value) {
  try {
    const u = new URL(String(value || ""));
    return u.protocol === "https:" && u.hostname === "profile.saby.ru" &&
      !u.username && !u.password;
  } catch { return false; }
}

function verifiedTrucks(record) {
  const fleet = record?.trucks;
  if (fleet?.status !== "verified" || !Number.isSafeInteger(fleet.count) ||
      fleet.count < 0 || fleet.count > 5000 || !Array.isArray(fleet.vehicles) ||
      fleet.vehicles.length !== fleet.count) return null;
  const vehicles = [];
  for (const raw of fleet.vehicles) {
    const model = String(raw?.model || "").replace(/\s+/g, " ").trim();
    const year = raw?.year ? Number(raw.year) : null;
    if (model.length < 3 || model.length > 150 || /(?:\.\.\.|…)\s*$/.test(model) ||
        !/[a-zа-яё]/iu.test(model) || (year !== null &&
        (!Number.isInteger(year) || year < 1900 || year > new Date().getUTCFullYear()+1))) {
      return null;
    }
    vehicles.push({ model, year });
  }
  return { count: fleet.count, vehicles };
}

// Saby only: recognize a persisted, first-party, company-scoped section.
// This is not a new legal-identity verifier; a subsequent browser attempt
// still has to verify the company before applying ANY fresh data.
// Older Stage12 evidence stores a verified truck inventory without the
// `status` field (unlike a fresh browser record). Require the original
// explicit Saby category/source plus the same strict count/model validation.
function verifiedStoredTrucks(stored) {
  if(stored?.source!=="SABY"||stored?.category!=="Грузовые")
    return null;
  return verifiedTrucks({trucks:{...stored,status:"verified"}});
}
export function sabyStoredSectionCoverage(row,{transport=false}={}) {
  const stored=row?.__evidence?.saby;
  const sourceInn=sabyInn(row?.["ИНН"]);
  const trusted=Boolean(sourceInn && stored?.inn===sourceInn &&
    isSabyProfileUrl(stored?.source_url) && stored?.collection);
  const contacts=trusted&&stored.collection.contacts==="collected";
  const trucks=trusted&&stored.collection.trucks==="verified"&&
    verifiedStoredTrucks(stored.trucks)!==null;
  return {trusted,contacts,trucks,
    complete:contacts&&(!transport||trucks)};
}

// Legacy v11 evidence had no KPP field. To carry verified sections across
// a later retry, demand either the same non-empty 9-digit KPP or the same
// first-party private card identifier. Never mix distinct Saby cards on
// the strength of an INN alone (branches can share that INN).
function sabyDetailId(url) {
  try {
    const u=new URL(String(url||""));
    return u.protocol==="https:" && u.hostname==="profile.saby.ru" &&
      u.pathname==="/page/contractor-info" ?
      String(u.searchParams.get("id")||"").trim():"";
  } catch {return "";}
}
function canCarrySabyEvidence(stored,record) {
  if(!stored||stored.inn!==sabyInn(record?.identity?.inn) ||
     !isSabyProfileUrl(stored.source_url) ||
     !isSabyProfileUrl(record?.source_url))return false;
  const a=String(stored.kpp||""),b=String(record?.identity?.kpp||"");
  if(a&&b&&a!==b)return false;
  const oldId=sabyDetailId(stored.source_url),
    newId=sabyDetailId(record.source_url);
  if(oldId&&newId&&oldId!==newId)return false;
  return Boolean((/^\d{9}$/.test(a) && a===b) ||
    (oldId&&oldId===newId));
}

export function fleetSummary(fleet) {
  if (!fleet || fleet.count === 0) return "";
  const groups = new Map();
  for (const {model, year} of fleet.vehicles) {
    const key = JSON.stringify([model, year]);
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  return [...groups].sort((a, b) => a[0].localeCompare(b[0], "ru"))
    .map(([key, count]) => {
      const [model, year] = JSON.parse(key);
      return model + (year ? " (" + year + " г.)" : "") + " — " + count + " шт.";
    }).join("; ");
}

function hasKnownPhone(value) {
  return parsePhoneEntries(value).length > 0;
}

export function sabyMissingFinancials(row) {
  const known=value=>(typeof value==="number"||
    typeof value==="string"&&/^\d+$/.test(value.trim()))&&
    Number.isSafeInteger(Number(value))&&Number(value)>=0;
  return !known(row?.["Выручка последнего подтвержденного года"])||
    !known(row?.["Численность"]);
}
export function sabyEligibleRows(result,{includeFinanceGaps=false,includeAll=false}={}) {
  const groups = [
    ...(result?.direct_buyers || []).map(row => ({row, transport:true})),
    ...(result?.intermediaries || []).map(row => ({row, transport:false})),
    ...(result?.leasing || []).map(row => ({row, transport:false}))
  ];
  const counts = new Map();
  for (const {row} of groups) {
    const inn = sabyInn(row?.["ИНН"]);
    if (inn) counts.set(inn, (counts.get(inn) || 0) + 1);
  }
  const duplicates = [], invalid = [], eligible = [];
  for (const entry of groups) {
    const inn = sabyInn(entry.row?.["ИНН"]);
    if (!inn || !sabyNameTokens(entry.row?.["Организация"]).length) {
      invalid.push(entry);
    } else if (counts.get(inn) !== 1) {
      duplicates.push(entry);
    } else if (includeAll || entry.transport || !hasKnownPhone(entry.row?.["Телефон"]) || !companyEmailCell(entry.row) ||
      (includeFinanceGaps&&sabyMissingFinancials(entry.row))) {
      eligible.push(entry);
    }
  }
  // Telephone gaps first, then A/B/C and secondary fields; keep the
  // stage's separate fresh-before-retry cursor and existing full coverage.
  eligible.sort((a,b) => {
    const score = x => {
      const g=String(x.row.__final_grade||x.row["Основание"]||"").trim().toUpperCase()[0];
      return (hasKnownPhone(x.row["Телефон"])?0:100)+(g==="A"?30:g==="B"?20:10)+
        (companyEmailCell(x.row)?0:2)+(x.transport?3:0);
    };
    return score(b)-score(a);
  });
  return {eligible, duplicates, invalid};
}

function sourceValid(record, row) {
  const inn = sabyInn(row?.["ИНН"]);
  return Boolean(inn && record?.identity?.verified === true &&
    sabyInn(record.identity.inn) === inn &&
    sabyNameMatches(row?.["Организация"], record.identity.name) &&
    isSabyProfileUrl(record.source_url));
}

// A new Saby address should not leave "Email: не найден" in the existing
// Excel comment. Never displace an email already found by another source.
function mergeCommentEmail(original, emails) {
  const before=String(original || "").trim();
  if (!emails.length) return before;
  const newEmail="Email: "+emails.join(", ");
  const missing=/^Email:[ \t]*(?:не найден(?:о)?|не установлен|не указан(?:о)?|отсутствует|нет|—|-)[ \t]*\r?$/im;
  if (missing.test(before)) return before.replace(missing,newEmail);
  if (!/^Email:[^\r\n]*$/im.test(before))
    return [before,newEmail].filter(Boolean).join("\n");
  return before;
}

// Persist only status categories for partial collection. Raw browser errors
// could contain page text or account data and are intentionally not stored.
function safeCollectionStatus(record) {
  const contacts=String(record?.contacts?.status || "");
  const trucks=String(record?.trucks?.status || "");
  const errors=Array.isArray(record?.errors) ? record.errors : [];
  return {
    contacts:["collected","missing","review"].includes(contacts) ? contacts : "unknown",
    trucks:["verified","missing","review"].includes(trucks) ? trucks : "unknown",
    financials:validSabyFinancialEvidence(record?.financials)?"collected":
      (record?.financials?.status==="missing"?"missing":"unknown"),
    failed_sections:[...new Set(errors.map(raw=>{
      const match=/^(contacts|trucks|financials):/.exec(String(raw));
      return match ? match[1] : "other";
    }))].sort()
  };
}

// Apply changes only to independently verified fields. Never replace a known
// phone, never infer trailers from truck count, and never promote A/B/C grades.
export function applySabyEnrichment(row, record, { phoneOwners = new Map(), transport = false } = {}) {
  if (!sourceValid(record, row)) return {status:"review", reason:"identity_mismatch", phoneAdded:false, transportAdded:false};
  const contacts = record.contacts || {};
  const evidence = {...(row.__evidence || {})};
  const existingSaby = {...(evidence.saby || {})};
  const carry=canCarrySabyEvidence(existingSaby,record);
  const keepContacts=carry&&existingSaby.collection?.contacts==="collected";
  const freshContacts=contacts.status==="collected";
  // A later fleet-only retry must not erase previously verified Saby
  // contacts. A freshly failed contacts widget is not evidence of absence.
  const previousPhones=keepContacts&&Array.isArray(existingSaby.phones)?
    existingSaby.phones:[];
  const currentPhones=freshContacts&&Array.isArray(contacts.phones)?
    contacts.phones:[];
  const phones=[...new Set([...previousPhones,...currentPhones]
    .map(normalizeRussianPhone).filter(Boolean))];
  // Departments are carried only when explicitly observed for this same
  // private Saby card; conflicting labels are deliberately dropped.
  const previousDetails=keepContacts&&Array.isArray(existingSaby.phone_details)?
    existingSaby.phone_details:[];
  const currentDetails=freshContacts&&Array.isArray(contacts.phone_details)?
    contacts.phone_details:[];
  const departments = new Map(),disputedDepartments=new Set();
  for(const info of [...previousDetails,...currentDetails]){
    const phone=normalizeRussianPhone(info?.phone);
    const label=explicitPhoneDepartment(info?.department);
    if(phone&&phones.includes(phone)&&label){
      const old=departments.get(phone);
      if(!old&&!disputedDepartments.has(phone))departments.set(phone,label);
      else if(old&&old!==label){
        departments.set(phone,null);
        disputedDepartments.add(phone);
      }
    }
  }
  const phoneDetails=phones.map(phone=>({
    phone,department:departments.get(phone)||""
  }));
  const previousEmails=keepContacts&&Array.isArray(existingSaby.emails)?
    existingSaby.emails:[];
  const currentEmails=freshContacts&&Array.isArray(contacts.emails)?
    contacts.emails:[];
  const emails=[...new Set([...previousEmails,...currentEmails]
    .map(x=>String(x||"").trim().toLowerCase())
    .filter(x=>/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(x)))].slice(0,10);
  const previousFleet=carry&&existingSaby.collection?.trucks==="verified"?
    verifiedStoredTrucks(existingSaby.trucks):null;
  const fleet=verifiedTrucks(record)||previousFleet;
  // Revenue/headcount have their own independent Saby evidence, separate
  // from phones, fleet and A/B/C. Only carry old facts when the exact same
  // KPP or private card ID was verified on this attempt.
  const observedFinancial=validSabyFinancialEvidence(record.financials);
  const previousFinancial=carry?
    validSabyFinancialEvidence(existingSaby.financials):null;
  const financialCandidates=[observedFinancial,previousFinancial].filter(Boolean);
  const latestRevenue=financialCandidates.filter(x=>Number.isSafeInteger(x.revenue_rub))
    .sort((a,b)=>b.revenue_year-a.revenue_year)[0];
  const headcount=observedFinancial?.employees??previousFinancial?.employees;
  const financials=latestRevenue||Number.isSafeInteger(headcount)?{
    status:"collected",
    ...(latestRevenue?{
      revenue_rub:latestRevenue.revenue_rub,
      revenue_year:latestRevenue.revenue_year
    }:{}),
    ...(Number.isSafeInteger(headcount)?{employees:headcount}:{})
  }:null;
  const collection=safeCollectionStatus(record);
  if(keepContacts||freshContacts)collection.contacts="collected";
  if(fleet)collection.trucks="verified";
  if(financials)collection.financials="collected";
  evidence.saby = {
    // Never retain prior section evidence from a different Saby card.
    ...(carry?existingSaby:{}),
    source_url: record.source_url,
    inn: record.identity.inn,
    ...( /^\d{9}$/.test(String(record.identity.kpp||""))?
      {kpp:String(record.identity.kpp)}:
      (carry&&/^\d{9}$/.test(String(existingSaby.kpp||""))?
        {kpp:String(existingSaby.kpp)}:{})),
    verified_at: String(record.collected_at || new Date().toISOString()),
    phones, phone_details:phoneDetails, emails,
    collection,
    ...(fleet ? {trucks: {...fleet, status:"verified",category:"Грузовые", source:"SABY"}} : {}),
    ...(financials ? {financials} : {})
  };
  evidence.source_urls = [...new Set([...(evidence.source_urls || []), record.source_url])];
  row.__evidence = evidence;
  // This exact-INN, verified Saby card contributes e-mail to the visible
  // CRM column even when phones or fleet evidence remain incomplete.
  const emailAdded=mergeCompanyEmail(row,emails);

  // Do not overwrite data already researched by stages 1-11 or edited in
  // the original workbook. Financial data from Saby fill empty columns
  // only; the accounting year remains in Saby provenance for auditing.
  let revenueAdded=false,employeesAdded=false;
  // Stage 10 remains authoritative. Saby supplements absent/unusable
  // financial fields but never replaces an existing nonnegative integer.
  const hasUsableNumber=value=>{
    if(typeof value==="number")return Number.isSafeInteger(value)&&value>=0;
    if(typeof value!=="string"||!/^\d+$/.test(value.trim()))return false;
    return Number.isSafeInteger(Number(value.trim()));
  };
  if(financials && !hasUsableNumber(row["Выручка последнего подтвержденного года"]) &&
      Number.isSafeInteger(financials.revenue_rub)){
    row["Выручка последнего подтвержденного года"]=financials.revenue_rub;
    revenueAdded=true;
  }
  if(financials && !hasUsableNumber(row["Численность"]) &&
      Number.isSafeInteger(financials.employees)){
    row["Численность"]=financials.employees;
    employeesAdded=true;
  }

  let phoneAdded = false;
  if (!hasKnownPhone(row["Телефон"])) {
    const available = phones.filter(phone => {
      const owners = phoneOwners.get(phone);
      return !owners || [...owners].every(owner => owner === row);
    }).slice(0,12);
    if (available.length) {
      row["Телефон"] = formatPhoneCell(available.map(phone => {
        const label=departments.get(phone);
        return phone+(label?" ("+label+")":"");
      }));
      phoneAdded = Boolean(row["Телефон"]);
      for (const phone of available) {
        if (!phoneOwners.has(phone)) phoneOwners.set(phone, new Set());
        phoneOwners.get(phone).add(row);
      }
    }
  }

  let transportAdded = false;
  if (transport && fleet && fleet.count > 0) {
    const summary = fleetSummary(fleet);
    if (summary) {
      const original = String(row["Наличие транспорта"] || row["TORGBOX"] || "").trim();
      const line = "Saby (грузовые): " + summary;
      if (!original.includes(line) && !original.includes("Saby (грузовые):")) {
        row["Наличие транспорта"] = [original, line].filter(Boolean).join("\n");
        transportAdded = true;
      } else if (original) {
        row["Наличие транспорта"] = original;
      }
    }
  }
  // Preserve the historic email line in the company note too; keep source
  // provenance out of the visible e-mail address column.
  const comment = [
    "Saby: ИНН " + record.identity.inn + " подтверждён",
    phones.length ? "телефоны " + phones.join(", ") : "",
    emails.length ? "email " + emails.join(", ") : "",
    fleet ? "грузовые " + fleet.count + " шт." : "",
    financials?.revenue_rub!==undefined?
      "выручка "+financials.revenue_year+" г. "+financials.revenue_rub+" ₽":"",
    financials?.employees!==undefined?
      "сотрудников "+financials.employees:"",
    record.source_url
  ].filter(Boolean).join("; ");
  const existingComment=mergeCommentEmail(row.__comment,emails);
  if (comment && !existingComment.includes(comment)) {
    row.__comment = [existingComment, comment].filter(Boolean).join("\n");
  } else {
    row.__comment = existingComment;
  }
  return {status:"ok", phoneAdded, emailAdded, transportAdded,
    revenueAdded,employeesAdded,
    phonesFound:phones.length, emailsFound:emails.length,
    verifiedTrucks:fleet?.count ?? null};
}
