#!/usr/bin/env node
// Offline diagnostics from a saved job log and optional SAT workbook.
// NO OpenAI or network calls. Discovery samples may not equal final canonical
// evidence; therefore B/C discrepancies are review candidates, not a score.
import fs from "node:fs";
import XLSX from "xlsx";
import { independentBSignals } from "../src/researchQuality.js";

const [logPath, xlsxPath] = process.argv.slice(2);
if (!logPath) {
  console.error("Usage: npm run replay:qualification -- <logs/jobs/run.log> [SAT.xlsx]");
  process.exit(2);
}

const samples = new Map();
const counts = {
  batchRequests: 0, batchWebSearches: 0, batchItemsRequested: 0, batchItemsReturned: 0,
  standaloneEnrichmentRequests: 0, standaloneEnrichmentWebSearches: 0
};
const norm = (v) => String(v || "").toLowerCase().replace(/ё/g, "е")
  .replace(/[^a-zа-я0-9]+/g, " ").trim().replace(/\s+/g, " ");
const log = fs.readFileSync(logPath, "utf8");
for (const line of log.split(/\r?\n/)) {
  const match = line.match(/\[(OPENAI_DIAG|ENRICHMENT_BATCH_RESULT|DISCOVERY_SCOPE_COMPANIES_SAMPLE|DISCOVERY_BRANCH_COMPANIES_SAMPLE|DISCOVERY_STAGE_COMPANIES_SAMPLE)\]\s+(\{.+\})$/);
  if (!match) continue;
  let data;
  try { data = JSON.parse(match[2]); } catch { continue; }
  if (match[1] === "OPENAI_DIAG") {
    const label = String(data.query || "");
    const web = Number(data.tool_calls?.web_search_call || 0);
    if (label.startsWith("enrichment batch")) {
      counts.batchRequests++;
      counts.batchWebSearches += web;
    } else if (label.startsWith("ТОЧЕЧНОЕ ОБОГАЩЕНИЕ ОДНОЙ КОМПАНИИ")) {
      counts.standaloneEnrichmentRequests++;
      counts.standaloneEnrichmentWebSearches += web;
    }
    continue;
  }
  if (match[1] === "ENRICHMENT_BATCH_RESULT") {
    counts.batchItemsRequested += Number(data.requested || 0);
    counts.batchItemsReturned += Number(data.returned || 0);
    continue;
  }
  for (const item of Array.isArray(data.sample) ? data.sample : []) {
    const key = norm(item.organization);
    if (!key) continue;
    if (!samples.has(key)) samples.set(key, {
      organization: String(item.organization), sheet: String(item.sheet || ""),
      __evidence: { notes: [], source_urls: [] }
    });
    const r = samples.get(key);
    for (const note of Array.isArray(item.evidence?.notes) ? item.evidence.notes : []) {
      if (note && !r.__evidence.notes.includes(note)) r.__evidence.notes.push(note);
    }
    for (const url of Array.isArray(item.evidence?.source_urls) ? item.evidence.source_urls : []) {
      if (url && !r.__evidence.source_urls.includes(url)) r.__evidence.source_urls.push(url);
    }
  }
}

const report = {
  input: { log: logPath, workbook: xlsxPath || null },
  costReplay: {
    ...counts,
    observedBatchPlusStandaloneWeb: counts.batchWebSearches + counts.standaloneEnrichmentWebSearches,
    completeBatchResponses: counts.batchItemsRequested === counts.batchItemsReturned,
    plannedBatchToolCallsAtDefaultLimit2: counts.batchRequests * 2,
    note: "A planning scenario, NOT actual new API usage or a guaranteed billing ceiling."
  },
  evidenceReplay: {
    sampledUniqueOrganizations: samples.size,
    sourcedSampleRows: [...samples.values()].filter((r) => r.__evidence.source_urls.length).length,
    bEvidenceValid: [...samples.values()].filter((r) => independentBSignals(r).valid).length
  }
};

if (xlsxPath) {
  const workbook = XLSX.readFile(xlsxPath);
  const output = { matchedSampleRows: 0, cWithIndependentBSignals: [], bWithoutIndependentBSignals: [] };
  for (const sheet of ["Прямые покупатели", "Посредники", "Лизинг"]) {
    const ws = workbook.Sheets[sheet];
    if (!ws) continue;
    for (const item of XLSX.utils.sheet_to_json(ws, { defval: "" })) {
      const candidate = samples.get(norm(item["Организация"]));
      if (!candidate) continue;
      const grade = String(item["Основание"] || "").trim().match(/^[ABC]/i)?.[0]?.toUpperCase() || "";
      output.matchedSampleRows++;
      const evidence = independentBSignals(candidate);
      const entry = {
        organization: item["Организация"], sheet, oldGrade: grade,
        proof: evidence.valid ? { cargo: evidence.cargo, transport: evidence.transport } : null
      };
      if (grade === "C" && evidence.valid) output.cWithIndependentBSignals.push(entry);
      if (grade === "B" && !evidence.valid) output.bWithoutIndependentBSignals.push(entry);
    }
  }
  report.evidenceReplay.workbook = {
    matchedSampleRows: output.matchedSampleRows,
    cWithIndependentBSignals: output.cWithIndependentBSignals.length,
    bWithoutIndependentBSignals: output.bWithoutIndependentBSignals.length,
    cReviewExamples: output.cWithIndependentBSignals.slice(0, 30),
    bReviewExamples: output.bWithoutIndependentBSignals.slice(0, 30),
    note: "Matches from discovery samples only; final qualification may rely on additional deduplicated evidence."
  };
}
console.log(JSON.stringify(report, null, 2));
