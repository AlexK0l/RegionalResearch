// Read-only regional audit and a bounded matched-cohort acceptance test.
// No network here. A confirmed fleet always passes the production evidence
// validator, and missing evidence is never treated as zero.
import {createHash} from "node:crypto";
import {sabyEligibleRows,sabyFleetCoverage,sabyStoredSectionCoverage,
  sabyInn,sabyNameTokens,sabyFinancialGaps,sabyStoredVehicleFleet,sabyStoredVehiclePartial} from "./sabyEnrichment.js";
import {verifiedInnChecksum} from "./sabyMissingInnRecovery.js";
import {identityOgrns,mergedNumberedLegalNameConflict} from "./legalIdentity.js";
import {parsePhoneEntries} from "./phoneExport.js";
import {companyEmailCell,parseEmailEntries} from "./emailContact.js";

const groups=["direct_buyers","intermediaries","leasing"];
const str=x=>String(x??"").trim();
const sha=x=>createHash("sha256").update(x).digest("hex");
const digest=x=>sha(JSON.stringify(x));
const int=x=>Number.isSafeInteger(x)&&x>=0?x:null;
const key=row=>digest([sabyInn(row["ИНН"]),str(row["Организация"])]);
const safeRow=row=>verifiedInnChecksum(sabyInn(row["ИНН"]))&&
  sabyNameTokens(row["Организация"]).length>0&&
  !row.__evidence?.legal_identity_conflicts?.length&&
  !mergedNumberedLegalNameConflict(row)&&identityOgrns(row).length<=1;
function completedResult(cp){
  if(cp?.version!==1||cp.phase!=="completed"||
    !["full","saby"].includes(cp.source_mode)||!str(cp.region)||
    groups.some(s=>!Array.isArray(cp.final_result?.[s])))
    throw Error("FLEET_ACCEPTANCE_COMPLETED_SOURCE_REQUIRED");
  return cp.final_result;
}
function fleet(row){
  if(!sabyStoredSectionCoverage(row,{transport:true}).trucks)
    return {status:"unknown",count:null,inventory_sha256:null,known_years:null};
  const trucks=row.__evidence.saby.trucks;
  // Sort a MULTISET, not a set: two identical model/year trucks are two
  // distinct vehicles. Reordering must not produce a false difference.
  const entries=trucks.vehicles.map(v=>JSON.stringify([
    str(v.model).replace(/\s+/g," "),v.year?Number(v.year):null
  ])).sort();
  return {status:trucks.count?"positive":"zero",count:trucks.count,
    inventory_sha256:digest(entries),
    known_years:trucks.vehicles.filter(v=>Boolean(v.year)).length};
}
function contacts(row){
  return {
    phone_sha256:[...new Set(parsePhoneEntries(row["Телефон"])
      .map(x=>sha(x.phone)))].sort(),
    email_sha256:[...new Set(parseEmailEntries(companyEmailCell(row))
      .map(x=>sha(String(x).toLowerCase())))].sort(),
    revenue:!sabyFinancialGaps(row).revenue?Number(row["Выручка последнего подтвержденного года"]):null,
    employees:!sabyFinancialGaps(row).employees?Number(row["Численность"]):null
  };
}
function bucket(row){
  const f=fleet(row);
  if(f.status==="positive")return "positive_control";
  if(f.status==="zero")return "zero_control";
  const coverage=sabyStoredSectionCoverage(row,{transport:true});
  if(!coverage.trusted)return "no_trusted_card";
  if(row.__evidence.saby.collection.trucks==="review")return "fleet_review";
  return "fleet_missing";
}
const buckets=["no_trusted_card","fleet_missing","fleet_review","positive_control","zero_control"];
const hex64=s=>typeof s==="string"&&/^[a-f0-9]{64}$/.test(s);
function validFleetSummary(row){
  if(row?.status==="unknown")
    return row.count===null&&row.inventory_sha256===null&&row.known_years===null;
  return ["positive","zero"].includes(row?.status)&&int(row.count)!==null&&row.count<=5000&&
    (row.status==="positive"?row.count>0:row.count===0)&&hex64(row.inventory_sha256)&&
    int(row.known_years)!==null&&row.known_years<=row.count;
}
const sameFleet=(a,b)=>a?.status===b?.status&&a?.count===b?.count&&
  a?.inventory_sha256===b?.inventory_sha256&&a?.known_years===b?.known_years;
