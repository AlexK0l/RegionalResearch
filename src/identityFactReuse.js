import { normalizeRussianPhone, validHttpUrl } from "./researchCostPolicy.js";

// Harvest only facts ALREADY SEEN during legal-INN identification. This
// module never searches the web and must not infer values from the group name.
const ALLOWED = new Set([
  "Телефон", "Руководитель / ЛПР", "Управляющая компания",
  "Выручка последнего подтвержденного года", "Численность", "Email"
]);
function digits(value) { return String(value || "").replace(/\D/g, ""); }
function norm(value) {
  return String(value || "").toLowerCase().replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gu, "").trim();
}
function innOf(value) {
  const v = digits(value);
  return v.length === 10 || v.length === 12 ? v : "";
}
function missing(value) {
  return !String(value ?? "").trim() || /^(?:н\/д|не найден|не подтвержден|не установл|нет данных)/i.test(String(value).trim());
}
/** Returns a patch only for a field and exact INN shown in the same snippet. */
export function identitySnippetFact(item, fact, row) {
  const inn = innOf(item?.confirmed_inn);
  if (!inn || inn !== innOf(row?.["ИНН"])) return null;
  const field = String(fact?.field || "");
  if (!ALLOWED.has(field)) return null;
  const url = String(fact?.source_url || "").trim();
  const sources = Array.isArray(item?.source_urls) ? item.source_urls : [];
  if (!validHttpUrl(url) || !sources.includes(url)) return null;
  const quote = String(fact?.evidence_excerpt || "").slice(0, 1000);
  // Evidence from another affiliate, old legal entity or unsourced sentence
  // is NOT an authoritative way of filling CRM cells.
  if (!digits(quote).includes(inn)) return null;
  let value = String(fact.value ?? "").trim();
  if (!value || /не\s+(?:подтвержд|найден)|нет данных/i.test(value)) return null;
  if (field === "Телефон") {
    value = normalizeRussianPhone(value);
    if (!value || !digits(quote).includes(value) &&
        !digits(quote).includes(value.slice(1))) return null;
  } else if (field === "Выручка последнего подтвержденного года" ||
             field === "Численность") {
    const pure = value.replace(/\s+/g, "");
    if (!/^\d+$/.test(pure) || !digits(quote).includes(pure)) return null;
    const amount = Number(pure);
    if (!Number.isSafeInteger(amount) || amount <= 0) return null;
    value = amount;
  } else if (field === "Email") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(value) ||
        !quote.toLowerCase().includes(value.toLowerCase())) return null;
  } else if (!norm(quote).includes(norm(value))) {
    return null;
  }
  return { field, value, source_url: url, inn, excerpt: quote.slice(0, 500) };
}
export function reuseIdentityObservedFacts(row, item) {
  const facts = Array.isArray(item?.observed_facts) ? item.observed_facts : [];
  const applied = [];
  if (!facts.length) return applied;
  const evidence = row.__evidence || {};
  const existing = Array.isArray(evidence.identity_observed_facts)
    ? evidence.identity_observed_facts : [];
  for (const candidate of facts.slice(0, 12)) {
    const fact = identitySnippetFact(item, candidate, row);
    if (!fact) continue;
    const field = fact.field;
    if (field === "Email") {
      if (missing(evidence.email)) {
        evidence.email = fact.value;
        applied.push(fact);
      }
    } else if (field === "Телефон") {
      if (missing(row["Телефон"])) {
        row["Телефон"] = fact.value;
        applied.push(fact);
      }
    } else if (missing(row[field])) {
      row[field] = fact.value;
      applied.push(fact);
    }
    if (applied.includes(fact) && !existing.some((prev) => prev.field === field &&
        prev.inn === fact.inn && String(prev.value) === String(fact.value))) {
      existing.push({ ...fact, method: "same_inn_source_excerpt" });
    }
    if (field === "Телефон" && applied.includes(fact)) {
      evidence.contact_verification = {
        inn: fact.inn, phone: fact.value, source_url: fact.source_url,
        verified_at: new Date().toISOString(), method: "same_inn_source_excerpt"
      };
    }
  }
  if (applied.length) {
    evidence.identity_observed_facts = existing.slice(-24);
    row.__evidence = evidence;
  }
  return applied;
}
