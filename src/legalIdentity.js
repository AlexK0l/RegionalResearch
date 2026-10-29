// Conservative legal identity matching. Never infer that a shared INN alone
// proves two differently named companies are one legal entity.
const LEGAL_PREFIX = /^(?:(?:общество с ограниченной ответственностью|публичное акционерное общество|открытое акционерное общество|закрытое акционерное общество|акционерное общество|индивидуальный предприниматель)\s+|(?:ооо|оао|зао|пао|ао|ип)\s+)/u;
const NONLEGAL_WORDS = new Set(["группа", "компаний", "гк", "компания", "предприятие", "регион", "региональная", "центр", "холдинг", "смоленск", "смоленская"]);
const OGRN_DOMAINS = new Set(["companies.rbc.ru", "check.tochka.com", "saby.ru", "xfirm.ru"]);
const OGRN_PATTERN = /(?:огрн(?:ип)?)[\s:№\-–]*(\d{13}|\d{15})(?!\d)/giu;
const URL_OGRN_PATTERN = /(?:^|[^0-9])(\d{13}|\d{15})(?![0-9])/g;
const ALIAS_TERMS = /сокращенн.{0,30}наименован|полное наименован|прежне.{0,20}наименован|историческ.{0,20}наименован|переимен|ранее именовал|то же юридическ.{0,18}лицо|также зарегистрирован|является сокращени/i;
const RENAMING_TERMS = /прежне.{0,20}наименован|историческ.{0,20}наименован|переимен|ранее именовал/i;

