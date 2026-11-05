// Historical coverage is a discovery hint, never proof of present identity,
// legal status, grade, phone, or revenue. This module has no API calls.
import { commercialEligibility } from "./qualificationSafety.js";

const SECTIONS = ["direct_buyers", "intermediaries", "leasing"];
const CURRENT_SECTIONS = [...SECTIONS, "qualification_review", "qualification_excluded"];
const txt = value => String(value ?? "").trim();
const arr = value => Array.isArray(value) ? value : [];

function validInn(value) {
  const digits = txt(value);
  if (!/^\d{10}(?:\d{2})?$/.test(digits)) return "";
  const d = [...digits].map(Number);
  const checksum = (index, weights) =>
    weights.reduce((total, weight, i) => total + weight * d[i], 0) % 11 % 10 === d[index];
  return digits.length === 10
    ? (checksum(9, [2, 4, 10, 3, 5, 9, 4, 6, 8]) ? digits : "")
    : (checksum(10, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) &&
       checksum(11, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) ? digits : "");
}

function normalizedName(value) {
  return txt(value).toLowerCase().replace(/ё/g, "е")
    .replace(/^общество с ограниченной ответственностью\s*/, "ооо ")
    .replace(/^акционерное общество\s*/, "ао ")
    .replace(/^индивидуальный предприниматель\s*/, "ип ")
    .replace(/[^a-zа-я0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function validSourceUrl(value) {
  try {
    const url = new URL(txt(value));
    return url.protocol === "https:" &&
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(url.hostname) &&
      !url.username && !url.password &&
      !/^turn\d+(?:search|view|fetch|news)\d+$/i.test(url.hostname);
  } catch { return false; }
}

const commercialRows = doc => SECTIONS.flatMap(section => arr(doc?.[section]));
const allCurrentRows = doc => Array.isArray(doc)
  ? doc.map(item => item?.data || item)
  : CURRENT_SECTIONS.flatMap(section => arr(doc?.[section]));

function previousGrade(row) {
  const grade = txt(row?.__final_grade).toUpperCase() ||
    txt(row?.["Основание"]).toUpperCase().slice(0, 1);
  return ["A", "B", "C"].includes(grade) ? grade : "C";
}

function historyRows(history) {
  const result = [];
  for (const run of arr(history)) {
    if (!run || !run.final_result || !run.id) continue;
    for (const row of commercialRows(run.final_result)) {
      const inn = validInn(row?.["ИНН"]);
      const name = txt(row?.["Организация"]);
      const key = normalizedName(name);
      const proof = row?.__evidence?.identity_verification;
      const urls = [...new Set(arr(proof?.source_urls).filter(validSourceUrl))];
      if (!inn || !key || proof?.inn !== inn || !urls.length) continue;
      if (commercialEligibility(row).blocked) continue;
      result.push({
        inn, name, name_key: key,
        city: txt(row?.["Город/район"]).slice(0, 150),
        source_hint: urls[0],
        grade: previousGrade(row),
        source_job_id: txt(run.id),
        source_updated_at: txt(run.updated_at)
      });
    }
  }
  return result;
}

/**
 * Completed region-matched SQLite runs, newest first. Same-name distinct-INN
 * conflicts are quarantined instead of supplied to the model.
 */
export function buildHistoricalRecallPlan(history, current, { maxCandidates = 24 } = {}) {
  const prior = historyRows(history);
  const byInn = new Map();
  for (const row of prior) if (!byInn.has(row.inn)) byInn.set(row.inn, row);
  const unique = [...byInn.values()];
  const innsByName = new Map();
  for (const item of unique) {
    if (!innsByName.has(item.name_key)) innsByName.set(item.name_key, new Set());
    innsByName.get(item.name_key).add(item.inn);
  }
  const currentInns = new Set();
  const currentNames = new Map();
  for (const row of allCurrentRows(current)) {
    const inn = validInn(row?.["ИНН"]);
    const name = normalizedName(row?.["Организация"]);
    if (inn) currentInns.add(inn);
    if (name) {
      if (!currentNames.has(name)) currentNames.set(name, new Set());
      if (inn) currentNames.get(name).add(inn);
    }
  }

  let seenByInn = 0, seenByName = 0, ambiguous = 0, currentConflict = 0;
  const gaps = [], conflicts = [];
  for (const item of unique) {
    if (currentInns.has(item.inn)) { seenByInn++; continue; }
    if ((innsByName.get(item.name_key)?.size || 0) > 1) {
      ambiguous++;
      conflicts.push({ name: item.name, kind: "prior_same_name_multiple_inn" });
      continue;
    }
    const matching = currentNames.get(item.name_key);
    if (matching?.size) {
      currentConflict++;
      conflicts.push({ name: item.name, kind: "current_same_name_different_inn" });
      continue;
    }
    if (currentNames.has(item.name_key)) { seenByName++; continue; }
    gaps.push(item);
  }

  // Prior A/B is a search PRIORITY SIGNAL ONLY, not inherited qualification.
  const rank = { A: 0, B: 1, C: 2 };
  gaps.sort((a, b) => rank[a.grade] - rank[b.grade] ||
    b.source_updated_at.localeCompare(a.source_updated_at) ||
    a.name.localeCompare(b.name, "ru"));
  const cap = Math.max(0, Math.min(2000, Math.floor(Number(maxCandidates) || 0)));
  return {
    version: 1,
    prior_runs: arr(history).map(run => txt(run?.id)).filter(Boolean),
    verified_history_unique: unique.length,
    already_seen_by_inn: seenByInn,
    already_seen_by_name_unverified: seenByName,
    ambiguous_history: ambiguous,
    current_name_inn_conflicts: currentConflict,
    conflicts,
    total_missing_candidates: gaps.length,
    deferred_candidates: Math.max(0, gaps.length - cap),
    candidates: gaps.slice(0, cap)
  };
}

export function historicalRecallPrompt(region, candidates) {
  const hints = arr(candidates).map(item => ({
    organization: txt(item.name).slice(0, 160),
    region_hint: txt(item.city).slice(0, 120),
    historical_url_hint: validSourceUrl(item.source_hint) ? item.source_hint : ""
  }));
  return [
    "ИСТОРИЧЕСКИЕ ПОДСКАЗКИ, НЕ ДОКАЗАТЕЛЬСТВА.",
    "Повторно найди среди организаций региона " + txt(region) +
      " покупателей, лизингополучателей, владельцев и ремонтников тяжёлых автомобильных прицепов.",
    "Выполни web_search по КАЖДОЙ организации из списка, проверяя конкретные источники.",
    "Исторические URL только ориентиры поиска. Их наличие не подтверждает актуальность,",
    "не подтверждает собственный парк и не разрешает перенос старого ИНН или контактов.",
    "Если организация одноимённая, из другого региона, ликвидирована, нерелевантна",
    "или доказательства отсутствуют — не возвращай её.",
    "Не добавляй другой стороне договора ИНН или действие проверяемой организации.",
    "Возвращай ТОЛЬКО независимо найденные организации из списка:",
    JSON.stringify(hints),
    "Верни только JSON вида",
    '{"direct_buyers":[],"intermediaries":[],"leasing":[]}',
    'с полями "Организация","ИНН","Город/район","Техника/сегмент","Основание",',
    '"__evidence":{"source_urls":[],"notes":[]}.',
    "Сохрани конкретные страницы-источники и описание роли юридического лица."
  ].join("\n");
}

/** Accept only new, entity-specific search output; old INN never propagates. */
export function filterHistoricalRecallFindings(result, candidates) {
  const expected = new Map(arr(candidates).map(item => [normalizedName(item?.name), item]));
  const accepted = { direct_buyers: [], intermediaries: [], leasing: [] };
  const acceptedNames = new Set();
  let rejected = 0;
  for (const sheet of SECTIONS) for (const row of arr(result?.[sheet])) {
    const key = normalizedName(row?.["Организация"]);
    const hint = expected.get(key);
    const evidence = row?.__evidence || {};
    const urls = [...new Set(arr(evidence.source_urls).filter(validSourceUrl))].slice(0, 6);
    const notes = arr(evidence.notes).filter(note => typeof note === "string" && note.trim());
    if (!hint || acceptedNames.has(key) || !urls.length || !notes.length ||
        commercialEligibility(row).blocked) { rejected++; continue; }
    acceptedNames.add(key);
    accepted[sheet].push({
      ...row,
      "ИНН": "", // Prior legal identity cannot be laundered through a search prompt.
      __evidence: { ...evidence, source_urls: urls, notes },
      __historical_recall: {
        version: 1,
        prior_job_id: hint.source_job_id,
        status: "fresh_discovery_candidate_not_identity_verified",
        historical_inn_copied: false
      }
    });
  }
  return { result: accepted, accepted_count: acceptedNames.size, rejected_count: rejected };
}
