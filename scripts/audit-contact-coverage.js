#!/usr/bin/env node
// Aggregate read-only evidence and coverage checks. No live source requests,
// no edits/exports, and no raw company names, phones or other contact data.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {contactPhoneCoverage} from "../src/publicContactEnrichment.js";
import {parsePhoneEntries} from "../src/phoneExport.js";
import {normalizeRussianPhone,validHttpUrl} from "../src/researchCostPolicy.js";
import {registeredContactName} from "../src/publicContactParser.js";
import {verifiedInnChecksum} from "../src/sabyMissingInnRecovery.js";
import {sabyStoredSectionCoverage} from "../src/sabyEnrichment.js";
import {restorePhoneConflictProof} from "../src/phoneConflictProof.js";
import {identityOgrns} from "../src/legalIdentity.js";
const sections=["direct_buyers","intermediaries","leasing"];
const txt=v=>String(v??"").normalize("NFKC").replace(/\s+/gu," ").trim();
const list=v=>Array.isArray(v)?v:[];
const legalInn=row=>{
  const n=txt(row?.["ИНН"]);
  return /^\d{10}(?:\d{2})?$/.test(n)&&verifiedInnChecksum(n)?n:"";
};
const phones=row=>new Set(parsePhoneEntries(row?.["Телефон"]).map(p=>p.phone));
function rowsOf(cp){
  if(cp?.version!==1||cp.phase!=="completed"||!txt(cp.region)||
    !["full","saby"].includes(cp.source_mode)||sections.some(s=>!Array.isArray(cp.final_result?.[s])))
    throw Error("CONTACT_AUDIT_COMPLETED_CHECKPOINT_REQUIRED");
  return sections.flatMap(sheet=>cp.final_result[sheet].map(row=>({sheet,row})));
}
const integer=v=>Number.isSafeInteger(v)&&v>=0?v:null;
function coverageSnapshot(v){
  if(!v||integer(v.rows)===null||integer(v.with_phone)===null||v.with_phone>v.rows)return null;
  return {rows:v.rows,with_phone:v.with_phone,without_phone:v.rows-v.with_phone,
    coverage_pct:v.rows?Math.round(v.with_phone/v.rows*10000)/100:null};
}
function sourceSupport(row,inn,visible){
  const e=row.__evidence||{},has=n=>visible.has(normalizeRussianPhone(n));
  const publicProof=list(e.public_contact_facts).some(p=>p?.field==="Телефон"&&p.inn===inn&&
    ["public_html_exact_entity","public_directory_exact_inn"].includes(p.method)&&
    /^[a-f0-9]{64}$/.test(p.source_sha256||"")&&/^[a-f0-9]{64}$/.test(p.identity_sha256||"")&&
    validHttpUrl(p.source_url)&&has(p.value)&&parsePhoneEntries(p.excerpt).some(x=>x.phone===normalizeRussianPhone(p.value)));
  const saby=Boolean(sabyStoredSectionCoverage(row).contacts&&list(e.saby?.phones).some(has));
  const model=Boolean(e.contact_verification?.inn===inn&&validHttpUrl(e.contact_verification.source_url)&&has(e.contact_verification.phone));
  const conflicts=list(e.contact_conflict_verifications).some(p=>p?.status==="confirmed"&&has(p.phone)&&
    restorePhoneConflictProof(p,{rowId:txt(row.__canonical_id),inn,phone:p.phone})?.status==="confirmed");
  return {public_html:publicProof,saby,model_source_hint:model,model_conflict_excerpt:conflicts};
}
export function auditContactCoverage(cp){
  const rows=rowsOf(cp),owners=new Map();
  const sourceSupportRows={public_html:0,saby:0,model_source_hint:0,model_conflict_excerpt:0,any_saved_support:0,no_recognized_saved_support:0};
  let withoutPhoneValidInn=0,withoutPhoneInvalidOrMissingInn=0,phoneEntries=0,innLikePhones=0;
  for(const {row} of rows){
    const inn=legalInn(row),visible=phones(row);
    if(!visible.size){
      if(inn)withoutPhoneValidInn++;else withoutPhoneInvalidOrMissingInn++;
      continue;
    }
    phoneEntries+=visible.size;
    for(const n of visible){
      if(!owners.has(n))owners.set(n,new Set());
      owners.get(n).add(row);
      if(inn.length===10&&n==="7"+inn)innLikePhones++;
    }
    const support=inn?sourceSupport(row,inn,visible):{};
    for(const [k,v] of Object.entries(support))sourceSupportRows[k]+=Number(v);
    sourceSupportRows[Object.values(support).some(Boolean)?"any_saved_support":"no_recognized_saved_support"]++;
  }
  const shared=[...owners.values()].filter(s=>s.size>1),sharedRows=new Set(shared.flatMap(s=>[...s]));
  const coverage=contactPhoneCoverage(cp.final_result);
  const actual=coverageSnapshot(coverage),saby=cp.saby_stats||{},publicStats=cp.public_contact_stats||{},contact=cp.contact_stats||{};
  return {region:cp.region,phase:cp.phase,source_mode:cp.source_mode,
    updated_at:cp.updated_at||null,actual,by_grade:coverage.by_grade,by_sheet:coverage.by_sheet,
    without_phone_valid_inn:withoutPhoneValidInn,without_phone_invalid_or_missing_inn:withoutPhoneInvalidOrMissingInn,
    phone_entries:phoneEntries,distinct_numbers:owners.size,shared_number_count:shared.length,rows_with_shared_numbers:sharedRows.size,
    possible_inn_like_phone_entries:innLikePhones,source_support_rows:sourceSupportRows,
    stages:{stage11:coverageSnapshot(contact.phone_coverage),saby:coverageSnapshot(saby.phoneCoverage),
      public_before:coverageSnapshot(publicStats.phone_coverage_before),public_after:coverageSnapshot(publicStats.phone_coverage_after),
      saved_final:coverageSnapshot(contact.final_phone_coverage)},
    pending:{stage11:integer(contact.unsearched),saby:integer(saby.deferred),public_html:integer(publicStats.pending)},
    reported_source_gains:{saby_phone_rows:integer(saby.phonesAdded),public_html_phone_rows:integer(publicStats.phone_added)},
    estimated_api_cost_usd:typeof cp.api_usage?.estimated_cost_usd==="number"&&Number.isFinite(cp.api_usage.estimated_cost_usd)?cp.api_usage.estimated_cost_usd:null,
    web_calls:integer(cp.api_usage?.web_usage?.total),
    method:"offline_saved_values_and_structural_source_support_not_live_phone_verification"};
}
function exactName(row){
  return registeredContactName(row?.["Организация"])||txt(row?.["Организация"]).toUpperCase();
}
function uniqueByInn(rows){
  const map=new Map(),duplicates=new Set();
  for(const entry of rows){
    const inn=legalInn(entry.row);
    if(!inn)continue;
    if(map.has(inn)){duplicates.add(inn);continue;}
    map.set(inn,entry);
  }
  for(const inn of duplicates)map.delete(inn);
  return map;
}
export function compareContactCoverage(before,after){
  const oldRows=rowsOf(before),newRows=rowsOf(after);
  if(txt(before.region).toLowerCase()!==txt(after.region).toLowerCase())throw Error("CONTACT_AUDIT_BASELINE_REGION_MISMATCH");
  const old=uniqueByInn(oldRows),next=uniqueByInn(newRows);
  let matched=0,oldPhone=0,newPhone=0,gained=0,lost=0,numberSetsChanged=0,identityConflicts=0;
  for(const [inn,a] of old){
    const b=next.get(inn);
    if(!b)continue;
    const x=identityOgrns(a.row),y=identityOgrns(b.row);
    if(!exactName(a.row)||exactName(a.row)!==exactName(b.row)||x.length>1||y.length>1||
      (x.length&&y.length&&x[0]!==y[0])||a.row.__evidence?.legal_identity_conflicts?.length||
      b.row.__evidence?.legal_identity_conflicts?.length){identityConflicts++;continue;}
    const p=phones(a.row),q=phones(b.row);
    matched++;oldPhone+=Number(p.size>0);newPhone+=Number(q.size>0);
    gained+=Number(!p.size&&q.size>0);lost+=Number(p.size>0&&!q.size);
    numberSetsChanged+=Number(p.size!==q.size||[...p].some(n=>!q.has(n)));
  }
  return {matched_exact_unique_legal_inn_and_name:matched,with_phone_before:oldPhone,with_phone_after:newPhone,
    gained_phone_rows:gained,lost_phone_rows:lost,net_change:gained-lost,changed_phone_sets:numberSetsChanged,
    unmatched_before:oldRows.length-matched,unmatched_after:newRows.length-matched,identity_conflicts:identityConflicts,
    method:"same_region_matched_cohort_only_unmatched_rows_not_assumed_added_or_lost"};
}
async function main(){
  const args=process.argv.slice(2),arg=(k,d="")=>args.find(s=>s.startsWith("--"+k+"="))?.slice(k.length+3)??d;
  if(args.includes("--help")){
    console.log("node scripts/audit-contact-coverage.js --db=/absolute/checkpoints.sqlite [--recent=8 | --checkpoint=<UUID> [--baseline=<UUID>]]");
    return;
  }
  const file=arg("db"),id=arg("checkpoint"),baseline=arg("baseline"),recent=Number(arg("recent","8"));
  const uuid=s=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
  if(!path.isAbsolute(file)||!fs.existsSync(file)||!fs.statSync(file).isFile()||
    (id&&!uuid(id))||(baseline&&(!id||!uuid(baseline)||baseline===id))||!Number.isSafeInteger(recent)||recent<1||recent>20)
    throw Error("CONTACT_AUDIT_BAD_ARGS");
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
    const load=key=>{
      const row=db.prepare("SELECT payload FROM research_checkpoints WHERE id=?").get(key);
      if(!row?.payload)throw Error("CONTACT_AUDIT_CHECKPOINT_NOT_FOUND");
      return JSON.parse(row.payload);
    };
    const ids=id?[id]:db.prepare("SELECT id FROM research_checkpoints WHERE phase='completed' ORDER BY updated_at DESC LIMIT ?").all(recent).map(x=>x.id);
    for(const key of ids){
      const cp=load(key),report=auditContactCoverage(cp);
      if(baseline)report.comparison={baseline_checkpoint:baseline,...compareContactCoverage(load(baseline),cp)};
      console.log("[CONTACT_COVERAGE_AUDIT] "+JSON.stringify({checkpoint:key,...report}));
    }
  }finally{db.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{
  console.error("[CONTACT_COVERAGE_AUDIT_ERROR] "+JSON.stringify({reason:/^CONTACT_AUDIT_[A-Z_]+$/.test(e?.message||"")?e.message:"CONTACT_AUDIT_UNAVAILABLE"}));
  process.exitCode=2;
});
