// Evidence-first helpers: qualification is derived from attributable source
// claims, never from an LLM's preliminary A/B/C label or its segment synopsis.
const CARGO = /зерн|рапс|масличн|пшениц|ячмен|кукуруз|комбикорм|кормов|щеб|песок|пгс|пгм|грави|карьер|неруд|торф|лесоматериал|пиломатериал|древес|щеп|опил|пеллет|лом|металлолом|вторсыр|отход|тко|цемент|бетон|асфальт|жби|строительн.{0,20}материал|сыпуч|навалоч|гранулирован|порошкообразн|удобрен|сырь[ея]/i;
const CARGO_ACTIVITY = /производ|добыч|добыва|выращ|отгруз|транспортирован|сбор|утилиз|захорон|перераб(?:от|ат)|заготов|реализ|поставк|поставля|перевоз|достав|вывоз|приемк|прием |приём |хранен|закуп|элеватор|комбикормов.{0,12}(?:завод|комплекс)|карьер|комплекс.{0,20}(?:производ|переработ)/i;
const HEAVY_EQUIPMENT = /самосвал|тягач|полуприцеп|автопоезд|зерновоз|щеповоз|ломовоз|мусоровоз|большегруз|фур[аы](?![а-яё])|камаз|белаз|shacman|howo|sitrak|тонар|грузов.{0,20}(?:автомоб|транспорт|машин|автопарк)|специализированн.{0,20}(?:автомоб|грузов|техник)/i;
const OPERATION = /собственн|имеет|эксплуат|использует|арендует|лизинг|на балансе|автопарк|водител|ваканси|нанима|набор|набирает|выполняет|осуществля|достав|перевоз|вывоз|обслужив|работа.{0,15}(?:в карьере|на самосвал)|рейс|парк.{0,25}(?:машин|техник)/i;
const TRUCK_CONTRACT = /договор.{0,70}(?:грузов.{0,20}перевоз|транспортирован|вывоз)|контракт.{0,70}(?:грузов.{0,20}перевоз|транспортирован|вывоз)|транспортн.{0,30}(?:контракт|оператор)|специализир.{0,30}(?:автомобильн|грузов).{0,40}перевоз/i;
const SPECIAL_TRANSPORT = /водител.{0,40}категори.{0,15}(?:се|ce|сe|cе|е|e)(?=\s|[,.;]|$)|категори.{0,12}(?:се|ce|сe|cе|е|e).{0,45}водител|собственн.{0,35}(?:грузов.{0,20}транспорт|автопарк|самосвал|перевоз|автомобил)|специализированн.{0,30}(?:автопарк|перевоз|транспортирован)|(?:автомобильн|грузов).{0,25}перевоз.{0,30}(?:тонн|тко|отход|зерн|неруд)/i;
const NEGATIVE = /не подтвержд|не найден|не обнаружен|не раскрыт|не указан|нет данных|нет сведений|нет доказательств|потенциальн|вероятн|предполож|экономически рациональн|может потреб|могут использ|не принадлеж|не собственник|чуж.{0,20}(?:парк|техник)|лишь предполага|отсутству|требует дополнительн|теоретическ|логистически вероятн|физически необходим|не доказан|не установл/i;
// Hypothetical transport demand and seller catalogues are not evidence that
// the named organization actually operates a heavy-vehicle fleet.
const INFERRED_TRANSPORT = /требующ.{0,65}(?:перевоз|достав|автомоб)|требует.{0,65}(?:перевоз|достав|транспорт)|созда.{0,65}(?:потребн|необходим).{0,55}(?:перевоз|вывоз|достав|логист|автомоб)|потребност.{0,65}(?:перевоз|вывоз|достав|логист|автомоб)|необходим.{0,60}(?:автомоб|достав|перевоз)|предполага.{0,45}(?:логист|транспорт|перевоз)|экономическ.{0,45}(?:оправдан|целесообразн|релевантн)|логистическ.{0,55}(?:потребн|обоснован)|создает.{0,65}спрос|потребност.{0,110}(?:зерновоз|самосвал|полуприцеп|тягач)|вытекает из.{0,80}(?:грузопоток|поток|поставк|производств)/i;
const MARKETPLACE_ONLY = /каталог|карточк.{0,50}(?:полуприцеп|прицеп)|поставщик.{0,80}(?:полуприцеп|прицеп)|(?:продавец|дилер).{0,70}(?:прицеп|полуприцеп)|прода.{0,50}(?:прицеп|полуприцеп)/i;
const EXPLICIT_OWN_OPERATION = /эксплуатир|на балансе|в собственности|собственн.{0,35}(?:парк|самосвал|тягач|автопоезд|полуприцеп)|осуществля.{0,45}перевоз/i;
const BULK_OWN_DELIVERY = /(?:достав|перевоз|вывоз).{0,60}(?:песок|щеб|пгс|бетон|грунт|зерн|корм|тко|отход).{0,50}собственн.{0,20}транспорт|собственн.{0,20}транспорт.{0,60}(?:песок|щеб|пгс|бетон|грунт|зерн|корм|тко|отход)/i;
const MACHINE_COUNT = /(?:[1-9]\d{1,4}\s*(?:машин|грузов.{0,15}автомобил|рейс)|(?:ежедневно|ежемесячно|в месяц|в сутки).{0,50}(?:машин|автомобил|рейс))/i;

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

