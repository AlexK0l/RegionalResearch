// Deterministic reunion of reviewed FULL offline CRM with replay v8 classes.
// No identity correction, source search, model call or checkpoint mutation.
// Historical alias rows remain in reviewed_alias_merges.archived_original_records.
import XLSX from "xlsx";
import {
  DIRECT_BUYER_COLS, INTERMEDIARY_COLS, LEASING_COLS,
  STAT_COLS, COLOR_STAT_COLS, LEGEND_COLS
} from "./constants.js";

const SECTIONS = ["direct_buyers", "intermediaries", "leasing"];
const CLASS = new Set(["A", "B", "C", "REVIEW", "EXCLUDED"]);
const VISIBLE = new Set(["A", "B", "C"]);

function demand(condition, reason) {
  if (!condition) throw new Error("Offline v8 integration: " + reason);
}
function string(value) { return String(value ?? "").trim(); }
function urlList(row) {
  return Array.isArray(row?.__evidence?.source_urls) ? row.__evidence.source_urls : [];
}
function originalNotes(row) {
  return Array.isArray(row?.__evidence?.notes) ? row.__evidence.notes : [];
}
function getOriginalEntry(a) {
  return a && a.canonical_id && a.retained_with && a.record ? a : null;
}
function validatedReviewStatus(row) {
  const status = string(row.qualification_status || row.replay_grade || "EXCLUDED");
  demand(CLASS.has(status), "unsupported replay status for " + row.canonical_id);
  demand((VISIBLE.has(status) && row.replay_grade === status) ||
    (!VISIBLE.has(status) && !string(row.replay_grade)),
    "replay grade/status mismatch " + row.canonical_id);
  return status;
}
function countGrades(rows) {
  const counts = { A: 0, B: 0, C: 0, REVIEW: 0, EXCLUDED: 0 };
  for (const row of rows) {
    const status = row.__replay_v8?.status;
    demand(CLASS.has(status), "missing v8 status " + row.__canonical_id);
    counts[status]++;
  }
  return counts;
}

