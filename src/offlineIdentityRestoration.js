// Offline restoration of aliases in a COPY of completed research results.
// Does not call OpenAI, mutate SQLite, or silently repair questionable INNs.
import { confirmedInnAliasDecision, identityOgrns, legalNameKey } from "./legalIdentity.js";

const SHEETS = ["direct_buyers", "intermediaries", "leasing"];
const CONFLICT_REGEX = /Final INN conflict:\s*ИНН\s*(\d{12}|\d{10})(?!\d)/i;
const EMPTY = (value) => value == null || String(value).trim() === "";
const asText = (value) => String(value ?? "").trim();
const uniq = (values) => [...new Set(values.filter((item) => item != null && String(item).trim() !== ""))];
function checksumValid(value) {
  const d = String(value || "").replace(/\D/g, "");
  const mod = (weights) => weights.reduce((sum, w, i) => sum + w * Number(d[i]), 0) % 11 % 10;
  if (d.length === 10) return mod([2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(d[9]);
  if (d.length === 12) {
    return mod([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(d[10]) &&
      mod([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(d[11]);
  }
  return false;
}
function priorConflictIds(row) {
  return uniq((Array.isArray(row?.__evidence?.notes) ? row.__evidence.notes : [])
    .map((note) => asText(note).match(CONFLICT_REGEX)?.[1] || ""));
}
function verifiedFor(row, inn) {
  const p = row?.__evidence?.identity_verification || {};
  return String(p.inn || "") === inn &&
    ["final_inn_web", "identity_web"].includes(String(p.method || "")) &&
    Array.isArray(p.source_urls) && p.source_urls.some((url) => /^https?:\/\//i.test(String(url)));
}
function sourceLinks(row) {
  const e = row.__evidence || {};
  return uniq([...(e.source_urls || []), ...(e.identity_verification?.source_urls || [])]
    .map(asText).filter((url) => /^https?:\/\//i.test(url)));
}
function rowName(entry) { return asText(entry.row["Организация"]); }
function gradeOf(row) { return asText(row["Основание"]).slice(0, 1).toUpperCase(); }
function survivorScore(entry) {
  const name = rowName(entry);
  const len = name.length;
  const formal = /^(?:акционерное общество|общество с ограниченной ответственностью|ао|ооо|зао|пао)\s+/i.test(name) ? 90 : 0;
  const newForm = /^ао\s|^акционерное общество/i.test(name) ? 8 : 0;
  const oldForm = /^зао\s|^оао\s/i.test(name) ? -10 : 0;
  const shortened = /(^|\s)(?:кхп|стинд|спецатх)(\s|$)/i.test(name) ? -20 : 0;
  return formal + newForm + oldForm + shortened + Math.min(len, 90);
}
function explicitCurrentNameScore(entry, partition) {
  const key = legalNameKey(rowName(entry));
  if (key.length < 5) return 0;
  const notes = partition.flatMap((item) =>
    Array.isArray(item.row?.__evidence?.notes) ? item.row.__evidence.notes : []);
  for (const raw of notes) {
    const note = String(raw || "").toLowerCase().replace(/ё/g, "е")
      .replace(/[^a-zа-я0-9]+/g, " ").replace(/\s+/g, " ").trim();
    const marker = note.match(/(?:переименован[а-я]* в|актуальное юридическое наименование|ныне зарегистрирован[а-я]* как)\s*/);
    if (!marker) continue;
    const tail = note.slice(marker.index + marker[0].length).trim();
    if (tail.includes(key)) return 150;
  }
  return 0;
}
function chooseSurvivor(partition) {
  return [...partition].sort((a, b) =>
    (survivorScore(b) + explicitCurrentNameScore(b, partition)) -
    (survivorScore(a) + explicitCurrentNameScore(a, partition)) ||
    rowName(a).localeCompare(rowName(b), "ru"))[0];
}
function partitionCompatible(entries, inn) {
  const clusters = [];
  const decisions = [];
  for (const entry of entries) {
    let target = null;
    for (const group of clusters) {
      const pairs = group.map((other) => confirmedInnAliasDecision(
        { ...entry.row, "ИНН": inn }, { ...other.row, "ИНН": inn }, inn
      ));
      decisions.push(...pairs.map((p) => ({
        left: rowName(entry), right: group.map(rowName).join(" | "), accepted: p.merge,
        reason: p.reason, ogrns_left: p.ogrnsA, ogrns_right: p.ogrnsB
      })));
      if (pairs.every((p) => p.merge)) { target = group; break; }
    }
    if (target) target.push(entry);
    else clusters.push([entry]);
  }
  return { clusters, decisions };
}
function mergeSourceEvidence(survivor, partition, inn, reason, checkpointId, fieldDisagreements) {
  const rows = partition.map((item) => item.row);
  const row = survivor.row;
  const evidence = row.__evidence || {};
  const mergedSources = uniq(rows.flatMap(sourceLinks));
  const notes = uniq(rows.flatMap((r) => Array.isArray(r.__evidence?.notes) ? r.__evidence.notes : []));
  const facts = uniq(rows.flatMap((r) => Array.isArray(r.__evidence?.facts) ? r.__evidence.facts.map((f) => JSON.stringify(f)) : []))
    .map((s) => JSON.parse(s));
  const priorIds = uniq(rows.map((r) => asText(r.__canonical_id)));
  const changes = [];
  const sourceGrades = rows.map((r) => ({
    organization: asText(r["Организация"]),
    grade: gradeOf(r),
    basis: asText(r["Основание"])
  }));
  const distinctGrades = uniq(sourceGrades.map((item) => item.grade));
  const gradeConflict = distinctGrades.length > 1;
  const originalComments = rows.map((r) => ({
    organization: asText(r["Организация"]), value: asText(r.__comment)
  }));
  for (const key of Object.keys(row)) {
    if (key.startsWith("__") || key === "ИНН" || key === "Организация") continue;
    const values = uniq(rows.map((item) => asText(item[key])));
    if (values.length > 1 && key !== "Техника/сегмент" && key !== "Телефон") {
      fieldDisagreements.push({ inn, company: rowName(survivor), field: key, values });
    }
    if (key === "Телефон") {
      const phones = uniq(rows.flatMap((r) => asText(r["Телефон"]).split(/[;\n]+/).map(asText)));
      row[key] = phones.join("; ");
    } else if (key === "Техника/сегмент") {
      const segments = uniq(rows.flatMap((r) => asText(r[key]).split(" | ").map(asText)));
      row[key] = segments.join(" | ");
    } else if (EMPTY(row[key]) && values.length) {
      row[key] = values[0];
      changes.push(key);
    }
  }
  row["ИНН"] = inn;
  row.__evidence = {
    ...evidence,
    source_urls: mergedSources,
    notes,
    facts,
    identity_verification: {
      ...(evidence.identity_verification || {}),
      inn, source_urls: uniq(rows.flatMap((r) => r.__evidence?.identity_verification?.source_urls || []))
    },
    legal_identity_merges: [
      ...(Array.isArray(evidence.legal_identity_merges) ? evidence.legal_identity_merges : []),
      {
        restored_in_offline_copy: true,
        checkpoint_id: checkpointId,
        confirmed_inn: inn,
        decision: reason,
        survivor_name: rowName(survivor),
        names: rows.map((r) => r["Организация"]),
        canonical_ids: priorIds,
        source_urls: mergedSources
      }
    ],
    previous_conflict_status: "resolved_alias_in_offline_copy",
    original_comments: originalComments,
    ...(gradeConflict ? { qualification_review: {
      status: "manual_review_required",
      reason: "merged_aliases_with_different_abc_grades",
      selected_grade: gradeOf(row),
      source_grades: sourceGrades,
      note: "Офлайн-слияние не подтверждает повышение или понижение класса. Требуется проверка evidence."
    }} : {})
  };
  const originalComment = asText(row.__comment);
  const innLine = `ИНН: ${inn} (восстановлен офлайн из сохранённых подтверждений)`;
  row.__comment = /^ИНН\s*:/m.test(originalComment)
    ? originalComment.replace(/^ИНН\s*:[^\r\n]*/m, innLine)
    : [originalComment, innLine].filter(Boolean).join("\n");
  if (gradeConflict) {
    row.__comment += `\n[ПРОВЕРКА A/B/C] Для алиасов обнаружены классы ${distinctGrades.join(", ")}; оставлен класс ${gradeOf(row)} без переквалификации.`;
  }
  row.__merged_canonical_ids = priorIds;
  return { changes, priorIds, source_urls: mergedSources, gradeConflict, sourceGrades };
}
export function restoreAliasesOffline(payload, { checkpointId = "" } = {}) {
  if (!payload || typeof payload !== "object" || !payload.final_result) {
    throw new Error("Expected completed checkpoint payload with final_result");
  }
  const original = payload.final_result;
  const result = structuredClone(original);
  for (const key of SHEETS) if (!Array.isArray(result[key])) throw new Error("Missing sheet: " + key);
  const entries = SHEETS.flatMap((sheet) => result[sheet].map((row, index) => ({ sheet, index, row })));
  const before = entries.length;
  const groups = new Map();
  const skipped = [];
  for (const entry of entries) {
    const row = entry.row;
    for (const inn of priorConflictIds(row)) {
      const existingInn = asText(row["ИНН"]);
      if (existingInn) {
        skipped.push({ inn, company: rowName(entry), sheet: entry.sheet, reason: "existing_inn_not_blank", existingInn });
        continue;
      }
      if (!checksumValid(inn)) {
        skipped.push({ inn, company: rowName(entry), sheet: entry.sheet, reason: "invalid_inn_checksum" });
        continue;
      }
      if (!verifiedFor(row, inn)) {
        skipped.push({ inn, company: rowName(entry), sheet: entry.sheet, reason: "no_source_backed_identity_attestation" });
        continue;
      }
      if (!groups.has(inn)) groups.set(inn, []);
      groups.get(inn).push(entry);
    }
  }
  const allPriorInns = new Set(groups.keys());
  const alreadyOwned = new Map();
  for (const entry of entries) {
    const inn = asText(entry.row["ИНН"]);
    if (!inn || !allPriorInns.has(inn)) continue;
    if (!alreadyOwned.has(inn)) alreadyOwned.set(inn, []);
    alreadyOwned.get(inn).push(entry);
  }

  const removals = new Set();
  const merges = [], review = [], fieldDisagreements = [], divisions = [], qualificationConflicts = [];
  let restored = 0;
  for (const [inn, items] of groups) {
    const conflictOwners = alreadyOwned.get(inn) || [];
    const { clusters, decisions } = partitionCompatible(items, inn);
    if (conflictOwners.length) {
      review.push({ inn, status: "inn_already_assigned_elsewhere", names: items.map(rowName),
        outside_owners: conflictOwners.map(rowName), decisions });
      continue;
    }
    for (const cluster of clusters) {
      if (cluster.length < 2) {
        const item = cluster[0];
        const likelyDivision = /(?:филиал|обособленное подразделение)/i.test(rowName(item));
        if (likelyDivision && clusters.some((g) => g.length >= 2)) {
          divisions.push({
            inn, branch: rowName(item),
            branch_canonical_id: asText(item.row.__canonical_id),
            parent_candidate: rowName(chooseSurvivor(clusters.find((g) => g.length >= 2))),
            action: "separate_site_no_inn_restoration"
          });
        }
        review.push({ inn, status: likelyDivision ? "separate_branch_or_division" : "insufficient_alias_evidence",
          names: cluster.map(rowName), ogrns: identityOgrns(item.row), identity_sources: sourceLinks(item.row),
          decisions });
        continue;
      }
      if (new Set(cluster.map((item) => item.sheet)).size > 1) {
        review.push({ inn, status: "cross_sheet_category_conflict", names: cluster.map(rowName), decisions });
        continue;
      }
      const survivor = chooseSurvivor(cluster);
      const other = cluster.filter((item) => item !== survivor);
      // The partition was already checked pairwise, not only against a
      // representative. This handles mixed OGRN, branch and group evidence.
      const directReasons = other.map((item) => confirmedInnAliasDecision(
        { ...survivor.row, "ИНН": inn }, { ...item.row, "ИНН": inn }, inn
      ));
      if (!directReasons.every((x) => x.merge)) {
        review.push({ inn, status: "pairwise_incompatibility", names: cluster.map(rowName), decisions });
        continue;
      }
      const originalNames = cluster.map(rowName);
      const originalIds = cluster.map((item) => asText(item.row.__canonical_id));
      const fieldValues = cluster.map((item) => ({ organization: rowName(item),
        inn: item.row["ИНН"], grade: gradeOf(item.row), phone: item.row["Телефон"],
        canonical_id: asText(item.row.__canonical_id) }));
      const merged = mergeSourceEvidence(survivor, cluster, inn,
        directReasons.map((x) => x.reason).join(" + "), checkpointId, fieldDisagreements);
      restored++;
      if (merged.gradeConflict) qualificationConflicts.push({
        inn, winner_name: rowName(survivor), selected_grade: gradeOf(survivor.row),
        source_grades: merged.sourceGrades, status: "manual_review_required"
      });
      for (const member of other) removals.add(member);
      merges.push({
        inn, winner_name: rowName(survivor), absorbed_names: originalNames.filter((n) => n !== rowName(survivor)),
        original_names: originalNames, original_canonical_ids: originalIds,
        before_rows: cluster.length, after_rows: 1,
        reason: directReasons.map((x) => x.reason).join(" + "),
        source_urls: merged.source_urls, filled_fields: merged.changes,
        source_row_fields: fieldValues,
        preserved_grade: gradeOf(survivor.row),
        qualification_review: merged.gradeConflict ? "manual_review_required" : ""
      });
    }
  }
  for (const sheet of SHEETS) {
    result[sheet] = entries.filter((e) => e.sheet === sheet && !removals.has(e)).map((e) => e.row);
  }
  const after = SHEETS.reduce((n, sheet) => n + result[sheet].length, 0);
  if (before - after !== removals.size || merges.length !== restored ||
      merges.reduce((sum, group) => sum + group.before_rows - 1, 0) !== before - after) {
    throw new Error("Offline merge invariants failed");
  }
  const recoveredInns = new Set(merges.map((m) => m.inn));
  for (const inn of recoveredInns) {
    const owners = SHEETS.flatMap((sheet) => result[sheet]).filter((r) => asText(r["ИНН"]) === inn);
    if (owners.length !== 1) throw new Error("Restored INN not uniquely assigned: " + inn);
  }
  return {
    final_result: result,
    audit: {
      checkpoint_id: checkpointId,
      input_rows: before,
      output_rows: after,
      restored_inns: restored,
      merged_away_rows: before - after,
      restored_groups: merges,
      unresolved: review,
      divisions,
      untrusted_or_unmatched: skipped,
      conflicting_field_values: fieldDisagreements,
      qualification_conflicts: qualificationConflicts,
      note: "Offline copy only. Source references were preserved, not independently downloaded or revalidated. Existing A/B/C grades were not recalculated; differences are marked for manual review."
    }
  };
}
