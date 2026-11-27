// Production Stage12: a finite set of section tasks, not a wall-clock
// deadline. Durable per-section cursors survive cooperative pauses/reconnects.
// The legacy single-company collector remains available for diagnostics.
import {setTimeout as sleep} from "node:timers/promises";
import {parsePhoneEntries} from "./phoneExport.js";
import {contactResearchPriority} from "./researchCostPolicy.js";
import {contactPhoneCoverage} from "./publicContactEnrichment.js";
import {applySabyEnrichment,sabyEligibleRows,sabyInn,
  sabyWorkGaps,sabyHasWork,sabyFleetCoverage,reconcileStoredSabyPhones,
  sabyNameMatches,isSabyProfileUrl} from "./sabyEnrichment.js";
import {collectSabySections,withSabyBrowser,SabyReview} from "./sabyBrowser.js";
import {sabyStage12Settings} from "./sabyStage12.js";
import {validSabyFinancialEvidence} from "./sabyFinancials.js";
import {isMemoryPause} from "./memoryAdmission.js";
import {SABY_FAST_STRATEGY,SABY_COMBINED_RETRY_STRATEGY,sabyVisitStrategy,rememberSabyNavigationHint,
  createSabyAdaptiveDelay,restoreSabyTiming,sabyAddTiming,recordSabyVisitTiming,
  sabyFleetScope,SABY_ALL_FLEETS_SCOPE,validSabyPassCursor,
  sabyVehicleCategoryScope,SABY_ALL_VEHICLE_CATEGORIES} from "./sabyVisitPolicy.js";
import {verifiedSabyVehicleFleet,verifiedSabyVehiclePartial} from "./sabyVehicleInventory.js";

const PHASES=["contacts","contact_retry","details","details_retry"];
const PHASE_LABELS={
  contacts:"Saby: телефоны и почта",
  contact_retry:"Saby: повторный поиск телефонов и почты",
  details:"Saby: финансы и транспорт",
  details_retry:"Saby: повторная проверка транспорта"
};
const counters=["verified","review","phonesAdded","emailsAdded","transportsAdded",
  "vehiclesVerified","revenuesAdded","employeesAdded","partialResults","companyReviews","systemicErrors"];
