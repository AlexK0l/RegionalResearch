import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { COLS, STAT_COLS, MODEL, STEPS } from "./constants.js";
import {
  closeResearchSession,
  createResearchSession,
  enrichCompanyWithGoogleAI,
  launchResearchBrowser,
  verifyPhoneForCompanyWithGoogleAI
} from "./googleAiAgent.js";

const OPENAI_MAX_OUTPUT_TOKENS = Math.max(
  1000,
  Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 128000)
);
const RESEARCH_MAX_OUTPUT_TOKENS = Math.min(50000, OPENAI_MAX_OUTPUT_TOKENS);
const FINAL_BATCH_MAX_OUTPUT_TOKENS = Math.min(50000, OPENAI_MAX_OUTPUT_TOKENS);
const FINAL_QA_MAX_OUTPUT_TOKENS = Math.min(30000, OPENAI_MAX_OUTPUT_TOKENS);
const TARGETED_SEARCH_MAX_OUTPUT_TOKENS = Math.min(8000, OPENAI_MAX_OUTPUT_TOKENS);
const STATISTICS_MAX_OUTPUT_TOKENS = Math.min(12000, OPENAI_MAX_OUTPUT_TOKENS);
const FINAL_BATCH_MODEL = process.env.FINAL_BATCH_MODEL || "gpt-5.6-luna";
const TARGETED_SEARCH_MODEL = process.env.TARGETED_SEARCH_MODEL || "gpt-5.6-luna";
const FINAL_QA_MODEL = process.env.FINAL_QA_MODEL || "gpt-5.6-luna";
const CONFLICT_MODEL = process.env.CONFLICT_MODEL || "gpt-5.6-sol";
const GOOGLE_AI_SOL_RETRY_PRIORITY_AB =
  String(process.env.GOOGLE_AI_SOL_RETRY_PRIORITY_AB || "true").toLowerCase() !== "false";
const FINAL_BATCH_SIZE = Math.max(
  20,
  Math.min(100, Number(process.env.OPENAI_FINAL_BATCH_SIZE || 60))
);

