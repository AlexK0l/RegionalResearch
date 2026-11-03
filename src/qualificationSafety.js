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
const SOURCE_ONLY_NAME = /^(?:журнал|отраслевой справочник|отраслевой каталог)(?: |$)/;
const SOURCE_ONLY_ROLE = /(?:информационн.{0,30}(?:источник|канал)|discovery.{0,15}канал|не\s+(?:является|относится).{0,35}(?:покупател|перевозчик)|источник\s+(?:поиска|сведений))/i;

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
  // Source publications stay in discovery evidence, never a buyer CRM sheet.
  // Both the publisher name and a source-only role note must be present.
  if (SOURCE_ONLY_NAME.test(name) &&
      (Array.isArray(row?.__evidence?.notes) ? row.__evidence.notes : [])
        .some((note) => SOURCE_ONLY_ROLE.test(normalized(note)))) return "source_channel";
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
  if (byName === "source_channel") {
    return { blocked: true, kind: byName,
      reason: "Информационный/отраслевой источник не является самостоятельным покупателем прицепной техники.",
      source_url: "", method: "source_role", inn };
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
// Explicit denial of a trailer/own-fleet fact must outweigh nearby regex
// tokens such as "полуприцепы", "закупка" or "собственный автопарк".
// Keep this check per evidence note: an independent positive note is still
// eligible for A and must not be invalidated by an unrelated missing detail.
const DENIED_TRAILER_A = /(?:источник.{0,65}не\s+(?:содерж|связыва|подтвержда|раскрыв|указыва).{0,165}(?:полуприцеп|прицеп|парк|техник|закуп|приобрет)|сведен.{0,120}(?:полуприцеп|прицеп|автопарк|парк|закуп|техник).{0,85}(?:нет|отсутств|не\s+(?:найден|подтвержд))|(?:полуприцеп|прицеп|парк|автопарк).{0,85}(?:не\s+(?:связан|подтвержд|доказан)|сведени.{0,40}нет)|собственн.{0,50}(?:парк|прицеп|полуприцеп).{0,100}не\s+подтвержд)/;
// Historical notes may name "trailers" while explicitly denying their proof.
// These are not ownership evidence even if a keyword-based fleet rule matches.
// An affirmative trailer fleet remains eligible when only its *model* is unknown.
const UNSUPPORTED_TRAILER_NOTE_A =
  /(?:не\s+да(?:ет|ют)\s+достаточн.{0,95}(?:парк|тягач|прицеп|полуприцеп)|но\s+не\s+(?:полуприцепн|прицепн).{0,22}техник|(?:наличи|эксплуатаци).{0,85}(?:полуприцеп|прицеп).{0,50}не\s+заявлен|(?:уровен|класс).{0,30}(?:ограничен|оставлен|не\s+выше).{0,18}[bc])/i;
const UNSPECIFIED_TRAILER_MODELS_A =
  /(?:модел|тип|марк).{0,65}(?:прицеп|полуприцеп).{0,55}не\s+(?:приведен|указан|назван)|(?:прицеп|полуприцеп).{0,70}(?:модел|тип|марк).{0,55}не\s+(?:приведен|указан|назван)/i;
const AFFIRMED_OWN_TRAILERS_A =
  /(?:собственн(?:(?!,\s*но\s|;\s*но\s).){0,75}(?:прицеп|полуприцеп)|(?:прицеп|полуприцеп).{0,45}(?:на балансе|в собственности|эксплуатируется|подтвержден))/i;

// An A-class fleet claim must not be inferred from a request to check the
// trailer types, a statement that public proof is absent, or a predicted
// need for trailers. These negative / speculative notes are assessed one by
// one: a separate, positively documented acquisition or own trailer fleet
// may still qualify as A.
const ADDITIONAL_DIRECT_NEGATIVE_A = /публичн.{0,25}подтвержден.{0,100}(?:парк|лизинг|эксплуатаци).{0,100}(?:прицеп|полуприцеп).{0,90}нет/i;
const ADDITIONAL_UNSUPPORTED_A = /(?:парк.{0,60}(?:прицепн|полуприцеп).{0,70}требу.{0,35}проверк|(?:прицепн|полуприцеп).{0,45}(?:парк|техник).{0,45}требу.{0,35}проверк|(?:склад|автопарк).{0,110}потребност.{0,75}(?:прицеп|полуприцеп))/i;
const CONCRETE_POSITIVE_TRAILER_A = /(?:собственн.{0,55}(?:полуприцеп|прицеп)|(?:прицеп|полуприцеп).{0,45}(?:в собственности|на балансе|эксплуат)|(?:купил|куплен|приобрел|приобрела|приобрели|закупк).{0,65}(?:прицеп|полуприцеп)|(?:прицеп|полуприцеп).{0,65}(?:купил|приобрел|закупк))/i;
// Do not mistake editorial warnings, inferred cargo demand, aggregator
// snippets or a shared GROUP fleet for fleet ownership by an individual LLC.
// All checks use one claim at a time except the explicitly unresolved
// group-fleet attribution, which is checked across the saved notes.
const EXPLICIT_CLASS_REJECTION_A =
  /(?:не\s+повышат.{0,18}до\s*a\s*\/\s*b|не\s+присваиват.{0,25}(?:уровен|класс)\s*a|без\s+отдельн.{0,50}доказательств.{0,60}(?:прицеп|полуприцеп))/i;
const INFERRED_JOB_AND_TRAILER_A =
  /(?:сочетани.{0,130}(?:категори.{0,10}(?:e|е|ce|се)).{0,100}делает\s+релевантн.{0,90}(?:прицеп|полуприцеп)|(?:агрегированн.{0,25}карточк).{0,140}типов.{0,35}рол.{0,110}(?:прицеп|полуприцеп))/i;
const GROUP_FLEET_UNATTRIBUTED_A =
  /(?:распределени.{0,130}(?:между.{0,100})?не\s+раскрыт|не\s+раскрыт.{0,100}распределени.{0,90}(?:парк|техник|единиц))/i;
const ENTITY_SPECIFIC_TRAILER_EVENT_A =
  /(?:лизингополучател.{0,90}(?:прицеп|полуприцеп)|(?:прицеп|полуприцеп).{0,90}лизингополучател|(?:купил|купила|куплено|приобрел|приобрела|приобрели).{0,70}(?:прицеп|полуприцеп)|(?:прицеп|полуприцеп).{0,70}(?:купил|приобрел|приобрела)|(?:в собственности|на балансе|собственник).{0,70}(?:прицеп|полуприцеп)|(?:прицеп|полуприцеп).{0,70}(?:в собственности|на балансе|собственник))/i;
const GROUP_FLEET_WORDS_A = /(?:групп|общ.{0,30}парк|предприяти.{0,30}компани)/i;

const THIRD_PARTY_OWNERSHIP_A = /(?:полуприцеп.{0,100}принадлеж.{0,60}(?:перевозчик|подрядчик|сторонн)|принадлеж.{0,60}(?:перевозчик|подрядчик|сторонн).{0,100}полуприцеп|треть.{0,20}сторон.{0,100}полуприцеп)/;
const POSITIVE_OWNERSHIP_A = /(?:собственн.{0,45}(?:парк|тягач|полуприцеп|прицеп)|подтвержд.{0,50}(?:собственник|владельц)|(?:(?:полуприцеп|прицеп).{0,40}(?:на балансе|в собственности|эксплуатируется))|(?:приобрел|приобрела|приобрели|купил|куплено).{0,55}(?:прицеп|полуприцеп|тонар)|(?:лизингополучател|лизингодател).{0,80}полуприцеп)/;
const TRACTOR_ONLY_A = /(?:тягач.{0,65}(?:необходимост|комплектован|замен).{0,60}прицеп|лизинг\s+седельн.{0,30}тягач)/;

// Small/utility trailers, unsigned repair estimates and financial lessors do
// not establish heavy road-trailer operation by a DIRECT buyer.
// Auctioning an asset in liquidation/bankruptcy does not prove a current
// purchase/operation need. A separate current, entity-specific source can
// still qualify as A; this check concerns only the disposal note.
const BANKRUPTCY_DISPOSAL_A = /(?:банкротств|конкурсн.{0,20}производств|ликвидационн.{0,25}торг|распродаж.{0,30}имуществ).{0,170}(?:продаж|реализац|отчужд|торг|прицеп|полуприцеп)|(?:ранее\s+находивш.{0,40}баланс|реализованн.{0,25}с\s+торгов).{0,100}(?:прицеп|полуприцеп)/i;
// Direct buyer A cannot be inferred from a debtor's historic trailers or from
// a sale/pledge listing. A separately evidenced later buyer event remains valid.
// Check ALL saved notes: often the fleet synopsis omits that the source was an auction.
const DISPOSED_TRAILER_CONTEXT_A =
  /(?:банкротств|конкурсн.{0,25}производств|должник|залогов.{0,35}имуществ|лот.{0,45}(?:продаж|имуществ|полуприцеп|прицеп)|(?:полуприцеп|прицеп).{0,45}лот|(?:продаж|реализац).{0,40}залогов|(?:выставлен|реализованн).{0,35}(?:на торг|с торгов)|(?:на|по)\s+торг(?:ах|ам)|(?:публичн.{0,25}предложени.{0,85}(?:продаж|имуществ|лот|торг)|(?:продаж|имуществ|лот|торг).{0,85}публичн.{0,25}предложени))/i;
const BANKRUPTCY_BUYER_EVENT_A =
  /(?:выиграл.{0,45}(?:торг|аукцион)|(?:приобрел|приобрела|купил|купила).{0,100}(?:на торгах|с торгов|по итогам торгов)|(?:покупател|победител).{0,40}лота)/i;
// A retrospective fleet inferred only from liquidation lots is not
// evidence of present ownership. This is checked on the same NOTE; a
// different contract/fleet note must be assessed independently.
const HISTORIC_FLEET_INFERENCE_A =
  /(?:ранее.{0,85}(?:сформирован|владени|на балансе|парк|прицеп)|(?:парк|прицеп|полуприцеп).{0,80}(?:ранее|историческ)|(?:сигнал|доказательств).{0,65}ранее сформирован)/i;
// An equipment PROCUREMENT and an order for someone else's haulage service
// are two different economic events, even when both mention semi-trailers.
const HAULAGE_SERVICE_CUSTOMER_A =
  /(?:закупк.{0,70}услуг.{0,95}(?:перевоз|достав|транспортир)|(?:услуг.{0,40}перевоз).{0,70}(?:закупк|тендер|договор)|(?:заказчик|грузовладельц).{0,65}(?:перевоз|транспортир|достав)|(?:перевоз|достав).{0,65}(?:заказчик|грузовладельц)|заказыва.{0,60}(?:перевоз|транспортир)|перевозк.{0,50}подрядчик)/i;
const DIRECT_TRAILER_PURCHASE_A =
  /(?:приобрел|приобрела|приобрели|купил|купила|закупил|закупила|заключил.{0,40}(?:договор|лизинг)).{0,95}(?:полуприцеп|прицеп|тонар|schmitz|kogel|krone)|(?:полуприцеп|прицеп|тонар|schmitz|kogel|krone).{0,65}(?:приобретен|куплен|закуплен|в собственности)/i;
// In agricultural catalogues "полуприцеп" may denote tractor-drawn equipment.
// A 2ПТС, ПРКТ feed-distributor or ПРТ hay roll carrier is not a road freight
// semitrailer merely because the archived note calls it a полуприцеп.
const TRACTOR_AGRI_TRAILER_A =
  /(?:тракторн.{0,75}(?:прицеп|полуприцеп)|(?:прицеп|полуприцеп).{0,75}тракторн|2птс\s*[- ]?\d|пркт\s*[- ]?\d|прт\s*[- ]?\d|(?:полуприцеп|прицеп).{0,45}(?:кормораздат|рулоновоз))/i;
const ROAD_TRAILER_EVENT_IN_MIXED_A =
  /(?:купил|приобрел|закупил|закупк|заключил.{0,20}договор).{0,75}(?:автомобильн.{0,20}полуприцеп|дорожн.{0,20}полуприцеп|полуприцеп.{0,25}(?:schmitz|kogel|krone|тонар)|полуприцеп.{0,35}г\s*\/\s*п\s*(?:2[5-9]|[3-9][0-9])(?:[,.][0-9]+)?\s*т)|(?:автомобильн|дорожн).{0,20}полуприцеп.{0,55}(?:приобретен|куплен|закуплен)/i;
const TRACTOR_UNIT_INFERENCE_A =
  /(?:лизинг|аренд).{0,55}седельн.{0,25}(?:тягач|самосвал).{0,130}(?:для.{0,35}эксплуатаци|комплектован|прицепн.{0,25}техник)|тягов.{0,30}единиц.{0,70}для.{0,30}эксплуатаци.{0,20}прицепн/i;
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
  // Requests for future evidence and absent repair customers are not completed A events.
  // Reject only the offending note; an independent positive event still wins.
  if (/(?:для\s+дальнейш.{0,45}квалификац.{0,50}нужн|для\s+подтвержден.{0,45}нужн.{0,40}документ|общее\s+сервисн.{0,65}но\s+нет|но\s+нет\s+(?:заказчик|клиент|номера\s+ремонта|марки\s+полуприцеп)|нет\s+(?:заказчика|клиента|номера\s+ремонта).{0,125}(?:прицеп|полуприцеп|ремонт))/.test(s)) {
    return "missing_completed_event_or_request_for_evidence";
  }
  const insolvencyDisposal = BANKRUPTCY_DISPOSAL_A.test(s) ||
    (/(?:банкротств|конкурсн.{0,20}производств|ликвидационн.{0,25}торг)/.test(s) &&
     /(?:продаж|реализац|отчужд|торг)/.test(s));
  if (record?.sheet === "direct_buyers") {
    // A company buying a real trailer *at* an auction is different from the
    // bankrupt debtor selling its trailer. Buyer role must be explicit.
    const identifiedDebtor = /(?:должник.{0,100}(?:полуприцеп|прицеп|лот|имуществ)|(?:полуприцеп|прицеп).{0,80}должник|собственник\s*\/\s*должник)/.test(s) &&
      !/не\s+должник/.test(s);
    const actualAuctionBuyer = BANKRUPTCY_BUYER_EVENT_A.test(s) && !identifiedDebtor;
    if (!actualAuctionBuyer && (insolvencyDisposal || DISPOSED_TRAILER_CONTEXT_A.test(s)) &&
        /(?:прицеп|полуприцеп|тонар|kogel|schmitz|krone)/.test(s)) {
      return "bankruptcy_or_collateral_asset_disposal_not_current_buyer";
    }
    // V7 regression: do NOT veto an independently documented contract or
    // active fleet simply because an OTHER note mentions an old auction.
    // Relevance to the same event/asset cannot be inferred from a shared
    // company's notes. Suspicious candidate notes are rejected on their own
    // content and kept available for review.
    if (HISTORIC_FLEET_INFERENCE_A.test(s) &&
        !/(?:подтвержден.{0,35}(?:нов.{0,15}договор|текущ.{0,25}эксплуатац)|отдельн.{0,20}договор.{0,65}(?:прицеп|полуприцеп))/.test(s)) {
      return "historical_auction_fleet_inference_not_current_operation";
    }
    if (HAULAGE_SERVICE_CUSTOMER_A.test(s) && !DIRECT_TRAILER_PURCHASE_A.test(s)) {
      return "purchased_transport_service_not_trailer";
    }
    if (TRACTOR_AGRI_TRAILER_A.test(s) && !ROAD_TRAILER_EVENT_IN_MIXED_A.test(s)) {
      return "tractor_agricultural_trailer_not_road_semitrailer";
    }
    if (TRACTOR_UNIT_INFERENCE_A.test(s) && !DIRECT_TRAILER_PURCHASE_A.test(s)) {
      return "tractor_unit_does_not_prove_trailer";
    }
  }
  if (DENIED_TRAILER_A.test(s)) return "explicit_denial_of_own_trailer_evidence";
  if (UNSUPPORTED_TRAILER_NOTE_A.test(s) ||
      (UNSPECIFIED_TRAILER_MODELS_A.test(s) && !AFFIRMED_OWN_TRAILERS_A.test(s))) {
    return "trailer_or_own_fleet_not_substantiated";
  }
  if (EXTRA_NEGATIVE_A.test(s)) return "negative_or_inferred_trailer_event";
  if (EXPLICIT_CLASS_REJECTION_A.test(s)) return "explicit_no_a_or_b_without_new_evidence";
  if (INFERRED_JOB_AND_TRAILER_A.test(s)) return "aggregated_or_inferred_driver_claim_not_a";
  if (record?.sheet === "direct_buyers") {
    const originalNotes = Array.isArray(record?.row?.__evidence?.notes)
      ? record.row.__evidence.notes.map((text) => String(text || "").toLowerCase().replace(/ё/g, "е"))
      : [];
    const groupFleetUndivided = originalNotes.some((other) => GROUP_FLEET_UNATTRIBUTED_A.test(other));
    // If a later independently stated company-specific purchase/lease/ownership
    // exists, it can still qualify; group membership alone cannot.
    const entityName = normalized(record?.row?.["Организация"] || "");
    const directProof = originalNotes.some((other) => {
      const noteNamesThisEntity = Boolean(entityName) && normalized(other).includes(entityName);
      return ENTITY_SPECIFIC_TRAILER_EVENT_A.test(other) &&
        !GROUP_FLEET_UNATTRIBUTED_A.test(other) &&
        // "ФАНТОМ ГРУПП" is a legal name, not automatically a GROUP-fleet
        // attribution. A separate contract naming that exact entity wins.
        (!GROUP_FLEET_WORDS_A.test(other) || noteNamesThisEntity);
    });
    if (groupFleetUndivided && !directProof) {
      return "shared_group_fleet_not_attributed_to_entity";
    }
  }
  if (ADDITIONAL_DIRECT_NEGATIVE_A.test(s) ||
      (ADDITIONAL_UNSUPPORTED_A.test(s) && !CONCRETE_POSITIVE_TRAILER_A.test(s))) {
    return "unsubstantiated_trailer_fleet_or_inferred_need";
  }
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

// Deterministic evidence ranking: prioritize specific buyer-side contracts,
// verified fleet operation and attributable equipment over general assertions.
// No source URL or ID is invented; the caller preserves the original note.
export function rankSafeAEvidence(record, note, rule) {
  const text = String(note || "").toLowerCase().replace(/ё/g, "е");
  const base = {
    direct_financial_lease: 105, direct_procurement: 95,
    direct_vin_ownership: 87, direct_ownership_or_fleet: 83,
    direct_driver_operation: 65, direct_operation: 60,
    intermediary_completed_transaction: 95, intermediary_completed_service: 90,
    intermediary_own_operation: 82, intermediary_established_channel: 74,
    leasing_concrete_contract: 100, leasing_concrete_transaction: 93
  };
  let score = base[rule] || 45;
  if (/(?:заключен.{0,30}договор|договор.{0,25}лизинг|акт выполненн|в собственности|на балансе|лизингополучател)/.test(text)) score += 16;
  if (/(?:приобрел|купил|закупил|приобретен|предмет.{0,20}финансов.{0,15}аренды)/.test(text)) score += 13;
  if (/(?:vin|госномер|\b(?:kogel|schmitz|krone|wielton|grunwald)\b|тонар\s*\d|полуприцеп.{0,25}\d{2,})/.test(text)) score += 8;
  if (/https?:\/\//.test(String(note || ""))) score += 7;
  const organization = normalized(record?.row?.["Организация"] || "");
  if (organization && normalized(note).includes(organization)) score += 9;
  // Editorial summaries and predictions are weaker than attributable events.
  if (/(?:указывает\s+на|сильн.{0,20}сигнал|вытекает|потенциальн|предполага)/.test(text)) score -= 17;
  return score;
}
