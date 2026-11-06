#!/usr/bin/env node
// Compare commercial discovery outcomes without paid calls, hidden repairs,
// or conflating a REVIEW promotion with a newly discovered legal entity.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { validInn } from "./audit-final-result-readonly.js";

const COMMERCIAL=["direct_buyers","intermediaries","leasing"];
const QUEUES=["qualification_review","qualification_excluded"];
const sections=[...COMMERCIAL,...QUEUES];
const str=x=>String(x??"").trim();
const arr=x=>Array.isArray(x)?x:[];
const uniq=x=>[...new Set(x)];
const sha=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
const hasSource=row=>{
  const proof=row?.__evidence?.identity_verification;
  return Boolean(proof &&
    validInn(str(row?.["ИНН"])) &&
    proof.inn===str(row["ИНН"]) &&
    ["identity_web","final_inn_web"].includes(proof.method) &&
    arr(proof.source_urls).some(url=>/^https?:\/\/[^/\s]+\.[^/\s]+/.test(str(url))));
};
const urls=rows=>rows.filter(row=>/^https?:\/\/[^/\s]+\.[^/\s]+/.test(str(row)));

export function summarizeResearchSnapshot(document){
  const d=document?.final_result||document?.result||document;
  if(!d||sections.some(s=>!Array.isArray(d[s])))
    throw new TypeError("Need complete final_result including REVIEW and EXCLUDED arrays");
  const commercial=COMMERCIAL.flatMap(s=>d[s]);
  const queued=QUEUES.flatMap(s=>d[s]);
  const observed=[...commercial,...queued];
  const validCom=commercial.filter(row=>validInn(str(row["ИНН"])));
  const validAll=observed.filter(row=>validInn(str(row["ИНН"])));
  const activeInns=new Set(validCom.map(row=>str(row["ИНН"])));
  const allInns=new Set(validAll.map(row=>str(row["ИНН"])));
  const queueInns=new Set(queued.filter(row=>validInn(str(row["ИНН"])))
    .map(row=>str(row["ИНН"])));
  const sourceConfirmed=new Set(validCom.filter(hasSource).map(row=>str(row["ИНН"])));
  const A=commercial.filter(row=>str(row.__final_grade)==="A");
  const gradeCounts=Object.fromEntries(["A","B","C"].map(grade=>
    [grade,commercial.filter(row=>str(row.__final_grade)===grade).length]));
  return {
    records:{commercial:commercial.length,
      review:d.qualification_review.length,excluded:d.qualification_excluded.length,
      archive:arr(d.manual_quality_archived_snapshots).length},
    sheets:Object.fromEntries(COMMERCIAL.map(s=>[s,d[s].length])),
    grades:gradeCounts,
    in_commercial:{valid_inn_rows:validCom.length,unique_valid_inns:activeInns.size,
      source_attributed_inn_rows:validCom.filter(hasSource).length,
      unique_source_attributed_inns:sourceConfirmed.size,
      missing_or_invalid_inn_rows:commercial.length-validCom.length},
    A:{total:A.length,selected_claim_url:A.filter(row=>urls([
      row?.__evidence?.selected_a_provenance?.source_url]).length>0).length,
      source_rechecked:A.filter(row=>
        row?.__evidence?.selected_a_provenance?.sources_rechecked===true).length},
    identity_inns:{active:uniq([...activeInns]),queued:uniq([...queueInns]),
      all:uniq([...allInns]),source_attributed_active:[...sourceConfirmed]}
  };
}

export function compareResearchSnapshots(before,after) {
  const prior=summarizeResearchSnapshot(before);
  const next=summarizeResearchSnapshot(after);
  const b=prior.identity_inns,n=next.identity_inns;
  const newCommercial=n.active.filter(inn=>!b.all.includes(inn));
  const queuePromotions=n.active.filter(inn=>b.queued.includes(inn)&&!b.active.includes(inn));
  const removedActive=b.active.filter(inn=>!n.active.includes(inn));
  const transferredReview=removedActive.filter(inn=>n.queued.includes(inn));
  return {
    version:1,method:"offline_comparable_inn_identities_not_paid_discovery_proof",
    before:{records:prior.records,sheets:prior.sheets,grades:prior.grades,
      commercial:prior.in_commercial,A:prior.A},
    after:{records:next.records,sheets:next.sheets,grades:next.grades,
      commercial:next.in_commercial,A:next.A},
    delta:{
      commercial_rows:next.records.commercial-prior.records.commercial,
      valid_inn_rows:next.in_commercial.valid_inn_rows-prior.in_commercial.valid_inn_rows,
      new_valid_inns_in_sales_not_in_any_previous_queue:newCommercial.length,
      new_valid_inns:newCommercial,
      promoted_from_review_or_excluded_without_new_identity:queuePromotions.length,
      moved_from_sales_to_review_or_excluded:transferredReview.length,
      no_longer_commercial_valid_inns:removedActive.length,
      known_inn_identity_retention: b.active.length
        ?(b.active.length-removedActive.length)/b.active.length:null,
      A_grade_change:next.grades.A-prior.grades.A
    },
    caveats:[
      "An INN checksum is not independent proof of the named legal identity.",
      "No-INN names are not counted as newly discovered legal entities.",
      "This comparison does not prove paid discovery recall or API savings.",
      "Movements between REVIEW and sales are not new company discoveries.",
      "Paid cost and web-search usage must come from run logs, not these JSONs."
    ]
  };
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const files=process.argv.slice(2).filter(s=>!s.startsWith("--"));
  const output=process.argv.slice(2).find(s=>s.startsWith("--out="))?.slice(6);
  if(files.length!==2){console.error("Usage: node scripts/compare-research-runs-offline.js baseline.json candidate.json [--out=NEW.json]");process.exit(2);}
  const raw=files.map(file=>fs.readFileSync(file));
  const report=compareResearchSnapshots(...raw.map(bytes=>JSON.parse(bytes)));
  report.inputs=files.map((file,i)=>({path:file,sha256:sha(raw[i])}));
  if(output)fs.writeFileSync(output,JSON.stringify(report,null,2),{flag:"wx"});
  else console.log(JSON.stringify(report,null,2));
}
