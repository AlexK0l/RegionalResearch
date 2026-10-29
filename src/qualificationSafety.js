// Evidence-bound commercial eligibility checks. No network calls and no
// inference of an ACTIVE company from a missing closure record.
// Audited exceptions are narrow, INN + organization-name matched, and retain
// their public sources. They do NOT supply identity for other candidates.
const VERIFIED_EXCLUSIONS = [
  {
    inn: "6722007648",
    name: /хмелит/,
    kind: "budget_institution",
    source_url: "https://khmelita.com/kontakty/",
    reason: "ФГБУК: государственный музей-заповедник, не коммерческий покупатель."
  },
  {
    inn: "6732008094",
    name: /пожарно[ -]спасательн.{0,15}центр/,
    kind: "budget_institution",
    source_url: "https://goszakupki.admin-smolensk.ru/portal/Show/contract?ParentItemId=14&link=10557124",
    reason: "СОГБУ: бюджетное учреждение, не коммерческий покупатель."
  },
  {
    inn: "6731065653",
    name: /смоленск.{0,25}транспортн.{0,15}компани/,
    kind: "ceased",
    ogrn: "1076731018143",
    source_url: "https://companies.rbc.ru/id/1076731018143-obschestvo-s-ogranichennoj-otvetstvennostyu-smolenskaya-transportnaya-kompaniya/",
    reason: "ООО с ОГРН 1076731018143 прекратило деятельность 24.04.2014."
  }
];

const GOVERNMENT = [
  /(?:^| )администраци/, /(?:^| )министерств/, /(?:^| )департамент/,
  /(?:^| )комитет(?: |$)/, /(?:^| )правительств/,
  /совет.{0,20}депутат/, /городск.{0,20}дум/,
  /муниципальн.{0,30}(совет|собрани)/
];
const BUDGET_ACRONYM = /(?:^| )(?:фгбу(?:к)?|фку|фгку|гбу|гку|мбу|мку|гау|мау|согбу|огбу|огку|мбоу|гбоу)(?: |$)/;
const BUDGET_FULL = /(?:федеральн|государственн|областн|муниципальн).{0,80}(?:бюджетн|казенн|автономн).{0,35}учрежден|(?:бюджетн|казенн|автономн).{0,25}учрежден.{0,80}(?:областн|муниципальн|федеральн|государственн)/;
const PUBLIC_OPERATOR = /(?:^| )(?:фгуп|гуп|муп)(?: |$)/;
const BRANCH = /^(?:обособленн.{0,20}подразделени|филиал|представительств)(?: |$)/;

function normalized(value) {
  return String(value || "").toLowerCase().replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/giu, " ").replace(/\s+/g, " ").trim();
}
function digits(value) {
  return String(value || "").replace(/\D/g, "");
}
function legalName(row) {
  return normalized(row?.["Организация"] || "");
}

export function classifyCommercialEntity(row) {
  const name = legalName(row);
  if (!name) return "commercial";
  if (BRANCH.test(name)) return "branch";
  if (GOVERNMENT.some((p) => p.test(name))) return "government_body";
  if (BUDGET_ACRONYM.test(name) || BUDGET_FULL.test(name)) return "budget_institution";
  if (PUBLIC_OPERATOR.test(name)) return "public_operator";
  return "commercial";
}

function specificOfficialRegistryUrl(raw, inn, ogrn) {
  try {
    const url = new URL(String(raw || ""));
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "egrul.nalog.ru" && host !== "service.nalog.ru" &&
        host !== "pb.nalog.ru" && host !== "nalog.gov.ru" &&
        !host.endsWith(".nalog.gov.ru")) return false;
    const path = decodeURIComponent(url.pathname + url.search);
    // An EGRUL home page or search page is not an entity-specific citation.
    if (!path || path === "/" || /^\/index(?:\.html)?\/?$/i.test(path)) return false;
    return path.includes(inn) || (ogrn && path.includes(ogrn)) ||
      /^\/download\//i.test(url.pathname);
  } catch { return false; }
}

