// Final quality gate for NORMAL research completion, not a historical-region
// postprocessing manifest. All operations are synchronous and offline.
// INN and alias lookup are already performed earlier by the production
// pipeline; this gate never guesses identities, merges companies or uses APIs.
import { attachInlineNoteProvenance } from "./evidenceProvenance.js";
import { populateCommercialActions } from "./researchQuality.js";
import { commercialEligibility } from "./qualificationSafety.js";

export const FINAL_QUALITY_GATE_VERSION = "1";
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
function factSourceCount(row) {
  const list = Array.isArray(row?.__evidence?.facts) ? row.__evidence.facts : [];
  return list.filter(f => f && (
    /^https?:\/\//i.test(string(f.source_url)) ||
    (Array.isArray(f.sources) && f.sources.some(s => /^https?:\/\//i.test(string(s))))
  )).length;
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
  const commercialBefore = SECTIONS.flatMap(sheet =>
    data[sheet].map(row => ({ sheet, row })));
  const previousReview = Array.isArray(data.qualification_review) ?
    data.qualification_review : [];
  const previousExcluded = Array.isArray(data.qualification_excluded) ?
    data.qualification_excluded : [];
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
  const finalSheets = Object.fromEntries(SECTIONS.map(sheet => [sheet, []]));
  const review = [...previousReview];
  const excluded = [...previousExcluded];
  const changes = [];
  const flags = [];
  let sourceUrlCount = 0, inlineLinked = 0, factLinked = 0;
  let noInn = 0, noInnPriority = 0, notesChecked = 0;
  let existingReview = previousReview.length;
  let missingName = 0;

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
    if (contestedInn.has(index)) issues.push("unresolved_shared_inn");

    const provenance = attachInlineNoteProvenance(row);
    inlineLinked += provenance.linked;
    notesChecked += provenance.note_count;
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
    const eligibility = commercialEligibility(row);
    if (eligibility.blocked) issues.push("noncommercial_entity");

    const mustHold = issues.length > 0 || !eligible;
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
  for (const { sheet, row } of allResultRows) {
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
  const report = {
    version: FINAL_QUALITY_GATE_VERSION,
    applied_to: "normal_production_pipeline",
    reviewed_source_manifest_used: false,
    original_row_count: originalRowCount,
    original_commercial_records: commercialBefore.length,
    active_commercial_records: visible.length,
    review_records: review.length,
    excluded_records: excluded.length,
    prior_review_records_preserved: existingReview,
    prior_excluded_records_preserved: previousExcluded.length,
    grades,
    with_inn_commercial: presentInn,
    without_inn_commercial: visible.length - presentInn,
    missing_inn_in_original_commercial_records: noInn,
    ab_missing_inn_attempt_still_required: noInnPriority,
    inline_note_citations: inlineLinked,
    evidence_notes_examined: notesChecked,
    source_urls_in_input_commercial_records: sourceUrlCount,
    already_structured_source_facts: factLinked,
    missing_organization_records: missingName,
    duplicated_canonical_id_records: contestedIds.size,
    shared_inn_conflict_records: contestedInn.size,
    source_id_lineage_count: lineageOwners.size,
    reviewed_alias_groups_from_pipeline: lineage,
    source_id_cross_survivor_conflicts: lineageConflicts,
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
