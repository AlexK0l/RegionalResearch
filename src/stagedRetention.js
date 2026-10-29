// Post-dedupe retention audit. The CRM is never inflated from this queue.
// Retains sourced, actionable companies that disappeared between final-batch
// staging and the final commercial result; does NOT use benchmark references.
const SHEETS = ["direct_buyers", "intermediaries", "leasing"];

function normalizedInn(raw) {
  const text = String(raw ?? "").trim().replace(/\.0$/, "");
  const digits = text.replace(/\D/g, "");
  return (digits.length === 10 || digits.length === 12) ? digits : "";
}
function normalizedLegalName(raw) {
  let name = String(raw || "").toLowerCase().replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gu, " ").replace(/\s+/g, " ").trim();
  const prefix = /^(?:(?:общество с ограниченной ответственностью|публичное акционерное общество|акционерное общество|открытое акционерное общество|закрытое акционерное общество)|(?:ооо|ао|пао|зао|оао))(?=\s|$)\s*/u;
  let old = "";
  while (name && name !== old) { old = name; name = name.replace(prefix, "").trim(); }
  return name;
}
function sourceUrls(row) {
  return Array.isArray(row?.__evidence?.source_urls)
    ? row.__evidence.source_urls.filter((url) => /^https?:\/\//i.test(String(url || ""))) : [];
}
function buildIndex(finalResult) {
  const rows = [...SHEETS.flatMap((sheet) => finalResult?.[sheet] || []),
    ...(finalResult?.qualification_review || [])];
  const byCanon = new Map(), byInn = new Map(), byName = new Map();
  for (const row of rows) {
    const id = String(row?.__canonical_id || "").trim();
    const inn = normalizedInn(row?.["ИНН"]);
    const name = normalizedLegalName(row?.["Организация"]);
    if (id) { if (!byCanon.has(id)) byCanon.set(id, []); byCanon.get(id).push(row); }
    if (inn) { if (!byInn.has(inn)) byInn.set(inn, []); byInn.get(inn).push(row); }
    if (name) { if (!byName.has(name)) byName.set(name, []); byName.get(name).push(row); }
  }
  return { byCanon, byInn, byName };
}
function sameEntityInIndex(row, index) {
  const cid = String(row?.__canonical_id || "").trim();
  const name = normalizedLegalName(row?.["Организация"]);
  const inn = normalizedInn(row?.["ИНН"]);
  if (cid && (index.byCanon.get(cid) || []).some((candidate) => {
    const finalInn = normalizedInn(candidate["ИНН"]);
    // Even an inherited canonical ID must not disguise two different
    // confirmed INNs. Such collisions remain visible in the review queue.
    return !inn || !finalInn || inn === finalInn;
  })) return true;
  // A shared INN with a completely different legal name is NOT sufficient
  // proof of alias identity: keep it for manual inspection.
  if (inn && (index.byInn.get(inn) || []).some((candidate) =>
      normalizedLegalName(candidate["Организация"]) === name)) return true;
  // When both rows have a confirmed but DIFFERENT INN, never merge by name.
  if (name && (index.byName.get(name) || []).some((candidate) => {
    const candidateInn = normalizedInn(candidate["ИНН"]);
    // A missing source INN and a populated FINAL INN with matching name
    // is not proof that the entities are identical. Keep a review trace.
    if (!inn && candidateInn) return false;
    return !inn || !candidateInn || inn === candidateInn;
  })) return true;
  return false;
}
function queueKey(row) {
  const cid = String(row?.__canonical_id || "").trim();
  if (cid) return "id:" + cid;
  const inn = normalizedInn(row?.["ИНН"]);
  const name = normalizedLegalName(row?.["Организация"]);
  return "entity:" + name + "|" + inn;
}

/**
 * @param {object} stagedResult - pre-dedupe/post-final-batch rows
 * @param {object} finalResult - final qualified CRM rows + prior review
 * @param {object} options - callbacks supplied by main pipeline qualifier
 * @returns {{rows:object[],diagnostics:object}} review rows, not CRM rows
 */
export function stagedRetentionReview(stagedResult, finalResult, {
  isActionable, isExcluded
} = {}) {
  if (typeof isActionable !== "function" || typeof isExcluded !== "function") {
    throw new Error("stagedRetentionReview requires isActionable and isExcluded.");
  }
  const index = buildIndex(finalResult);
  const existing = new Set((finalResult?.qualification_review || []).map(queueKey));
  const rows = [];
  const diagnostics = { inspected: 0, covered: 0, missing: 0,
    blocked: 0, weak_or_unsourced: 0, preserved: 0 };
  for (const sheet of SHEETS) {
    for (const original of Array.isArray(stagedResult?.[sheet]) ? stagedResult[sheet] : []) {
      diagnostics.inspected++;
      if (!original || !String(original["Организация"] || "").trim()) continue;
      if (sameEntityInIndex(original, index)) { diagnostics.covered++; continue; }
      diagnostics.missing++;
      if (isExcluded(original)) { diagnostics.blocked++; continue; }
      if (!sourceUrls(original).length || !isActionable({ sheet, row: original })) {
        diagnostics.weak_or_unsourced++; continue;
      }
      const key = queueKey(original);
      if (existing.has(key)) continue;
      existing.add(key);
      const row = {
        ...original,
        __decision: "manual_review",
        __final_grade: "",
        __a_evidence: "",
        __a_rule: "",
        __qualification_origin_sheet: sheet,
        __review_stage: "staged_retention",
        __decision_reason: "Компания с первичным источником была в staged_result, но не прослеживается среди финальных юридических лиц; проверить дедупликацию, регион, роль и класс A/B/C."
      };
      rows.push(row);
      diagnostics.preserved++;
    }
  }
  return { rows, diagnostics };
}