export function acceptedLegalStatusProof(row) {
  const proof = row?.__evidence?.legal_status_verification;
  if (!proof || typeof proof !== "object") return null;
  const inn = digits(row?.["ИНН"]);
  if (!inn || inn !== digits(proof.inn)) return null;
  const status = String(proof.status || "").toLowerCase();
  if (status !== "liquidated" && status !== "ceased") return null;
  const ogrn = digits(proof.ogrn);
  const knownOgrn = digits(row?.["ОГРН"] || row?.__evidence?.identity_verification?.ogrn);
  if (knownOgrn && ogrn && knownOgrn !== ogrn) return null;
  const excerpt = normalized(proof.evidence_excerpt);
  if (!excerpt.includes(inn) ||
      !/(ликвидирован|деятельност.{0,40}прекращен|прекращен.{0,40}деятельност|исключен.{0,40}егрюл)/.test(excerpt)) return null;
  if (!specificOfficialRegistryUrl(proof.source_url, inn, ogrn)) return null;
  return {
    kind: "ceased", reason: "По записи ЕГРЮЛ с тем же ИНН деятельность юрлица прекращена.",
    source_url: String(proof.source_url), method: "matched_official_registry", inn
  };
}

export function commercialEligibility(row) {
  const name = legalName(row);
  const inn = digits(row?.["ИНН"]);
  const byName = classifyCommercialEntity(row);
  const reviewed = VERIFIED_EXCLUSIONS.find((item) =>
    inn === item.inn && item.name.test(name));
  if (reviewed) {
    return { blocked: true, kind: reviewed.kind, reason: reviewed.reason,
      source_url: reviewed.source_url, method: "audited_entity", inn };
  }
  if (byName === "branch") {
    return { blocked: true, kind: byName,
      reason: "Филиал/обособленное подразделение не является отдельным юридическим лицом.",
      source_url: "", method: "organization_role", inn };
  }
  if (byName === "government_body" || byName === "budget_institution") {
    return { blocked: true, kind: byName,
      reason: byName === "government_body" ? "Орган власти не относится к коммерческим покупателям." :
        "Бюджетное/казённое учреждение не относится к коммерческим покупателям.",
      source_url: "", method: "legal_name", inn };
  }
  const status = acceptedLegalStatusProof(row);
  if (status) return { ...status, blocked: true };

  // Unknown status is NOT proof of activity and is NOT a reason to silently
  // discard a potentially valuable lead. Record this limitation explicitly.
  const source = row?.__evidence?.legal_status_verification;
  const statusClaim = String(source?.status || "").toLowerCase();
  const identityNotes = (Array.isArray(row?.__evidence?.notes) ? row.__evidence.notes : [])
    .filter((note) => /^(?:identity:|final inn:)/i.test(String(note).trim()));
  const unverifiedClosure = (statusClaim === "liquidated" || statusClaim === "ceased") ||
    identityNotes.some((note) => /ликвидирован|деятельност.{0,35}прекращен|исключен.{0,35}егрюл/i.test(normalized(note)));
  return { blocked: false, kind: byName,
    reason: unverifiedClosure ? "Неоднозначный сигнал прекращения деятельности: проверить ЕГРЮЛ." :
      "Юридический статус не подтверждён отдельной актуальной записью ЕГРЮЛ.",
    source_url: "", method: unverifiedClosure ? "closure_review" : "unverified",
    needs_review: unverifiedClosure, inn };
}

// Lookup answers are evidence hints until a matching entity-specific primary
// registry URL and an explicit status excerpt have been returned.
export function statusProofFromFinalInn(item, inn) {
  const status = String(item?.legal_status || "").toLowerCase();
  if (!inn || (status !== "liquidated" && status !== "ceased")) return null;
  const claim = {
    status, inn, ogrn: digits(item?.legal_status_ogrn),
    source_url: String(item?.legal_status_source_url || ""),
    evidence_excerpt: String(item?.legal_status_evidence || "").slice(0, 350),
    method: "final_inn_web", checked_at: new Date().toISOString()
  };
  return claim;
}
