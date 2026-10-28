// Evidence-first helpers. The evidence source, not the generated lead description,
// determines whether a claim is strong enough to qualify a company.
const CARGO = /зерн|рапс|масличн|пшениц|ячмен|кукуруз|комбикорм|кормов|щеб|песок|пгс|грави|карьер|неруд|торф|лесоматериал|пиломатериал|древес|щеп|опил|пеллет|лом|металлолом|вторсыр|отход|тко|цемент|бетон|асфальт|сыпуч|навалоч|гранулирован|порошкообразн|удобрен|сырь[ея]/i;
const TRANSPORT = /седельн.{0,20}тягач|тягач|полуприцеп|прицеп[- ]?(?:зерновоз|самосвал)|самосвал|собственн.{0,30}(?:автопарк|грузов|транспорт)|лизинг.{0,40}(?:тягач|грузов)|грузов.{0,20}автопарк|категори.{0,12}(?:ce|cе|е)|водител.{0,30}(?:ce|cе|категори)|контракт.{0,40}перевоз|договор.{0,40}перевоз|автопоезд|парк.{0,25}(?:камаз|маз|howo|sitrak|shacman)/i;
const NEGATIVE = /не подтвержд|не найден|не обнаружен|не раскрыт|не указан|нет данных|нет сведений|нет доказательств|потенциальн|вероятн|предполож|экономически рациональн|может потреб|могут использ|не принадлеж|не собственник|чуж.{0,20}(?:парк|техник)|лишь предполага/i;

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

function sourceNotes(row) {
  return (Array.isArray(row?.__evidence?.notes) ? row.__evidence.notes : [])
    .map((x) => String(x || "").trim()).filter(Boolean)
    .filter((x) => !/^(?:identity:|final inn:|подтвержденный инн:|identity без нового web-search:)/i.test(normalizeText(x)));
}

export function independentBSignals(row) {
  const facts = Array.isArray(row?.__evidence?.facts) ? row.__evidence.facts : [];
  const accepted = facts.filter((x) => x && x.source_url && /^https?:\/\//i.test(String(x.source_url)) &&
    !NEGATIVE.test(normalizeText(x.statement)));
  const cargoFact = accepted.find((x) => x.fact_type === "cargo_process" && CARGO.test(normalizeText(x.statement)));
  const transportFact = accepted.find((x) => x.fact_type === "heavy_transport" && TRANSPORT.test(normalizeText(x.statement)));
  if (cargoFact && transportFact &&
      normalizeText(cargoFact.statement) !== normalizeText(transportFact.statement)) {
    return { valid: true, method: "structured_facts", cargo: cargoFact.statement, transport: transportFact.statement };
  }

  // Backward-compatible legacy evidence. A single broad description that says
  // "перевозит зерно" must NOT be counted as two independent strong signals.
  const notes = sourceNotes(row)
    .map((text) => ({ text, normalized: normalizeText(text) }))
    .filter((note) => !NEGATIVE.test(note.normalized));
  const cargo = notes.find((x) => CARGO.test(x.normalized));
  const transport = notes.find((x) => TRANSPORT.test(x.normalized));
  if (cargo && transport && cargo !== transport) {
    return { valid: true, method: "independent_notes", cargo: cargo.text, transport: transport.text };
  }
  if (cargo && transport && cargo === transport &&
      /[;.]\s+|(?:\sи\s+(?:имеет|владеет|эксплуатирует|заключил|использует))/.test(cargo.normalized) &&
      /(?:производ|добыв|выращив|отгруж|перерабат|перевозит|перевозк)/.test(cargo.normalized)) {
    return { valid: true, method: "separate_explicit_claims", cargo: cargo.text, transport: transport.text };
  }
  return { valid: false, method: "insufficient_independent_evidence", cargo: cargo?.text || "", transport: transport?.text || "" };
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
