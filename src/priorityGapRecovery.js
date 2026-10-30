// Strict, attributable gap recovery for verified A/B legal entities.
// Never infer a value from a similar company or replace an already filled field.
export const PRIORITY_FACT_FIELDS = Object.freeze([
  "Руководитель / ЛПР",
  "Выручка последнего подтвержденного года",
  "Численность"
]);

function normalized(value) {
  return String(value ?? "").toLowerCase().replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/giu, " ").replace(/\s+/g, " ").trim();
}
function digits(value) {
  return String(value ?? "").replace(/\D/g, "");
}
function isFilled(row, field) {
  const value = row?.[field];
  if (value === undefined || value === null) return false;
  const s = String(value).trim();
  if (!s || /^(?:н\/д|не найдено|не подтверждено|нет данных|нет сведений|unknown|—|-)$/i.test(s)) return false;
  if (field === "Численность") return Number(s.replace(/\s/g, "")) > 0;
  if (field === "Выручка последнего подтвержденного года") return Number(s.replace(/\s/g, "")) > 0;
  return true;
}

export function priorityRecoveryGaps(row) {
  if (!["A", "B"].includes(String(row?.__final_grade || ""))) return [];
  if (!/^(?:\d{10}|\d{12})$/.test(String(row?.["ИНН"] || ""))) return [];
  return PRIORITY_FACT_FIELDS.filter((field) => !isFilled(row, field));
}

export function eligiblePriorityRecoveryRows(rows, completed, idOf, maximum = 60) {
  const done = new Set([...completed].map(String));
  const limit = Math.max(0, Math.min(600, Number(maximum) || 0));
  const candidates = (rows || []).filter((row) => {
    const id = String(idOf(row) || "");
    return Boolean(id) && !done.has(id) && priorityRecoveryGaps(row).length > 0;
  });
  const byUrgency = (a, b) =>
    priorityRecoveryGaps(b).length - priorityRecoveryGaps(a).length ||
    String(a["Организация"] || "").localeCompare(String(b["Организация"] || ""), "ru");
  const gradeA = candidates.filter((row) => row.__final_grade === "A").sort(byUrgency);
  const gradeB = candidates.filter((row) => row.__final_grade === "B").sort(byUrgency);
  // Reserve roughly 1/3 of the limited searches for B: otherwise the first
  // 60 entries could all be A and important B buyers never get checked.
  const reservedB = Math.min(Math.floor(limit / 3), gradeB.length);
  const firstA = gradeA.slice(0, limit - reservedB);
  const firstB = gradeB.slice(0, reservedB);
  const restA = gradeA.slice(firstA.length);
  const restB = gradeB.slice(firstB.length);
  return [...firstA, ...firstB, ...restA, ...restB].slice(0, limit);
}

export function validPriorityBatchItem(item, row, expectedId) {
  if (!item || typeof item !== "object") return false;
  if (String(item.id || "") !== String(expectedId || "")) return false;
  const inn = digits(row?.["ИНН"]);
  if (!inn || digits(item.inn) !== inn) return false;
  if (!normalized(item.organization) ||
      normalized(item.organization) !== normalized(row?.["Организация"])) return false;
  return Array.isArray(item.facts);
}

function validatedFact(fact, row) {
  if (!fact || !PRIORITY_FACT_FIELDS.includes(fact.field)) return null;
  const field = fact.field;
  if (isFilled(row, field)) return null;
  const value = String(fact.value ?? "").trim();
  const excerpt = String(fact.evidence_excerpt ?? "").trim();
  const source = String(fact.source_url ?? "").trim();
  if (!value || !excerpt || excerpt.length > 2400) return null;
  try {
    const u = new URL(source);
    if (u.protocol !== "https:" || !u.hostname.includes(".")) return null;
  } catch { return null; }
  const inn = digits(row?.["ИНН"]);
  // The quoted page must LABEL the company's INN: a random 10-digit
  // substring, URL number or unrelated company is not proof.
  if (!inn || !new RegExp("инн\\D{0,12}" + inn + "(?!\\d)", "i").test(excerpt)) return null;
  if (field === "Руководитель / ЛПР") {
    const person = normalized(value);
    if (person.length < 5 || /\d/.test(person) ||
        /^(?:не\s+найден|не\s+установ|руководитель|нет\s+данных)/.test(person)) return null;
    const surname = person.split(" ").find((word) => word.length >= 4);
    if (!surname || !normalized(excerpt).includes(surname)) return null;
    return { field, value, source_url: source, evidence_excerpt: excerpt, year: "" };
  }
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  if (field === "Численность" && number > 5000000) return null;
  if (field === "Выручка последнего подтвержденного года" && number > 1000000000000000) return null;
  // A number embedded in an INN, another amount or a longer ID is not
  // evidence of the specific revenue/headcount claim.
  if (!new RegExp("(?:^|\\D)" + value + "(?=\\D|$)").test(excerpt)) return null;
  const year = String(fact.year || "").trim();
  if (field === "Выручка последнего подтвержденного года") {
    const n = Number(year);
    if (!/^\d{4}$/.test(year) || n < 2015 || n > new Date().getUTCFullYear()) return null;
    if (!excerpt.includes(year)) return null;
  }
  return { field, value: number, source_url: source, evidence_excerpt: excerpt, year };
}

export function applyPriorityRecoveryItem(row, item, expectedId) {
  if (!validPriorityBatchItem(item, row, expectedId)) return { researched: false, applied: [] };
  const applied = [];
  for (const fact of item.facts) {
    const checked = validatedFact(fact, row);
    if (!checked) continue;
    row[checked.field] = checked.value;
    applied.push(checked);
  }
  if (applied.length) {
    const prev = row.__evidence || {};
    row.__evidence = {
      ...prev,
      source_urls: [...new Set([
        ...(Array.isArray(prev.source_urls) ? prev.source_urls : []),
        ...applied.map((x) => x.source_url)
      ])],
      priority_recovery_facts: [
        ...(Array.isArray(prev.priority_recovery_facts) ? prev.priority_recovery_facts : []),
        ...applied.map((x) => ({ ...x, inn: String(row["ИНН"]), checked_at: new Date().toISOString() }))
      ]
    };
  }
  // A complete empty facts array is still a genuinely researched response.
  return { researched: true, applied };
}
