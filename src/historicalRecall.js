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

// A source URL can itself embed an old INN (registry/1234567890).
// Never leak that identity into a new search prompt via a URL.
function safeSearchHintUrl(value) {
  if (!validSourceUrl(value)) return false;
  let decoded = txt(value);
  try { decoded = decodeURIComponent(decoded); } catch { /* keep raw */ }
  return !/\d{10}(?:\d{2})?/.test(decoded);
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
      const hintUrls = [...new Set([
        ...arr(row?.__evidence?.source_urls), ...urls
      ].filter(safeSearchHintUrl))];
      if (!inn || !key || proof?.inn !== inn || !urls.length) continue;
      if (commercialEligibility(row).blocked) continue;
      result.push({
        inn, name, name_key: key,
        city: txt(row?.["Город/район"]).slice(0, 150),
        source_hint: hintUrls[0] || "",
        identity_source_url: urls[0],
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
  const appearances = new Map();
  for (const row of prior) {
    if (!byInn.has(row.inn)) byInn.set(row.inn, row);
    if (!appearances.has(row.inn)) appearances.set(row.inn, new Set());
    appearances.get(row.inn).add(row.source_job_id);
  }
  const unique = [...byInn.values()].map(row => ({
    ...row, historical_run_count: appearances.get(row.inn).size
  }));
  // Only suppress repeated paid attempts from the most recent THREE
  // completed studies, not forever. Older failures must not become a
  // permanent exclusion of an otherwise relevant organization.
  const previousAttempts = new Set(arr(history).slice(0, 3).flatMap(run =>
    arr(run?.recall_attempted_inns).map(validInn).filter(Boolean)));
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
  let recentlyAttempted = 0;
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
    if (previousAttempts.has(item.inn)) { recentlyAttempted++; continue; }
    gaps.push(item);
  }

  // Prior A/B is a search PRIORITY SIGNAL ONLY, not inherited qualification.
  const rank = { A: 0, B: 1, C: 2 };
  gaps.sort((a, b) => rank[a.grade] - rank[b.grade] ||
    b.historical_run_count - a.historical_run_count ||
    b.source_updated_at.localeCompare(a.source_updated_at) ||
    a.name.localeCompare(b.name, "ru"));
  const cap = Math.max(0, Math.min(2000, Math.floor(Number(maxCandidates) || 0)));
  // Never let a few recent large studies starve older validated leads.
  // One quarter of the SMALL preexisting recall budget is reserved for
  // candidates absent from the latest three historical snapshots.
  const recentRunIds = new Set(arr(history).slice(0, 3).map(run => txt(run?.id)));
  const oldOnly = gaps.filter(item => !recentRunIds.has(item.source_job_id));
  const olderSlots = arr(history).length > 3
    ? Math.min(oldOnly.length, Math.floor(cap / 4)) : 0;
  const candidates = gaps.filter(item => recentRunIds.has(item.source_job_id))
    .slice(0, cap - olderSlots);
  candidates.push(...oldOnly.slice(0, olderSlots));
  const selectedInns = new Set(candidates.map(item => item.inn));
  for (const item of gaps) {
    if (candidates.length >= cap) break;
    if (!selectedInns.has(item.inn)) {
      candidates.push(item);
      selectedInns.add(item.inn);
    }
  }
  return {
    version: 1,
    prior_runs: arr(history).map(run => txt(run?.id)).filter(Boolean),
    verified_history_unique: unique.length,
    already_seen_by_inn: seenByInn,
    already_seen_by_name_unverified: seenByName,
    ambiguous_history: ambiguous,
    current_name_inn_conflicts: currentConflict,
    recently_attempted_in_previous_runs: recentlyAttempted,
    conflicts,
    total_missing_candidates: gaps.length,
    older_history_eligible: oldOnly.length,
    older_history_selected: candidates.filter(x => !recentRunIds.has(x.source_job_id)).length,
    deferred_candidates: Math.max(0, gaps.length - candidates.length),
    candidates
  };
}

export function historicalRecallPrompt(region, candidates) {
  const hints = arr(candidates).map(item => ({
    organization: txt(item.name).slice(0, 160),
    region_hint: txt(item.city).slice(0, 120),
    historical_url_hint: safeSearchHintUrl(item.source_hint) ? item.source_hint : ""
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
      "Организация": txt(row["Организация"]),
      "ИНН": "", // Prior legal identity cannot be laundered through a search prompt.
      "Город/район": txt(row["Город/район"]),
      "Техника/сегмент": txt(row["Техника/сегмент"]),
      "Основание": txt(row["Основание"]),
      __evidence: { source_urls: urls, notes },
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

// Audits names of NEW historical-discovery candidates after final sorting.
// Same-name matches are not proof that the same legal entity was recovered.
export function auditHistoricalRecallOutcome(recall, current) {
  const accepted = arr(recall?.accepted_candidates);
  const observed = new Map();
  for (const section of [...SECTIONS, "qualification_review", "qualification_excluded"]) {
    for (const row of arr(current?.[section])) {
      const key = normalizedName(row?.["Организация"]);
      if (!key) continue;
      if (!observed.has(key)) observed.set(key, []);
      observed.get(key).push({ section, inn: validInn(row?.["ИНН"]) });
    }
  }
  const prior = new Map(arr(recall?.plan?.candidates).map(item =>
    [normalizedName(item?.name), validInn(item?.inn)]));
  const entries = accepted.map(item => {
    const name = txt(item?.name);
    const key = normalizedName(name);
    const found = observed.get(key) || [];
    const previousInn = prior.get(key) || "";
    const currentInns = [...new Set(found.map(x => x.inn).filter(Boolean))];
    const state = found.some(x => SECTIONS.includes(x.section)) ? "active_name_match" :
      found.some(x => x.section === "qualification_review") ? "review_name_match" :
      found.some(x => x.section === "qualification_excluded") ? "excluded_name_match" :
      "not_found_by_name";
    return {
      name, state, prior_inn_audit_only: previousInn,
      current_inns_audit_only: currentInns,
      possible_distinct_legal_person: Boolean(previousInn &&
        currentInns.some(inn => inn !== previousInn)),
      identity_verified_by_name: false
    };
  });
  return {
    version: 1, accepted_discovery_candidates: accepted.length,
    active_name_matches: entries.filter(x => x.state === "active_name_match").length,
    review_name_matches: entries.filter(x => x.state === "review_name_match").length,
    excluded_name_matches: entries.filter(x => x.state === "excluded_name_match").length,
    unmatched_by_name: entries.filter(x => x.state === "not_found_by_name").length,
    possible_inn_conflicts: entries.filter(x => x.possible_distinct_legal_person).length,
    identity_verified_by_name: false, entries
  };
}

/**
 * Full, zero-cost continuity ledger. Every historically source-linked legal
 * identity is represented once; no row is inserted into the current CRM.
 * A same-name match without the same INN is NOT a confirmed return.
 * Links are historical audit leads only (pages are not re-fetched here).
 */
export function buildHistoricalCoverageLedger(history, current) {
  const prior = historyRows(history);
  const grouped = new Map();
  for (const item of prior) {
    let entry = grouped.get(item.inn);
    if (!entry) {
      entry = {
        historical_inn: item.inn,
        historical_name: item.name,
        previous_priority_only: item.grade,
        historical_identity_source: item.identity_source_url || "",
        historical_search_hint: item.source_hint || "",
        latest_historical_job_id: item.source_job_id,
        latest_historical_updated_at: item.source_updated_at,
        run_ids: new Set(),
        known_names: new Set()
      };
      grouped.set(item.inn, entry);
    }
    entry.run_ids.add(item.source_job_id);
    entry.known_names.add(item.name);
  }
  const currentByInn = new Map();
  const currentByName = new Map();
  const sections = [...SECTIONS, "qualification_review", "qualification_excluded"];
  const currentSections = Array.isArray(current)
    ? [{ sheet: "unqualified_discovery", rows: allCurrentRows(current) }]
    : sections.map(sheet => ({ sheet, rows: arr(current?.[sheet]) }));
  for (const { sheet, rows } of currentSections) for (const row of rows) {
    const inn = validInn(row?.["ИНН"]);
    const name = normalizedName(row?.["Организация"]);
    const record = { sheet, inn, name };
    if (inn) {
      if (!currentByInn.has(inn)) currentByInn.set(inn, []);
      currentByInn.get(inn).push(record);
    }
    if (name) {
      if (!currentByName.has(name)) currentByName.set(name, []);
      currentByName.get(name).push(record);
    }
  }
  const priorInnByName = new Map();
  for (const item of grouped.values()) for (const name of item.known_names) {
    const normalized = normalizedName(name);
    if (!normalized) continue;
    if (!priorInnByName.has(normalized)) priorInnByName.set(normalized, new Set());
    priorInnByName.get(normalized).add(item.historical_inn);
  }

  const entries = [];
  const counts = {
    historic_source_linked_inn: grouped.size,
    present_active_by_inn: 0,
    present_review_by_inn: 0,
    present_excluded_by_inn: 0,
    present_unqualified_by_inn: 0,
    current_same_name_unverified: 0,
    current_same_name_different_inn: 0,
    historic_name_multiple_inn: 0,
    not_found_in_current: 0
  };
  for (const item of grouped.values()) {
    const innMatches = currentByInn.get(item.historical_inn) || [];
    const names = [...item.known_names];
    const matchingNames = [...new Map(names.flatMap(name =>
      (currentByName.get(normalizedName(name)) || []).map(row =>
        [row.sheet + ":" + row.name + ":" + row.inn, row])
    )).values()];
    const nameInns = [...new Set(matchingNames.map(x => x.inn).filter(Boolean))];
    const competingHistoric = names.some(name =>
      (priorInnByName.get(normalizedName(name))?.size || 0) > 1);

    let status;
    if (innMatches.some(x => SECTIONS.includes(x.sheet))) {
      status = "present_active_by_inn";
    } else if (innMatches.some(x => x.sheet === "qualification_review")) {
      status = "present_review_by_inn";
    } else if (innMatches.some(x => x.sheet === "qualification_excluded")) {
      status = "present_excluded_by_inn";
    } else if (innMatches.length) {
      status = "present_unqualified_by_inn";
    } else if (nameInns.some(inn => inn !== item.historical_inn)) {
      status = "current_same_name_different_inn";
    } else if (matchingNames.length) {
      status = "current_same_name_unverified";
    } else if (competingHistoric) {
      status = "historic_name_multiple_inn";
    } else {
      status = "not_found_in_current";
    }
    counts[status]++;
    entries.push({
      historical_inn: item.historical_inn,
      historical_name: item.historical_name,
      historical_name_variants: names,
      previous_grade_priority_only: item.previous_priority_only,
      historical_identity_source_audit_only: item.historical_identity_source,
      historical_search_hint_audit_only: item.historical_search_hint,
      latest_historical_job_id: item.latest_historical_job_id,
      latest_historical_updated_at: item.latest_historical_updated_at,
      observed_in_completed_runs: item.run_ids.size,
      status,
      current_same_name_inns_audit_only: status === "current_same_name_different_inn"
        ? nameInns : [],
      identity_proven_from_name: false,
      automatically_promoted_to_crm: false
    });
  }
  entries.sort((a,b) => a.historical_inn.localeCompare(b.historical_inn));
  return {
    version: 1,
    counts,
    history_runs_included: arr(history).length,
    missing_or_conflicting: counts.not_found_in_current +
      counts.historic_name_multiple_inn +
      counts.current_same_name_unverified +
      counts.current_same_name_different_inn,
    entries,
    historical_data_not_reverified: true,
    auto_promoted_records: 0,
    extra_web_calls: 0
  };
}
