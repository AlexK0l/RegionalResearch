// Evidence-first discovery quality assessment, using ONLY the organizations
// and independent source URLs seen during the current research run.
// Never reads completed jobs, checkpoints from another run, or benchmark lists.
// Planning/filtering is offline: network calls are owned by the pipeline.
const SECTIONS = ["direct_buyers", "intermediaries", "leasing"];
const text = value => String(value ?? "").trim();
const arr = value => Array.isArray(value) ? value : [];
const normalize = value => text(value).toLowerCase().replace(/ё/g, "е")
  .replace(/[^a-zа-я0-9]+/gu, " ").replace(/\s+/g, " ").trim();

function validUrl(raw) {
  try {
    const u = new URL(text(raw));
    return u.protocol === "https:" && u.hostname.includes(".") &&
      !u.username && !u.password &&
      !/^turn\d+(?:search|view|fetch|news)\d+$/i.test(u.hostname);
  } catch { return false; }
}
function urlsFor(row) {
  return [...new Set(arr(row?.__evidence?.source_urls).filter(validUrl))];
}
function contentFor(row) {
  const evidence = row?.__evidence || {};
  return normalize([
    row?.["Организация"], row?.["Техника/сегмент"],
    row?.["Основание"], ...arr(evidence.notes)
  ].join(" "));
}
function rowsOf(result) {
  return SECTIONS.flatMap(sheet => arr(result?.[sheet]).map(row => ({ sheet, row })));
}
function nameOf(row) { return normalize(row?.["Организация"]); }
function compactInt(value, fallback, cap) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(0, Math.min(cap, Math.floor(number))) : fallback;
}

export function planAutonomousDiscoveryCoverage({
  current, sectors = [], undercoveredGeography = [], classifySource = () => "other",
  gradeForRow = () => "", maxPasses = 2
} = {}) {
  const seen = rowsOf(current);
  const existingNames = new Set(seen.map(({row}) => nameOf(row)).filter(Boolean));
  const summaries = [];
  for (const sector of arr(sectors)) {
    if (!sector?.key || !sector?.pattern || !sector?.label) continue;
    const names = new Set();
    const strongNames = new Set();
    const sourceFamilies = new Set();
    let noUrls = 0;
    for (const {sheet, row} of seen) {
      const key = nameOf(row);
      if (!key || names.has(key) || !sector.pattern.test(contentFor(row))) continue;
      names.add(key);
      const sources = urlsFor(row);
      if (!sources.length) noUrls++;
      for (const url of sources) sourceFamilies.add(text(classifySource(url)));
      const decision = gradeForRow({sheet, row});
      const grade = typeof decision === "string" ? decision : decision?.grade;
      // The model's preliminary A/B label is NOT accepted as evidence here.
      if (sources.length && ["A", "B"].includes(grade)) strongNames.add(key);
    }
    const count = names.size;
    const strong = strongNames.size;
    const diversity = [...sourceFamilies].filter(Boolean).length;
    const ratio = count ? strong / count : 0;
    // A small/empty sector was already inspected by the ordinary census.
    // This second opinion is for measurable EVIDENCE quality gaps, not for
    // inflating the total count of organizations.
    const eligible = count >= 2 && (ratio < 0.25 || diversity <= 1);
    const score = eligible ? Number((
      (1 - ratio) * 4 +
      (1 - Math.min(1, diversity / 3)) * 2 +
      (count ? noUrls / count : 0) +
      Math.min(1, Math.log1p(count) / 5)
    ).toFixed(3)) : 0;
    summaries.push({
      key: sector.key, label: sector.label, count,
      strong, weak_or_unverified: Math.max(0, count - strong),
      source_families: [...sourceFamilies].sort(),
      source_diversity: diversity, rows_without_urls: noUrls,
      eligible, score
    });
  }
  const geo = arr(undercoveredGeography).map(g => ({
    scope: text(g?.scope),
    count: compactInt(g?.count, 0, 1000000)
  })).filter(g => g.scope).sort((a,b) =>
    a.count - b.count || a.scope.localeCompare(b.scope, "ru"));
  const limit = compactInt(maxPasses, 2, 4);
  const passes = summaries.filter(s => s.eligible)
    .sort((a,b) => b.score - a.score ||
      a.strong - b.strong || a.key.localeCompare(b.key))
    .slice(0, limit).map((s,i) => ({
      index: i,
      key: s.key,
      sector: s.label,
      geography: geo.length ? geo[i % geo.length].scope : "",
      reason: "current_run_evidence_gap",
      observed: {companies: s.count, stronger_evidence: s.strong,
        source_families: s.source_families},
      no_historical_inputs: true
    }));
  return {
    version: 1,
    strategy: "current_run_only_source_quality",
    historical_jobs_read: 0,
    named_company_targets: 0,
    current_seen_organizations: existingNames.size,
    sectors: summaries,
    passes,
    max_passes: limit
  };
}

