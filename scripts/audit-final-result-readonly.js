#!/usr/bin/env node
// Deterministic read-only audit of an existing regional research export.
// No API, browser, network, checkpoint or live database is opened.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const COMMERCIAL=["direct_buyers","intermediaries","leasing"];
const SECTIONS=[...COMMERCIAL,"qualification_review","qualification_excluded"];
const str=x=>String(x??"").trim();
const isUrl=x=>{
  try {const u=new URL(str(x));return ["http:","https:"].includes(u.protocol)&&u.hostname.includes(".");}
  catch{return false;}
};
const normalize=x=>str(x).toLowerCase().replace(/ё/g,"е");

export function validInn(raw) {
  const inn=str(raw);
  if(!/^(?:\d{10}|\d{12})$/.test(inn))return false;
  const digits=[...inn].map(Number);
  const check=(index,weights)=>weights.reduce((sum,w,i)=>sum+w*digits[i],0)%11%10===digits[index];
  return inn.length===10
    ?check(9,[2,4,10,3,5,9,4,6,8])
    :check(10,[7,2,4,10,3,5,9,4,6,8])&&check(11,[3,7,2,4,10,3,5,9,4,6,8]);
}

export function isGenericSource(raw){
  try{
    const url=new URL(str(raw)),host=url.hostname.toLowerCase(),p=url.pathname.toLowerCase();
    return (/(?:^|\.)hh\.ru$/.test(host)&&p.startsWith("/vacancies/"))||
      (/(?:^|\.)b2b-center\.ru$/.test(host)&&p.startsWith("/search/"))||
      (/(?:^|\.)samosval\.info$/.test(host)&&p.includes("/doska-obyavleniy/trebuyutsya-samosvaly-i-tonary/"))||
      (/(?:^|\.)jobcareer\.ru$/.test(host)&&p.startsWith("/jobs/"))||
      (/(?:^|\.)jobrun\.ru$/.test(host)&&!(/\/vacancy\/\d+/.test(p)));
  }catch{return false;}
}

