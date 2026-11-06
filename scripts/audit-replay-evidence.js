#!/usr/bin/env node
// Offline replay JSON audit. No network, no DB writes, no API calls.
import fs from "node:fs";
import path from "node:path";
import { auditReplayEvidence } from "../src/evidenceAudit.js";
const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("Usage: node scripts/audit-replay-evidence.js <replay.json> <new-output.json>");
  process.exit(2);
}
const report = auditReplayEvidence(JSON.parse(fs.readFileSync(path.resolve(input),"utf8")));
fs.writeFileSync(path.resolve(output), JSON.stringify(report,null,2), {flag:"wx"});
console.log(JSON.stringify(report.summary,null,2));
