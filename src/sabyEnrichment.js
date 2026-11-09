// Pure, offline Saby data policy. Browser DOM is untrusted; do not change a CRM
// row until legal identity and the source have both passed validation.
import { normalizeRussianPhone } from "./researchCostPolicy.js";

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

// The scraped search result may have a city or director AFTER the legal name.
// Never accept a middle-of-string match or a generic similar-looking name.
export function sabySearchResultMatches(expected, candidateText, inn) {
  const prefix = String(candidateText || "").split(String(inn), 1)[0];
  const wanted = sabyNameTokens(expected);
  const actual = sabyNameTokens(prefix);
  return wanted.length > 0 && actual.length >= wanted.length &&
    wanted.every((token, index) => token === actual[index]);
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

export function sabyEligibleRows(result) {
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
    } else if (entry.transport ||
               !normalizeRussianPhone(entry.row?.["Телефон"])) {
      eligible.push(entry);
    }
  }
  // Prioritize missing contacts and direct buyers; no additional API searches.
  eligible.sort((a,b) => {
    const score = x => (normalizeRussianPhone(x.row["Телефон"]) ? 0 : 4) +
      (x.transport ? 2 : 0);
    return score(b) - score(a);
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

// Apply changes only to independently verified fields. Never replace a known
// phone, never infer trailers from truck count, and never promote A/B/C grades.
export function applySabyEnrichment(row, record, { phoneOwners = new Map(), transport = false } = {}) {
  if (!sourceValid(record, row)) return {status:"review", reason:"identity_mismatch", phoneAdded:false, transportAdded:false};
  const contacts = record.contacts || {};
  const phones = [...new Set((Array.isArray(contacts.phones) ? contacts.phones : [])
    .map(normalizeRussianPhone).filter(Boolean))];
  const emails = [...new Set((Array.isArray(contacts.emails) ? contacts.emails : [])
    .map(x => String(x || "").trim().toLowerCase())
    .filter(x => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(x)))].slice(0,10);
  const fleet = verifiedTrucks(record);
  const evidence = {...(row.__evidence || {})};
  const existingSaby = {...(evidence.saby || {})};
  evidence.saby = {
    ...existingSaby,
    source_url: record.source_url,
    inn: record.identity.inn,
    verified_at: String(record.collected_at || new Date().toISOString()),
    phones, emails,
    ...(fleet ? {trucks: {...fleet, category:"Грузовые", source:"SABY"}} : {})
  };
  evidence.source_urls = [...new Set([...(evidence.source_urls || []), record.source_url])];
  row.__evidence = evidence;

  let phoneAdded = false;
  if (!normalizeRussianPhone(row["Телефон"])) {
    const available = phones.find(phone => {
      const owners = phoneOwners.get(phone);
      return !owners || [...owners].every(owner => owner === row);
    });
    if (available) {
      row["Телефон"] = available;
      phoneAdded = true;
      if (!phoneOwners.has(available)) phoneOwners.set(available, new Set());
      phoneOwners.get(available).add(row);
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
  // Contact e-mails are preserved in the existing Excel comment, not a new
  // commercial column. This keeps the reference's column count and style.
  const comment = [
    "Saby: ИНН " + record.identity.inn + " подтверждён",
    phones.length ? "телефоны " + phones.join(", ") : "",
    emails.length ? "email " + emails.join(", ") : "",
    fleet ? "грузовые " + fleet.count + " шт." : "",
    record.source_url
  ].filter(Boolean).join("; ");
  if (comment && !String(row.__comment || "").includes(comment)) {
    row.__comment = [String(row.__comment || "").trim(), comment].filter(Boolean).join("\n");
  }
  return {status:"ok", phoneAdded, transportAdded,
    phonesFound:phones.length, emailsFound:emails.length,
    verifiedTrucks:fleet?.count ?? null};
}