export function integrateReviewedReplay(verifiedFull, qualificationReplay, options = {}) {
  demand(verifiedFull && qualificationReplay, "two JSON inputs are required");
  const checkpoint = string(verifiedFull.checkpoint_id);
  demand(checkpoint && checkpoint === string(qualificationReplay.checkpoint), "checkpoint mismatch");
  demand(qualificationReplay.source_sqlite_readonly === true, "replay must be a read-only SQLite export");
  demand(Array.isArray(qualificationReplay.rows), "missing replay rows");
  demand(verifiedFull.final_result && Array.isArray(verifiedFull.rows), "full reviewed JSON required; compact export is insufficient");

  const verified = structuredClone(verifiedFull);
  const active = new Map();
  for (const sheet of SECTIONS) {
    const list = verified.final_result[sheet];
    demand(Array.isArray(list), "missing verified final_result." + sheet);
    for (const row of list) {
      const id = string(row.__canonical_id);
      demand(id && !active.has(id), "duplicate or missing active ID " + id);
      active.set(id, { row, sheet });
    }
  }
  const compact = new Map();
  for (const row of verified.rows) {
    const id = string(row.canonical_id);
    demand(id && !compact.has(id), "invalid compact ID " + id);
    compact.set(id, row);
  }
  demand(active.size === compact.size &&
    [...active.keys()].every(id => compact.has(id)), "full-record / compact-index mismatch");

  const archive = verified.reviewed_alias_merges?.archived_original_records;
  demand(Array.isArray(archive), "reviewed_alias_merges.archived_original_records required; no inferred alias merges");
  const absorbed = new Map();
  const sourceRows = new Map();
  for (const [id, item] of active) sourceRows.set(id, { sheet: item.sheet, row: item.row, absorbed: false });
  for (const entry of archive) {
    const a = getOriginalEntry(entry);
    demand(a && !sourceRows.has(a.canonical_id), "invalid archived alias record");
    demand(active.has(a.retained_with), "archived alias survivor does not exist: " + a.retained_with);
    demand(string(a.record.__canonical_id) === a.canonical_id,
      "archived canonical ID must be the exact source record");
    demand(string(a.record["Организация"]), "missing archived legal name");
    absorbed.set(a.canonical_id, a.retained_with);
    sourceRows.set(a.canonical_id, { sheet: a.original_sheet, row: a.record, absorbed: true });
  }
  demand(sourceRows.size === active.size + archive.length, "missing or duplicate original record");
  if (verified.reviewed_alias_merges.original_company_count != null)
    demand(Number(verified.reviewed_alias_merges.original_company_count) === sourceRows.size,
      "source company count differs from saved reviewed alias manifest");

  const replay = new Map();
  for (const r of qualificationReplay.rows) {
    const id = string(r.canonical_id);
    demand(id && !replay.has(id), "duplicate replay canonical ID " + id);
    validatedReviewStatus(r);
    replay.set(id, r);
  }
  // An earlier source-backed alias group is recorded *before* reviewed aliases.
  // Example: АО «СпецАТХ» (k000319) -> АО «Спецавтохозяйство» (k000066).
  // The full verified JSON already contains the merged contact/finance fields
  // and source_ids, while the original alias is not in the later 3-record
  // reviewed_alias_merges archive. Never resurrect it as a separate company.
  const earlierRestored = verified.identity_audit?.restored_groups || [];
  demand(Array.isArray(earlierRestored), "invalid earlier identity audit");
  const earlierAbsorbed = [];
  for (const group of earlierRestored) {
    demand(group.reason === "sourced_explicit_alias" &&
      Array.isArray(group.original_canonical_ids) &&
      group.original_canonical_ids.length >= 2 &&
      Array.isArray(group.absorbed_names) && group.absorbed_names.length,
      "earlier identity merge lacks an explicit sourced alias group");
    const winnerIds = group.original_canonical_ids.filter(id => active.has(id));
    demand(winnerIds.length === 1, "earlier identity group must contain exactly one active survivor");
    const winner = winnerIds[0];
    const current = active.get(winner);
    const savedSources = compact.get(winner)?.source_ids || [];
    demand(current.row["Организация"] === group.winner_name &&
      string(current.row["ИНН"]) === string(group.inn) && string(group.inn) &&
      group.original_canonical_ids.every(id => savedSources.includes(id)) &&
      (group.source_urls || []).every(url => urlList(current.row).includes(url)),
      "source-backed earlier alias does not match verified survivor");
    for (const sourceId of group.original_canonical_ids) {
      if (sourceId === winner) continue;
      demand(!sourceRows.has(sourceId) && !absorbed.has(sourceId),
        "earlier identity alias collides with another record " + sourceId);
      const originalReplay = replay.get(sourceId);
      demand(originalReplay && originalReplay.sheet === current.sheet &&
        group.absorbed_names.includes(originalReplay.organization) &&
        originalReplay.qualification_status === replay.get(winner)?.qualification_status &&
        VISIBLE.has(originalReplay.qualification_status) &&
        (!string(originalReplay.inn) || string(originalReplay.inn) === string(group.inn)),
        "earlier identity alias contradicts replay role, name, grade or INN " + sourceId);
      // This is a minimal ORIGINAL-source snapshot from read-only Replay.
      // No detached full CRM record exists for this already absorbed alias.
      sourceRows.set(sourceId, { sheet: originalReplay.sheet,
        row: { __canonical_id: sourceId, "Организация": originalReplay.organization,
          "ИНН": string(originalReplay.inn) }, absorbed: true,
        historical_source_restoration: true });
      absorbed.set(sourceId, winner);
      earlierAbsorbed.push(sourceId);
    }
  }
  for (const [id] of active) {
    const sourceIds = compact.get(id)?.source_ids || [id];
    demand(sourceIds.includes(id) && sourceIds.every(
      sid => sid === id || absorbed.get(sid) === id),
      "reviewed compact source_ids are not completely accounted for " + id);
  }
  demand(replay.size === sourceRows.size &&
    [...sourceRows.keys()].every(id => replay.has(id)),
    "Replay and reviewed JSON do not cover exactly the same original IDs");
  if (verified.identity_audit?.input_rows != null)
    demand(Number(verified.identity_audit.input_rows) === replay.size,
      "earlier identity audit input count differs from replay");

  // Fail before mutation when the legal identity or original role differs.
  for (const [id, origin] of sourceRows) {
    const candidate = replay.get(id);
    demand(string(origin.row["Организация"]) === string(candidate.organization),
      "legal name mismatch " + id);
    demand(origin.sheet === candidate.sheet, "commercial role mismatch " + id);
    const oldInn = string(candidate.inn);
    const reviewedInn = string(origin.row["ИНН"]);
    demand(!oldInn || oldInn === reviewedInn,
      "verified full record has a conflicting or cleared source INN " + id);
    if (origin.absorbed) {
      if (origin.historical_source_restoration) {
        demand(VISIBLE.has(candidate.qualification_status) &&
          candidate.qualification_status === replay.get(absorbed.get(id))?.qualification_status,
          "source-backed earlier alias qualification mismatch: " + id);
      } else {
        demand(candidate.qualification_status === "C" &&
          replay.get(absorbed.get(id))?.qualification_status === "C",
          "only later manually reviewed C/C alias groups can be transferred: " + id);
      }
      demand(!reviewedInn, "absorbed record unexpectedly has a live INN: " + id);
    }
  }

  // Prevent misattribution: do not concatenate unrelated evidence notes or
  // borrow INNs from archived aliases. All identity corrections already exist
  // in the reviewed full JSON and are left byte-equivalent as field values.
  const lineage = [];
  for (const r of qualificationReplay.rows) {
    const id = r.canonical_id;
    const survivor = absorbed.get(id) || id;
    lineage.push({
      canonical_id: id, original_organization: r.organization,
      original_sheet: r.sheet, original_inn: r.inn,
      original_replay_v8_status: r.qualification_status,
      survivor_canonical_id: survivor, absorbed: absorbed.has(id),
      effective_inn: string(active.get(survivor).row["ИНН"])
    });
  }

  const review = [];
  const excluded = [];
  let selected = 0;
  let originalSourceNotesNotInReviewed = 0;
  let originalSourceUrlsNotInReviewed = 0;
  for (const [id, item] of active) {
    const r = replay.get(id);
    const row = item.row;
    const status = validatedReviewStatus(r);
    const prevAEvidence = string(row.__a_evidence);
    row.__replay_v8 = {
      status, grade: string(r.replay_grade), a_rule: string(r.a_rule),
      a_evidence: string(r.a_evidence), reason: string(r.why),
      archived_grade_in_checkpoint: string(r.archived_grade),
      source_checkpoint: checkpoint,
      replay_run_is_offline: true, reverified_source_urls: false,
      qualification_code_sha: string(options.qualificationSha)
    };
    row.__a_evidence_before_v8 = prevAEvidence;
    row.__a_evidence = status === "A" ? string(r.a_evidence) : "";
    row.__a_rule = status === "A" ? string(r.a_rule) : "";
    row.__final_grade = VISIBLE.has(status) ? status : "";
    row.__final_qualification_status = status;
    row.__comment = string(row.__comment) +
      "\n\n[Офлайн квалификация Replay v8] " + status + ". " + string(r.why) +
      (r.a_evidence ? "\nA: " + r.a_evidence : "");
    const originalUrls = urlList(row);
    const originalClaims = originalNotes(row);
    for (const url of r.source_urls || [])
      if (!originalUrls.includes(url)) originalSourceUrlsNotInReviewed++;
    for (const note of r.evidence_notes || [])
      if (!originalClaims.includes(note)) originalSourceNotesNotInReviewed++;
    const short = compact.get(id);
    short.replay_v8_status = status;
    short.replay_v8_grade = VISIBLE.has(status) ? status : "";
    short.replay_v8_rule = string(r.a_rule);
    short.replay_v8_selected_evidence = string(r.a_evidence);
    short.replay_v8_reason = string(r.why);
    if (status === "REVIEW") review.push(row);
    else if (status === "EXCLUDED") excluded.push(row);
    else selected++;
  }
  verified.final_result.qualification_review_v5_archived =
    structuredClone(verified.final_result.qualification_review || []);
  verified.final_result.qualification_review = review;
  verified.final_result.qualification_excluded_v8 = excluded;

  const all = [...active.values()].map(({ row }) => row);
  const counts = countGrades(all);
  const reviewedInnPresent = all.filter(row => Boolean(string(row["ИНН"]))).length;
  demand(reviewedInnPresent === new Set(all.map(row => string(row["ИНН"])).filter(Boolean)).size,
    "duplicate INN in reviewed full JSON");
  const report = {
    checkpoint, qualification_code_sha: string(options.qualificationSha),
    replay_input_rows: replay.size, active_full_records: active.size,
    absorbed_alias_records: archive.length + earlierAbsorbed.length,
    reviewed_absorbed_alias_records: archive.length,
    source_restored_alias_records: earlierAbsorbed.length,
    all_original_ids_preserved: true,
    counts, crm_visible_rows: selected, reviewed_inn_present: reviewedInnPresent,
    reviewed_inn_missing: all.length - reviewedInnPresent,
    old_source_urls_absent_in_reviewed_full: originalSourceUrlsNotInReviewed,
    old_source_notes_absent_in_reviewed_full: originalSourceNotesNotInReviewed,
    status: "working_draft_not_current_legal_verification",
    original_names_and_inns_reassigned: false,
    new_structured_transport_facts: 0, openai_calls: 0,
    web_search_calls: 0, input_checkpoint_modified: false
  };
  demand(counts.A + counts.B + counts.C + counts.REVIEW + counts.EXCLUDED === active.size,
    "grade reconciliation mismatch");

  verified.integration_replay_v8 = {
    report, lineage, source_replay_checkpoint: checkpoint,
    input_archive_count: archive.length,
    earlier_restored_canonical_ids: earlierAbsorbed,
    prior_full_summary: structuredClone(verifiedFull.summary || {}),
    methodology: [
      "Only previously-reviewed legal identities and alias merges are carried forward.",
      "Qualification is replay v8; no independent source verification is performed here.",
      "A/B/C sales sheets exclude REVIEW and EXCLUDED, but these rows remain in full JSON.",
      "Original evidence.notes, source_urls, facts, contacts and financial values stay intact.",
      "If original URL/note evidence differs from reviewed full evidence, retain both inputs and audit discrepancy counts.",
      "Historical v5 qualification is not erased; __replay_v8 is a separate overlay."
    ]
  };
  verified.summary = {
    ...verified.summary,
    total: active.size, with_inn: reviewedInnPresent,
    without_inn: active.size - reviewedInnPresent,
    grades: counts, current_qualification_version: "replay_v8",
    new_paid_api_calls: 0
  };
  verified.working_draft_not_approved_for_crm = true;
  return { data: verified, report };
}

