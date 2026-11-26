// Offline-only cost/attribution policy. The reference workbook is never used.
// All limits are independently configurable; budgets are not quality claims.
// A new autonomous study must not inherit phone numbers from older studies.
// Legacy cache requires an explicit opt-in AND autonomous discovery disabled.
import { parseEmailEntries,companyEmailCell } from "./emailContact.js";

export function previousContactCacheEnabled(env = process.env) {
  const autonomous = String(env.OPENAI_AUTONOMOUS_DISCOVERY_ENABLED ?? "true")
    .toLowerCase() !== "false";
  const cacheOptIn = String(env.OPENAI_PREVIOUS_CONTACT_CACHE ?? "false")
    .toLowerCase() === "true";
  return !autonomous && cacheOptIn;
}

function boundedInt(raw, fallback, min = 0, max = 20000) {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}
export function fullWebLimits(env = process.env) {
  return {
    total: boundedInt(env.OPENAI_FULL_WEB_MAX_CALLS, 1850, 100),
    discovery: boundedInt(env.OPENAI_FULL_WEB_DISCOVERY_MAX_CALLS, 1050, 50),
    identity: boundedInt(env.OPENAI_FULL_WEB_IDENTITY_MAX_CALLS, 600, 50),
    enrichment: boundedInt(env.OPENAI_FULL_WEB_ENRICHMENT_MAX_CALLS, 120, 0),
    contacts: boundedInt(env.OPENAI_FULL_WEB_CONTACTS_MAX_CALLS, 340, 0),
    statistics: boundedInt(env.OPENAI_FULL_WEB_STATISTICS_MAX_CALLS, 12, 0),
    other: boundedInt(env.OPENAI_FULL_WEB_OTHER_MAX_CALLS, 70, 0)
  };
}
export function researchWebScope(label, kind = "full") {
  const s = String(label || "").toLowerCase();
  if (kind !== "full") {
    if (s.startsWith("этап 1 |")) return "stage1";
    if (s.startsWith("этап 2 |")) return "stage2";
  }
  if (/^(?:identity\s*\||final inn\s*\||post.inn.conflict)/.test(s) ||
      s.includes("identity resolution")) return "identity";
  if (/^(?:contact\s|phone verify\s*\|)/.test(s)) return "contacts";
  if (/^(?:enrichment\s|targeted enrichment\s|company enrichment\s)/.test(s)) return "enrichment";
  if (/^(?:regional statistics|статистик)/.test(s)) return "statistics";
  if (/^(?:этап\s*\d+\s*\||discovery\s|coverage gap\s|география региона\s*\||geo(?:graphy)?\s|entity census\s|historical recall\s*\|)/.test(s)) {
    return "discovery";
  }
  return "other";
}
export function costEnvLimitUsd(env = process.env) {
  const n = Number(env.OPENAI_MAX_RESEARCH_COST_USD);
  return Number.isFinite(n) && n > 0 ? Math.max(1, n) : 25;
}
// Preserve a small contact-search allowance from optional enrichment calls.
// This does NOT increase the global web or dollar limits and does not block
// mandatory discovery/identity checks. It is a conservative, configurable
// soft reservation, not a guarantee about actual OpenAI billing.
export function protectedContactAllowance(env = process.env) {
  const webCalls = boundedInt(env.OPENAI_CONTACTS_PROTECTED_WEB_CALLS, 145, 0, 340);
  const rawUsd = Number(env.OPENAI_CONTACTS_PROTECTED_ESTIMATED_USD ?? 1.2);
  const estimatedUsd = Number.isFinite(rawUsd) ?
    Math.max(0, Math.min(5, rawUsd)) : 1.2;
  return { webCalls, estimatedUsd };
}