function validPrior(row){
  return validFleetSummary(row?.prior)&&
    (row.stratum==="positive_control"?row.prior.status==="positive":
      row.stratum==="zero_control"?row.prior.status==="zero":row.prior.status==="unknown");
}
export function auditSavedFleetCoverage(cp){
  const result=completedResult(cp);
  const plan=sabyEligibleRows(result,{includeAll:true,includeFinanceGaps:true,allCompanyFleets:true});
  const timing=cp.saby_stats?.timing;
  const by_bucket=Object.fromEntries(buckets.map(k=>[k,0]));
  let checksum_or_conflict_blocked=0;
  for(const entry of plan.eligible){
    if(!safeRow(entry.row))checksum_or_conflict_blocked++;
    by_bucket[bucket(entry.row)]++;
  }
  return {region:cp.region,updated_at:cp.updated_at||null,
    coverage:sabyFleetCoverage(result,plan),by_bucket,checksum_or_conflict_blocked,
    previous_sweep:{
      full_sweep_completed:typeof cp.saby_stats?.fullSweepCompleted==="boolean"?cp.saby_stats.fullSweepCompleted:null,
      deadline_reached:typeof cp.saby_stats?.deadlineReached==="boolean"?cp.saby_stats.deadlineReached:null,
      total_attempts:int(cp.saby_stats?.totalAttempts),distinct_processed:int(cp.saby_stats?.processed),
      timing:timing&&int(timing.visits)!==null?{
        visits:timing.visits,visit_ms:int(timing.visit_ms),
        search_ms:int(timing.search_ms),fleet_ms:int(timing.fleet_ms),
        full_searches:int(timing.full_searches),saved_card_hits:int(timing.saved_card_hits),
        checkpoint_ms:int(timing.checkpoint_ms),delay_ms:int(timing.delay_ms)
      }:null
    }};
}
export function buildFleetCohort(cp,{limit=12,sourceId=""}={}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>30||!str(sourceId))
    throw Error("FLEET_ACCEPTANCE_BAD_PLAN");
  const result=completedResult(cp),direct=new Set(result.direct_buyers);
  // Eligibility includes ALL commercial sheets when detecting shared INNs.
  // The paired test is direct-only, the common scope of old/new versions.
  const plan=sabyEligibleRows(result,{includeAll:true,includeFinanceGaps:true,allCompanyFleets:true});
  const candidates=plan.eligible.filter(e=>direct.has(e.row)&&safeRow(e.row));
  const bins=Object.fromEntries(buckets.map(b=>[b,[]]));
  // Deterministic INN ordering within each stratum, not a handpicked
  // success-only sample. Positive/zero controls are forced to be reread.
  for(const {row} of [...candidates].sort((a,b)=>sabyInn(a.row["ИНН"]).localeCompare(sabyInn(b.row["ИНН"]))))
    bins[bucket(row)].push(row);
  const available=Object.fromEntries(buckets.map(b=>[b,bins[b].length]));
  const picked=[];
  // Put positive controls in the first round before missing/review repeats.
  const order=["positive_control","no_trusted_card","fleet_missing","fleet_review","zero_control"];
  while(picked.length<limit){
    let any=false;
    for(const b of order){
      if(!bins[b].length||picked.length>=limit)continue;
      const source=bins[b].shift(),row=structuredClone(source);
      const prior=fleet(source);
      if(row.__evidence?.saby){
        delete row.__evidence.saby.trucks;
        delete row.__evidence.saby.vehicle_fleet;
        delete row.__evidence.saby.vehicle_fleet_partial;
        if(row.__evidence.saby.collection){
          delete row.__evidence.saby.collection.trucks;
          delete row.__evidence.saby.collection.vehicle_fleet;
        }
      }
      // Remove only the comparison copy's transport cell. Keep genuine
      // identity, saved-card hints, contacts and finance input identical.
      row["Наличие транспорта"]="";
      picked.push({key:key(row),stratum:b,prior,row});any=true;
    }
    if(!any)break;
  }
  if(!picked.length)throw Error("FLEET_ACCEPTANCE_EMPTY_COHORT");
  return {version:1,region:cp.region,source_checkpoint:sourceId,scope:"direct_buyers",
    available,selected:picked};
}
export function validateFleetCohort(cohort){
  if(cohort?.version!==1||cohort.scope!=="direct_buyers"||!str(cohort.region)||
    !str(cohort.source_checkpoint)||!Array.isArray(cohort.selected)||
    cohort.selected.length<1||cohort.selected.length>30)
    throw Error("FLEET_ACCEPTANCE_BAD_COHORT");
  const keys=new Set(),inns=new Set();
  for(const e of cohort.selected){
    const row=e?.row,inn=sabyInn(row?.["ИНН"]);
    if(!row||!safeRow(row)||e.key!==key(row)||keys.has(e.key)||inns.has(inn)||
      !buckets.includes(e.stratum)||!validPrior(e)||fleet(row).status!=="unknown")
      throw Error("FLEET_ACCEPTANCE_BAD_COHORT");
    keys.add(e.key);inns.add(inn);
  }
  return cohort;
}
export function cohortResult(cohort){
  validateFleetCohort(cohort);
  return {direct_buyers:cohort.selected.map(e=>structuredClone(e.row)),
    intermediaries:[],leasing:[],statistics:[]};
}
export function summarizeFleetAcceptance({cohort,result,outcome,elapsedMs,commit,cohortSha,policy}){
  validateFleetCohort(cohort);
  if(!Number.isSafeInteger(elapsedMs)||elapsedMs<=0||
    !/^[a-f0-9]{40}$/.test(commit||"")||!/^[a-f0-9]{64}$/.test(cohortSha||""))
    throw Error("FLEET_ACCEPTANCE_BAD_RUN");
  if(groups.some(s=>!Array.isArray(result?.[s]))||result.intermediaries.length||result.leasing.length||
    result.direct_buyers.length!==cohort.selected.length)
    throw Error("FLEET_ACCEPTANCE_CHANGED_COHORT");
  const byKey=new Map(result.direct_buyers.map(row=>[key(row),row]));
  const rows=cohort.selected.map(e=>{
    const row=byKey.get(e.key);
    if(!row)throw Error("FLEET_ACCEPTANCE_CHANGED_COHORT");
    return {key:e.key,stratum:e.stratum,prior:structuredClone(e.prior),...fleet(row),...contacts(row)};
  });
  const positive=rows.filter(r=>r.status==="positive").length,zero=rows.filter(r=>r.status==="zero").length;
  const stats=outcome?.stats||{},timing=stats.timing||{};
  return {version:1,region:cohort.region,cohort_sha256:cohortSha,policy_sha256:digest(policy),
    commit,measured_at:new Date().toISOString(),elapsed_ms:elapsedMs,
    full_sweep_completed:stats.fullSweepCompleted===true&&!stats.circuitOpen&&!stats.browserError,
    metrics:{companies:rows.length,positive,zero,unknown:rows.length-positive-zero,
      vehicles:rows.reduce((n,r)=>n+(r.count??0),0),
      known_years:rows.reduce((n,r)=>n+(r.known_years??0),0),
      attempts:int(stats.totalAttempts),full_searches:int(timing.full_searches),
      saved_card_hits:int(timing.saved_card_hits),visit_ms:int(timing.visit_ms),
      search_ms:int(timing.search_ms),fleet_ms:int(timing.fleet_ms),
      phone_rows:rows.filter(r=>r.phone_sha256.length).length,
      email_rows:rows.filter(r=>r.email_sha256.length).length,
      revenue_rows:rows.filter(r=>r.revenue!==null).length,
      employee_rows:rows.filter(r=>r.employees!==null).length,
      full_fleets_per_hour:Math.round((positive+zero)*3600000/elapsedMs*100)/100,
      positive_fleets_per_hour:Math.round(positive*3600000/elapsedMs*100)/100},
    rows};
}
function checkedReport(r){
  if(r?.version!==1||!hex64(r.cohort_sha256)||!hex64(r.policy_sha256)||
    !/^[a-f0-9]{40}$/.test(r.commit||"")||!str(r.region)||
    !Number.isSafeInteger(r.elapsed_ms)||r.elapsed_ms<=0||
    !Array.isArray(r.rows)||r.rows.length<1||r.rows.length>30||
    r.metrics?.companies!==r.rows.length||typeof r.full_sweep_completed!=="boolean")
    throw Error("FLEET_ACCEPTANCE_BAD_REPORT");
  const seen=new Set();
  for(const row of r.rows){
    if(!hex64(row?.key)||seen.has(row.key)||!buckets.includes(row.stratum)||
      !validFleetSummary(row)||!validPrior(row)||
      !Array.isArray(row.phone_sha256)||!row.phone_sha256.every(hex64)||
      !Array.isArray(row.email_sha256)||!row.email_sha256.every(hex64)||
      (row.revenue!==null&&int(row.revenue)===null)||(row.employees!==null&&int(row.employees)===null))
      throw Error("FLEET_ACCEPTANCE_BAD_REPORT");
    seen.add(row.key);
  }
  return r;
}
export function compareFleetAcceptance(baseline,candidate){
  const a=checkedReport(baseline),b=checkedReport(candidate);
  if(a.cohort_sha256!==b.cohort_sha256||a.policy_sha256!==b.policy_sha256||
    a.region!==b.region||a.rows.length!==b.rows.length)
    throw Error("FLEET_ACCEPTANCE_UNMATCHED_RUNS");
  const byKey=new Map(b.rows.map(r=>[r.key,r]));
  let gained=0,gained_positive=0,gained_zero=0,lost=0,inventory_changed=0,
    contact_or_finance_loss=0,baseline_control_mismatch=0,candidate_control_mismatch=0;
  const changes=[];
  for(const x of a.rows){
    const y=byKey.get(x.key);
    if(!y||x.stratum!==y.stratum||!sameFleet(x.prior,y.prior))
      throw Error("FLEET_ACCEPTANCE_UNMATCHED_RUNS");
    const flags=[];
    // Controls must really be reread. Two failures on the same known
    // fleet must not make a zero-yield faster run an acceptance success.
    if(x.prior.status!=="unknown"){
      if(!sameFleet(x.prior,x)){baseline_control_mismatch++;flags.push("baseline_control_changed");}
      if(!sameFleet(y.prior,y)){candidate_control_mismatch++;flags.push("candidate_control_changed_requires_review");}
    }
    if(x.status==="unknown"&&y.status!=="unknown"){
      gained++;if(y.status==="positive")gained_positive++;else gained_zero++;
      flags.push("new_verified_fleet");
    }
    if(x.status!=="unknown"&&y.status==="unknown"){lost++;flags.push("lost_verified_fleet");}
    if(x.status!=="unknown"&&y.status!=="unknown"&&
      (x.count!==y.count||x.inventory_sha256!==y.inventory_sha256)){
      inventory_changed++;flags.push("inventory_changed_requires_review");
    }
    if(x.phone_sha256.some(v=>!y.phone_sha256.includes(v))||
       x.email_sha256.some(v=>!y.email_sha256.includes(v))||
       x.revenue!==null&&x.revenue!==y.revenue||x.employees!==null&&x.employees!==y.employees){
      contact_or_finance_loss++;flags.push("contact_or_finance_changed_requires_review");
    }
    if(flags.length)changes.push({key:x.key,stratum:x.stratum,flags});
  }
  const speed_change_pct=Math.round((a.elapsed_ms-b.elapsed_ms)/a.elapsed_ms*10000)/100;
  // Never accept a shorter interrupted sweep or a smaller fleet as a gain.
  const complete=a.full_sweep_completed&&b.full_sweep_completed;
  const no_loss=lost===0&&inventory_changed===0&&contact_or_finance_loss===0&&candidate_control_mismatch===0;
  const status=!complete?"incomplete_comparison":!no_loss?"coverage_or_fact_review_required":
    speed_change_pct<=0?"speed_not_improved":gained>0?"both_improved":"faster_equal_verified_coverage";
  return {region:a.region,baseline_commit:a.commit,candidate_commit:b.commit,matched:a.rows.length,
    complete,gained_verified_fleets:gained,gained_positive_fleets:gained_positive,
    gained_zero_fleets:gained_zero,lost_verified_fleets:lost,inventory_changed,
    baseline_control_mismatch,candidate_control_mismatch,
    contact_or_finance_loss,baseline_elapsed_ms:a.elapsed_ms,candidate_elapsed_ms:b.elapsed_ms,
    speed_change_pct,baseline:a.metrics,candidate:b.metrics,status,changes,
    note:"Matched live sample only; changed source facts require review, not automatic regression attribution. No SQLite I/O in the benchmark."};
}