function commentForRow(row) {
  return string(row.__comment) || [
    "URL источников: " + urlList(row).join(", "),
    "ИНН: " + string(row["ИНН"]),
    "Деятельность: " + originalNotes(row).slice(0, 2).join("; ")
  ].join("\n");
}
function buyerValue(row, column) {
  if (column === "Основание")
    return "Replay v8 [" + row.__replay_v8.status + "]: " + row.__replay_v8.reason +
      "\n" + string(row[column]);
  return row[column] ?? "";
}
function buildSheet(wb, name, cols, rows) {
  const data = [cols, ...rows.map(r => cols.map(c => buyerValue(r, c)))];
  const sheet = XLSX.utils.aoa_to_sheet(data);
  rows.forEach((r,i) => {
    // All commercial sheets have their note in the first column, not a new one.
    const address = "A" + (i + 2);
    sheet[address] ||= { t: "s", v: "" };
    XLSX.utils.cell_add_comment(sheet[address], commentForRow(r), "RegionalResearch");
  });
  sheet["!cols"] = cols.map(col => ({ wch: col === "Основание" ? 75 :
    col === "Организация" ? 45 : col === "ИНН" ? 21 : 28 }));
  XLSX.utils.book_append_sheet(wb, sheet, name);
}

export function integratedReviewedWorkbook(data, report) {
  const wb = XLSX.utils.book_new();
  const sections = [
    ["direct_buyers", "Прямые покупатели", DIRECT_BUYER_COLS],
    ["intermediaries", "Посредники", INTERMEDIARY_COLS],
    ["leasing", "Лизинг", LEASING_COLS]
  ];
  for (const [key, name, cols] of sections)
    buildSheet(wb, name, cols, data.final_result[key].filter(r =>
      VISIBLE.has(r.__replay_v8?.status)));
  const summary = [
    ["Интеграция квалификации", "Replay v8", "По старому checkpoint",
      report.checkpoint, "Без платных запросов"],
    ["Самостоятельных записей", report.active_full_records, "записей", "", "После проверенных алиасов"],
    ["В CRM A/B/C", report.crm_visible_rows, "записей", "", "REVIEW / EXCLUDED вынесены отдельно"],
    ...["A", "B", "C", "REVIEW", "EXCLUDED"].map(g =>
      ["Класс " + g, report.counts[g], "записей", "", ""]),
    ["С ИНН", report.reviewed_inn_present, "записей", "", "Проверенные данные сохраняются"],
    ["Без ИНН", report.reviewed_inn_missing, "записей", "", "Не присваивать без подтверждённого юрлица"],
    ["Архив проверенных алиасов", report.absorbed_alias_records, "записей", "", "См. исходную историю ID"]
  ];
  const stat = XLSX.utils.aoa_to_sheet([STAT_COLS, ...summary]);
  XLSX.utils.book_append_sheet(wb, stat, "Статистика");
  const colors = XLSX.utils.aoa_to_sheet([COLOR_STAT_COLS,
    ["A", "A", "Подтверждённый полуприцеп / владение / лизинг", report.counts.A],
    ["B", "B", "Подтверждённая тяжелая логистика; без основания A", report.counts.B],
    ["C", "C", "Подтверждённый релевантный груз или процесс", report.counts.C],
    ["REVIEW", "REVIEW", "Сохранено для ручной проверки, не входит в CRM", report.counts.REVIEW],
    ["EXCLUDED", "EXCLUDED", "Не является активным коммерческим лидом", report.counts.EXCLUDED]]);
  XLSX.utils.book_append_sheet(wb, colors, "Статистика по цветам");
  const legend = XLSX.utils.aoa_to_sheet([LEGEND_COLS,
    ["A", "Зелёный", "Конкретный подтверждённый спрос / эксплуатация дорожной прицепной техники"],
    ["B", "Жёлтый", "Тяжёлая логистика и целевые грузы при недостаточном основании для A"],
    ["C", "Нейтральный", "Релевантный грузовладелец, необходима проверка фактического перевозчика"],
    ["REVIEW", "Оранжевый", "Сохранить в контрольной очереди"],
    ["EXCLUDED", "Красный", "Показывать только в аудите"]]);
  XLSX.utils.book_append_sheet(wb, legend, "Легенда");
  const detailHeaders=["ID","Организация","Роль","Статус v8","ИНН","Основание v8","URL источников"];
  for (const [title,filter] of [
    ["REVIEW v8",r => r.__replay_v8?.status === "REVIEW"],
    ["Исключено v8",r => r.__replay_v8?.status === "EXCLUDED"]]) {
    const records=SECTIONS.flatMap(section => data.final_result[section].map(r=>({r,section})))
      .filter(({r})=>filter(r));
    const table = XLSX.utils.aoa_to_sheet([detailHeaders,
      ...records.map(({r,section})=>[r.__canonical_id,r["Организация"],section,
        r.__replay_v8.status,r["ИНН"],r.__replay_v8.reason,urlList(r).join("\n")])]);
    XLSX.utils.book_append_sheet(wb,table,title);
  }
  const ids = data.integration_replay_v8.lineage;
  const history = XLSX.utils.aoa_to_sheet([["Исходный ID","Исходная организация",
    "Исходная роль","Статус v8","Основной ID","Поглощённый алиас","ИНН основной записи"],
    ...ids.map(l=>[l.canonical_id,l.original_organization,l.original_sheet,
      l.original_replay_v8_status,l.survivor_canonical_id,
      l.absorbed?"ДА":"НЕТ",l.effective_inn])]);
  XLSX.utils.book_append_sheet(wb,history,"История 492 ID");
  const qa=XLSX.utils.aoa_to_sheet([["Контроль","Значение"],
    ...Object.entries(report).map(([k,v])=>[k,typeof v==="object"?JSON.stringify(v):v])]);
  XLSX.utils.book_append_sheet(wb,qa,"Аудит v8");
  return wb;
}