function sourceNotes(row) {
  return (Array.isArray(row?.__evidence?.notes) ? row.__evidence.notes : [])
    .map((x) => String(x || "").trim()).filter(Boolean)
    .filter((x) => !/^(?:identity:|final inn:|подтвержденный инн:|identity без нового web-search:)/i.test(normalizeText(x)));
}

function usableSourceUrl(value) {
  return /^https?:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+/i.test(String(value || "").trim());
}

function isCargoClaim(text) {
  return CARGO.test(text) && CARGO_ACTIVITY.test(text);
}

function isTransportClaim(text) {
  // Operating a documented heavy vehicle is sufficient; a generic promise
  // of "automotive delivery" or a classifier's inferred need is not.
  if (INFERRED_TRANSPORT.test(text) && !EXPLICIT_OWN_OPERATION.test(text)) return false;
  if (MARKETPLACE_ONLY.test(text) && !EXPLICIT_OWN_OPERATION.test(text)) return false;
  if (HEAVY_EQUIPMENT.test(text) && OPERATION.test(text)) return true;
  if (TRUCK_CONTRACT.test(text)) return true;
  if (BULK_OWN_DELIVERY.test(text)) return true;
  if (/лицензи.{0,60}(?:транспортирован|вывоз)|транспортирован.{0,60}лицензи/i.test(text)) return true;
  if (SPECIAL_TRANSPORT.test(text)) return true;
  if (MACHINE_COUNT.test(text) && /автомобил|машин|рейс/i.test(text)) return true;
  return false;
}

function splitClaims(value) {
  // Remove source URL markup but retain the source itself in __evidence.
  const cleaned = String(value || "")
    .replace(/\[[^\]]+\]\(https?:\/\/[^)]+\)/gi, "")
    .replace(/https?:\/\/\S+/gi, "");
  return cleaned.split(/(?:;\s*|\.\s+(?=[А-ЯЁA-Z])|[\r\n]+|,\s*(?=(?:конкретн|модель|марк)[^,.]{0,90}не\s+(?:подтвержд|найден|обнаружен|указан|раскрыт))|,\s*(?:но|однако|при этом)\s+|\s+(?:но|однако)\s+)/i)
    .map(normalizeText).filter(Boolean);
}