// Focused functional probe of explicit companies already in the saved
// matched cohort. Include one distinct positive truck control. This is
// deliberately not a new random cohort or a speed acceptance comparison.
export function selectVehicleCategoryProbe(cohort,inns){
  validateFleetCohort(cohort);
  if(!Array.isArray(inns)||inns.length<1||inns.length>5||
     new Set(inns).size!==inns.length||inns.some(x=>sabyInn(x)!==x))
    throw Error("FLEET_ACCEPTANCE_BAD_PROBE_SELECTION");
  const chosen=cohort.selected.filter(e=>inns.includes(sabyInn(e.row["ИНН"])));
  if(chosen.length!==inns.length)throw Error("FLEET_ACCEPTANCE_PROBE_COMPANY_NOT_IN_COHORT");
  const control=cohort.selected.find(e=>e.prior.status==="positive"&&!chosen.includes(e));
  if(!control&&!chosen.some(e=>e.prior.status==="positive"))
    throw Error("FLEET_ACCEPTANCE_PROBE_CONTROL_REQUIRED");
  return validateFleetCohort({...cohort,selected:control?[...chosen,control]:chosen});
}
export function summarizeVehicleCategoryProbe(args){
  const base=summarizeFleetAcceptance(args);
  const {cohort,result,outcome}=args;
  if(outcome?.stats?.fleetCategoryScope!=="all_vehicle_categories_v1")
    throw Error("FLEET_ACCEPTANCE_PROBE_SCOPE_NOT_ENABLED");
  const byKey=new Map(result.direct_buyers.map(row=>[key(row),row]));
  const rows=base.rows.map(e=>{
    const row=byKey.get(e.key),whole=sabyStoredVehicleFleet(row),partial=whole?null:sabyStoredVehiclePartial(row);
    return {
      inn:sabyInn(row["ИНН"]),stratum:e.stratum,
      status:whole?"verified":partial?"partial":"unknown",
      count:whole?.count??null,announced_count:whole?.count??partial?.announced_count??null,
      verified_category_vehicles:whole?.count??partial?.groups.reduce((n,g)=>n+g.count,0)??0,
      groups:whole?.groups??partial?.groups??[],
      categories:whole?.groups.map(({category,count})=>({category,count}))??partial?.categories??[],
      truck_status:e.status,truck_count:e.count,
      truck_control_match:e.prior.status==="unknown"?null:sameFleet(e.prior,e)
    };
  });
  const priorControls=rows.filter(e=>e.truck_control_match!==null);
  return {version:1,scope:"all_vehicle_categories_v1",region:base.region,
    commit:base.commit,cohort_sha256:base.cohort_sha256,policy_sha256:base.policy_sha256,
    measured_at:base.measured_at,elapsed_ms:base.elapsed_ms,full_sweep_completed:base.full_sweep_completed,
    complete_fleets:rows.filter(e=>e.status==="verified").length,
    partial_fleets:rows.filter(e=>e.status==="partial").length,
    unknown_fleets:rows.filter(e=>e.status==="unknown").length,
    whole_fleet_vehicles:rows.reduce((n,e)=>n+(e.count??0),0),
    partial_category_vehicles:rows.filter(e=>e.status==="partial").reduce((n,e)=>n+e.verified_category_vehicles,0),
    truck_controls:priorControls.length,
    truck_control_mismatches:priorControls.filter(e=>!e.truck_control_match).length,
    timing:{attempts:base.metrics.attempts,full_searches:base.metrics.full_searches,
      saved_card_hits:base.metrics.saved_card_hits,fleet_ms:base.metrics.fleet_ms},
    rows,
    note:"Focused functional probe, not a matched all-category speed benchmark. Unknown is not zero. Partial groups may have separate observation dates."};
}