/** @param {object} document - raw final_result or a complete JSON export */
export function auditFinalResult(document){
  const data=document?.final_result||document?.result||document;
  if(!data||SECTIONS.some(section=>!Array.isArray(data[section])))
    throw new TypeError("Need three commercial arrays, qualification_review and qualification_excluded");
  const rows=SECTIONS.flatMap(section=>data[section].map(row=>({section,row})));
  const commercial=COMMERCIAL.flatMap(section=>data[section].map(row=>({section,row})));
  const issues=[],warnings=[],idOwners=new Map(),innOwners=new Map();
  const missing={active:0,review:0,excluded:0};
  const grades={A:0,B:0,C:0,other:0};
  const missingPriority=[],unlinkedA=[],unverifiedA=[],genericA=[];

  for(const {section,row} of rows){
    const id=str(row?.__canonical_id),name=str(row?.["Организация"]),inn=str(row?.["ИНН"]);
    const active=COMMERCIAL.includes(section);
    if(!id)issues.push({kind:"missing_id",section,name});
    else{
      if(!idOwners.has(id))idOwners.set(id,[]);
      idOwners.get(id).push({section,name,inn});
    }
    if(!inn)missing[active?"active":section==="qualification_review"?"review":"excluded"]++;
    if(inn&&!validInn(inn)){
      const problem={kind:"invalid_inn",id,name,section,inn};
      if(active)issues.push(problem);
      else warnings.push({...problem,kind:"queue_unverified_inn_or_placeholder"});
    }
    if(active&&validInn(inn)){
      if(!innOwners.has(inn))innOwners.set(inn,[]);
      innOwners.get(inn).push({id,name,section});
    }
    // Evidence may carry a foreign legal entity even when the active INN and
    // canonical ID are well-shaped. Detect contradictory *explicitly verified*
    // INN notes across all active and review/excluded queues.
    const notes=Array.isArray(row?.__evidence?.notes)?row.__evidence.notes.map(str):[];
    const confirmedInns=[...new Set(notes.flatMap(note=>
      [...note.matchAll(/Подтвержд[её]нный ИНН:\s*(\d{10}|\d{12})/gi)]
        .map(match=>match[1])))];
    if(confirmedInns.length>1)issues.push({
      kind:"contradictory_verified_inns_in_notes",id,name,section,
      verified_inns:confirmedInns.sort()
    });
    const declared=new Set([id,...(Array.isArray(row?.__merged_canonical_ids)
      ? row.__merged_canonical_ids.map(str):[])].filter(Boolean));
    const foreignMerged=(Array.isArray(row?.__merged_original_records)
      ? row.__merged_original_records:[])
      .map(original=>({id:str(original?.__canonical_id),
        name:str(original?.["Организация"])}))
      .filter(original=>original.id&&!declared.has(original.id));
    if(foreignMerged.length)issues.push({
      kind:"merged_original_missing_lineage_id",id,name,section,
      undeclared_originals:foreignMerged
    });
    if(!active)continue;
    const text=normalize(notes.join(" ")),nameLower=normalize(name);
    if(section==="leasing"&&text.includes("лизингодатель отдельно не идентифицирован"))
      warnings.push({kind:"leasing_role_not_established",id,name});
    if(section==="direct_buyers"&&nameLower.includes("лизинг")&&
      /(лизингодател|финансирующ.{0,25}сторон)/.test(text))
      warnings.push({kind:"lessor_on_direct_buyers_sheet",id,name});

    const grade=str(row?.__final_grade).toUpperCase();
    if(Object.hasOwn(grades,grade))grades[grade]++;else grades.other++;
    if(["A","B"].includes(grade)&&!inn)missingPriority.push({id,name,section,grade});
    if(grade!=="A")continue;
    const provenance=row?.__evidence?.selected_a_provenance||{};
    const url=str(provenance.source_url);
    const detail={id,name,section,inn,url,status:str(provenance.status)};
    if(!isUrl(url)){unlinkedA.push(detail);continue;}
    if(provenance.sources_rechecked!==true)unverifiedA.push(detail);
    if(isGenericSource(url))genericA.push(detail);
  }
  for(const [id,holders] of idOwners)if(holders.length>1)
    issues.push({kind:"duplicate_canonical_id",id,holders});
  for(const [inn,holders] of innOwners)if(holders.length>1)
    issues.push({kind:"active_duplicate_inn",inn,holders});
  for(const row of unlinkedA)issues.push({kind:"A_selected_claim_missing_url",...row});
  for(const row of genericA)issues.push({kind:"A_selected_claim_generic_index",...row});
  const lineage=data?.final_quality_gate?.source_id_cross_survivor_conflicts||[];
  return {
    version:"1",method:"offline_readonly",online_fact_verifications:0,
    counts:Object.fromEntries(SECTIONS.map(section=>[section,data[section].length])),
    archive_snapshots:Array.isArray(data.manual_quality_archived_snapshots)?data.manual_quality_archived_snapshots.length:0,
    grades,all_current_records:rows.length,commercial_records:commercial.length,
    distinct_current_ids:idOwners.size,missing_inn:missing,
    priority_missing_inn:missingPriority,A_missing_url:unlinkedA,
    A_linked_not_live_verified:unverifiedA,A_generic_source:genericA,
    historical_source_lineage_conflicts:lineage.length,issues,warnings,
    critical_issue_count:issues.length,
    verdict:issues.length?"technical_blocked":"offline_technical_checks_passed_not_primary_registry_verification"
  };
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const input=process.argv.slice(2).find(a=>!a.startsWith("--"));
  const out=process.argv.slice(2).find(a=>a.startsWith("--out="))?.slice(6);
  if(!input){console.error("Usage: node scripts/audit-final-result-readonly.js <final.json> [--out=NEW.json] [--fail-on-critical]");process.exit(2);}
  const bytes=fs.readFileSync(input),report=auditFinalResult(JSON.parse(bytes));
  const payload={...report,source_json_sha256:crypto.createHash("sha256").update(bytes).digest("hex")};
  if(out)fs.writeFileSync(out,JSON.stringify(payload,null,2),{flag:"wx"});
  else console.log(JSON.stringify(payload,null,2));
  if(process.argv.includes("--fail-on-critical")&&report.critical_issue_count)process.exitCode=1;
}
