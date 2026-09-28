import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { COLS, STAT_COLS, MODEL, STEPS } from "./constants.js";
import { enrichCompanyWithGoogleAI, launchResearchBrowser } from "./googleAiAgent.js";

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
Коммерческие объекты содержат ровно ключи: ${COLS.map((x) => `"${x}"`).join(", ")}.
Статистика содержит ровно ключи: ${STAT_COLS.map((x) => `"${x}"`).join(", ")}.
Не добавляй поле "Источник". Если значения нет — пустая строка.`;
  }

  return `\n\nТЕХНИЧЕСКИЙ ФОРМАТ: верни ТОЛЬКО валидный JSON без markdown:
{"direct_buyers":[],"intermediaries":[],"leasing":[]}.
Каждый объект содержит ровно ключи: ${COLS.map((x) => `"${x}"`).join(", ")}.
Не добавляй поле "Источник". Если значения нет — пустая строка. Не выдумывай данные.`;
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

async function ask(client, input, maxOutputTokens = 50000) {
  const response = await client.responses.create({
    model: MODEL,
    tools: [{ type: "web_search" }],
    tool_choice: "required",
    input,
    max_output_tokens: maxOutputTokens
  });
  if (response.status && response.status !== "completed") {
    throw new Error(`OpenAI response status: ${response.status}`);
  }
  return parseJson(response.output_text || "");
}

function initialStatuses() {
  return STEPS.map((name, index) => ({
    step: index + 1,
    name,
    status: "waiting",
    detail: ""
  }));
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

export async function runResearchPipeline({ job, apiKey }) {
  if (!apiKey) throw new Error("OpenAI API key is required");

  const client = new OpenAI({ apiKey });
  const region = String(job.data.region || "").trim();
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
    statuses[i].status = "running";
    statuses[i].detail = "исследование";
    await progress({ phase: "research", step: i + 1, percent: i * 9 });

    const output = normalize(
      await ask(
        client,
        prompts[i] +
          contract(false) +
          `\n\nРЕГИОН: ${region}\nВыполни полный поиск именно по этому региону. Web search обязателен.`
      )
    );
    parts.push(output);

    statuses[i].status = "done";
    statuses[i].detail = `выполнен · ${rowCount(output)} записей`;
    await progress({ phase: "research", step: i + 1, percent: (i + 1) * 9 });
  }

  await assertNotCancelled();
  statuses[9].status = "running";
  statuses[9].detail = "финальная дедупликация";
  await progress({ phase: "dedupe", step: 10, percent: 82 });

  const finalResult = normalize(
    await ask(
      client,
      prompts[9] +
        contract(true) +
        `\n\nРЕГИОН: ${region}
Ниже единый временный пул результатов шагов 1–9. Считай его эквивалентом входных XLSX.
При необходимости используй web_search для точечной перепроверки.

ВРЕМЕННЫЙ ПУЛ JSON:
${JSON.stringify(parts.map((data, i) => ({ step: i + 1, name: STEPS[i], data })))}`,
      65000
    ),
    true
  );

  statuses[9].status = "done";
  statuses[9].detail = `выполнен · ${rowCount(finalResult)} организаций`;
  await progress({ phase: "dedupe", step: 10, percent: 90 });

  const companies = [
    ...finalResult.direct_buyers,
    ...finalResult.intermediaries,
    ...finalResult.leasing
  ];

  statuses[10].status = "running";
  statuses[10].detail = companies.length ? `0 / ${companies.length}` : "нет компаний";
  await progress({
    phase: "google_ai",
    step: 11,
    percent: 90,
    contactCurrent: 0,
    contactTotal: companies.length
  });

  let ok = 0;
  let unavailable = 0;
  let notFound = 0;
  let browser;

  try {
    if (companies.length) browser = await launchResearchBrowser();

    for (let i = 0; i < companies.length; i++) {
      await assertNotCancelled();
      const row = companies[i];
      statuses[10].detail = `${i} / ${companies.length} · ${row["Организация"] || ""}`;
      await progress({
        phase: "google_ai",
        step: 11,
        percent: 90 + Math.floor((i / Math.max(1, companies.length)) * 9),
        contactCurrent: i,
        contactTotal: companies.length,
        contactCompany: row["Организация"] || ""
      });

      let contact;
      try {
        contact = await enrichCompanyWithGoogleAI({
          client,
          browser,
          row,
          region,
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

      if (contact.status === "ok") {
        ok++;
        applyContact(row, contact);
      } else if (contact.status === "not_found") {
        notFound++;
      } else {
        unavailable++;
      }

      statuses[10].detail = `${i + 1} / ${companies.length} · выполнено`;
      await progress({
        phase: "google_ai",
        step: 11,
        percent: 90 + Math.floor(((i + 1) / Math.max(1, companies.length)) * 9),
        contactCurrent: i + 1,
        contactTotal: companies.length,
        contactCompany: row["Организация"] || "",
        contactStats: { ok, unavailable, notFound }
      });
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  statuses[10].status = "done";
  statuses[10].detail = `выполнен · ${companies.length} компаний`;
  await progress({
    phase: "completed",
    step: 11,
    percent: 100,
    contactCurrent: companies.length,
    contactTotal: companies.length,
    contactStats: { ok, unavailable, notFound }
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
    contacts: { total: companies.length, ok, unavailable, notFound }
  };
}