export function contactLimits(env = process.env) {
  return {
    batchSize: boundedInt(env.OPENAI_CONTACT_BATCH_SIZE, 5, 2, 8),
    batchWebCalls: boundedInt(env.OPENAI_CONTACT_BATCH_MAX_TOOL_CALLS, 2, 1, 3),
    individualFallbacks: boundedInt(env.OPENAI_CONTACT_INDIVIDUAL_FALLBACKS, 30, 0, 150),
    phoneRetries: boundedInt(env.OPENAI_CONTACT_PHONE_RETRIES, 12, 0, 150)
  };
}
function digits(value) { return String(value ?? "").replace(/\D/g, ""); }
function validInn(value) {
  const v = digits(value);
  return v.length === 10 || v.length === 12 ? v : "";
}
function normalizedName(value) {
  return String(value || "").toLowerCase().replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gu, " ").replace(/\s+/g, " ").trim();
}
export function validHttpUrl(value) {
  try {
    const u = new URL(String(value || ""));
    return u.protocol === "https:" && u.hostname.includes(".") &&
      !u.username && !u.password;
  } catch { return false; }
}
export function normalizeRussianPhone(value) {
  let v = digits(value);
  if (v.length === 11 && v.startsWith("8")) v = "7" + v.slice(1);
  if (v.length === 10) v = "7" + v;
  return v.length === 11 && v.startsWith("7") ? v : "";
}

// The sales team's primary outcome is a usable telephone. All companies
// without a telephone precede email/leader-only gaps; preserve A/B/C order
// within each cohort. Never change a company's grade to obtain a phone.
export function hasContactPhone(row) {
  return String(row?.["Телефон"] || "").split(/[;\r\n]+/)
    .some(entry => Boolean(normalizeRussianPhone(entry)));
}
export function contactResearchPriority(row) {
  const grade = String(row?.__final_grade || row?.["Основание"] || "")
    .trim().toUpperCase().slice(0, 1);
  const gradeWeight = grade === "A" ? 3 : grade === "B" ? 2 : 1;
  const phoneKnown = hasContactPhone(row);
  const emailKnown=Boolean(companyEmailCell(row));
  const leader=String(row?.["Руководитель / ЛПР"]||"").trim();
  const leaderKnown=Boolean(leader&&!/^(?:[-—–]+|н\/д|нет данных|не найден|не подтвержд|не установл)/iu.test(leader));
  return (phoneKnown ? 0 : 100) + gradeWeight * 10 + (emailKnown?0:2) + (leaderKnown ? 0 : 1);
}

// Keep telephone and secondary-contact batches homogeneous. An email-only
// company cannot consume part of a limited phone-first web search.
export function planContactGroups(rows, batchSize) {
  const ordered=[...(rows||[])].sort((a,b)=>contactResearchPriority(b)-contactResearchPriority(a));
  const size=Number.isSafeInteger(batchSize)&&batchSize>0?batchSize:1;
  const chunk=list=>{
    const out=[];
    for(let i=0;i<list.length;i+=size)out.push(list.slice(i,i+size));
    return out;
  };
  return {phoneGroups:chunk(ordered.filter(row=>!hasContactPhone(row))),
    otherGroups:chunk(ordered.filter(hasContactPhone))};
}

// Only a source-attributed primary response with an INN and no phone can
// justify a dedicated second query. Omitted responses are handled by the
// separate omission queue, not counted twice. Persist attempted IDs.
export function planPhoneGapRecovery(rows,primaryResults,completed,attempted,idOf) {
  const seen=new Set();
  return (rows||[]).filter(row=>{
    const id=String(idOf(row)||"");
    // A primary source-backed response is recorded as completed BEFORE
    // applying its contacts. That is exactly the cohort eligible for a
    // phone-only retry. The persisted retry IDs prevent duplicate searches.
    if(!id||seen.has(id)||attempted.has(id)||hasContactPhone(row))return false;
    seen.add(id);
    const answer=primaryResults.get(id);
    return Boolean(validInn(row?.["ИНН"])&&answer&&
      Array.isArray(answer.source_urls)&&answer.source_urls.some(validHttpUrl)&&
      !(Array.isArray(answer.phones)&&answer.phones.some(normalizeRussianPhone)));
  }).sort((a,b)=>contactResearchPriority(b)-contactResearchPriority(a));
}

