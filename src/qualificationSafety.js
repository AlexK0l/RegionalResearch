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
const BRANCH = /^(?:обособленн.{0,20}подразделени[ея]|филиал|представительств)(?: |$)/;

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


// Qualification A must come from a positive, role-appropriate trailer claim.
// A legacy note that merely names trailers while denying ownership or stating
// a hypothetical need must never be interpreted as evidence of their use.
// JS \b word boundaries are ASCII-centric and unsafe on Cyrillic text.
const DIRECT_NEGATIVE_A = /(?:не\s+(?:установ|доказ|подтвержд|назван|названн|раскры|найден|указ|выявлен|следует|позволя|принадлеж)|нет\s+(?:положительн|независим|достаточн|прям|конкретн|сведен|данн|подтвержд)|отсутств|без\s+(?:независим|подтвержден|доказател)|не\s+дает\s+основан|нельзя|не\s+использован\s+как\s+основан|не\s+является\s+подтвержден)/;
const INFERRED_TRAILER_A = /(?:необходимост.{0,70}(?:прицеп|полуприцеп|комплектован|замен)|сигнал\s+эксплуатаци.{0,40}прицеп|вытекает\s+из|формиру.{0,60}грузопоток|созда.{0,60}(?:потребность|грузопоток|поток\s+поставок)|только\s+роль\s+(?:поставщик|победител)|положительн.{0,25}evidence.{0,30}нет)/;
const INFRASTRUCTURE_NOT_TRAILER_A = /(?:вес[ыо].{0,35}тонар|тонар.{0,35}вес[ыо]|упоминани.{0,45}тонар|тентованн\w*\s+транспорт|прицепн.{0,25}состав.{0,30}(?:предполага|сигнал|вероятн))/;
const EXTRA_NEGATIVE_A = /(?:не\s+(?:собственн|конкретн|положительн|самостоятельн)|требуется\s+отдельн.{0,40}подтвержден|для\s+повышения\s+уровн|положительн.{0,150}нет|повод\s+для\s+(?:обновлени|приобретени).{0,65}(?:прицеп|полуприцеп)|нуждается\s+в\s+(?:проверке|доказательстве))/;
const THIRD_PARTY_OWNERSHIP_A = /(?:полуприцеп.{0,100}принадлеж.{0,60}(?:перевозчик|подрядчик|сторонн)|принадлеж.{0,60}(?:перевозчик|подрядчик|сторонн).{0,100}полуприцеп|треть.{0,20}сторон.{0,100}полуприцеп)/;
const POSITIVE_OWNERSHIP_A = /(?:собственн.{0,45}(?:парк|тягач|полуприцеп|прицеп)|подтвержд.{0,50}(?:собственник|владельц)|(?:(?:полуприцеп|прицеп).{0,40}(?:на балансе|в собственности|эксплуатируется))|(?:приобрел|приобрела|приобрели|купил|куплено).{0,55}(?:прицеп|полуприцеп|тонар)|(?:лизингополучател|лизингодател).{0,80}полуприцеп)/;
const TRACTOR_ONLY_A = /(?:тягач.{0,65}(?:необходимост|комплектован|замен).{0,60}прицеп|лизинг\s+седельн.{0,30}тягач)/;

// Small/utility trailers, unsigned repair estimates and financial lessors do
// not establish heavy road-trailer operation by a DIRECT buyer.
const LIGHT_TRAILER_ONLY_A = /(?:легков.{0,35}прицеп|прицеп.{0,45}(?:мзса|дгу|дизель.{0,15}генератор)|мзса.{0,30}прицеп|прицеп.{0,45}цистерн.{0,20}1150)/;
const HEAVY_TRAILER_PROOF_A = /(?:полуприцеп|тонар[ -]?[0-9]{3,5}|schmitz|krone|kogel|wielton|grunwald|пстб[- ]?\d)/;
const UNCOMPLETED_SERVICE_A = /(?:предварител.{0,35}заказ.{0,10}наряд|предварител.{0,35}расчет.{0,50}ремонт|смет.{0,40}ремонт|предварител.{0,35}стоимост.{0,30}восстанов)/;
const ACTUAL_COMPLETED_SERVICE_A = /(?:выполн.{0,25}ремонт|фактическ.{0,30}отремонтирован|акт.{0,20}выполненн.{0,30}работ)/;

/** Return a diagnostic reason to reject a false A evidence note, or "". */
export function rejectUnsafeAEvidence(record, note) {
  // Preserve the colon in provenance prefixes (Final INN:, Identity:).
  const s = String(note || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  if (/^(?:identity:|final inn:|подтвержденный инн:|identity без нового web-search:)/.test(s)) {
    return "identity_metadata_not_trailer_proof";
  }
  if (EXTRA_NEGATIVE_A.test(s)) return "negative_or_inferred_trailer_event";
  if (LIGHT_TRAILER_ONLY_A.test(s) && !HEAVY_TRAILER_PROOF_A.test(s)) {
    return "light_utility_trailer_not_target_heavy_freight";
  }
  if (record?.sheet === "direct_buyers" &&
      /(?:лизингодатель|арендодатель).{0,110}(?:полуприцеп|прицеп)|(?:полуприцеп|прицеп).{0,110}(?:лизингодатель|арендодатель)/.test(s) &&
      !/(?:собственн.{0,40}эксплуатац|самостоятельн.{0,40}перевоз)/.test(s)) {
    return "lessor_role_not_direct_buyer";
  }
  if (record?.sheet === "intermediaries" &&
      UNCOMPLETED_SERVICE_A.test(s) && !ACTUAL_COMPLETED_SERVICE_A.test(s)) {
    return "preliminary_quote_not_completed_repair";
  }
  if (DIRECT_NEGATIVE_A.test(s)) {
    // Confirmed ownership is A even when an individual trip is unobserved.
    const owned = POSITIVE_OWNERSHIP_A.test(s);
    const operationUnobserved = /(?:фактическ.{0,30}эксплуатаци.{0,35}не\s+установл|эксплуатаци.{0,35}не\s+подтвержд)/.test(s);
    if (!(owned && operationUnobserved)) return "negative_or_unknown_trailer_claim";
  }
  if (INFERRED_TRAILER_A.test(s) && !POSITIVE_OWNERSHIP_A.test(s)) {
    return "inferred_not_actual_trailer_event";
  }
  if (INFRASTRUCTURE_NOT_TRAILER_A.test(s) && !POSITIVE_OWNERSHIP_A.test(s)) {
    return "infrastructure_or_trailer_inference_only";
  }
  if (TRACTOR_ONLY_A.test(s) && !POSITIVE_OWNERSHIP_A.test(s)) {
    return "tractor_only_not_trailer";
  }
  if (record?.sheet === "direct_buyers") {
    const notes = Array.isArray(record?.row?.__evidence?.notes)
      ? record.row.__evidence.notes.map(normalized) : [];
    if (notes.some((other) => THIRD_PARTY_OWNERSHIP_A.test(other)) &&
        !notes.some((other) => POSITIVE_OWNERSHIP_A.test(other))) {
      return "third_party_trailer_not_own";
    }
  }
  return "";
}
