#!/usr/bin/env node
// Free finalization of an already PAID Stage13 v5 result: never starts Saby,
// OpenAI, web_search or an earlier research stage. Source files are immutable.
// Replays existing high-confidence classification from __priority13_ai,
// restores only conservatively matched company-website provenance, adjusts
// documented business channels, persists email fields and exports five sheets.
import fs from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {applyPriorityStage13} from "../src/priorityStage13.js";
import {stage13SourceAudit,stage13DiffAudit} from "../src/priorityStage13FullAudit.js";
import {finalizeStage13CommercialOutput} from "../src/priorityStage13Finalize.js";
import {buildReferenceWorkbookBuffer} from "../src/referenceWorkbookExport.js";

const args=process.argv.slice(2);
const option=name=>args.find(a=>a.startsWith("--"+name+"="))?.slice(name.length+3)||"";
const fail=message=>{throw Error("Stage13 free finalize: "+message)};
async function main(){
  const input=option("result"),output=option("out-prefix"),oldAudit=option("audit");
  if(args.some(x=>x.startsWith("--")&&
     !["--result=","--out-prefix=","--audit="].some(p=>x.startsWith(p))))
    fail("Only --result, --out-prefix and optional --audit are accepted; no paid flags");
  if(!input||!output)fail("Provide --result and a NEW --out-prefix");
  const absoluteInput=path.resolve(input),source=await fs.readFile(absoluteInput);
  const payload=JSON.parse(source.toString("utf8"));
  if(payload.phase!=="completed"||!payload.final_result||
     !Array.isArray(payload.final_result.direct_buyers)||
     !Array.isArray(payload.final_result.leasing)||
     !Array.isArray(payload.final_result.intermediaries)||
     !Array.isArray(payload.final_result.statistics))
    fail("Need a completed Stage13 checkpoint with four final arrays");
  const result=payload.final_result,initialCount=result.direct_buyers.length;
  const aiHistory=payload.priority_ai_stats;
  if(!aiHistory||aiHistory.deferred!==0||aiHistory.stopped_reason)
    fail("Stage13 AI classification must already be completed; no API calls will be made");
  const savedModelRows=result.direct_buyers.filter(r=>
    Array.isArray(r?.__priority13_ai?.results)).length;
  if(savedModelRows===0)fail("No saved model classification results");
  const base=path.resolve(output),files={
    xlsx:base+".xlsx",json:base+".json",audit:base+"_audit.json"
  };
  if([files.xlsx,files.json,files.audit].includes(absoluteInput))
    fail("Source and destination must differ");
  await fs.mkdir(path.dirname(base),{recursive:true,mode:0o700});
  for(const target of Object.values(files)){
    try{await fs.access(target);fail("File already exists: "+target)}
    catch(error){if(error.code!=="ENOENT")throw error}
  }
  const before=structuredClone(result);
  const selection=stage13SourceAudit(result,{maxPerBuyer:50,batchSize:12,maxCalls:20});
  if(selection.models_skipped_due_to_limit)
    fail("Inventory truncated; do not finalize silently");
  if(selection.candidates>aiHistory.classified+Number(aiHistory.cached||0))
    fail("Inventory has new unclassified models; cannot claim a free complete replay");
  const score=applyPriorityStage13(result);
  let priorAudit=null;
  if(oldAudit){
    priorAudit=JSON.parse(await fs.readFile(path.resolve(oldAudit),"utf8"));
    if(priorAudit.complete!==true||priorAudit.input_buyers!==initialCount)
      fail("Supplied original audit does not match a completed full Stage13");
  }
  const audit=stage13DiffAudit(before,result,aiHistory,priorAudit?.usage||{},selection);
  if(!audit.unchanged_source_fields)
    fail("Unexpected changes before commercial routing: "+
      JSON.stringify(audit.unexpected_differences.slice(0,4)));
  if(!audit.complete)fail("Saved AI results no longer cover all identified models");
  const commercial=finalizeStage13CommercialOutput(result);
  const preserved=Object.values(commercial.roles.final).reduce((s,x)=>s+x,0);
  if(preserved+commercial.roles.deduplicated_count!==
     before.direct_buyers.length+before.intermediaries.length+before.leasing.length)
    fail("Company records not conserved during commercial routing");
  score.commercial_postprocess=commercial;
  score.ai_calls_reused=aiHistory.calls;
  score.openai_calls=0;score.network_calls=0;
  payload.priority_stats=score;
  payload.stage13_postprocessing={
    version:1,mode:"offline_reuse_saved_ai",source:path.basename(absoluteInput),
    source_sha256:createHash("sha256").update(source).digest("hex"),
    api_calls_new:0,saby_calls_new:0,web_search_calls_new:0,
    reused_ai_classification_rows:savedModelRows,commercial};
  audit.commercial_postprocess=commercial;
  audit.delivered_counts=commercial.roles.final;
  audit.score_audit_scope="Original direct buyers before commercial-role transfers";
  audit.initial_buyers=initialCount;
  audit.new_api_calls=0;
  audit.reused_prior_api_calls=aiHistory.calls;
  audit.prior_token_charges_usd=priorAudit?.usage?.estimated_token_cost_usd??null;
  audit.source_sha256=payload.stage13_postprocessing.source_sha256;
  const workbook=await buildReferenceWorkbookBuffer(result);
  await fs.writeFile(files.xlsx,workbook,{flag:"wx",mode:0o600});
  await fs.writeFile(files.json,JSON.stringify(payload,null,2)+"\n",
    {flag:"wx",mode:0o600});
  await fs.writeFile(files.audit,JSON.stringify(audit,null,2)+"\n",
    {flag:"wx",mode:0o600});
  console.log(JSON.stringify({
    version:"stage13-postprocess-v1",
    source:input,source_unchanged:true,
    examined_buyers:initialCount,saved_ai_model_rows:savedModelRows,
    corrected_scores:audit.changed_buyers.map(x=>({
      buyer:x.buyer,from:x.score_before,to:x.score_after})),
    model_inventory_complete:audit.complete,
    commercial_routing:commercial.roles,
    emails:commercial.emails,
    new_openai_calls:0,new_saby_calls:0,new_web_search_calls:0,
    prior_token_charges_usd:audit.prior_token_charges_usd,
    files
  },null,2));
}
main().catch(err=>{console.error(err.stack||String(err));process.exitCode=1});
