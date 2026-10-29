// Review-oriented workbook projection with strict positional validation.
// When a SAT template is supplied, carry through its CRM columns, unrelated
// tabs and formula cells. A mismatch is an ERROR, never an invitation to
// silently shift notes or contacts onto the wrong legal entity.
const STR = (v) => String(v ?? "").trim();
const BIZ_COLUMNS = new Set([
  "Организация", "Управляющая компания", "ИНН", "Город/район", "Техника/сегмент",
  "Основание", "Телефон", "Следующее действие",
  "Почему им нужно звонить / потенциальный интерес к САТ", "Руководитель / ЛПР",
  "Выручка последнего подтвержденного года", "Численность", "__comment"
]);
const ONLY_REVIEW = ["__comment", "Проверка A/B/C"];
const MANUAL_FIELD = (head) => typeof head === "string" &&
  head.trim() !== "" && !BIZ_COLUMNS.has(head);

function buildIndex(originalRows) {
  const ids = new Map();
  for (const [index, row] of originalRows.entries()) {
    const id = STR(row.__canonical_id);
    if (!id || ids.has(id)) {
      throw new Error("Source checkpoint cannot be matched uniquely by __canonical_id: " + id);
    }
    ids.set(id, index);
  }
  return ids;
}

export function projectRecoveredTemplateSheet(XLSX, sheet, originalRows, recoveredRows, {
  sheetName = ""
} = {}) {
  if (!sheet || !Array.isArray(originalRows) || !Array.isArray(recoveredRows)) {
    throw new Error("Template projection requires original and recovered rows: " + sheetName);
  }
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });
  const header = [...(matrix[0] || [])];
  const sourceRows = matrix.slice(1);
  if (sourceRows.length !== originalRows.length) {
    throw new Error("Template row count mismatch for " + sheetName +
      ": template=" + sourceRows.length + " checkpoint=" + originalRows.length);
  }
  const nameCol = header.findIndex((h) => h === "Организация");
  if (nameCol < 0) throw new Error("Template missing 'Организация': " + sheetName);
  for (let i = 0; i < originalRows.length; i++) {
    if (STR(sourceRows[i][nameCol]) !== STR(originalRows[i]["Организация"])) {
      throw new Error("Template organization mismatch for " + sheetName +
        " at row " + (i + 2) + ": template=" + STR(sourceRows[i][nameCol]) +
        ", checkpoint=" + STR(originalRows[i]["Организация"]));
    }
  }
  const lookup = buildIndex(originalRows);
  const reviewColumns = ONLY_REVIEW.filter((head) => !header.includes(head));
  const outputHeader = [...header, ...reviewColumns];
  const rows = [outputHeader];
  const crmTransfers = [], crmConflicts = [];
  const sourcePositions = [], cellOrigins = [], reviewerComments = [];

  for (const rec of recoveredRows) {
    const mainId = STR(rec.__canonical_id);
    if (!lookup.has(mainId)) throw new Error("Unknown restored canonical ID: " + mainId);
    const relatedIds = [...new Set(Array.isArray(rec.__merged_canonical_ids) && rec.__merged_canonical_ids.length
      ? rec.__merged_canonical_ids.map(STR) : [mainId])];
    if (!relatedIds.includes(mainId)) throw new Error("Merged identity audit missing survivor ID: " + mainId);
    const related = relatedIds.map((id) => {
      if (!lookup.has(id)) throw new Error("Missing source canonical ID " + id);
      const i = lookup.get(id);
      return { id, index: i, values: sourceRows[i] };
    });
    const primary = related.find((r) => r.id === mainId);
    const out = [...primary.values];
    const origins = header.map(() => primary.index);
    for (let c = 0; c < header.length; c++) {
      const field = header[c];
      if (typeof field !== "string" || !field) continue;
      if (Object.prototype.hasOwnProperty.call(rec, field)) {
        out[c] = rec[field] ?? "";
      } else if (MANUAL_FIELD(field) && related.length > 1) {
        const variants = [...new Set(related.map((r) => STR(r.values[c])).filter(Boolean))];
        if (variants.length > 1) {
          crmConflicts.push({ organization: STR(rec["Организация"]), field,
            values: variants, original_ids: relatedIds });
        } else if (variants.length === 1 && !STR(out[c])) {
          const donor = related.find((r) => STR(r.values[c]));
          out[c] = donor.values[c];
          origins[c] = donor.index;
          crmTransfers.push({ organization: STR(rec["Организация"]), field,
            value: variants[0], original_ids: relatedIds });
        }
      }
    }
    for (const review of reviewColumns) {
      if (review === "__comment") out.push(rec.__comment || "");
      if (review === "Проверка A/B/C") {
        out.push(rec.__evidence?.qualification_review?.status === "manual_review_required"
          ? "ПРОВЕРИТЬ: разные классы у объединённых алиасов" : "");
      }
    }
    rows.push(out);
    sourcePositions.push(primary.index);
    cellOrigins.push(origins);
    reviewerComments.push(STR(rec.__comment));
  }

  const projected = XLSX.utils.aoa_to_sheet(rows);
  projected["!cols"] = outputHeader.map((h, c) =>
    sheet["!cols"]?.[c] || { wch: h === "Организация" ? 45 :
      h === "Основание" || h === "Техника/сегмент" ? 60 :
      h === "__comment" ? 75 : 25 });

  // Carry each original Excel comment along with its legal entity, rather
  // than retaining the old row number after 20 aliases become 10.
  // In the organization cell, the current offline __comment supersedes the
  // archived stale "ИНН: не подтверждено" text.
  let commentsRemapped = 0;
  for (let i = 0; i < recoveredRows.length; i++) {
    for (let c = 0; c < header.length; c++) {
      const oldIndex = cellOrigins[i][c];
      const oldAddress = XLSX.utils.encode_cell({ r: oldIndex + 1, c });
      const newAddress = XLSX.utils.encode_cell({ r: i + 1, c });
      const oldCell = sheet[oldAddress];
      const formula = oldCell?.f;
      if (formula && MANUAL_FIELD(header[c])) {
        // A row relocation would change cell-relative references. Refuse it.
        if (/\$?[A-Z]{1,3}\$?\d+/i.test(formula)) {
          throw new Error("Cannot safely carry relative CRM formula through dedupe: " +
            sheetName + "!" + oldAddress);
        }
        projected[newAddress] = { ...oldCell, ...projected[newAddress] };
      }
      const originalComments = oldCell?.c;
      let comments = Array.isArray(originalComments) ?
        originalComments.map((comment) => ({ ...comment })) : [];
      if (c === nameCol && reviewerComments[i]) {
        comments = [{ a: comments[0]?.a || "RegionalResearch", t: reviewerComments[i] }];
      }
      if (comments.length) {
        const target = projected[newAddress] || { t: "z" };
        target.c = comments;
        projected[newAddress] = target;
        commentsRemapped++;
      }
    }
  }
    projected["!autofilter"] = sheet["!autofilter"] ? { ...sheet["!autofilter"],
    ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 },
      e: { r: recoveredRows.length, c: outputHeader.length - 1 } }) } : undefined;
  return { sheet: projected, crmTransfers, crmConflicts, commentsRemapped,
    original_columns: header.length, output_columns: outputHeader.length };
}
