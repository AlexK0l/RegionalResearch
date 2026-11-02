// Temporary public-code-only offline bundle (no customer data, no API calls).
import fs from "node:fs";
import { finalizeProductionResearch } from "../src/productionFinalQuality.js";
import { deterministicQualificationDecision, actionableUnqualifiedLead } from "../src/pipeline.js";
const [inputPath,outputPath,auditPath]=process.argv.slice(2);
if (!inputPath || !outputPath || !auditPath) throw Error("Usage: node offline-gate.mjs input.json full-output.json audit.json");
const source=JSON.parse(fs.readFileSync(inputPath,"utf8"));
const final=source.final_result || source.result;
if(!final || !Array.isArray(final.direct_buyers)) throw Error("Full source final_result required");
const {result,report}=finalizeProductionResearch(final,{
  qualify:deterministicQualificationDecision,
  isActionable:actionableUnqualifiedLead
});
fs.writeFileSync(outputPath,JSON.stringify({...source,final_result:result,final_quality_gate:report},null,2));
fs.writeFileSync(auditPath,JSON.stringify(report,null,2));
console.log(JSON.stringify({version:report.version,original:report.original_row_count,
  current:report.active_commercial_records,grades:report.grades,review:report.review_records,
  excluded:report.excluded_records,transitions:report.transitions.length,
  archivedReview:report.historical_review_records_preserved}));
