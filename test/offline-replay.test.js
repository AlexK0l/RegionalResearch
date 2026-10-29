import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

test("saved research diagnostics can be replayed offline without OpenAI", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "regionalresearch-replay-"));
  try {
    const file = path.join(dir, "saved.log");
    const rows = [
      ["OPENAI_DIAG", {
        query: "enrichment batch | 3 companies",
        tool_calls: { web_search_call: 4 }
      }],
      ["OPENAI_DIAG", {
        query: "ТОЧЕЧНОЕ ОБОГАЩЕНИЕ ОДНОЙ КОМПАНИИ — верни ТОЛЬКО JSON",
        tool_calls: { web_search_call: 2 }
      }],
      ["ENRICHMENT_BATCH_RESULT", { requested: 3, returned: 3 }],
      ["DISCOVERY_SCOPE_COMPANIES_SAMPLE", {
        sample: [{
          organization: "ООО Тест Карьер",
          sheet: "direct_buyers",
          evidence: {
            source_urls: ["https://example.org/quarry"],
            notes: ["Компания производит щебень.", "Компания эксплуатирует собственные самосвалы."]
          }
        }]
      }]
    ];
    writeFileSync(file, rows.map(([kind, payload]) =>
      "2026-10-28T12:00:00Z [LOG] [" + kind + "] " + JSON.stringify(payload)
    ).join("\n"), "utf8");
    const output = execFileSync(
      process.execPath,
      [new URL("../scripts/replay-qualification-offline.js", import.meta.url).pathname, file],
      { encoding: "utf8" }
    );
    const data = JSON.parse(output);
    assert.equal(data.costReplay.batchRequests, 1);
    assert.equal(data.costReplay.batchWebSearches, 4);
    assert.equal(data.costReplay.standaloneEnrichmentRequests, 1);
    assert.equal(data.costReplay.observedBatchPlusStandaloneWeb, 6);
    assert.equal(data.costReplay.completeBatchResponses, true);
    assert.equal(data.evidenceReplay.bEvidenceValid, 1);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
