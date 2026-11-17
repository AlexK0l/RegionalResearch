#!/usr/bin/env node
// Re-run Stage 13 on a saved final JSON/checkpoint; no OpenAI/Saby/SQLite or network.
import fs from "node:fs/promises";
import OpenAI from "openai";
import path from "node:path";
import {buildReferenceWorkbookBuffer} from "../src/referenceWorkbookExport.js";
import {applyPriorityStage13,calculatePriority13,priority13AICandidates} from "../src/priorityStage13.js";
import {classifyStage13UnknownModels} from "../src/priorityStage13AI.js";

const option=(args,name)=>{
  const arg=args.find(x=>x.startsWith("--"+name+"="));
  return arg?arg.slice(name.length+3):"";
};
const args=process.argv.slice(2);
async function main(){
  if(args.includes("--help")){
    console.log("Stage 13: --result=FINAL.json [--preview|--preview-ai-candidates] [--out-prefix=exports/stage13-region] [--with-openai]");
    return;
  }
  const input=option(args,"result"),prefix=option(args,"out-prefix");
  if(!input)throw new Error("Provide --result=FINAL.json");
  const preview=args.includes("--preview")||args.includes("--preview-ai-candidates");
  if(preview&&args.includes("--with-openai"))
    throw new Error("preview modes are offline; use --with-openai with a new --out-prefix");
  if(!prefix&&!preview)throw new Error("Provide --out-prefix or --preview");
  const original=JSON.parse(await fs.readFile(path.resolve(input),"utf8"));
  if(original.final_result&&original.phase&&original.phase!=="completed")
    throw new Error("Only a completed checkpoint can be recalculated");
  const payload=structuredClone(original);
  const result=payload.final_result&&typeof payload.final_result==="object"
    ?payload.final_result:payload;
  if(!["direct_buyers","intermediaries","leasing","statistics"]
      .every(key=>Array.isArray(result[key])))
    throw new Error("Stage 13 requires a completed four-array final result");
  if(args.includes("--preview-ai-candidates")){
    const sample=[],bySource={TORGBOX:0,evidence:0};
    let companies=0,identified=0;
    for(const row of result.direct_buyers){
      const candidates=priority13AICandidates(row);
      if(!candidates.length)continue;
      companies++;
      for(const candidate of candidates){
        identified++;
        bySource[candidate.source]=(bySource[candidate.source]||0)+1;
        if(sample.length<25)sample.push({
          buyer:row["Организация"],model_text:candidate.model_text,
          source:candidate.source,source_url:candidate.source_url||""
        });
      }
    }
    console.log(JSON.stringify({
      mode:"preview-ai-candidates",buyers:result.direct_buyers.length,
      candidate_rows:companies,candidate_mentions:identified,bySource,
      firstCandidates:sample,openai_calls:0,network_calls:0,
      original_unchanged:true
    },null,2));
    return;
  }
  if(args.includes("--preview")){
    const stats={buyers:0,changedScores:0,
      tiers:{none:0,ordinary:0,white:0,green:0},rowsWithWarnings:0,
      firstChanges:[],firstWarnings:[]};
    for(const [index,row] of result.direct_buyers.entries()){
      if(!String(row["Организация"]||"").trim())continue;
      const v=calculatePriority13({c:row["Наличие транспорта"]||"",
        d:row["Основание"],revenue:row["Выручка последнего подтвержденного года"],
        staff:row["Численность"],notes:row.__evidence?.notes||[]});
      stats.buyers++;stats.tiers[v.tier]++;
      if(row["Итоговый коэффициент"]!==v.score){
        stats.changedScores++;
        if(stats.firstChanges.length<25)stats.firstChanges.push({
          row:index+2,buyer:row["Организация"],
          previous:row["Итоговый коэффициент"]??null,
          calculated:v.score,tier:v.tier,models:v.models
        });
      }
      if(v.warnings.length){
        stats.rowsWithWarnings++;
        if(stats.firstWarnings.length<15)stats.firstWarnings.push({
          row:index+2,buyer:row["Организация"],warnings:v.warnings
        });
      }
    }
    console.log(JSON.stringify({...stats,preview_only:true,source_unchanged:true},null,2));
    return;
  }
  // Explicit --with-openai is the ONLY way this replay command may incur a
  // model charge. The normal replay and preview stay 100% network-free.
  let aiStats=null;
  if(args.includes("--with-openai")){
    if(!process.env.OPENAI_API_KEY)throw new Error("--with-openai requires OPENAI_API_KEY");
    const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
    aiStats=await classifyStage13UnknownModels(result,{client,env:process.env});
  }
  const summary=applyPriorityStage13(result,{aiStats});
  if(aiStats)payload.priority_ai_stats=aiStats;
  if(payload!==result)payload.priority_stats=summary;
  const base=path.resolve(prefix),xlsx=base+".xlsx",json=base+".json";
  await fs.mkdir(path.dirname(base),{recursive:true,mode:0o700});
  // Prevent accidental overwrite even before running the exporter.
  for(const p of [xlsx,json]){
    try{await fs.access(p);throw new Error("Output already exists: "+p);}
    catch(error){if(error.code!=="ENOENT")throw error;}
  }
  const bytes=await buildReferenceWorkbookBuffer(result);
  await fs.writeFile(xlsx,bytes,{flag:"wx",mode:0o600});
  await fs.writeFile(json,JSON.stringify(payload,null,2)+"\n",{flag:"wx",mode:0o600});
  console.log(JSON.stringify({...summary,files:{xlsx,json},
    original_unchanged:true,sqlite_writes:0},null,2));
}
main().catch(e=>{console.error("Stage 13: "+String(e.message||e));process.exitCode=1;});
