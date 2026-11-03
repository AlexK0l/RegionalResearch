// Final quality gate for NORMAL research completion, not a historical-region
// postprocessing manifest. All operations are synchronous and offline.
// INN and alias lookup are already performed earlier by the production
// pipeline; this gate never guesses identities, merges companies or uses APIs.
import { attachInlineNoteProvenance } from "./evidenceProvenance.js";
import { populateCommercialActions } from "./researchQuality.js";
import { commercialEligibility } from "./qualificationSafety.js";

export const FINAL_QUALITY_GATE_VERSION = "2";
const SECTIONS = ["direct_buyers", "intermediaries", "leasing"];
const ALLOWED_GRADES = new Set(["A", "B", "C"]);
const string = (v) => String(v ?? "").trim();
const unique = (a) => [...new Set(a)];

function checksumInn(value) {
  if (!/^\d{10}(?:\d{2})?$/.test(value)) return false;
  const d = [...value].map(Number);
  const checksum = (index, weights) =>
    weights.reduce((sum, weight, i) => sum + weight * d[i], 0) % 11 % 10 === d[index];
  return value.length === 10
    ? checksum(9, [2, 4, 10, 3, 5, 9, 4, 6, 8])
    : checksum(10, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) &&
      checksum(11, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
}
function sourceUrls(row) {
  const raw = row?.__evidence || {};
  return unique([
    ...(Array.isArray(raw.source_urls) ? raw.source_urls : []),
    ...(Array.isArray(raw.inline_note_provenance)
      ? raw.inline_note_provenance.map(item => item?.source_url) : [])
  ].filter(v => /^https?:\/\/[^\/\s?#]+\.[^\/\s?#]+/i.test(string(v))).map(String));
}
function malformedSourceUrls(row) {
  const urls = Array.isArray(row?.__evidence?.source_urls) ? row.__evidence.source_urls : [];
  return unique(urls.map(string).filter(value => {
    try {
      const parsed = new URL(value);
      return !["http:", "https:"].includes(parsed.protocol) || !parsed.hostname.includes(".");
    } catch { return true; }
  }));
}
function factSourceCount(row) {
  const list = Array.isArray(row?.__evidence?.facts) ? row.__evidence.facts : [];
  return list.filter(f => f && (
    /^https?:\/\//i.test(string(f.source_url)) ||
    (Array.isArray(f.sources) && f.sources.some(s => /^https?:\/\//i.test(string(s))))
  )).length;
}
// A selected positive claim may only cite a URL from the SAME evidence
// note, or a structured source fact with exactly the same claim text. Merely
// having one or more links in the company-wide source list proves nothing.
export function selectedAEvidenceSource(row, aEvidence) {
  const claim = string(aEvidence);
  const evidence = row?.__evidence || {};
  const notes = Array.isArray(evidence.notes) ? evidence.notes : [];
  const matches = notes.flatMap((note, index) =>
    string(note) === claim ? [index] : []);
  const rawClaimUrls = unique(matches.flatMap(index =>
    (string(notes[index]).match(/https?:\/\/[^\s)<>\]]+/gi) || [])
      .map(url => url.replace(/[.,;!?]+$/g, ""))));
  const linked = Array.isArray(evidence.inline_note_provenance)
    ? evidence.inline_note_provenance : [];
  const cited = unique(linked.filter(item => matches.includes(item.note_index))
    .map(item => string(item.source_url)).filter(Boolean));
  const matchingFacts = Array.isArray(evidence.facts) ? evidence.facts.filter(
    item => string(item?.statement) === claim) : [];
  const factUrls = unique(matchingFacts.flatMap(item => [
    item?.source_url,
    ...(Array.isArray(item?.sources) ? item.sources : [])
  ]).map(string).filter(url => /^https?:\/\//i.test(url)));
  if (cited.length === 1 && factUrls.every(url => url === cited[0])) {
    return { status: "inline_citation_only_not_live_verified",
      source_url: cited[0], method: "exact_same_evidence_note",
      note_indices: matches, sources_rechecked: false };
  }
  if (cited.length === 0 && factUrls.length === 1 && matches.length > 0) {
    return { status: "exact_structured_claim_only_not_live_verified",
      source_url: factUrls[0], method: "matching_structured_fact_statement",
      note_indices: matches, sources_rechecked: false };
  }
  return { status: rawClaimUrls.length > 1 || cited.length > 1 || factUrls.length > 1 ||
      (cited.length && factUrls.length && cited[0] !== factUrls[0])
      ? "ambiguous_claim_sources" : "missing_claim_source",
    source_url: "", method: "no_defensible_claim_to_url_mapping",
    note_indices: matches, sources_rechecked: false };
}

// A selected claim can include an explicit disclaimer that the source does
// NOT establish trailer/tractor operation. Never let an injected classifier
// override its own negative evidence and sell such a company as grade A.
export function disclaimsSelectedTrailerEvidence(claim) {
  const note = string(claim).toLowerCase().replace(/ё/g, "е");
  if (!note) return false;
  return [
    /(?:источник|документ|материал|сведения).{0,65}(?:не фиксир|не подтвержд|не устанавлива).{0,130}(?:полуприцеп|прицепн|тягач|автопоезд)/,
    /(?:нет|не найдены|не подтверждены|не установлены).{0,60}(?:доказательств|сведений|данных).{0,100}(?:полуприцеп|прицепн|тягач|автопоезд)/
  ].some(pattern => pattern.test(note));
}

// Category/search pages are discovery hints, not a cited fact about a named
// legal person. A grade-A claim must cite the actual vacancy/contract/company
// page; these aggregations can contain unrelated employers and locations.
export function isGenericDiscoverySource(raw) {
  try {
    const u = new URL(string(raw));
    const host = u.hostname.toLowerCase();
    const path = decodeURIComponent(u.pathname).toLowerCase();
    if (/(?:^|\.)hh\.ru$/.test(host) && path.startsWith("/vacancies/")) return true;
    if (/(?:^|\.)b2b-center\.ru$/.test(host) && path.startsWith("/search/")) return true;
    if (/(?:^|\.)jobcareer\.ru$/.test(host) && path.startsWith("/jobs/")) return true;
    if (/(?:^|\.)jobrun\.ru$/.test(host) && !/\/vacancy\/\d+/.test(path)) return true;
    if (/(?:^|\.)samosval\.info$/.test(host) &&
        path.includes("/doska-obyavleniy/trebuyutsya-samosvaly-i-tonary/")) return true;
    return false;
  } catch { return false; }
}

function rowId(row) { return string(row?.__canonical_id); }
function gradeFromRow(row) {
  const grade = string(row?.__final_grade).toUpperCase();
  if (ALLOWED_GRADES.has(grade)) return grade;
  const basis = string(row?.["Основание"]).toUpperCase();
  return /^[ABC](?:\s|—|-|$)/.test(basis) ? basis[0] : "";
}
function stamp(row, outcome, issues, originSheet, reason) {
  row.__quality_gate = {
    version: FINAL_QUALITY_GATE_VERSION, outcome,
    issues: unique(issues), original_sheet: originSheet,
    reason: string(reason), sources_rechecked: false,
    legal_status_rechecked: false
  };
  return row;
}
function reviewedRow(row, sheet, reason, issues) {
  row.__final_grade = "";
  row.__a_evidence = "";
  row.__a_rule = "";
  row.__decision = "manual_review";
  row.__decision_reason = string(reason);
  row.__qualification_origin_sheet ||= sheet;
  stamp(row, "REVIEW", issues, sheet, reason);
  return row;
}
function excludedRow(row, sheet, reason, issues) {
  row.__final_grade = "";
  row.__a_evidence = "";
  row.__a_rule = "";
  row.__decision = "exclude";
  row.__decision_reason = string(reason);
  row.__qualification_origin_sheet ||= sheet;
  stamp(row, "EXCLUDED", issues, sheet, reason);
  return row;
}

/**
 * Apply the same deterministic qualifier after all enrichment/contact steps.
 * Keep the entire source record for everything that becomes REVIEW/EXCLUDED.
 * Do not requalify an earlier REVIEW just because a phone was discovered;
 * those records must be explicitly re-examined with entity-specific evidence.
 *
 * The caller injects qualify / isActionable. Neither callback may use an API.
 */
export function finalizeProductionResearch(source, { qualify, isActionable = () => false } = {}) {
  if (!source || typeof source !== "object" ||
      SECTIONS.some(sheet => !Array.isArray(source[sheet])) ||
      typeof qualify !== "function" || typeof isActionable !== "function") {
    throw new TypeError("Final quality requires full final_result and offline qualification callbacks");
  }
  const data = structuredClone(source);
  const rawCommercial = SECTIONS.flatMap(sheet =>
    data[sheet].map(row => ({ sheet, row })));
  // Full earlier reviewed JSONs may carry 148 HISTORICAL candidates in
  // qualification_review and the actual seven current ones in a separate
  // qualification_review_v8. Treat the latter as authoritative when present.
  // Live production results have no qualification_review_v8 and keep the
  // normal queue unchanged. Never turn 148 + 7 into 155 current REVIEW.
  const versionedReview = Array.isArray(data.qualification_review_v8);
  const historicalReview = versionedReview
    ? (Array.isArray(data.qualification_review_v5_archived)
      ? data.qualification_review_v5_archived
      : Array.isArray(data.qualification_review) ? data.qualification_review : [])
    : (Array.isArray(data.qualification_review_v5_archived)
      ? data.qualification_review_v5_archived : []);
  if (versionedReview) {
    data.qualification_review_v5_archived = historicalReview;
  }
  const previousReview = versionedReview
    ? data.qualification_review_v8
    : Array.isArray(data.qualification_review) ? data.qualification_review : [];
  const previousExcluded = versionedReview
    ? (Array.isArray(data.qualification_excluded_v8) ? data.qualification_excluded_v8 : [])
    : (Array.isArray(data.qualification_excluded) ? data.qualification_excluded : []);
  // Some legacy full-v8 JSONs include the SAME nine REVIEW/EXCLUDED
  // snapshots twice: in the source 488-row commercial arrays AND in the
  // explicit v8 queues. A row can be collapsed only if status, ID, name,
  // INN, and the complete archived snapshot match exactly.
  let commercialBefore = rawCommercial;
  let duplicatedCurrentQueueRowsCollapsed = 0;
  if (versionedReview) {
    const queueById = new Map();
    for (const [status, rows] of [["REVIEW", previousReview], ["EXCLUDED", previousExcluded]]) {
      for (const row of rows) {
        const id = rowId(row);
        if (!id || queueById.has(id))
          throw new Error("Final quality: duplicate or missing ID in current versioned queue: " + id);
        queueById.set(id, { status, row });
      }
    }
    commercialBefore = rawCommercial.filter(({ row }) => {
      const id = rowId(row);
      const matched = queueById.get(id);
      if (!matched) return true;
      const sameStatus = string(row?.__replay_v8?.status) === matched.status ||
        string(row?.__final_qualification_status) === matched.status;
      const sameIdentity = string(row["Организация"]) ===
        string(matched.row["Организация"]) &&
        string(row["ИНН"]) === string(matched.row["ИНН"]);
      if (!sameStatus || !sameIdentity ||
          JSON.stringify(row) !== JSON.stringify(matched.row)) {
        throw new Error("Final quality: conflicting commercial and current queue snapshot: " + id);
      }
      duplicatedCurrentQueueRowsCollapsed++;
      return false;
    });
  }
  const originalRowCount = commercialBefore.length +
    previousReview.length + previousExcluded.length;
  const preservedFields = [
    "ИНН", "Телефон", "Руководитель / ЛПР",
    "Управляющая компания", "Выручка последнего подтвержденного года",
    "Численность"
  ];
  const identityBaseline = new Map();
  commercialBefore.forEach(({ row }, index) => {
    identityBaseline.set(index, preservedFields.map(field => row?.[field] ?? ""));
  });
  const duplicateIds = new Map();
  const innOwners = new Map();
  for (const [index, { row }] of commercialBefore.entries()) {
    const id = rowId(row);
    if (id) {
      if (!duplicateIds.has(id)) duplicateIds.set(id, []);
      duplicateIds.get(id).push(index);
    }
    const inn = string(row["ИНН"]);
    if (inn) {
      if (!innOwners.has(inn)) innOwners.set(inn, []);
      innOwners.get(inn).push(index);
    }
  }
  const contestedIds = new Set([...duplicateIds.values()]
    .filter(items => items.length > 1).flat());
  const contestedInn = new Set([...innOwners.values()]
    .filter(items => items.length > 1).flat());
  // A merged source ID can also survive separately in a prior REVIEW queue.
  // If it subsequently acquired a DIFFERENT checksum-valid INN, the active
  // survivor has absorbed evidence from a separate legal entity. Quarantine
  // that active company instead of silently retaining a contaminated CRM row.
  const queuedById = new Map();
  for (const entry of [...previousReview, ...previousExcluded]) {
    const id = rowId(entry);
    if (!id) continue;
    if (!queuedById.has(id)) queuedById.set(id, []);
    queuedById.get(id).push(entry);
  }
  const verifiedLineageConflicts = new Map();
  const unverifiedQueueInnConflicts = new Map();
  for (const [index, { row }] of commercialBefore.entries()) {
    const mainInn = string(row["ИНН"]);
    if (!checksumInn(mainInn)) continue;
    const ids = unique([rowId(row),
      ...(Array.isArray(row.__merged_canonical_ids) ? row.__merged_canonical_ids.map(string) : [])
    ].filter(Boolean));
    for (const id of ids) for (const queued of queuedById.get(id) || []) {
      const otherInn = string(queued["ИНН"]);
      if (otherInn === mainInn) continue;
      if (!checksumInn(otherInn)) {
        // A well-shaped but checksum-invalid INN is NOT another verified
        // identity. Still, the same canonical ID in competing queues must
        // never be silently accepted as one commercial legal person.
        if (/^\d{10}(?:\d{2})?$/.test(otherInn)) {
          if (!unverifiedQueueInnConflicts.has(index)) unverifiedQueueInnConflicts.set(index, []);
          unverifiedQueueInnConflicts.get(index).push({
            survivor_canonical_id: rowId(row), source_id: id,
            survivor_name: string(row["Организация"]), survivor_inn: mainInn,
            conflicting_name: string(queued["Организация"]), unverified_inn: otherInn,
            reason: "same_canonical_id_invalid_competing_inn"
          });
        }
        continue;
      }
      if (!verifiedLineageConflicts.has(index)) verifiedLineageConflicts.set(index, []);
      verifiedLineageConflicts.get(index).push({
        survivor_canonical_id: rowId(row), source_id: id,
        survivor_name: string(row["Организация"]), survivor_inn: mainInn,
        conflicting_name: string(queued["Организация"]), conflicting_inn: otherInn
      });
    }
  }
  const finalSheets = Object.fromEntries(SECTIONS.map(sheet => [sheet, []]));
  const review = [...previousReview];
  const excluded = [...previousExcluded];
  const changes = [];
  const flags = [];
  let sourceUrlCount = 0, inlineLinked = 0, factLinked = 0;
  let noInn = 0, noInnPriority = 0, notesChecked = 0;
  const existingReview = previousReview.length;
  let missingName = 0;
  let selectedASourceLinked = 0, selectedASourceMissing = 0,
    selectedASourceAmbiguous = 0;
  const attributionWarnings = [];
  const malformedSourceWarnings = [];

  for (const [index, { sheet, row }] of commercialBefore.entries()) {
    const id = rowId(row);
    const previousGrade = gradeFromRow(row);
    const identity = identityBaseline.get(index);
    const issues = [];
    if (!id) issues.push("missing_canonical_id");
    if (contestedIds.has(index)) issues.push("duplicate_canonical_id");
    if (!string(row["Организация"])) { issues.push("missing_organization"); missingName++; }
    const inn = string(row["ИНН"]);
    if (!inn) noInn++;
    else if (!checksumInn(inn)) issues.push("invalid_inn_checksum");
    // A twelve-digit INN identifies a person. Never attach it to an LLC.
    if (inn.length === 12 &&
        /^(?:ооо|общество с ограниченной ответственностью)(?:\s|[«"'(]|$)/i.test(string(row["Организация"]))) {
      issues.push("llc_with_individual_inn");
    }
    if (contestedInn.has(index)) issues.push("unresolved_shared_inn");
    if (verifiedLineageConflicts.has(index)) issues.push("cross_queue_lineage_inn_conflict");
    if (unverifiedQueueInnConflicts.has(index)) issues.push("cross_queue_canonical_invalid_inn_collision");

    const provenance = attachInlineNoteProvenance(row);
    inlineLinked += provenance.linked;
    notesChecked += provenance.note_count;
    const invalidUrls = malformedSourceUrls(row);
    if (invalidUrls.length) malformedSourceWarnings.push({
      canonical_id: id, organization: string(row["Организация"]), invalid_urls: invalidUrls
    });
    const sourceCount = sourceUrls(row).length;
    sourceUrlCount += sourceCount;
    factLinked += factSourceCount(row);
    if (!sourceCount) issues.push("missing_source_url");

    // All records get a deterministic decision; the archived original
    // classification is retained as metadata rather than overwritten.
    const decision = qualify({ sheet, row, id: id || "quality_record_" + index });
    const grade = string(decision?.grade).toUpperCase();
    const eligible = decision?.decision === "include" && ALLOWED_GRADES.has(grade);
    const reason = string(decision?.reason) || "Insufficient attributable qualification";
    if (eligible && !inn && (grade === "A" || grade === "B")) noInnPriority++;
    const missingAEvidence = grade === "A" && !string(decision?.aEvidence);
    if (missingAEvidence) issues.push("A_without_specific_note");
    if (grade === "A" && !missingAEvidence) {
      const selected = selectedAEvidenceSource(row, decision.aEvidence);
      if (selected.source_url && isGenericDiscoverySource(selected.source_url)) {
        issues.push("A_claim_cites_generic_discovery_page");
      }
    }
    if (grade === "A" && !missingAEvidence && disclaimsSelectedTrailerEvidence(decision.aEvidence))
      issues.push("A_selected_claim_explicitly_disclaims_trailer_evidence");
    const eligibility = commercialEligibility(row);
    if (eligibility.blocked) issues.push("noncommercial_entity");
    const mustHold = issues.length > 0 || !eligible;
    // Citation failure is a DOCUMENTED soft warning: no fabricated source,
    // no unsupported automatic A demotion. A real contract without a direct
    // inline URL is still useful for human verification.
    if (eligible && grade === "A" && !missingAEvidence && !mustHold) {
      row.__evidence ||= {};
      const attribution = selectedAEvidenceSource(row, decision.aEvidence);
      row.__evidence.selected_a_provenance = attribution;
      if (attribution.source_url) selectedASourceLinked++;
      else {
        if (attribution.status === "ambiguous_claim_sources")
          selectedASourceAmbiguous++;
        else selectedASourceMissing++;
        attributionWarnings.push({
          canonical_id: id, organization: string(row["Организация"]),
          a_rule: string(decision.aRule), status: attribution.status,
          selected_a_evidence: string(decision.aEvidence),
          company_source_url_count: sourceCount
        });
      }
    }
    if (mustHold) {
      const reviewable = !eligibility.blocked && (
        eligible || isActionable({ sheet, row, id: id || "quality_record_" + index }));
      const issueDescription = issues.length
        ? "Автоматический контроль качества: " + issues.join(", ") + ". " + reason
        : reason;
      if (reviewable) review.push(reviewedRow(row, sheet, issueDescription,
        issues.length ? issues : ["needs_qualification_review"]));
      else excluded.push(excludedRow(row, sheet, issueDescription,
        issues.length ? issues : ["not_commercially_qualified"]));
      changes.push({ canonical_id: id, organization: string(row["Организация"]),
        sheet, before: previousGrade, after: reviewable ? "REVIEW" : "EXCLUDED",
        reasons: issues, evidence_rechecked: false });
    } else {
      if (previousGrade !== grade) {
        row.__grade_before_final_quality ||= previousGrade;
        row["Основание"] = grade + " — " + reason;
        changes.push({ canonical_id: id, organization: string(row["Организация"]),
          sheet, before: previousGrade, after: grade, reasons: ["deterministic_requalification"],
          evidence_rechecked: false });
      }
      row.__final_grade = grade;
      row.__decision = "include";
      row.__decision_reason = reason;
      row.__a_evidence = grade === "A" ? string(decision.aEvidence) : "";
      row.__a_rule = grade === "A" ? string(decision.aRule) : "";
      stamp(row, grade, [], sheet, reason);
      populateCommercialActions(row, sheet, grade);
      finalSheets[sheet].push(row);
    }
    // Never change or transfer any legal identity, phone, owner, finances or
    // contact fields during post-contact quality reconciliation.
    for (const [fieldIndex, field] of preservedFields.entries()) {
      if (JSON.stringify(row[field] ?? "") !== JSON.stringify(identity[fieldIndex]))
        throw new Error("Final quality unexpectedly changed preserved field: " + field);
    }
    if (issues.length) flags.push({ canonical_id: id, organization: string(row["Организация"]),
      sheet, reasons: issues });
  }

  // REVIEW and EXCLUDED are not additional sales prospects; keep their source
  // rows verbatim, without trying to merge them with unrelated legal entities.
  data.qualification_review = review;
  data.qualification_excluded = excluded;
  for (const sheet of SECTIONS) data[sheet] = finalSheets[sheet];

  const visible = SECTIONS.flatMap(sheet => data[sheet]);
  const grades = { A: 0, B: 0, C: 0 };
  for (const row of visible) grades[row.__final_grade]++;
  const countAfter = visible.length + review.length + excluded.length;
  if (countAfter !== originalRowCount) {
    throw new Error("Final quality lost records: " + originalRowCount + " -> " + countAfter);
  }
  const presentInn = visible.filter(r => string(r["ИНН"])).length;
  // The source-ID history is independent of the number of surviving legal
  // entities. Do not turn aliases into new CRM prospects or restore their
  // INNs merely to increase coverage statistics.
  const lineage = [];
  const allResultRows = [
    ...SECTIONS.flatMap(sheet => data[sheet].map(row => ({ sheet, row }))),
    ...review.map(row => ({ sheet: "REVIEW", row })),
    ...excluded.map(row => ({ sheet: "EXCLUDED", row }))
  ];
  const lineageOwners = new Map();
  const lineageConflicts = [];
  const outputCanonicalOwners = new Map();
  for (const { sheet, row } of allResultRows) {
    const currentId = rowId(row);
    if (currentId) {
      if (!outputCanonicalOwners.has(currentId)) outputCanonicalOwners.set(currentId, []);
      outputCanonicalOwners.get(currentId).push({
        sheet, organization: string(row["Организация"]), inn: string(row["ИНН"]),
        source_kind: string(row.__review_stage || row.__decision || "")
      });
    }
    const owner = rowId(row);
    const ids = unique([
      owner,
      ...(Array.isArray(row.__merged_canonical_ids)
        ? row.__merged_canonical_ids.map(string) : [])
    ].filter(Boolean));
    if (ids.length > 1) lineage.push({
      survivor_canonical_id: owner, sheet,
      original_canonical_ids: ids,
      absorbed_count: ids.length - 1,
      source_restoration: "preexisting_identity_merge_no_new_lookups"
    });
    for (const sourceId of ids) {
      if (lineageOwners.has(sourceId) && lineageOwners.get(sourceId) !== owner)
        lineageConflicts.push({ source_id: sourceId,
          other_survivor: lineageOwners.get(sourceId), survivor: owner });
      else lineageOwners.set(sourceId, owner);
    }
  }
  const outputCanonicalIdCollisions = [...outputCanonicalOwners.entries()]
    .filter(([, holders]) => holders.length > 1)
    .map(([canonical_id, holders]) => ({ canonical_id, records: holders }));
  const report = {
    version: FINAL_QUALITY_GATE_VERSION,
    applied_to: "normal_production_pipeline",
    reviewed_source_manifest_used: false,
    original_row_count: originalRowCount,
    original_commercial_records: commercialBefore.length,
    input_commercial_array_rows: rawCommercial.length,
    duplicated_current_queue_rows_collapsed: duplicatedCurrentQueueRowsCollapsed,
    active_commercial_records: visible.length,
    review_records: review.length,
    excluded_records: excluded.length,
    prior_review_records_preserved: existingReview,
    prior_excluded_records_preserved: previousExcluded.length,
    review_queue_mode: versionedReview ? "explicit_replay_current_vs_historical" : "normal_production",
    historical_review_records_preserved: historicalReview.length,
    current_review_records_at_input: previousReview.length,
    grades,
    with_inn_commercial: presentInn,
    without_inn_commercial: visible.length - presentInn,
    missing_inn_in_original_commercial_records: noInn,
    ab_missing_inn_attempt_still_required: noInnPriority,
    inline_note_citations: inlineLinked,
    evidence_notes_examined: notesChecked,
    source_urls_in_input_commercial_records: sourceUrlCount,
    already_structured_source_facts: factLinked,
    a_claim_source_linked: selectedASourceLinked,
    a_claim_source_missing: selectedASourceMissing,
    a_claim_source_ambiguous: selectedASourceAmbiguous,
    a_claim_attribution_review: attributionWarnings,
    invalid_source_url_records: malformedSourceWarnings.length,
    invalid_source_url_review: malformedSourceWarnings,
    source_attribution_method: "same_note_or_exact_structured_fact_no_live_lookups",
    missing_organization_records: missingName,
    duplicated_canonical_id_records: contestedIds.size,
    shared_inn_conflict_records: contestedInn.size,
    source_id_lineage_count: lineageOwners.size,
    reviewed_alias_groups_from_pipeline: lineage,
    source_id_cross_survivor_conflicts: lineageConflicts,
    verified_cross_queue_inn_conflict_records: verifiedLineageConflicts.size,
    verified_cross_queue_inn_conflicts: [...verifiedLineageConflicts.values()].flat(),
    unverified_cross_queue_inn_conflict_records: unverifiedQueueInnConflicts.size,
    unverified_cross_queue_inn_conflicts: [...unverifiedQueueInnConflicts.values()].flat(),
    output_canonical_id_collision_groups: outputCanonicalIdCollisions.length,
    output_canonical_id_collisions: outputCanonicalIdCollisions,
    transitions: changes,
    flags,
    originals_lost: 0,
    legal_identities_modified: 0,
    new_alias_merges: 0,
    fabricated_source_facts: 0,
    web_search_calls: 0,
    openai_calls: 0,
    historical_sources_rechecked: false
  };
  data.final_quality_gate = report;
  return { result: data, report };
}