function legacyClaims(row) {
  const urls = (Array.isArray(row?.__evidence?.source_urls) ? row.__evidence.source_urls : [])
    .filter(usableSourceUrl);
  if (!urls.length && !sourceNotes(row).some((x) => /https?:\/\//i.test(x))) return [];
  return sourceNotes(row).flatMap((note, noteIndex) =>
    splitClaims(note).map((text, clauseIndex) => ({
      text, noteIndex, clauseIndex, origin: "legacy_notes"
    })).filter(({ text }) => !NEGATIVE.test(text))
  );
}

function independentClaimPair(claims) {
  const cargo = claims.filter(({ text }) => isCargoClaim(text));
  const transport = claims.filter(({ text }) => isTransportClaim(text));
  for (const c of cargo) {
    for (const t of transport) {
      if (c === t || c.text === t.text) {
        // Two separately stated factual predicates in the same clause can
        // represent independent SEMANTIC evidence (e.g. produces cement AND
        // operates its own dump trucks). "Перевозка зерна" alone cannot.
        const production = /производ|добыч|выращ|переработ|заготов|элеватор|карьер|выпуск/i.test(c.text);
        const operation = /(?:собственн.{0,35}(?:самосвал|автопарк|тягач|грузов|транспорт)|эксплуат.{0,35}(?:самосвал|тягач|автопоезд)|водител.{0,35}(?:самосвал|тягач)|имеет.{0,35}(?:самосвал|тягач|автопарк))/i.test(t.text);
        if (!(production && operation)) continue;
      }
      if (c.independenceGroup && t.independenceGroup && c.independenceGroup === t.independenceGroup) continue;
      return { valid: true, method: c.origin === "structured_facts" && t.origin === "structured_facts"
        ? "structured_facts" : "independent_claims", cargo: c.text, transport: t.text };
    }
  }
  return {
    valid: false,
    method: "insufficient_independent_evidence",
    cargo: cargo[0]?.text || "",
    transport: transport[0]?.text || ""
  };
}

export function independentBSignals(row) {
  const facts = Array.isArray(row?.__evidence?.facts) ? row.__evidence.facts : [];
  const explicit = facts
    .filter((f) => f && usableSourceUrl(f.source_url) && !NEGATIVE.test(normalizeText(f.statement)))
    .map((f) => ({
      text: normalizeText(f.statement),
      type: f.fact_type,
      independenceGroup: String(f.independence_group || ""),
      origin: "structured_facts"
    }));
  const structuredCargo = explicit.filter((f) => f.type === "cargo_process" && isCargoClaim(f.text));
  const structuredTransport = explicit.filter((f) => f.type === "heavy_transport" && isTransportClaim(f.text));
  if (structuredCargo.length && structuredTransport.length) {
    const pair = independentClaimPair([...structuredCargo, ...structuredTransport]);
    if (pair.valid) return pair;
  }
  return independentClaimPair([...explicit, ...legacyClaims(row)]);
}

export function verifiedInnFromEvidence(row, normalizeInn) {
  const inn = normalizeInn(row?.["ИНН"]);
  const evidence = row?.__evidence || {};
  const proof = evidence.identity_verification;
  if (!inn || !proof || normalizeInn(proof.inn) !== inn) return "";
  const urls = Array.isArray(proof.source_urls) ? proof.source_urls : [];
  if (!urls.some((url) => /^https?:\/\//i.test(String(url)))) return "";
  return proof.method === "identity_web" || proof.method === "final_inn_web" ? inn : "";
}

export function populateKnownEvidenceFields(row) {
  if (!Array.isArray(row?.__evidence?.facts)) return 0;
  let filled = 0;
  // Values can be reused only when their original source is explicitly linked.
  for (const fact of row.__evidence.facts) {
    if (!/^https?:\/\//i.test(String(fact?.source_url || ""))) continue;
    const match = String(fact.statement || "").match(/^\s*(выручка|численность)\s*[:=]\s*(\d[\d\s]*)\s*(?:рублей|руб\.|сотрудников|человек)?\s*$/i);
    if (!match) continue;
    const field = match[1].toLowerCase() === "выручка"
      ? "Выручка последнего подтвержденного года" : "Численность";
    if (String(row[field] || "").trim()) continue;
    const number = Number(match[2].replace(/\s+/g, ""));
    if (Number.isSafeInteger(number) && number > 0) {
      row[field] = number;
      filled++;
    }
  }
  return filled;
}

function conciseEvidence(row) {
  const notes = sourceNotes(row).filter((note) => !NEGATIVE.test(normalizeText(note)));
  const direct = String(row?.__a_evidence || "").trim();
  if (direct && !NEGATIVE.test(normalizeText(direct))) return direct.slice(0, 260);
  if (notes.length) return notes[0].slice(0, 260);
  return String(row?.["Техника/сегмент"] || "").trim().slice(0, 180);
}

export function populateCommercialActions(row, sheet, grade) {
  if (!row || !grade) return row;
  const evidence = conciseEvidence(row);
  const org = String(row["Организация"] || "").trim();
  const name = org || "организации";
  const nextField = "Следующее действие";
  const whyField = "Почему им нужно звонить / потенциальный интерес к САТ";
  const action = sheet === "leasing"
    ? "Связаться с ответственным за лизинг коммерческого транспорта; уточнить действующие программы по прицепной технике и клиентов региона."
    : sheet === "intermediaries"
      ? "Связаться с руководителем направления; выяснить конкретных клиентов с прицепной техникой и возможность партнёрских поставок САТ."
      : grade === "A"
        ? "Связаться с руководителем автопарка/закупок; проверить актуальность выявленной техники и планы замены или расширения парка."
        : grade === "B"
          ? "Связаться с логистом/руководителем транспорта; уточнить состав парка, типы грузов и планы приобретения прицепной техники."
          : "Установить фактического перевозчика и транспортную схему; проверить потенциальную потребность в прицепной технике САТ.";
  if (!String(row[nextField] || "").trim()) row[nextField] = action;
  if (!String(row[whyField] || "").trim()) {
    const preface = grade === "A" ? "Есть прямое свидетельство: " :
      grade === "B" ? "Есть независимые признаки целевого грузопотока и тяжёлой логистики: " :
        "Подтверждён релевантный грузовой или производственный процесс: ";
    row[whyField] = evidence ? preface + evidence :
      "Требуется уточнить характер грузопотока и потребность " + name + " в прицепной технике.";
  }
  return row;
}

export function safeSearchPriority(row) {
  const grade = String(row?.__final_grade || row?.["Основание"] || "").trim().toUpperCase();
  if (grade.startsWith("A")) return 3;
  if (grade.startsWith("B")) return 2;
  return 1;
}

export function distinctSourceFacts(row) {
  const evidence = row?.__evidence || {};
  const facts = Array.isArray(evidence.facts) ? evidence.facts : [];
  const seen = new Set();
  return facts.filter((fact) => {
    const key = String(fact?.fact_type || "") + "|" + normalizeText(fact?.statement) + "|" + String(fact?.source_url || "");
    if (!fact || !String(fact.statement || "").trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
