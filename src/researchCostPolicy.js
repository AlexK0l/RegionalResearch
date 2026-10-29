// Offline-only cost/attribution policy. The reference workbook is never used.
// All limits are independently configurable; budgets are not quality claims.
function boundedInt(raw, fallback, min = 0, max = 20000) {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}
export function fullWebLimits(env = process.env) {
  return {
    total: boundedInt(env.OPENAI_FULL_WEB_MAX_CALLS, 1850, 100),
    discovery: boundedInt(env.OPENAI_FULL_WEB_DISCOVERY_MAX_CALLS, 1050, 50),
    identity: boundedInt(env.OPENAI_FULL_WEB_IDENTITY_MAX_CALLS, 600, 50),
    enrichment: boundedInt(env.OPENAI_FULL_WEB_ENRICHMENT_MAX_CALLS, 190, 0),
    contacts: boundedInt(env.OPENAI_FULL_WEB_CONTACTS_MAX_CALLS, 270, 0),
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
  if (/^(?:этап\s*\d+\s*\||discovery\s|coverage gap\s|география региона\s*\||geo(?:graphy)?\s|entity census\s)/.test(s)) {
    return "discovery";
  }
  return "other";
}
export function costEnvLimitUsd(env = process.env) {
  const n = Number(env.OPENAI_MAX_RESEARCH_COST_USD);
  return Number.isFinite(n) && n > 0 ? Math.max(1, n) : 25;
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
  if (!name || (item.organization &&
      normalizedName(item.organization) !== name)) return null;
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
  const site = validHttpUrl(item.official_site) &&
    sources.some((u) => {
      try { return new URL(u).hostname.replace(/^www\./, "") ===
        new URL(String(item.official_site)).hostname.replace(/^www\./, ""); }
      catch { return false; }
    }) ? String(item.official_site) : "";
  // Empty, researched results can be cached; an omitted/mismatched response
  // is NOT a "not_found" and may need bounded structural recovery.
  return {
    status: phones.length || leader ? "ok" : "not_found",
    phones, leader, official_site: site,
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