const emptyStats=()=>Object.fromEntries(counters.map(k=>[k,0]));
function sectionNeeds(gaps,phase,optimized=false,combineRetry=false,combined={}){
  const {trucks,financials}=gaps;
  if(phase==="contacts"||phase==="contact_retry"){
    const contacts=gaps.contacts;
    // Initial contacts pass still finishes for the entire region first.
    // On the existing second contact visit, do the first FULL details
    // attempt instead of another quick read and a separate card opening.
    if(combineRetry&&phase==="contact_retry"&&contacts&&(trucks||financials))
      return {contacts,financials,trucks,optimized:true,combinedDetails:true};
    // Only read already-mounted finance/fleet data while collecting contacts.
    // An incomplete quick read does NOT consume a full details attempt.
    if(optimized&&contacts)return {contacts,financials,trucks,optimized:true,quickDetails:true};
    return {contacts,financials:false,trucks:false,...(optimized?{optimized:true}: {})};
  }
  // Retain the full previous detail and truck-retry coverage. In particular
  // no quick attempt marks a truck list or finance gap as completed.
  return {contacts:false,
    trucks:trucks&&!(phase==="details"&&combined.trucks),
    financials:(phase==="details"||trucks)&&financials&&!(phase==="details"&&combined.financials),
    ...(optimized?{optimized:true}: {})};
}
const any=sabyHasWork;
function phoneOwnersForResult(result){
  const map=new Map();
  for(const row of [...(result.direct_buyers||[]),...(result.intermediaries||[]),...(result.leasing||[])]){
    for(const {phone} of parsePhoneEntries(row["Телефон"])){
      if(!map.has(phone))map.set(phone,new Set());
      map.get(phone).add(row);
    }
  }
  return map;
}
function safeState(raw,entries,limit,env,fleetScope,gaps){
  const strategy=sabyVisitStrategy(env,raw);
  const all=new Set(entries.map(e=>sabyInn(e.row["ИНН"])));
  const valid=validSabyPassCursor(raw);
  if(valid){
    const ids=[...new Set(raw.planned_inns.map(sabyInn).filter(id=>all.has(id)))];
    const allowed=new Set(ids);
    const attempted=raw.attempted.filter(key=>{
      if(typeof key!=="string")return false;
      const [phase,id,...rest]=key.split(":");
      return !rest.length&&PHASES.includes(phase)&&allowed.has(id);
    });
    const attemptedSet=new Set(attempted);
    const combined_detail_attempts=strategy===SABY_COMBINED_RETRY_STRATEGY?
      Object.fromEntries(ids.filter(id=>attemptedSet.has("contact_retry:"+id))
        .flatMap(id=>{
          const v=raw.combined_detail_attempts?.[id];
          const trucks=v?.trucks===true,financials=v?.financials===true;
          return trucks||financials?[[id,{trucks,financials}]]:[];
        })):{};
    return {version:1,strategy,fleet_scope:fleetScope,timing:restoreSabyTiming(raw.timing),planned_inns:ids,attempted:[...new Set(attempted)],
      combined_detail_attempts,
      verified_inns:[...new Set((Array.isArray(raw.verified_inns)?raw.verified_inns:[]).map(sabyInn).filter(id=>allowed.has(id)))],
      initially_complete:Math.max(0,Math.min(entries.length,Number(raw.initially_complete)||0)),
      phase_index:Math.max(0,Math.min(PHASES.length,Math.trunc(Number(raw.phase_index)||0))),
      stats:Object.fromEntries(counters.map(k=>[k,Math.max(0,Number(raw.stats?.[k])||0)]))};
  }
  const pending=entries.filter(e=>any(gaps.get(e)));
  return {version:1,strategy,fleet_scope:fleetScope,timing:restoreSabyTiming(),planned_inns:(limit?pending.slice(0,limit):pending).map(e=>sabyInn(e.row["ИНН"])),
    attempted:[],verified_inns:[],combined_detail_attempts:{},
    initially_complete:entries.length-pending.length,phase_index:0,stats:emptyStats()};
}
export async function runSabyContactFirst({
  result,passState=null,env=process.env,signal=null,
  sessionRunner=withSabyBrowser,collectSections=collectSabySections,
  acquireSabyBrowser,onProgress=async()=>{},persistCheckpoint=async()=>{},
  recoveryWait=ms=>sleep(ms,undefined,{signal:signal??undefined}),maxRestarts=2,
  collectGarbage=typeof global.gc==="function"?()=>global.gc():null
}={}){
  const settings=sabyStage12Settings(env);
  // This bounds browser lifetime, never the regional sweep. A rotation is
  // ordinary maintenance, not a failed task or a consumed retry.
  const boundedPositive=(raw,fallback,max)=>{
    const n=Number(raw);
    return Number.isSafeInteger(n)&&n>=1?Math.min(n,max):fallback;
  };
  const sessionLimit=boundedPositive(env.SABY_BROWSER_RECYCLE_EVERY,25,200);
  const gcEvery=boundedPositive(env.SABY_GC_EVERY,10,100);
  maxRestarts=Math.max(0,Math.min(2,Math.trunc(Number(maxRestarts)||0)));
  const restoredPhones=reconcileStoredSabyPhones(result);
  if(restoredPhones.numbersAppended||restoredPhones.conflicts)
    console.info("[SABY_STORED_PHONE_RECONCILIATION] "+JSON.stringify(restoredPhones));
  const fleetScope=sabyFleetScope(env,passState);
  const all=sabyEligibleRows(result,{includeAll:true,includeFinanceGaps:true,
    allCompanyFleets:fleetScope===SABY_ALL_FLEETS_SCOPE});
  // Stable INN mapping includes rows whose gaps are filled during the run.
  const entries=all.eligible,byInn=new Map(entries.map(e=>[sabyInn(e.row["ИНН"]),e]));
  // A committed visit can change ONLY its selected row. Avoid repeatedly
  // validating every stored model/year list on every checkpoint, progress
  // report, and later pass. Rebuild the index from durable rows on resume;
  // refresh the affected row after each visit, including partial results.
  const fleetCategories=sabyVehicleCategoryScope(env,passState);
  const allVehicleCategories=fleetCategories===SABY_ALL_VEHICLE_CATEGORIES;
  const workGaps=entry=>sabyWorkGaps(entry,{allVehicleCategories});
  const gaps=new Map(entries.map(entry=>[entry,workGaps(entry)]));
  const state=safeState(passState,entries,settings.maxCompanies,env,fleetScope,gaps);
  state.fleet_categories=fleetCategories;
  const combineRetry=state.strategy===SABY_COMBINED_RETRY_STRATEGY;
  const optimized=state.strategy===SABY_FAST_STRATEGY||combineRetry;
  const pacing=createSabyAdaptiveDelay(settings.delayMs,env);
  const needs=(entry,phase)=>{
    const sections=sectionNeeds(gaps.get(entry),phase,optimized,combineRetry,
      state.combined_detail_attempts[sabyInn(entry.row["ИНН"])]||{});
    return allVehicleCategories&&sections.trucks?{...sections,allVehicleCategories:true}:sections;
  };
  const attempted=new Set(state.attempted),verifiedInns=new Set(state.verified_inns);
  const planned=state.planned_inns.map(id=>byInn.get(id)).filter(Boolean);
  const ownerMap=phoneOwnersForResult(result);
  const abort=()=>{if(signal?.aborted)throw Error("JOB_CANCELLED");};
  let restarts=0,consecutive=0,circuitOpen=false,browserError="";
  let releaseBrowser,phaseDone=0,phaseTotal=0,rotations=0;
  const reclaim=()=>{
    if(typeof collectGarbage==="function")try{collectGarbage();}catch{/* best effort */}
  };
  const stateSnapshot=()=>({...state,timing:{...state.timing},attempted:[...attempted],verified_inns:[...verifiedInns],stats:{...state.stats},
    combined_detail_attempts:{...state.combined_detail_attempts}});
  const snapshot=()=>{
    const deferred=[],done=[];
    for(const entry of entries){
      (any(gaps.get(entry))?deferred:done).push(sabyInn(entry.row["ИНН"]));
    }
    const visited=new Set([...attempted].map(key=>key.split(":")[1]));
    const phase=PHASES[state.phase_index]||"completed";
    const plannedSet=new Set(state.planned_inns);
    const unscheduled=deferred.filter(id=>!plannedSet.has(id)).length;
    const fullSweepCompleted=state.phase_index===PHASES.length&&!circuitOpen&&!browserError&&!unscheduled;
    return {
      stats:{enabled:settings.enabled,eligible:entries.length,invalidInnOrName:all.invalid.length,
        duplicateInn:all.duplicates.length,scheduled:planned.length,processed:visited.size,
        ...state.stats,verified:verifiedInns.size,verifiedTasks:state.stats.verified,totalAttempts:attempted.size,phase,phaseLabel:PHASE_LABELS[phase]||"Saby: проход завершён",
        passProcessed:phaseDone,passTotal:phaseTotal,passIndex:Math.min(state.phase_index+1,PHASES.length),passCount:PHASES.length,
        maxDurationMs:null,unlimited:true,deadlineReached:false,fullSweepCompleted,unscheduled,
        previouslyCompleted:state.initially_complete,deferred:settings.enabled?deferred.length:0,
        circuitOpen,browserError,browserRestarts:restarts,maxBrowserRestarts:maxRestarts,
        browserRotations:rotations,browserSessionTaskLimit:sessionLimit,
        visitStrategy:state.strategy,fleetScope:state.fleet_scope,
        fleetCategoryScope:fleetCategories,timing:{...state.timing},
        combinedDetailVisits:Object.keys(state.combined_detail_attempts).length,
        fleetCoverage:sabyFleetCoverage(result,all,gaps),
        phoneCoverage:contactPhoneCoverage(result)},
      completedInns:done,deferredInns:settings.enabled?deferred:[],
      attemptedInns:[...visited].filter(id=>deferred.includes(id)),
      passState:stateSnapshot()
    };
  };
  const save=async()=>{
    const out=snapshot(),start=performance.now();
    await persistCheckpoint("saby",{completed_stage:9,stage11_completed:true,final_result:result,
      saby_completed_inns:out.completedInns,saby_deferred_inns:out.deferredInns,
      saby_attempted_inns:out.attemptedInns,saby_pass_state:out.passState,saby_stats:out.stats});
    sabyAddTiming(state.timing,"checkpoint_ms",performance.now()-start);
    return out;
  };
  if(!settings.enabled)return snapshot();
  abort();
  // Save before waiting for RAM so a competing Saby job can yield safely.
  await save();
  // Skip entirely completed/empty plans without opening Chromium.
  if(!planned.length||state.phase_index===PHASES.length){
    state.phase_index=PHASES.length;
    return save();
  }
  const circuit=Error("SABY_SECTION_CIRCUIT");
  const log=(event,payload)=>console.info("["+event+"] "+JSON.stringify(payload));
  const runSession=async({page,settings:browserSettings})=>{
    let visits=0;
    for(;state.phase_index<PHASES.length;){
      const phase=PHASES[state.phase_index];
      const tasks=planned.filter(e=>any(needs(e,phase))&&
        !attempted.has(phase+":"+sabyInn(e.row["ИНН"])))
        .sort((a,b)=>contactResearchPriority(b.row)-contactResearchPriority(a.row));
      phaseDone=[...attempted].filter(key=>key.startsWith(phase+":")).length;
      phaseTotal=phaseDone+tasks.length;
      log("SABY_SECTION_PLAN",{phase,scheduled:phaseTotal,visited:phaseDone});
      await onProgress(snapshot().stats);
      for(const entry of tasks){
        abort();
        const {row,transport}=entry,inn=sabyInn(row["ИНН"]),sections=needs(entry,phase);
        const key=phase+":"+inn;
        if(attempted.has(key)||!any(sections))continue;
        if(visits>=sessionLimit)return "rotate";
        let record,error;
        const visitStart=performance.now();
        try{record=await collectSections(page,row,browserSettings,sections);}
        catch(e){if(isMemoryPause(e)||signal?.aborted||e?.message==="JOB_CANCELLED")throw e;error=e;}
        abort();
        const visitMs=Math.round(performance.now()-visitStart);
        let visitTiming=record?{timing:record.timing}:{timing:error?.sabyTiming};
        recordSabyVisitTiming(state.timing,visitTiming,visitMs);
        let appliedOk=false;
        if(error){
          state.stats.review++;
          if(error instanceof SabyReview&&error.scope==="company"){
            state.stats.companyReviews++;consecutive=0;
          }else{
            state.stats.systemicErrors++;consecutive++;
          }
          // Do not log raw browser errors or private page contents.
          log("SABY_SECTION_REVIEW",{inn,phase,scope:consecutive?"systemic":"company",
            code:error instanceof SabyReview?error.code:"unexpected_error"});
        }else{
          const relevant=(sections.contacts&&record?.contacts?.status==="collected")||
            (sections.trucks&&(record?.trucks?.status==="verified"||
              (allVehicleCategories&&Boolean(verifiedSabyVehicleFleet(record?.vehicle_fleet)||
                verifiedSabyVehiclePartial(record?.vehicle_fleet_partial)))))||
            (sections.financials&&Boolean(validSabyFinancialEvidence(record?.financials)));
          // Save a valid navigation hint even when all requested widgets
          // were absent. The next visit still freshly verifies the card.
          // Navigation hints do not change any pass cursor, required
          // section, attempt budget or completion evidence. Legacy
          // in-flight sweeps can safely reuse them too.
          rememberSabyNavigationHint(row,record);
          const applied=relevant?applySabyEnrichment(row,record,{phoneOwners:ownerMap,transport}):null;
          gaps.set(entry,workGaps(entry));
          // A navigation/identity failure or an unentered section must
          // not consume its separate full attempt. The browser explicitly
          // attests which reads started on the still-verified same card.
          if(sections.combinedDetails&&record?.identity?.verified===true&&
             sabyInn(record.identity.inn)===inn&&sabyNameMatches(row["Организация"],record.identity.name)&&
             isSabyProfileUrl(record.source_url)&&applied?.status!=="review"&&
             !(record.errors||[]).some(x=>/card_changed/.test(String(x)))){
            const attemptedDetails=record.full_detail_attempts;
            const trucks=sections.trucks===true&&attemptedDetails?.trucks===true;
            const financials=sections.financials===true&&attemptedDetails?.financials===true;
            if(trucks||financials)state.combined_detail_attempts[inn]={trucks,financials};
          }
          if(applied?.status==="ok"){
            appliedOk=true;
            if(sections.quickDetails){
              if(applied.revenueAdded||applied.employeesAdded)state.timing.quick_finance_filled++;
              if(sections.trucks&&(allVehicleCategories?applied.verifiedVehicles!==undefined&&!gaps.get(entry).trucks:
                record.trucks?.status==="verified"&&applied.verifiedTrucks!==null))
                state.timing.quick_fleet_completed++;
            }
            state.stats.verified++;
            verifiedInns.add(inn);
            for(const [stat,flag] of [["phonesAdded","phoneAdded"],["emailsAdded","emailAdded"],
              ["transportsAdded","transportAdded"],["revenuesAdded","revenueAdded"],["employeesAdded","employeesAdded"]])
              if(applied[flag])state.stats[stat]++;
            // A carried, previously verified fleet is not a new observation.
            if(sections.trucks){
              if(allVehicleCategories&&verifiedSabyVehicleFleet(record.vehicle_fleet)&&applied.verifiedVehicles!==undefined)
                state.stats.vehiclesVerified+=applied.verifiedVehicles;
              else if(!allVehicleCategories&&record.trucks?.status==="verified"&&applied.verifiedTrucks!==null)
                state.stats.vehiclesVerified+=applied.verifiedTrucks;
            }
            if(any(needs(entry,phase)))state.stats.partialResults++;
          }else{state.stats.review++;state.stats.companyReviews++;}
          // Separate full fleet outcomes from contact-only/quick visits.
          // Emit fixed categories, not raw Playwright errors or page data.
          if(sections.trucks&&!sections.quickDetails){
            const completeFleet=!gaps.get(entry).trucks;
            const status=completeFleet?"verified":
              ["missing","review"].includes(record?.trucks?.status)?record.trucks.status:"unknown";
            const code=(record?.errors||[]).map(String).find(x=>
              /^trucks: (?:fleet_heading_missing|truck_preview_missing|truck_preview_ambiguous|truck_count_invalid|vehicle_rows_incomplete|contact_overlay_not_closed|fleet_interaction_failed|card_changed)$/.test(x));
            log("SABY_FLEET_OUTCOME",{inn,phase,status,
              reason:completeFleet?"verified":code?code.slice(8):
                status==="missing"?"section_missing":applied?.status==="review"?"identity_mismatch":"unresolved"});
          }
          consecutive=0;
        }
        // Persist even an unsuccessful attempted task, but keep its data
        // gaps unresolved. Another pass may retry it at most once.
        attempted.add(key);phaseDone++;visits++;
        // Drop the last browser record before the GC/snapshot boundary.
        const safeTimings=restoreSabyTiming();
        recordSabyVisitTiming(safeTimings,visitTiming,visitMs);
        record=undefined;error=undefined;visitTiming=undefined;
        if(attempted.size%gcEvery===0)reclaim();
        const checkpointStart=performance.now();
        const saved=await save();
        log("SABY_SECTION_TIMING",{inn,phase,quick:sections.quickDetails===true,
          combined_details:sections.combinedDetails===true,
          contacts:sections.contacts,financials:sections.financials,trucks:sections.trucks,
          ...safeTimings,checkpoint_ms:Math.round(performance.now()-checkpointStart)});
        await onProgress({...saved.stats,company:row["Организация"]});
        if(consecutive>=settings.consecutiveErrors)throw circuit;
        if(phaseDone<phaseTotal&&visits<sessionLimit){
          const delayMs=pacing.next({success:appliedOk,systemic:consecutive>0,elapsedMs:visitMs});
          const start=performance.now();
          await sleep(delayMs,undefined,{signal:signal??undefined});
          sabyAddTiming(state.timing,"delay_ms",performance.now()-start);
        }
      }
      state.phase_index++;
      await save();
    }
  };
  try{
    if(acquireSabyBrowser){
      const start=performance.now();releaseBrowser=await acquireSabyBrowser();
      sabyAddTiming(state.timing,"admission_ms",performance.now()-start);
    }
    while(true){
      abort();
      let callbackError;
      let sessionOutcome;
      try{
        const openStart=performance.now();
        let closeStart=null;
        await sessionRunner(async ctx=>{
          sabyAddTiming(state.timing,"session_open_ms",performance.now()-openStart);
          try{sessionOutcome=await runSession(ctx);}
          catch(e){callbackError=e;throw e;}
          finally{closeStart=performance.now();}
        },{env});
        if(closeStart!==null)sabyAddTiming(state.timing,"session_close_ms",performance.now()-closeStart);
      }catch(e){
        if(isMemoryPause(e)||signal?.aborted||e?.message==="JOB_CANCELLED")throw e;
        // A checkpoint/storage/programming failure must never be treated
        // as a browser reconnect and silently replay successful work.
        if(callbackError&&callbackError!==circuit)throw callbackError;
        circuitOpen=e===circuit;
        browserError=circuitOpen?"":"SABY_BROWSER_UNAVAILABLE";
        if(restarts===maxRestarts)break;
        restarts++;
        consecutive=0;
        reclaim();
        log("SABY_SECTION_RECONNECT",{attempt:restarts,reason:circuitOpen?"systemic":"browser"});
        await save();
        await recoveryWait(restarts===1?5000:15000);
        if(releaseBrowser?.beforeReopen){
          const start=performance.now();await releaseBrowser.beforeReopen();
          sabyAddTiming(state.timing,"admission_ms",performance.now()-start);
        }
        continue;
      }
      circuitOpen=false;browserError="";
      if(sessionOutcome!=="rotate")break;
      // Context closure was awaited. Storage/re-admission failures below
      // are NOT browser failures and must propagate without consuming retries.
      rotations++;
      reclaim();
      log("SABY_BROWSER_ROTATED",{rotations,total_attempts:attempted.size});
      await save();
      if(releaseBrowser?.beforeReopen){
        const start=performance.now();await releaseBrowser.beforeReopen();
        sabyAddTiming(state.timing,"admission_ms",performance.now()-start);
      }
    }
    const out=await save();
    log("SABY_SECTION_DONE",{...out.stats,remaining:out.deferredInns.length});
    return out;
  }finally{releaseBrowser?.();}
}