function parseJson(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^\`\`\`(?:json)?\s*/i, "")
    .replace(/\s*\`\`\`$/i, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("Ответ модели не удалось разобрать как JSON");
  }
}

function contract(final = false) {
  if (final) {
    return `\n\nТЕХНИЧЕСКИЙ ФОРМАТ: верни ТОЛЬКО валидный JSON без markdown:
{"direct_buyers":[],"intermediaries":[],"leasing":[],"statistics":[]}.
Коммерческие объекты содержат ключи: ${COLS.map((x) => `"${x}"`).join(", ")}, а также служебный ключ "__comment".
"__comment" — текст Excel-примечания для ячейки первого столбца "Организация". Он обязателен для каждой коммерческой организации и должен содержать отдельными строками: "Сайт/источник:", "ИНН:", "Деятельность:", "Холдинг/УК/группа:", "Email:". Этот служебный ключ не является колонкой XLSX.
Статистика содержит ровно ключи: ${STAT_COLS.map((x) => `"${x}"`).join(", ")}.
Не добавляй видимое поле/колонку "Источник". Если значения нет — пустая строка; в "__comment" для неподтвержденных сведений явно укажи "не подтверждено" или "не найден".`;
  }

  return `\n\nТЕХНИЧЕСКИЙ ФОРМАТ: верни ТОЛЬКО валидный JSON без markdown:
{"direct_buyers":[],"intermediaries":[],"leasing":[]}.
Каждый объект содержит видимые ключи: ${COLS.map((x) => `"${x}"`).join(", ")}, а также служебный "__evidence".
"__evidence" не является колонкой XLSX и имеет формат:
{"source_urls":[],"official_site":"","email":"","holding_source":"","notes":[]}.
Сохраняй в "__evidence" уже найденные при web_search URL первичных/наиболее сильных источников, официальный сайт, публичный e-mail и краткие подтверждающие заметки. Не выполняй отдельный поиск только ради заполнения "__evidence": сохраняй то, что уже встретилось в ходе текущего исследования.
Не добавляй видимое поле "Источник". Если значения нет — пустая строка. Не выдумывай данные.`;
}

function finalBatchContract() {
  return `\n\nПАКЕТНЫЙ ТЕХНИЧЕСКИЙ ФОРМАТ: верни ТОЛЬКО валидный JSON без markdown:
{"direct_buyers":[],"intermediaries":[],"leasing":[]}.
На входе находятся CANONICAL-компании. Каждую входную canonical-компанию верни РОВНО ОДИН РАЗ и обязательно сохрани её "__canonical_id".
Не удаляй компанию на этом этапе. Если она кажется нерелевантной, верни её как обычно и добавь "__decision":"exclude" и краткий "__decision_reason"; окончательное удаление выполняется только глобальным QA.
Для каждой canonical-компании используй ВСЕ элементы массива evidence как единый набор доказательств. Не теряй сведения из отдельных шагов.
Этот пакет обрабатывается БЕЗ web_search: не требуй нового поиска и не придумывай отсутствующие факты. Сначала используй сохранённый "__evidence" из шагов 1–9.
Каждый коммерческий объект содержит ключи: ${COLS.map((x) => `"${x}"`).join(", ")}, "__comment", "__canonical_id", "__decision", "__decision_reason".
"__comment" обязателен и содержит ровно пять смысловых строк: "Сайт/источник:", "ИНН:", "Деятельность:", "Холдинг/УК/группа:", "Email:".
Не возвращай статистику. Не выдумывай данные.`;
}

function finalQaContract() {
  return `\n\nФИНАЛЬНЫЙ QA — верни ТОЛЬКО валидный JSON без markdown:
{
  "remove_ids": [],
  "moves": [{"id":"","sheet":"direct_buyers|intermediaries|leasing"}],
  "patches": [{"id":"","fields":{}}]
}
Не возвращай полный список компаний и не выполняй web_search.
remove_ids — только строки, которые действительно нужно удалить как дубли или нерелевантные.
moves — только строки, которые нужно перенести на другой коммерческий лист.
patches — только исправления полей сохранённой строки; fields может содержать только видимые коммерческие поля и "__comment".
При схлопывании дублей перенеси полезные сведения из удаляемых строк в сохраняемую строку через patches.
Одна организация должна остаться только один раз во всей итоговой совокупности.`;
}

function conflictContract() {
  return `\n\nРАЗРЕШЕНИЕ КОНФЛИКТОВ — верни ТОЛЬКО JSON:
{"remove_ids":[],"moves":[],"patches":[]}.
На входе ТОЛЬКО конфликтные группы. Не анализируй остальные компании.
Разные подтверждённые ИНН — разные юридические лица и никогда не должны объединяться.
Если совпадает телефон/название, но ИНН разные, сохрани обе строки и исправь ошибочную привязку через patch только при явном основании из переданных данных.
Если один объект действительно дубль другого и ИНН не противоречат, можно удалить дубль, сохранив полезные сведения patch-ом в оставшейся строке.
Не выполняй web_search и не придумывай факты.`;
}

function statisticsContract() {
  return `\n\nВерни ТОЛЬКО JSON:
{"statistics":[]}.
statistics — ровно 8 показателей: население региона; количество лесных хозяйств; перевозчиков промышленных и бытовых отходов; дорожных ремонтно-строительных компаний; агро-хозяйств; деревообрабатывающих компаний; производителей ДСП; компаний по вывозу металлического лома/вторчермета.
Каждый объект содержит ровно ключи: ${STAT_COLS.map((x) => `"${x}"`).join(", ")}.
Используй web_search. Для населения предпочитай официальный свежий показатель; для количества компаний — официальный источник или воспроизводимую методику. Если точное число нельзя получить воспроизводимо — "н/д" с причиной.`;
}

function targetedSearchContract() {
  return `\n\nТОЧЕЧНОЕ ОБОГАЩЕНИЕ ОДНОЙ КОМПАНИИ — верни ТОЛЬКО JSON:
{"fields":{},"__comment":""}.
Ищи ТОЛЬКО указанную компанию и ТОЛЬКО перечисленные недостающие сведения.
fields может содержать только: "Управляющая компания", "ИНН", "Телефон", "Руководитель / ЛПР", "Выручка последнего подтвержденного года", "Численность".
"__comment" должен содержать пять строк: Сайт/источник; ИНН; Деятельность; Холдинг/УК/группа; Email.
Не заменяй уже подтверждённые сведения более слабыми. Не выдумывай данные.`;
}

async function loadPrompt(n) {
  const commonPath = path.resolve("prompts/common.txt");
  const promptPath = path.resolve("prompts", String(n).padStart(2, "0") + ".txt");
  const [common, specific] = await Promise.all([
    fs.readFile(commonPath, "utf8"),
    fs.readFile(promptPath, "utf8")
  ]);
  return specific + "\n\n" + common;
}

function normalize(data, withStats = false) {
  const result = {
    direct_buyers: Array.isArray(data?.direct_buyers) ? data.direct_buyers : [],
    intermediaries: Array.isArray(data?.intermediaries) ? data.intermediaries : [],
    leasing: Array.isArray(data?.leasing) ? data.leasing : []
  };
  if (withStats) {
    result.statistics = Array.isArray(data?.statistics) ? data.statistics : [];
  }
  return result;
}

function rowCount(result) {
  return (
    (result.direct_buyers?.length || 0) +
    (result.intermediaries?.length || 0) +
    (result.leasing?.length || 0)
  );
}

function flattenCandidates(parts) {
  const rows = [];
  const groups = [
    ["direct_buyers", "Прямые покупатели"],
    ["intermediaries", "Посредники"],
    ["leasing", "Лизинг"]
  ];

  for (let stepIndex = 0; stepIndex < parts.length; stepIndex++) {
    const part = parts[stepIndex] || {};
    for (const [key, sourceSheet] of groups) {
      for (const row of part[key] || []) {
        rows.push({
          candidate_id: `c${String(rows.length + 1).padStart(6, "0")}`,
          source_step: stepIndex + 1,
          source_sheet: sourceSheet,
          data: row
        });
      }
    }
  }
  return rows;
}

function normalizeInn(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 10 || digits.length === 12 ? digits : "";
}

function normalizeOrgKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[«»"'.,()]/g, " ")
    .replace(/\b(ооо|ао|пао|зао|оао|ип)\b/g, " ")
    .replace(/[^a-zа-яё0-9]+/gi, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizePlaceKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function canonicalizeCandidates(candidates) {
  const parent = candidates.map((_, i) => i);
  const rank = candidates.map(() => 0);

  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };

  const union = (a, b) => {
    let ra = find(a);
    let rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) [ra, rb] = [rb, ra];
    parent[rb] = ra;
    if (rank[ra] === rank[rb]) rank[ra]++;
  };

  const innOwners = new Map();
  const orgPlaceOwners = new Map();

  for (let i = 0; i < candidates.length; i++) {
    const row = candidates[i]?.data || {};
    const inn = normalizeInn(row["ИНН"]);
    if (inn) {
      if (innOwners.has(inn)) union(i, innOwners.get(inn));
      else innOwners.set(inn, i);
    }

    const org = normalizeOrgKey(row["Организация"]);
    const place = normalizePlaceKey(row["Город/район"]);
    if (org && place) {
      const key = `${org}|${place}`;
      if (orgPlaceOwners.has(key)) {
        const otherIndex = orgPlaceOwners.get(key);
        const otherInn = normalizeInn(candidates[otherIndex]?.data?.["ИНН"]);
        if (!(inn && otherInn && inn !== otherInn)) union(i, otherIndex);
      } else {
        orgPlaceOwners.set(key, i);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < candidates.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(candidates[i]);
  }

  return [...groups.values()].map((evidence, index) => ({
    canonical_id: `k${String(index + 1).padStart(6, "0")}`,
    candidate_ids: evidence.map((x) => x.candidate_id),
    source_steps: [...new Set(evidence.map((x) => x.source_step))],
    source_sheets: [...new Set(evidence.map((x) => x.source_sheet))],
    evidence
  }));
}

function baselineRowFromCanonical(canonical) {
  const row = {};
  const evidenceRows = canonical?.evidence?.map((x) => x.data || {}) || [];

  for (const col of COLS) {
    const values = [...new Set(
      evidenceRows
        .map((item) => String(item?.[col] ?? "").trim())
        .filter(Boolean)
    )];

    if (col === "Телефон") row[col] = values.join("; ");
    else if (col === "Основание" || col === "Техника/сегмент") row[col] = values.join(" | ");
    else row[col] = values[0] || "";
  }

  row.__canonical_id = canonical.canonical_id;
  row.__decision = "review";
  row.__decision_reason = "Восстановлено из исходных свидетельств: пакетный ответ пропустил canonical-компанию.";
  row.__comment = [
    "Сайт/источник: не подтверждено",
    `ИНН: ${row["ИНН"] || "не подтверждено"}`,
    "Деятельность: требуется финальная проверка",
    `Холдинг/УК/группа: ${row["Управляющая компания"] || "не подтверждено"}`,
    "Email: не найден"
  ].join("\n");
  return row;
}

function ensureBatchCoverage(batch, batchResult) {
  const output = {
    direct_buyers: [],
    intermediaries: [],
    leasing: []
  };
  const seen = new Set();
  const byCanonicalId = new Map(batch.map((item) => [item.canonical_id, item]));

  for (const sheet of ["direct_buyers", "intermediaries", "leasing"]) {
    for (const row of batchResult?.[sheet] || []) {
      const id = String(row?.__canonical_id || "");
      if (!id || !byCanonicalId.has(id) || seen.has(id)) continue;
      seen.add(id);
      output[sheet].push(row);
    }
  }

  for (const canonical of batch) {
    if (seen.has(canonical.canonical_id)) continue;

    const fallback = baselineRowFromCanonical(canonical);
    const preferred = canonical.source_sheets.includes("Лизинг")
      ? "leasing"
      : canonical.source_sheets.includes("Прямые покупатели")
        ? "direct_buyers"
        : "intermediaries";
    output[preferred].push(fallback);
  }

  return output;
}

function makeQaRecords(result) {
  const records = [];
  const groups = ["direct_buyers", "intermediaries", "leasing"];
  for (const sheet of groups) {
    for (const row of result[sheet] || []) {
      records.push({
        id: `q${String(records.length + 1).padStart(6, "0")}`,
        canonical_id: row?.__canonical_id || "",
        sheet,
        row
      });
    }
  }
  return records;
}

function applyFinalQa(records, qa) {
  const allowedSheets = new Set(["direct_buyers", "intermediaries", "leasing"]);
  const allowedFields = new Set([...COLS, "__comment", "__decision", "__decision_reason"]);
  const removeIds = new Set(Array.isArray(qa?.remove_ids) ? qa.remove_ids.map(String) : []);
  const moves = new Map();

  for (const item of Array.isArray(qa?.moves) ? qa.moves : []) {
    const id = String(item?.id || "");
    const sheet = String(item?.sheet || "");
    if (id && allowedSheets.has(sheet)) moves.set(id, sheet);
  }

  const patches = new Map();
  for (const item of Array.isArray(qa?.patches) ? qa.patches : []) {
    const id = String(item?.id || "");
    if (!id || !item?.fields || typeof item.fields !== "object") continue;
    const filtered = {};
    for (const [key, value] of Object.entries(item.fields)) {
      if (allowedFields.has(key)) filtered[key] = value ?? "";
    }
    if (Object.keys(filtered).length) patches.set(id, filtered);
  }

  const result = {
    direct_buyers: [],
    intermediaries: [],
    leasing: [],
    statistics: []
  };

  for (const record of records) {
    if (removeIds.has(record.id)) continue;
    const row = { ...record.row, ...(patches.get(record.id) || {}) };
    const sheet = moves.get(record.id) || record.sheet;
    if (allowedSheets.has(sheet)) result[sheet].push(row);
  }

  return result;
}

async function askJson(client, {
  input,
  model = MODEL,
  maxOutputTokens = RESEARCH_MAX_OUTPUT_TOKENS,
  webSearch = false
}) {
  const request = {
    model,
    input,
    max_output_tokens: maxOutputTokens
  };
  if (webSearch) {
    request.tools = [{ type: "web_search" }];
    request.tool_choice = "required";
  }

  const response = await client.responses.create(request);
  if (response.status && response.status !== "completed") {
    throw new Error(`OpenAI response status: ${response.status}`);
  }
  return parseJson(response.output_text || "");
}

function askResearch(client, input, maxOutputTokens = RESEARCH_MAX_OUTPUT_TOKENS) {
  return askJson(client, {
    input,
    model: MODEL,
    maxOutputTokens,
    webSearch: true
  });
}

function askWithoutSearch(client, input, model, maxOutputTokens) {
  return askJson(client, {
    input,
    model,
    maxOutputTokens,
    webSearch: false
  });
}

function askTargetedSearch(client, input) {
  return askJson(client, {
    input,
    model: TARGETED_SEARCH_MODEL,
    maxOutputTokens: TARGETED_SEARCH_MAX_OUTPUT_TOKENS,
    webSearch: true
  });
}

function commentValue(comment, label) {
  const line = String(comment || "")
    .split(/\r?\n/)
    .find((x) => x.trim().toLowerCase().startsWith(label.toLowerCase() + ":"));
  return line ? line.slice(line.indexOf(":") + 1).trim() : "";
}

function isMissingText(value) {
  const text = String(value || "").trim().toLowerCase();
  return !text ||
    text === "н/д" ||
    text.includes("не найден") ||
    text.includes("не подтвержден") ||
    text.includes("требуется финальная проверка");
}

function missingResearchFields(row) {
  const gaps = [];
  const comment = row?.__comment || "";
  if (isMissingText(commentValue(comment, "Сайт/источник"))) gaps.push("сайт/источник");
  if (!normalizeInn(row?.["ИНН"])) gaps.push("ИНН");
  if (isMissingText(commentValue(comment, "Email"))) gaps.push("email");
  if (isMissingText(commentValue(comment, "Деятельность"))) gaps.push("краткое описание деятельности");

  const holding = commentValue(comment, "Холдинг/УК/группа");
  const manager = String(row?.["Управляющая компания"] || "").trim();
  if (isMissingText(holding) && (!manager || /не подтвержд/i.test(manager))) {
    gaps.push("холдинг/УК/группа");
  }
  return [...new Set(gaps)];
}

function applyTargetedPatch(row, result) {
  const allowed = new Set([
    "Управляющая компания",
    "ИНН",
    "Телефон",
    "Руководитель / ЛПР",
    "Выручка последнего подтвержденного года",
    "Численность"
  ]);
  for (const [key, value] of Object.entries(result?.fields || {})) {
    if (!allowed.has(key)) continue;
    if (value === undefined || value === null || String(value).trim() === "") continue;
    if (key === "Телефон") row[key] = mergePhone(row[key], value);
    else if (!String(row[key] || "").trim() || /не подтвержд/i.test(String(row[key]))) row[key] = value;
  }
  if (String(result?.__comment || "").trim()) row.__comment = String(result.__comment).trim();
}

function buildConflictGroups(records) {
  const buckets = new Map();
  const add = (key, record) => {
    if (!key) return;
    if (!buckets.has(key)) buckets.set(key, []);
    const arr = buckets.get(key);
    if (!arr.some((x) => x.id === record.id)) arr.push(record);
  };

  for (const record of records) {
    const row = record.row || {};
    const org = normalizeOrgKey(row["Организация"]);
    const place = normalizePlaceKey(row["Город/район"]);
    if (org && place) add(`orgplace:${org}|${place}`, record);

    for (const phone of splitPhoneEntries(row["Телефон"])) {
      const normalized = normalizePhoneDigits(phone);
      if (normalized) add(`phone:${normalized}`, record);
    }
  }

  const groups = [];
  const seen = new Set();
  for (const [key, items] of buckets) {
    if (items.length < 2) continue;
    const inns = [...new Set(items.map((x) => normalizeInn(x.row?.["ИНН"])).filter(Boolean))];
    const canonicalIds = [...new Set(items.map((x) => x.canonical_id).filter(Boolean))];
    if (inns.length <= 1 && canonicalIds.length <= 1) continue;
    const signature = items.map((x) => x.id).sort().join("|");
    if (seen.has(signature)) continue;
    seen.add(signature);
    groups.push({ key, records: items });
  }
  return groups;
}


function initialStatuses() {
  return STEPS.map((name, index) => ({
    step: index + 1,
    name,
    status: "waiting",
    detail: "",
    startedAt: null,
    completedAt: null
  }));
}

function startStep(status) {
  status.status = "running";
  status.startedAt = Date.now();
  status.completedAt = null;
}

function finishStep(status) {
  status.status = "done";
  status.completedAt = Date.now();
}

function mergePhone(current, found) {
  const parts = String(current || "")
    .split(";")
    .concat(String(found || "").split(";"))
    .map((x) => x.trim())
    .filter(Boolean);
  return [...new Set(parts)].join(";");
}

function applyContact(row, contact) {
  if (contact?.phone) row["Телефон"] = mergePhone(row["Телефон"], contact.phone);
  if (contact?.leader) row["Руководитель / ЛПР"] = contact.leader;
}

function normalizePhoneDigits(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) digits = "7" + digits.slice(1);
  if (digits.length === 10) digits = "7" + digits;
  return digits.length === 11 && digits.startsWith("7") ? digits : "";
}

function splitPhoneEntries(value) {
  return String(value || "")
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
}

function buildPhoneOwnerMap(rows) {
  const map = new Map();
  for (const row of rows) {
    for (const entry of splitPhoneEntries(row["Телефон"])) {
      const normalized = normalizePhoneDigits(entry);
      if (!normalized) continue;
      if (!map.has(normalized)) map.set(normalized, []);
      map.get(normalized).push(row);
    }
  }
  return map;
}

function filterAlreadyInCurrentCell(currentValue, candidateValue) {
  const existing = new Set(
    splitPhoneEntries(currentValue)
      .map(normalizePhoneDigits)
      .filter(Boolean)
  );
  return splitPhoneEntries(candidateValue).filter((entry) => {
    const normalized = normalizePhoneDigits(entry);
    return normalized && !existing.has(normalized);
  });
}

function hasConfirmedPhone(row) {
  return splitPhoneEntries(row?.["Телефон"]).some((entry) => Boolean(normalizePhoneDigits(entry)));
}

function hasConfirmedLeader(row) {
  return Boolean(String(row?.["Руководитель / ЛПР"] || "").trim());
}

function needsGoogleResearch(row) {
  return !hasConfirmedPhone(row) || !hasConfirmedLeader(row);
}

function isPriorityAB(row) {
  const basis = String(row?.["Основание"] || "").trim().toUpperCase();
  return basis.startsWith("A") || basis.startsWith("B");
}

export async function runResearchPipeline({ job, apiKey }) {
  if (!apiKey) throw new Error("OpenAI API key is required");

  const client = new OpenAI({ apiKey });
  const region = String(job.region || job.data?.region || "").trim();
  if (!region) throw new Error("Region is required");

  const statuses = initialStatuses();
  const progress = async (patch = {}) => {
    await job.updateProgress({
      statuses,
      region,
      ...patch
    });
  };

  const assertNotCancelled = async () => {
    if (job.cancelled) throw new Error("JOB_CANCELLED");
  };

  await progress({ phase: "starting", percent: 0 });
  const prompts = await Promise.all(Array.from({ length: 10 }, (_, i) => loadPrompt(i + 1)));
  const parts = [];

  for (let i = 0; i < 9; i++) {
    await assertNotCancelled();
    startStep(statuses[i]);
    statuses[i].detail = "исследование";
    await progress({ phase: "research", step: i + 1, percent: i * 9 });

    const output = normalize(
      await askResearch(
        client,
        prompts[i] +
          contract(false) +
          `\n\nРЕГИОН: ${region}\nВыполни полный поиск именно по этому региону. Web search обязателен.`
      )
    );
    parts.push(output);

    finishStep(statuses[i]);
    statuses[i].detail = `выполнен · ${rowCount(output)} записей`;
    await progress({ phase: "research", step: i + 1, percent: (i + 1) * 9 });
  }

  await assertNotCancelled();
  startStep(statuses[9]);
  const candidatePool = flattenCandidates(parts);
  const canonicalPool = canonicalizeCandidates(candidatePool);
  const batchCount = Math.max(1, Math.ceil(canonicalPool.length / FINAL_BATCH_SIZE));
  const stagedResult = {
    direct_buyers: [],
    intermediaries: [],
    leasing: []
  };

  for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
    await assertNotCancelled();
    const batch = canonicalPool.slice(
      batchIndex * FINAL_BATCH_SIZE,
      (batchIndex + 1) * FINAL_BATCH_SIZE
    );

    statuses[9].detail = `пакет ${batchIndex + 1} / ${batchCount} · ${batch.length} компаний`;
    await progress({
      phase: "dedupe",
      step: 10,
      percent: 82 + Math.floor(((batchIndex + 1) / batchCount) * 5)
    });

    const rawBatchResult = normalize(
      await askWithoutSearch(
        client,
        prompts[9] +
          finalBatchContract() +
          `\n\nРЕГИОН: ${region}
Это пакет CANONICAL-компаний, предварительно собранных программно из всех шагов 1–9.
В evidence каждой canonical-компании находятся ВСЕ исходные строки, которые были безопасно объединены по подтверждённому ИНН либо точному нормализованному названию + городу/району.
Не игнорируй отдельные элементы evidence: факты из разных шагов должны дополнять друг друга.
Не удаляй canonical-компании и обязательно верни каждый "__canonical_id" ровно один раз.
Сохраняй максимум полезной информации из evidence. Новый web_search здесь запрещён; пробелы будут обработаны отдельным точечным проходом.
Глобальная дедупликация между canonical-компаниями будет отдельным QA-вызовом после обработки всех пакетов.

ПАКЕТ CANONICAL-КОМПАНИЙ JSON:
${JSON.stringify(batch)}`,
        FINAL_BATCH_MODEL,
        FINAL_BATCH_MAX_OUTPUT_TOKENS
      )
    );

    const batchResult = ensureBatchCoverage(batch, rawBatchResult);
    stagedResult.direct_buyers.push(...batchResult.direct_buyers);
    stagedResult.intermediaries.push(...batchResult.intermediaries);
    stagedResult.leasing.push(...batchResult.leasing);
  }

  await assertNotCancelled();
  const stagedCompanies = [
    ...stagedResult.direct_buyers,
    ...stagedResult.intermediaries,
    ...stagedResult.leasing
  ];
  let targetedSearches = 0;

  for (const row of stagedCompanies) {
    const gaps = missingResearchFields(row);
    if (!gaps.length) continue;

    await assertNotCancelled();
    targetedSearches++;
    statuses[9].detail = `точечная проверка ${targetedSearches} · ${row["Организация"] || ""}`;
    await progress({ phase: "dedupe", step: 10, percent: 87 });

    const enriched = await askTargetedSearch(
      client,
      prompts[9] +
        targetedSearchContract() +
        `\n\nРЕГИОН: ${region}
КОМПАНИЯ:
${JSON.stringify(row)}
НЕДОСТАЮЩИЕ СВЕДЕНИЯ:
${JSON.stringify(gaps)}
Сделай один точечный web_search только по этой компании. Ищи недостающие сведения и верни аккуратный patch. Не перепроверяй заполненные поля без необходимости.`
    );
    applyTargetedPatch(row, enriched);
  }

  await assertNotCancelled();
  let qaRecords = makeQaRecords(stagedResult);
  const conflictGroups = buildConflictGroups(qaRecords);

  if (conflictGroups.length) {
    statuses[9].detail = `разрешение конфликтов · ${conflictGroups.length} групп`;
    await progress({ phase: "dedupe", step: 10, percent: 88 });

    const conflictQa = await askWithoutSearch(
      client,
      prompts[9] +
        conflictContract() +
        `\n\nКОНФЛИКТНЫЕ ГРУППЫ:
${JSON.stringify(conflictGroups)}`,
      CONFLICT_MODEL,
      FINAL_QA_MAX_OUTPUT_TOKENS
    );

    const conflictResolved = applyFinalQa(qaRecords, conflictQa);
    stagedResult.direct_buyers = conflictResolved.direct_buyers;
    stagedResult.intermediaries = conflictResolved.intermediaries;
    stagedResult.leasing = conflictResolved.leasing;
    qaRecords = makeQaRecords(stagedResult);
  }

  statuses[9].detail = `глобальный QA · ${qaRecords.length} организаций`;
  await progress({ phase: "dedupe", step: 10, percent: 89 });

  const qa = await askWithoutSearch(
    client,
    prompts[9] +
      finalQaContract() +
      `\n\nРЕГИОН: ${region}
Ниже уже обработанные canonical-компании с техническими id и canonical_id.
Выполни глобальную дедупликацию, финальную переклассификацию и QA только по переданным данным.
Строки с "__decision":"exclude" не удаляй механически: проверь основание.
Не переписывай весь массив компаний: верни только remove_ids, moves и patches.
Разные подтверждённые ИНН никогда не объединяй.
Работай без web_search.

КОММЕРЧЕСКИЕ СТРОКИ JSON:
${JSON.stringify(qaRecords)}`,
    FINAL_QA_MODEL,
    FINAL_QA_MAX_OUTPUT_TOKENS
  );

  const finalResult = applyFinalQa(qaRecords, qa);

  statuses[9].detail = "региональная статистика";
  await progress({ phase: "dedupe", step: 10, percent: 89 });

  const statsResult = await askJson(client, {
    input:
      prompts[9] +
      statisticsContract() +
      `\n\nРЕГИОН: ${region}\nСобери только 8 обязательных показателей статистики по региону.`,
    model: TARGETED_SEARCH_MODEL,
    maxOutputTokens: STATISTICS_MAX_OUTPUT_TOKENS,
    webSearch: true
  });
  finalResult.statistics = Array.isArray(statsResult?.statistics) ? statsResult.statistics : [];

  finishStep(statuses[9]);
  statuses[9].detail = `выполнен · ${rowCount(finalResult)} организаций · точечных поисков: ${targetedSearches}`;
  await progress({ phase: "dedupe", step: 10, percent: 90 });

  const companies = [
    ...finalResult.direct_buyers,
    ...finalResult.intermediaries,
    ...finalResult.leasing
  ];
  const phoneOwners = buildPhoneOwnerMap(companies);
  const googleCompanies = companies.filter(needsGoogleResearch);
  const skippedGoogle = companies.length - googleCompanies.length;

  startStep(statuses[10]);
  statuses[10].detail = googleCompanies.length
    ? `0 / ${googleCompanies.length} · пропущено готовых: ${skippedGoogle}`
    : `контакты уже заполнены · пропущено: ${skippedGoogle}`;
  await progress({
    phase: "google_ai",
    step: 11,
    percent: 90,
    contactCurrent: 0,
    contactTotal: googleCompanies.length
  });

  let ok = 0;
  let unavailable = 0;
  let notFound = 0;
  let solRetries = 0;
  let solRecovered = 0;
  let browser;
  let session;

  try {
    if (googleCompanies.length) {
      browser = await launchResearchBrowser();
      session = await createResearchSession(browser);
    }

    for (let i = 0; i < googleCompanies.length; i++) {
      await assertNotCancelled();

      if (i > 0 && i % 90 === 0) {
        if (session) await closeResearchSession(session);
        if (browser) await browser.close().catch(() => {});
        browser = await launchResearchBrowser();
        session = await createResearchSession(browser);
        statuses[10].detail = `${i} / ${googleCompanies.length} · новая сессия поиска`;
        await progress({
          phase: "google_ai",
          step: 11,
          percent: 90 + Math.floor((i / Math.max(1, googleCompanies.length)) * 9),
          contactCurrent: i,
          contactTotal: googleCompanies.length,
          contactCompany: "",
          contactStats: { ok, unavailable, notFound, solRetries, solRecovered }
        });
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      const row = googleCompanies[i];
      statuses[10].detail = `${i} / ${googleCompanies.length} · ${row["Организация"] || ""}`;
      await progress({
        phase: "google_ai",
        step: 11,
        percent: 90 + Math.floor((i / Math.max(1, googleCompanies.length)) * 9),
        contactCurrent: i,
        contactTotal: googleCompanies.length,
        contactCompany: row["Организация"] || ""
      });

      let contact;
      try {
        const needPhone = !hasConfirmedPhone(row);
        const needLeader = !hasConfirmedLeader(row);
        contact = await enrichCompanyWithGoogleAI({
          client,
          session,
          row,
          region,
          needPhone,
          needLeader,
          isCancelled: () => Boolean(job.cancelled)
        });
      } catch (error) {
        contact = {
          status: "unavailable",
          phone: "",
          leader: "",
          note: error?.message || "browser error"
        };
      }

      if (contact.status === "not_found" && GOOGLE_AI_SOL_RETRY_PRIORITY_AB && isPriorityAB(row)) {
        solRetries++;
        statuses[10].detail = `${i + 1} / ${googleCompanies.length} · Sol retry · ${row["Организация"] || ""}`;
        await progress({
          phase: "google_ai",
          step: 11,
          percent: 90 + Math.floor((i / Math.max(1, googleCompanies.length)) * 9),
          contactCurrent: i,
          contactTotal: googleCompanies.length,
          contactCompany: row["Организация"] || "",
          contactStats: { ok, unavailable, notFound, solRetries, solRecovered }
        });

        try {
          const needPhone = !hasConfirmedPhone(row);
          const needLeader = !hasConfirmedLeader(row);
          contact = await enrichCompanyWithGoogleAI({
            client,
            session,
            row,
            region,
            needPhone,
            needLeader,
            forceFallback: true,
            isCancelled: () => Boolean(job.cancelled)
          });
          if (contact.status === "ok") solRecovered++;
        } catch (error) {
          contact = {
            status: "unavailable",
            phone: "",
            leader: "",
            note: error?.message || "Sol retry browser error"
          };
        }
      }

      if (contact.status === "ok") {
        const candidates = filterAlreadyInCurrentCell(row["Телефон"], contact.phone);
        const accepted = [];

        for (const entry of candidates) {
          const normalized = normalizePhoneDigits(entry);
          if (!normalized) continue;

          const owners = phoneOwners.get(normalized) || [];
          const belongsElsewhere = owners.some((owner) => owner !== row);

          if (belongsElsewhere) {
            const verification = await verifyPhoneForCompanyWithGoogleAI({
              client,
              session,
              row,
              region,
              phone: normalized,
              isCancelled: () => Boolean(job.cancelled)
            });
            if (!verification?.confirmed) continue;
          }

          accepted.push(entry);
          if (!phoneOwners.has(normalized)) phoneOwners.set(normalized, []);
          if (!phoneOwners.get(normalized).includes(row)) {
            phoneOwners.get(normalized).push(row);
          }
        }

        if (accepted.length) {
          contact.phone = accepted.join("; ");
          applyContact(row, contact);
          ok++;
        } else if (contact.leader) {
          applyContact(row, { ...contact, phone: "" });
          ok++;
        } else {
          notFound++;
        }
      } else if (contact.status === "not_found") {
        notFound++;
      } else {
        unavailable++;
      }

      statuses[10].detail = `${i + 1} / ${googleCompanies.length} · выполнено`;
      await progress({
        phase: "google_ai",
        step: 11,
        percent: 90 + Math.floor(((i + 1) / Math.max(1, googleCompanies.length)) * 9),
        contactCurrent: i + 1,
        contactTotal: googleCompanies.length,
        contactCompany: row["Организация"] || "",
        contactStats: { ok, unavailable, notFound, solRetries, solRecovered }
      });

      if (i < googleCompanies.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  } finally {
    if (session) await closeResearchSession(session);
    if (browser) await browser.close().catch(() => {});
  }

  finishStep(statuses[10]);
  statuses[10].detail = `выполнен · проверено ${googleCompanies.length}, пропущено ${skippedGoogle}`;
  await progress({
    phase: "completed",
    step: 11,
    percent: 100,
    contactCurrent: googleCompanies.length,
    contactTotal: googleCompanies.length,
    contactStats: { ok, unavailable, notFound, solRetries, solRecovered }
  });

  return {
    result: finalResult,
    region,
    counts: {
      direct_buyers: finalResult.direct_buyers.length,
      intermediaries: finalResult.intermediaries.length,
      leasing: finalResult.leasing.length,
      statistics: finalResult.statistics.length
    },
    contacts: {
      total: companies.length,
      checked: googleCompanies.length,
      skipped: skippedGoogle,
      ok,
      unavailable,
      notFound,
      solRetries,
      solRecovered
    }
  };
}