function comparableText(input) {
  return String(input || "").toLowerCase().replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gu, " ").replace(/\s+/g, " ").trim();
}
export function legalNameKey(input) {
  let value = comparableText(input);
  while (LEGAL_PREFIX.test(value)) value = value.replace(LEGAL_PREFIX, "").trim();
  return value;
}
export function normalizedOgrn(raw) {
  const value = String(raw || "").replace(/\D/g, "");
  if (value.length === 13) {
    return Number(BigInt(value.slice(0, 12)) % 11n % 10n) === Number(value[12]) ? value : "";
  }
  if (value.length === 15) {
    return Number(BigInt(value.slice(0, 14)) % 13n % 10n) === Number(value[14]) ? value : "";
  }
  return "";
}
function confirmedIdentityProof(row, inn) {
  const proof = row?.__evidence?.identity_verification;
  return Boolean(proof && String(proof.inn || "") === String(inn || "") &&
    ["identity_web", "final_inn_web"].includes(String(proof.method)) &&
    Array.isArray(proof.source_urls) &&
    proof.source_urls.some((url) => /^https?:\/\//i.test(String(url))));
}
function sourceUrls(row) {
  const ev = row?.__evidence || {};
  return [
    ...(Array.isArray(ev.identity_verification?.source_urls) ? ev.identity_verification.source_urls : []),
    ...(Array.isArray(ev.source_urls) ? ev.source_urls : [])
  ].filter((url) => /^https?:\/\//i.test(String(url)));
}
export function identityOgrns(row) {
  const ids = new Set();
  const explicit = normalizedOgrn(row?.["ОГРН"] || row?.__evidence?.identity_verification?.ogrn || "");
  if (explicit) ids.add(explicit);
  for (const raw of Array.isArray(row?.__evidence?.notes) ? row.__evidence.notes : []) {
    const note = String(raw || "").trim();
    if (!/^(?:identity:|final inn:|подтвержд[её]нн[а-яё ]*инн:)/i.test(note)) continue;
    for (const match of note.matchAll(OGRN_PATTERN)) {
      const id = normalizedOgrn(match[1]);
      if (id) ids.add(id);
    }
  }
  for (const rawUrl of sourceUrls(row)) {
    try {
      const url = new URL(String(rawUrl));
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      if (!OGRN_DOMAINS.has(host)) continue;
      for (const match of decodeURIComponent(url.pathname).matchAll(URL_OGRN_PATTERN)) {
        const id = normalizedOgrn(match[1]);
        if (id) ids.add(id);
      }
    } catch {}
  }
  return [...ids].sort();
}
function meaningfulTokens(input) {
  return legalNameKey(input).split(/\s+/).filter((t) => t.length >= 4 && !NONLEGAL_WORDS.has(t));
}
function roleSignature(name) {
  const s = comparableText(name);
  return {
    branch: /(?:^| )филиал(?: |$)|(?:^| )обособленное подразделение(?: |$)/.test(s),
    group: /(?:^| )гк(?: |$)|(?:^| )группа компаний(?: |$)/.test(s)
  };
}
function sameRole(a, b) {
  const x = roleSignature(a), y = roleSignature(b);
  return x.branch === y.branch && x.group === y.group;
}
function aliasNote(rowA, rowB, aName, bName, inn) {
  const aKey = legalNameKey(aName), bKey = legalNameKey(bName);
  if (!aKey || !bKey || aKey.length < 3 || bKey.length < 3) return null;
  const notes = [...(rowA?.__evidence?.notes || []), ...(rowB?.__evidence?.notes || [])];
  for (const raw of notes) {
    const note = String(raw || "").trim();
    if (!/^(?:Identity:|Final INN:)/i.test(note) || !ALIAS_TERMS.test(note)) continue;
    const text = " " + comparableText(note) + " ";
    if (!text.includes(" " + aKey + " ") || !text.includes(" " + bKey + " ")) continue;
    if (!text.includes(String(inn))) {
      if (!confirmedIdentityProof(rowA, inn) || !confirmedIdentityProof(rowB, inn)) continue;
    }
    return { renamed: RENAMING_TERMS.test(note) };
  }
  return null;
}
function sharedProofUrl(rowA, rowB) {
  const urls = (rowA?.__evidence?.identity_verification?.source_urls || [])
    .map((x) => String(x).toLowerCase().replace(/\/+$/, ""));
  const left = new Set(urls);
  return (rowB?.__evidence?.identity_verification?.source_urls || [])
    .some((x) => left.has(String(x).toLowerCase().replace(/\/+$/, "")));
}
function namesShareAnchor(a, b) {
  const x = new Set(meaningfulTokens(a)), y = new Set(meaningfulTokens(b));
  return [...x].some((token) => y.has(token));
}
export function confirmedInnAliasDecision(recordA, recordB, inn, compatibleNames = null) {
  const a = recordA?.row || recordA || {};
  const b = recordB?.row || recordB || {};
  const nameA = String(a["Организация"] || ""), nameB = String(b["Организация"] || "");
  const ogA = identityOgrns(a), ogB = identityOgrns(b);
  const base = { ogrnsA: ogA, ogrnsB: ogB };
  if (!inn || !nameA || !nameB ||
      String(a["ИНН"] || "") !== String(inn) ||
      String(b["ИНН"] || "") !== String(inn)) {
    return { ...base, merge: false, reason: "missing_or_mismatched_identity" };
  }
  if (ogA.length > 1 || ogB.length > 1) {
    return { ...base, merge: false, reason: "conflicting_ogrns_in_one_record" };
  }
  if (ogA.length === 1 && ogB.length === 1 && ogA[0] !== ogB[0]) {
    return { ...base, merge: false, reason: "different_ogrns" };
  }
  if (!sameRole(nameA, nameB)) return { ...base, merge: false, reason: "different_legal_roles" };
  if (legalNameKey(nameA) === legalNameKey(nameB)) {
    return { ...base, merge: true, reason: "same_normalized_legal_name" };
  }
  const verifiedBoth = confirmedIdentityProof(a, inn) && confirmedIdentityProof(b, inn);
  const matchingOgrn = ogA.length === 1 && ogB.length === 1 && ogA[0] === ogB[0];
  if (verifiedBoth && matchingOgrn && namesShareAnchor(nameA, nameB)) {
    return { ...base, merge: true, reason: "matching_ogrn_and_name_anchor" };
  }
  const note = verifiedBoth ? aliasNote(a, b, nameA, nameB, inn) : null;
  if (note && (sharedProofUrl(a, b) || note.renamed)) {
    return { ...base, merge: true, reason: note.renamed ? "sourced_historical_rename" : "sourced_explicit_alias" };
  }
  if (typeof compatibleNames === "function" && compatibleNames(nameA, nameB)) {
    return { ...base, merge: true, reason: "compatible_legal_name" };
  }
  return { ...base, merge: false, reason: "alias_unverified" };
}