// Recovery may contribute phones only. Preserve the first response even
// when a second query fails, and apply ownership checks later in one place.
export function mergeRecoveredPhoneResult(first,second) {
  if(!first||!second||!Array.isArray(second.source_urls)||!second.source_urls.some(validHttpUrl))
    return first;
  const retrySources=[...new Set([...(first.phone_recovery_source_urls||[]),...second.source_urls]
    .filter(validHttpUrl))].slice(0,8);
  const phones=[...new Set([...(first.phones||[]),...(second.phones||[])]
    .map(normalizeRussianPhone).filter(Boolean))];
  // The already-paid retry may reveal a useful source even without a
  // telephone. Store it separately as an unverified public-HTML hint.
  if(!phones.length){
    return JSON.stringify(retrySources)===JSON.stringify(first.phone_recovery_source_urls||[])
      ?first:{...first,phone_recovery_source_urls:retrySources};
  }
  return {...first,phones,status:"ok",
    source_urls:[...new Set([...(first.source_urls||[]),...second.source_urls])].filter(validHttpUrl),
    official_site:first.official_site||second.official_site||"",
    phone_recovery_source_urls:retrySources};
}

/**
 * Batch contact items are accepted ONLY if exactly tied to the requested
 * row ID and confirmed INN. No source => no harvested personal fields.
 * Missing INN requires same normalized name and a cited source.
 */
export function validBatchContactItem(item, row, expectedId) {
  if (!item || String(item.id || "") !== String(expectedId || "")) return null;
  const rowInn = validInn(row?.["ИНН"]);
  const itemInn = validInn(item.inn);
  if (rowInn ? rowInn !== itemInn : Boolean(itemInn)) return null;
  const name = normalizedName(row?.["Организация"]);
  if (!name || (!rowInn&&!normalizedName(item.organization)) ||
      (item.organization&&normalizedName(item.organization)!==name)) return null;
  const sources = Array.isArray(item.source_urls)
    ? [...new Set(item.source_urls.filter(validHttpUrl))].slice(0, 4) : [];
  // Without a specific cited page we cannot know whether a particular
  // company was actually examined within a shared multi-entity search.
  // Do not mark unsourced "not_found" as a completed investigation.
  if (!sources.length) return null;
  const phones = sources.length
    ? [...new Set((Array.isArray(item.phones) ? item.phones : [])
      .map(normalizeRussianPhone).filter(Boolean))] : [];
  const leader = sources.length ? String(item.leader || "").trim().slice(0, 180) : "";
  const emails = sources.length ? parseEmailEntries(item.emails) : [];
  const site = validHttpUrl(item.official_site) &&
    sources.some((u) => {
      try { return new URL(u).hostname.replace(/^www\./, "") ===
        new URL(String(item.official_site)).hostname.replace(/^www\./, ""); }
      catch { return false; }
    }) ? String(item.official_site) : "";
  // Empty, researched results can be cached; an omitted/mismatched response
  // is NOT a "not_found" and may need bounded structural recovery.
  return {
    status: phones.length || leader || emails.length ? "ok" : "not_found",
    phones, emails, leader, official_site: site,
    source_urls: sources,
    note: String(item.note || "").slice(0, 500)
  };
}
export function mayRetryContactPhone(row, result, remaining, deadlineRemainingMs) {
  if (!(remaining > 0) || !(deadlineRemainingMs > 7000)) return false;
  if (String(row?.__final_grade || "") !== "A") return false;
  if (!validInn(row?.["ИНН"])) return false;
  if (Array.isArray(result?.phones) && result.phones.some(normalizeRussianPhone)) return false;
  // A second search has a concrete reason only when a primary-source site is
  // known. Merely missing a phone, even if a leader was found, is not enough.
  const official = String(result?.official_site || "");
  const trusted = validHttpUrl(official) && (Array.isArray(result?.source_urls)
    ? result.source_urls.some((u) => {
        try { return new URL(u).hostname === new URL(official).hostname; }
        catch { return false; }
      })
    : true);
  return trusted;
}
