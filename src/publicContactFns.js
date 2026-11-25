// Opt-in official EGRUL extraction. Reuse the validated public form and
// complete PDF proof. No guessed URLs, CAPTCHA bypass or per-company browser.
import {withPublicRegistryLookup} from "./independentInnRegistryBrowser.js";
import {isOfficialExtractProof} from "./independentInnFnsExtract.js";
import {registeredContactName,publicContactTarget} from "./publicContactParser.js";
import {planPublicContactEnrichment,applyPublicContactFacts,publicContactOwnership,
  PUBLIC_CONTACT_REVISION} from "./publicContactEnrichment.js";
const bounded=(v,d,min,max)=>/^\d+$/.test(String(v??"").trim())?
  Math.max(min,Math.min(max,Number(v))):d;
export const fnsContactEnabled=(env=process.env)=>
  String(env.PUBLIC_CONTACTS_FNS_ENABLED??"false").toLowerCase()==="true";
let tail=Promise.resolve();
async function serialBrowser(task,options){
  const run=tail.then(()=>withPublicRegistryLookup(task,options));
  tail=run.catch(()=>{});
  return run;
}
function sameIdentity(record,target){
  return record?.inn===target.inn&&
    [record.full_name,record.short_name].some(n=>registeredContactName(n)===target.name)&&
    /^\d{13}$/.test(String(record.ogrn||""))&&/^\d{9}$/.test(String(record.kpp||""));
}
export async function lookupFnsCompanyContacts(row,lookup){
  const target=publicContactTarget(row);
  if(!target)return {reason:"fns_identity_unproven",facts:[]};
  const found=await lookup.search({organization:row["Организация"]},{inn:target.inn});
  if(found?.state!=="observed"||!found.complete||!found.allCardsRead||
    found.records?.length!==1||!sameIdentity(found.records[0].record,target)||
    found.records[0].record.active===false)
    return {reason:"fns_identity_unproven",facts:[]};
  const expected=found.records[0].record;
  const proof=await lookup.confirm(expected.ogrn,expected);
  if(!isOfficialExtractProof(proof,target.inn)||!sameIdentity(proof.record,target)||
    proof.record.ogrn!==expected.ogrn||proof.record.kpp!==expected.kpp||!proof.record.active||
    registeredContactName(proof.record.full_name)!==registeredContactName(expected.full_name)||
    registeredContactName(proof.record.short_name)!==registeredContactName(expected.short_name))
    return {reason:"fns_extract_unproven",facts:[]};
  const facts=(Array.isArray(proof.contact_facts)?proof.contact_facts:[]).filter(f=>
    ["Электронная почта","Руководитель / ЛПР"].includes(f.field)).map(f=>({
      ...f,inn:target.inn,name:target.name,method:"fns_extract_exact_entity",
      source_url:proof.url,identity_url:proof.url,
      source_sha256:proof.extract.sha256,identity_sha256:proof.extract.sha256,
      extract_date:proof.extract.date,extract_number:proof.extract.number,
      page_count:proof.extract.page_count
    }));
  return {reason:facts.length?"fns_contacts_verified":"fns_no_contacts",facts};
}
export async function runFnsContactEnrichment({result,env=process.env,signal=null,
  priorOutcomes={},previousStats=null,retryUnavailable=false,shouldPause=()=>false,
  onCheckpoint=async()=>{},sessionRunner=serialBrowser}={}){
  const enabled=fnsContactEnabled(env),outcomes={...priorOutcomes};
  const plan=planPublicContactEnrichment(result,{priorOutcomes:outcomes,source:"fns",retryUnavailable});
  const prev=previousStats?.revision===PUBLIC_CONTACT_REVISION?previousStats:{};
  const maxCompanies=bounded(env.PUBLIC_CONTACTS_FNS_MAX_COMPANIES,25,1,200),
    maxMs=bounded(env.PUBLIC_CONTACTS_FNS_MAX_MS,900000,60000,3600000);
  const stats={revision:PUBLIC_CONTACT_REVISION,enabled,eligible:plan.eligible,scheduled:0,
    processed:Number(prev.processed||0),phone_added:0,email_added:Number(prev.email_added||0),
    leader_added:Number(prev.leader_added||0),department_added:0,conflicts:Number(prev.conflicts||0),
    page_navigations:Number(prev.page_navigations||0),elapsed_ms:Number(prev.elapsed_ms||0),
    by_reason:{...prev.by_reason},pending:plan.eligible,stop_reason:"",
    openai_requests:0,saby_requests:0};
  if(!enabled)return {stats,outcomes};
  const targets=plan.selected.slice(0,Math.max(0,maxCompanies-stats.processed));
  stats.scheduled=targets.length;
  const started=Date.now(),priorElapsed=stats.elapsed_ms,deadline=started+Math.max(0,maxMs-priorElapsed),
    priorPages=stats.page_navigations;
  const owners=publicContactOwnership(result);
  let here=0,entered=false,failures=0,lookupRef=null;
  const save=async()=>{
    stats.pending=Math.max(0,plan.eligible-here);
    stats.page_navigations=priorPages+Number(lookupRef?.pages||0);
    stats.elapsed_ms=priorElapsed+Math.max(0,Date.now()-started);
    await onCheckpoint({stats:{...stats,by_reason:{...stats.by_reason}},outcomes:{...outcomes}});
  };
  if(!targets.length||Date.now()>=deadline||priorPages>=maxCompanies*3){
    stats.stop_reason=plan.eligible?"budget_or_deadline":"";await save();return {stats,outcomes};
  }
  if(signal?.aborted)throw Error("JOB_CANCELLED");
  if(shouldPause()){await save();throw Error("MEMORY_PAUSE_NOT_COMMITTED");}
  try{
    await sessionRunner(async lookup=>{
      entered=true;lookupRef=lookup;
      for(const t of targets){
        if(signal?.aborted)throw Error("JOB_CANCELLED");
        if(shouldPause()){await save();throw Error("MEMORY_PAUSE_NOT_COMMITTED");}
        if(Date.now()>=deadline){stats.stop_reason="budget_or_deadline";break;}
        let observed;
        try{observed=await lookupFnsCompanyContacts(t.row,lookup);failures=0;}
        catch(error){
          if(signal?.aborted)throw Error("JOB_CANCELLED");
          if(error?.code==="navigation_budget"){stats.stop_reason="budget_or_deadline";break;}
          observed={reason:"fns_unavailable",facts:[]};
          failures++;
          if(/captcha|http_unavailable|route_untrusted|pdftotext_missing|extract_unavailable/i.test(String(error?.code||error?.message||"")))
            failures=3;
        }
        if(signal?.aborted)throw Error("JOB_CANCELLED");
        const gains=applyPublicContactFacts(t.row,observed.facts,{owners,target:t.target,gaps:t.gaps});
        stats.email_added+=gains.email;stats.leader_added+=gains.leader;stats.conflicts+=gains.conflicts;
        outcomes[t.id]={revision:PUBLIC_CONTACT_REVISION,signature:t.signature,
          reason:observed.reason,gains,attempted_at:new Date().toISOString()};
        stats.by_reason[observed.reason]=Number(stats.by_reason[observed.reason]||0)+1;
        stats.processed++;here++;
        // Durable per-company ledger; pause errors unwind the browser via
        // the existing withPublicRegistryLookup finally block.
        await save();
        if(shouldPause())throw Error("MEMORY_PAUSE_NOT_COMMITTED");
        if(failures>=3){stats.stop_reason="source_unavailable";break;}
      }
    },{provider:"fns",confirmationMode:"extract",
      maxPages:Math.max(1,Math.min(600,maxCompanies*3-priorPages)),delayMs:2000});
  }catch(error){
    // A storage or pause error from INSIDE the callback must propagate.
    // Only a browser startup failure is downgraded to a source outage.
    if(entered||signal?.aborted)throw error;
    stats.stop_reason="browser_unavailable";
  }
  if(!stats.stop_reason&&plan.eligible>here)stats.stop_reason="company_limit";
  await save();
  console.info("[FNS_CONTACT_DONE] "+JSON.stringify(stats));
  return {stats,outcomes};
}