export function autonomousDiscoveryPrompt({
  region, pass, alreadyFound = [], core = ""
} = {}) {
  const known = arr(alreadyFound).slice(-120).map(text).filter(Boolean);
  return [
    text(core),
    "АВТОНОМНАЯ ПРОВЕРКА ПРОБЕЛОВ ДОКАЗАТЕЛЬСТВ В ТЕКУЩЕМ ИССЛЕДОВАНИИ.",
    "РЕГИОН: " + text(region),
    "ОТРАСЛЬ/ТИП ГРУЗОПОТОКА: " + text(pass?.sector),
    pass?.geography ? "МАЛООХВАЧЕННАЯ ГЕОГРАФИЯ: " + text(pass.geography)
      : "ГЕОГРАФИЯ: весь регион",
    "НАБЛЮДЕНИЕ: текущий поиск нашёл " +
      Number(pass?.observed?.companies || 0) +
      " организаций, с конкретными более сильными основаниями " +
      Number(pass?.observed?.stronger_evidence || 0) + ".",
    "УЖЕ ИСПОЛЬЗОВАННЫЕ ТИПЫ ИСТОЧНИКОВ: " +
      arr(pass?.observed?.source_families).join(", "),
    "ЗАДАЧА: самостоятельно смени формулировки поиска и типы источников.",
    "Ищи независимые свежие первичные документы: договоры на конкретную технику, " +
      "действительные объявления собственника, вакансии с полуприцепами, " +
      "судебные акты, реестры закупок, реальные кейсы перевозчика или производителя.",
    "Для КАЖДОЙ новой организации сохрани конкретный HTTPS URL и текстовое " +
      "объяснение её роли именно в целевом грузопотоке/технике.",
    "Не допускай автоматического переноса ИНН, роли, телефона или категории " +
      "из других исследований. Идентификацию каждой находки проверит отдельный этап.",
    "Наличие грузов, логистической потребности или ОКВЭД не означает эксплуатацию полуприцепа.",
    "Не подменяй отсутствие фактов предположениями или общими ссылками на поиск. " +
      "Если не удалось найти организации с самостоятельными источниками, верни пустые массивы.",
    "Не проводи обогащение контактов или повторный поиск известных организаций.",
    "УЖЕ НАЙДЕНО В ЭТОМ ЗАПУСКЕ: " + (known.join("; ") || "нет")
  ].filter(Boolean).join("\n");
}

export function filterAutonomousDiscoveryFindings({
  response, current, sector, isCommercial = () => true
} = {}) {
  const known = new Set(rowsOf(current).map(({row}) => nameOf(row)).filter(Boolean));
  const acceptedThisPass = new Set();
  const rejected = {
    duplicate_current: 0, duplicate_new: 0, no_name: 0,
    off_topic: 0, no_specific_source: 0, noncommercial: 0
  };
  const result = Object.fromEntries(SECTIONS.map(sheet => [sheet, []]));
  let accepted = 0;
  for (const {sheet,row} of rowsOf(response)) {
    const name = nameOf(row);
    if (!name) { rejected.no_name++; continue; }
    if (known.has(name)) { rejected.duplicate_current++; continue; }
    if (acceptedThisPass.has(name)) { rejected.duplicate_new++; continue; }
    const sources = urlsFor(row);
    const notes = arr(row?.__evidence?.notes).filter(note => text(note));
    if (!sources.length || !notes.length) {
      rejected.no_specific_source++; continue;
    }
    if (!sector?.pattern?.test(contentFor(row))) {
      rejected.off_topic++; continue;
    }
    if (!isCommercial(row)) { rejected.noncommercial++; continue; }
    // New discovery facts are hints only. In particular do not trust model-
    // authored identity_verification or contact fields at this stage.
    const evidence = {...row.__evidence, source_urls: sources, notes};
    delete evidence.identity_verification;
    delete evidence.legal_status_verification;
    const clean = {...row,
      __evidence: evidence,
      __autonomous_coverage: {
        version: 1,
        source: "same_run_independent_search",
        identity_reverified: false,
        source_content_reverified: false
      }
    };
    for (const key of [
      "Телефон", "Email", "Руководитель / ЛПР",
      "Выручка последнего подтвержденного года", "Численность"
    ]) delete clean[key];
    result[sheet].push(clean);
    acceptedThisPass.add(name);
    accepted++;
  }
  return {result, accepted, rejected,
    inherited_prior_inn: 0, historical_jobs_read: 0};
}
