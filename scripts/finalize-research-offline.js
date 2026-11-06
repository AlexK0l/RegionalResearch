#!/usr/bin/env node
// Rehearse the EXACT production completion gate against a saved full checkpoint
// or final_result JSON. All inputs remain unchanged and no API is initialized.
import fs from "node:fs";
import path from "node:path";
import { loadOfflineCheckpointInput } from "../src/offlineCheckpointInput.js";
import { finalizeProductionResearch } from "../src/productionFinalQuality.js";
import { deterministicQualificationDecision, actionableUnqualifiedLead } from "../src/pipeline.js";
import { buildWorkbookBuffer } from "../src/xlsx.js";

const args=process.argv.slice(2),input=args.find(x=>!x.startsWith("--"));
const opt=k=>args.find(x=>x.startsWith("--"+k+"="))?.slice(k.length+3);
const out=opt("out");
if(!input||!out){
 console.error("Usage: node scripts/finalize-research-offline.js <checkpoint.sqlite|checkpoint.json> --out=<NEW-directory> [--job-id=ID] [--region=REGION]");
 process.exit(2);
}
const sourcePath=path.resolve(input);
const { parsed, inputKind, payloadSha256 } = loadOfflineCheckpointInput(sourcePath, {
  jobId:opt("job-id")||"", region:opt("region")||""
});
const finalResult=parsed.final_result || parsed.result;
if(!finalResult||!Array.isArray(finalResult.direct_buyers))
 throw Error("A full final_result (with company evidence) is required, not a compact replay");
if(parsed.phase && !["completed","contacts","statistics","enrichment","final_inn"].includes(parsed.phase))
 throw Error("Checkpoint predates final INN and qualification; cannot finalize incomplete discovery");
const {result,report}=finalizeProductionResearch(finalResult,{
 qualify:deterministicQualificationDecision,isActionable:actionableUnqualifiedLead
});
const dir=path.resolve(out);
fs.mkdirSync(dir,{recursive:true});
const prefix="RegionalResearch_final_quality_"+String(parsed.checkpoint_id||parsed.id||"offline").slice(0,20)
  .replace(/[^a-zA-Z0-9_-]/g,"_");
const paths={
 json:path.join(dir,prefix+".json"),
 xlsx:path.join(dir,prefix+".xlsx"),
 audit:path.join(dir,prefix+"_audit.json")
};
if(Object.values(paths).some(fs.existsSync))throw Error("Output already exists; choose a NEW --out");
const inputHash=payloadSha256;
const files=[
 [paths.json,Buffer.from(JSON.stringify({...parsed,final_result:result,final_quality_gate:report},null,2))],
 [paths.xlsx,buildWorkbookBuffer(result)],
 [paths.audit,Buffer.from(JSON.stringify({
  source_file:sourcePath,source_sha256:inputHash,
  source_hash_scope:inputKind==="sqlite"?"selected_sqlite_payload":"json_file",
  source_checkpoint_id:parsed.checkpoint_id||null,
  final_quality_gate:report,source_untouched:true,paid_api_calls:0
 },null,2))]
];
const done=[];
try {
 for(const [file,bytes] of files) {fs.writeFileSync(file,bytes,{flag:"wx"});done.push(file);}
}catch(error){for(const file of done)try{fs.unlinkSync(file)}catch{}throw error;}
console.log(JSON.stringify({report,outputs:paths},null,2));
