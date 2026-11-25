// Production Stage12: a finite set of section tasks, not a wall-clock
// deadline. Durable per-section cursors survive cooperative pauses/reconnects.
// The legacy single-company collector remains available for diagnostics.
import {setTimeout as sleep} from "node:timers/promises";
import {parsePhoneEntries} from "./phoneExport.js";
import {companyEmailCell} from "./emailContact.js";
import {contactResearchPriority} from "./researchCostPolicy.js";
import {contactPhoneCoverage} from "./publicContactEnrichment.js";
import {applySabyEnrichment,sabyEligibleRows,sabyInn,sabyStoredSectionCoverage,sabyMissingFinancials} from "./sabyEnrichment.js";
import {collectSabySections,withSabyBrowser,SabyReview} from "./sabyBrowser.js";
import {sabyStage12Settings} from "./sabyStage12.js";
import {validSabyFinancialEvidence} from "./sabyFinancials.js";
import {isMemoryPause} from "./memoryAdmission.js";

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
const contactsMissing=row=>!parsePhoneEntries(row["Телефон"]).length||!companyEmailCell(row);
function sectionNeeds(entry,phase){
  const {row,transport}=entry;
  const coverage=sabyStoredSectionCoverage(row,{transport});
  if(phase==="contacts"||phase==="contact_retry")
    return {contacts:contactsMissing(row),financials:false,trucks:false};
  const trucks=transport&&!coverage.trucks;
  return {contacts:false,trucks,financials:(phase==="details"||trucks)&&sabyMissingFinancials(row)};
}
const any=x=>Object.values(x).some(Boolean);
function unresolved(entry){
  return any(sectionNeeds(entry,"contacts"))||any(sectionNeeds(entry,"details"));
}
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
function safeState(raw,entries,limit){
  const all=new Set(entries.map(e=>sabyInn(e.row["ИНН"])));
  const valid=raw?.version===1&&Array.isArray(raw.planned_inns)&&Array.isArray(raw.attempted);
  if(valid){
    const ids=[...new Set(raw.planned_inns.map(sabyInn).filter(id=>all.has(id)))];
    const allowed=new Set(ids);
    const attempted=raw.attempted.filter(key=>{
      if(typeof key!=="string")return false;
      const [phase,id,...rest]=key.split(":");
      return !rest.length&&PHASES.includes(phase)&&allowed.has(id);
    });
    return {version:1,planned_inns:ids,attempted:[...new Set(attempted)],
      verified_inns:[...new Set((Array.isArray(raw.verified_inns)?raw.verified_inns:[]).map(sabyInn).filter(id=>allowed.has(id)))],
      initially_complete:Math.max(0,Math.min(entries.length,Number(raw.initially_complete)||0)),
      phase_index:Math.max(0,Math.min(PHASES.length,Math.trunc(Number(raw.phase_index)||0))),
      stats:Object.fromEntries(counters.map(k=>[k,Math.max(0,Number(raw.stats?.[k])||0)]))};
  }
  const pending=entries.filter(unresolved);
  return {version:1,planned_inns:(limit?pending.slice(0,limit):pending).map(e=>sabyInn(e.row["ИНН"])),
    attempted:[],verified_inns:[],initially_complete:entries.length-pending.length,phase_index:0,stats:emptyStats()};
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
  const all=sabyEligibleRows(result,{includeAll:true,includeFinanceGaps:true});
  // Stable INN mapping includes rows whose gaps are filled during the run.
  const entries=all.eligible,byInn=new Map(entries.map(e=>[sabyInn(e.row["ИНН"]),e]));
  const state=safeState(passState,entries,settings.maxCompanies);
  const attempted=new Set(state.attempted),verifiedInns=new Set(state.verified_inns);
  const planned=state.planned_inns.map(id=>byInn.get(id)).filter(Boolean);
  const ownerMap=phoneOwnersForResult(result);
  const abort=()=>{if(signal?.aborted)throw Error("JOB_CANCELLED");};
  let restarts=0,consecutive=0,circuitOpen=false,browserError="";
  let releaseBrowser,phaseDone=0,phaseTotal=0,rotations=0;
  const reclaim=()=>{
    if(typeof collectGarbage==="function")try{collectGarbage();}catch{/* best effort */}
  };
  const stateSnapshot=()=>({...state,attempted:[...attempted],verified_inns:[...verifiedInns],stats:{...state.stats}});
  const snapshot=()=>{
    const deferred=entries.filter(unresolved).map(e=>sabyInn(e.row["ИНН"]));
    const done=entries.filter(e=>!unresolved(e)).map(e=>sabyInn(e.row["ИНН"]));
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
        phoneCoverage:contactPhoneCoverage(result)},
      completedInns:done,deferredInns:settings.enabled?deferred:[],
      attemptedInns:[...visited].filter(id=>deferred.includes(id)),
      passState:stateSnapshot()
    };
  };
  const save=async()=>{
    const out=snapshot();
    await persistCheckpoint("saby",{completed_stage:9,stage11_completed:true,final_result:result,
      saby_completed_inns:out.completedInns,saby_deferred_inns:out.deferredInns,
      saby_attempted_inns:out.attemptedInns,saby_pass_state:out.passState,saby_stats:out.stats});
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
      const tasks=planned.filter(e=>any(sectionNeeds(e,phase))&&
        !attempted.has(phase+":"+sabyInn(e.row["ИНН"])))
        .sort((a,b)=>contactResearchPriority(b.row)-contactResearchPriority(a.row));
      phaseDone=[...attempted].filter(key=>key.startsWith(phase+":")).length;
      phaseTotal=phaseDone+tasks.length;
      log("SABY_SECTION_PLAN",{phase,scheduled:phaseTotal,visited:phaseDone});
      await onProgress(snapshot().stats);
      for(const entry of tasks){
        abort();
        const {row,transport}=entry,inn=sabyInn(row["ИНН"]),sections=sectionNeeds(entry,phase);
        const key=phase+":"+inn;
        if(attempted.has(key)||!any(sections))continue;
        if(visits>=sessionLimit)return "rotate";
        let record,error;
        try{record=await collectSections(page,row,browserSettings,sections);}
        catch(e){if(isMemoryPause(e)||signal?.aborted||e?.message==="JOB_CANCELLED")throw e;error=e;}
        abort();
        if(error){
          state.stats.review++;
          if(error instanceof SabyReview&&error.scope==="company"){
            state.stats.companyReviews++;consecutive=0;
          }else{
            state.stats.systemicErrors++;consecutive++;
          }
          // Do not log raw browser errors or private page contents.
          log("SABY_SECTION_REVIEW",{inn,phase,scope:consecutive?"systemic":"company"});
        }else{
          const relevant=(sections.contacts&&record?.contacts?.status==="collected")||
            (sections.trucks&&record?.trucks?.status==="verified")||
            (sections.financials&&Boolean(validSabyFinancialEvidence(record?.financials)));
          const applied=relevant?applySabyEnrichment(row,record,{phoneOwners:ownerMap,transport}):null;
          if(applied?.status==="ok"){
            state.stats.verified++;
            verifiedInns.add(inn);
            for(const [stat,flag] of [["phonesAdded","phoneAdded"],["emailsAdded","emailAdded"],
              ["transportsAdded","transportAdded"],["revenuesAdded","revenueAdded"],["employeesAdded","employeesAdded"]])
              if(applied[flag])state.stats[stat]++;
            // A carried, previously verified fleet is not a new observation.
            if(sections.trucks&&record.trucks?.status==="verified"&&applied.verifiedTrucks!==null)
              state.stats.vehiclesVerified+=applied.verifiedTrucks;
            if(any(sectionNeeds(entry,phase)))state.stats.partialResults++;
          }else{state.stats.review++;state.stats.companyReviews++;}
          consecutive=0;
        }
        // Persist even an unsuccessful attempted task, but keep its data
        // gaps unresolved. Another pass may retry it at most once.
        attempted.add(key);phaseDone++;visits++;
        // Drop the last browser record before the GC/snapshot boundary.
        record=undefined;error=undefined;
        if(attempted.size%gcEvery===0)reclaim();
        const saved=await save();
        await onProgress({...saved.stats,company:row["Организация"]});
        if(consecutive>=settings.consecutiveErrors)throw circuit;
        if(phaseDone<phaseTotal&&visits<sessionLimit)
          await sleep(settings.delayMs,undefined,{signal:signal??undefined});
      }
      state.phase_index++;
      await save();
    }
  };
  try{
    if(acquireSabyBrowser)releaseBrowser=await acquireSabyBrowser();
    while(true){
      abort();
      consecutive=0;
      let callbackError;
      let sessionOutcome;
      try{
        await sessionRunner(async ctx=>{
          try{sessionOutcome=await runSession(ctx);}
          catch(e){callbackError=e;throw e;}
        },{env});
        circuitOpen=false;browserError="";
        if(sessionOutcome!=="rotate")break;
        // withSabyBrowser has awaited context.close() at this point.
        // Reclaim only after the context's async stack has unwound.
        rotations++;
        reclaim();
        log("SABY_BROWSER_ROTATED",{rotations,total_attempts:attempted.size});
        await save();
        if(releaseBrowser?.beforeReopen)await releaseBrowser.beforeReopen();
        continue;
      }catch(e){
        if(isMemoryPause(e)||signal?.aborted||e?.message==="JOB_CANCELLED")throw e;
        // A checkpoint/storage/programming failure must never be treated
        // as a browser reconnect and silently replay successful work.
        if(callbackError&&callbackError!==circuit)throw callbackError;
        circuitOpen=e===circuit;
        browserError=circuitOpen?"":"SABY_BROWSER_UNAVAILABLE";
        if(restarts===maxRestarts)break;
        restarts++;
        reclaim();
        log("SABY_SECTION_RECONNECT",{attempt:restarts,reason:circuitOpen?"systemic":"browser"});
        await save();
        await recoveryWait(restarts===1?5000:15000);
        if(releaseBrowser?.beforeReopen)await releaseBrowser.beforeReopen();
      }
    }
    const out=await save();
    log("SABY_SECTION_DONE",{...out.stats,remaining:out.deferredInns.length});
    return out;
  }finally{releaseBrowser?.();}
}
