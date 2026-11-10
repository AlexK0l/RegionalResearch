// Stage 12: optional, bounded Saby enrichment after final research QA.
// No OpenAI requests. Never creates new organizations or changes A/B/C grades.
import { parsePhoneEntries } from "./phoneExport.js";
import { applySabyEnrichment, sabyEligibleRows, sabyInn } from "./sabyEnrichment.js";
import { withSabyBrowser, collectSabyCompany } from "./sabyBrowser.js";

const bounded = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
};
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));

export function sabyStage12Settings(env = process.env) {
  return {
    enabled:String(env.SABY_STAGE12_ENABLED || "false").toLowerCase() === "true",
    maxCompanies:bounded(env.SABY_MAX_COMPANIES, 0, 0, 20000),
    maxMs:bounded(env.STAGE12_MAX_MS, 30*60000, 60000, 120*60000),
    checkpointEvery:bounded(env.SABY_CHECKPOINT_EVERY, 5, 1, 50),
    consecutiveErrors:bounded(env.SABY_CIRCUIT_AFTER, 3, 1, 10),
    delayMs:bounded(env.SABY_DELAY_MS, 1500, 250, 30000)
  };
}

// A confirmed INN/name alone does not prove that Saby enrichment was read.
// For intermediary/leasing rows the relevant section is contacts only; direct
// buyers can additionally be completed by a verified truck section.
function hasRelevantSection(record, transport) {
  return record?.contacts?.status === "collected" ||
    (transport && record?.trucks?.status === "verified");
}

function phoneOwnersForResult(result) {
  const map=new Map();
  const rows=[...(result?.direct_buyers||[]),
    ...(result?.intermediaries||[]),...(result?.leasing||[])];
  for(const row of rows) {
    for (const {phone} of parsePhoneEntries(row?.["Телефон"])) {
      if (!map.has(phone)) map.set(phone,new Set());
      map.get(phone).add(row);
    }
  }
  return map;
}

export async function runSabyStage12({
  result,
  completedInns = [],
  offset = 0, // smoke-test pagination only; default leaves production intact
  env = process.env,
  onProgress = async () => {},
  onCheckpoint = async () => {},
  signal = null,
  sessionRunner = withSabyBrowser,
  collectCompany = collectSabyCompany
} = {}) {
  const settings=sabyStage12Settings(env);
  const completed=new Set((completedInns||[]).map(sabyInn).filter(Boolean));
  const plan=sabyEligibleRows(result);
  const pending=plan.eligible.filter(x=>!completed.has(sabyInn(x.row["ИНН"])));
  const start=Number.isSafeInteger(Number(offset)) && Number(offset)>=0 ?
    Math.min(Number(offset),20000) : 0;
  const selected=settings.maxCompanies ?
    pending.slice(start,start+settings.maxCompanies) : pending.slice(start);
  const stats={
    enabled:settings.enabled,eligible:plan.eligible.length,
    invalidInnOrName:plan.invalid.length,duplicateInn:plan.duplicates.length,
    previouslyCompleted:plan.eligible.length-pending.length,
    scheduled:selected.length,processed:0,verified:0,review:0,
    phonesAdded:0,transportsAdded:0,vehiclesVerified:0,
    partialResults:0,circuitOpen:false,browserError:"",
    deferred:settings.enabled ? pending.length : 0
  };
  if (!settings.enabled) return {stats,completedInns:[...completed],deferredInns:[]};
  if (!selected.length) return {stats,completedInns:[...completed],deferredInns:[]};

  const phoneOwners=phoneOwnersForResult(result);
  const startedAt=Date.now();
  let consecutive=0;

  const flush=async () => {
    const deferredInns=pending.map(x=>sabyInn(x.row["ИНН"]))
      .filter(inn=>!completed.has(inn));
    stats.deferred=deferredInns.length;
    await onCheckpoint({stats:{...stats},completedInns:[...completed],deferredInns});
  };

  try {
    await sessionRunner(async ({page,settings:browserSettings})=>{
      for(const entry of selected) {
        if(signal?.aborted) throw new Error("JOB_CANCELLED");
        if(Date.now()-startedAt>=settings.maxMs) break;
        const row=entry.row;
        const inn=sabyInn(row["ИНН"]);
        try {
          const record=await collectCompany(page,row,browserSettings);
          if(!hasRelevantSection(record,entry.transport)) {
            // Do not mutate the CRM row or checkpoint the company as done:
            // a Saby card may render its legal details before contacts/trucks.
            stats.review++;
            consecutive++;
            console.warn("[SABY_COLLECTION_REVIEW] "+JSON.stringify({
              reason:"relevant_sections_unavailable",
              contacts:["missing","review","collected"].includes(record?.contacts?.status)
                ? record.contacts.status : "unknown",
              trucks:["missing","review","verified"].includes(record?.trucks?.status)
                ? record.trucks.status : "unknown"
            }));
          } else {
            const applied=applySabyEnrichment(row,record,
              {phoneOwners,transport:entry.transport});
            if(applied.status==="ok") {
              completed.add(inn);
              stats.verified++;
              if(applied.phoneAdded) stats.phonesAdded++;
              if(applied.transportAdded) stats.transportsAdded++;
              if(applied.verifiedTrucks!==null)
                stats.vehiclesVerified+=applied.verifiedTrucks;
              if(record.errors?.length) stats.partialResults++;
              consecutive=0;
            } else {
              stats.review++;
              consecutive++;
            }
          }
        } catch(error) {
          if(signal?.aborted || error?.message==="JOB_CANCELLED") throw error;
          consecutive++;
          stats.review++;
          console.warn("[SABY_COMPANY_REVIEW] "+JSON.stringify({
            inn,error:String(error?.message||error).slice(0,300)
          }));
        }
        stats.processed++;
        await onProgress({...stats,company:row["Организация"]});
        if(stats.processed%settings.checkpointEvery===0) await flush();
        if(consecutive>=settings.consecutiveErrors) {
          stats.circuitOpen=true;
          console.warn("[SABY_CIRCUIT_OPEN] "+JSON.stringify({
            failures:consecutive,processed:stats.processed
          }));
          break;
        }
        if(stats.processed<selected.length) await sleep(settings.delayMs);
      }
    },{env});
  } catch(error) {
    if(signal?.aborted || error?.message==="JOB_CANCELLED") throw error;
    stats.browserError=String(error?.message||error).slice(0,400);
    console.warn("[SABY_BROWSER_UNAVAILABLE] "+JSON.stringify({
      error:stats.browserError
    }));
  }
  await flush();
  const deferredInns=pending.map(x=>sabyInn(x.row["ИНН"]))
    .filter(inn=>!completed.has(inn));
  return {stats,completedInns:[...completed],deferredInns};
}
