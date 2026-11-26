// Independent current legal status from the public FNS form + complete
// extract. No model decisions, guessed deep links or edits to CRM membership.
import {withPublicRegistryLookup} from "./independentInnRegistryBrowser.js";
import {isCurrentOfficialExtractProof,validExtractCessation} from "./independentInnFnsExtract.js";
import {fnsSourceUrl} from "./independentInnFns.js";
import {registeredContactName,publicContactTarget} from "./publicContactParser.js";
import {identityOgrns,normalizedOgrn} from "./legalIdentity.js";
import {commercialEligibility} from "./qualificationSafety.js";
const SECTIONS=["direct_buyers","intermediaries","leasing"];
const txt=v=>String(v??"").normalize("NFKC").replace(/\s+/gu," ").trim();
const sameName=(a,b)=>{
  const left=registeredContactName(a),right=registeredContactName(b);
  return left&&right?left===right:!!txt(a)&&txt(a).toUpperCase()===txt(b).toUpperCase();
};
const rowsOf=result=>SECTIONS.flatMap(k=>Array.isArray(result?.[k])?result[k]:[]);
function legalStatusTarget(row){
  const target=publicContactTarget(row),ogrns=identityOgrns(row),ev=row?.__evidence||{};
  if(!target||ogrns.length>1||ev.legal_identity_conflicts?.length||
    [ev.identity_verification,ev.saby,ev.saby_finance_backfill].some(p=>p?.inn&&txt(p.inn)!==target.inn))return null;
  return {...target,ogrn:ogrns[0]||""};
}
function exactRecord(record,target){
  return record?.inn===target.inn&&
    [record.full_name,record.short_name].some(n=>registeredContactName(n)===target.name)&&
    /^\d{13}$/.test(record.ogrn||"")&&normalizedOgrn(record.ogrn)===record.ogrn&&
    /^\d{9}$/.test(record.kpp||"")&&(!target.ogrn||target.ogrn===record.ogrn);
}
function identitySignature(target){return JSON.stringify([target.inn,target.name,target.ogrn]);}
export function buildFnsLegalStatusEvidence(row,proof,{now=Date.now()}={}){
  const target=legalStatusTarget(row);
  if(!target||!isCurrentOfficialExtractProof(proof,target.inn,now)||!exactRecord(proof.record,target))return null;
  const e=proof.extract,r=proof.record;
  const ceased=r.active===false&&validExtractCessation(proof.cessation,e.date);
  const status=r.active===true?"no_adverse_status":ceased?"ceased":"adverse_status_review";
  return {status,inn:target.inn,legal_name:target.name,ogrn:r.ogrn,kpp:r.kpp,
    source_url:proof.url,method:"fns_current_extract",status_basis:e.status_basis,
    extract_date:e.date,extract_number:e.number,extract_sha256:e.sha256,page_count:e.page_count,
    ...(ceased?{cessation:{...proof.cessation}}:{}),checked_at:new Date(now).toISOString()};
}
function savedProofValid(row,proof,now){
  const target=legalStatusTarget(row);
  if(!target||!proof||proof.method!=="fns_current_extract"||proof.inn!==target.inn||
    proof.legal_name!==target.name||proof.source_url!==fnsSourceUrl(target.inn)||
    !/^\d{13}$/.test(proof.ogrn||"")||normalizedOgrn(proof.ogrn)!==proof.ogrn||
    !/^\d{9}$/.test(proof.kpp||"")||(target.ogrn&&proof.ogrn!==target.ogrn)||
    !["no_adverse_status","ceased","adverse_status_review"].includes(proof.status))return false;
  const active=proof.status==="no_adverse_status";
  if(!isCurrentOfficialExtractProof({kind:"fns_extract",url:proof.source_url,record:{active},
    extract:{date:proof.extract_date,number:proof.extract_number,sha256:proof.extract_sha256,
      page_count:proof.page_count,status_basis:proof.status_basis}},target.inn,now))return false;
  return proof.status!=="ceased"||validExtractCessation(proof.cessation,proof.extract_date);
}
export function applyFnsLegalStatusEvidence(row,proof,{now=Date.now()}={}){
  if(!savedProofValid(row,proof,now))return false;
  const old=row.__evidence?.fns_legal_status;
  if(old&&savedProofValid(row,old,now)&&Date.parse(old.checked_at)>Date.parse(proof.checked_at))return false;
  row.__evidence={...(row.__evidence||{}),fns_legal_status:structuredClone(proof)};
  // This is a separate operational note, NOT qualification evidence.
  // Do not edit the grade, score, phone, financials or commercial sheets.
  const label=proof.status==="ceased"?"прекращение деятельности "+proof.cessation.termination_date+" — проверить перед звонком":
    proof.status==="adverse_status_review"?"неблагоприятный статус — требуется проверка":
      "в полной выписке не обнаружен неблагоприятный статус";
  const comment="ЕГРЮЛ (независимая проверка): "+label+"; выписка от "+proof.extract_date+" № "+proof.extract_number+" · "+proof.source_url;
  row.__comment=[...String(row.__comment||"").split(/\r?\n/).filter(l=>l.trim()&&!/^ЕГРЮЛ \(независимая проверка\):/u.test(l.trim())),comment].join("\n");
  return true;
}
export async function lookupFnsLegalStatus(row,lookup,{now=Date.now()}={}){
  const target=legalStatusTarget(row);
  if(!target)return {reason:"fns_identity_unproven",proof:null};
  const search=await lookup.search({organization:row["Организация"]},{inn:target.inn});
  const observed=search?.records?.[0],expected=observed?.record;
  if(search?.state!=="observed"||search.complete!==true||search.allCardsRead!==true||
    search.records?.length!==1||observed.provider!=="fns"||observed.url!==fnsSourceUrl(target.inn)||
    !exactRecord(expected,target))return {reason:"fns_identity_unproven",proof:null};
  const downloaded=await lookup.confirm(expected.ogrn,expected);
  const evidence=buildFnsLegalStatusEvidence(row,downloaded,{now});
  if(!evidence||downloaded.record.ogrn!==expected.ogrn||downloaded.record.kpp!==expected.kpp||
    !sameName(downloaded.record.full_name,expected.full_name)||!sameName(downloaded.record.short_name,expected.short_name))
    return {reason:"fns_extract_unproven",proof:null};
  if(expected.active===false&&evidence.status==="no_adverse_status")
    return {reason:"fns_status_conflict",proof:null};
  return {reason:evidence.status,proof:evidence};
}
export function planFnsLegalStatus(result,{priorOutcomes={},retryUnavailable=false,now=Date.now()}={}){
  const rows=rowsOf(result),counts=new Map();
  for(const row of rows){const inn=txt(row?.["ИНН"]);if(inn)counts.set(inn,(counts.get(inn)||0)+1);}
  const stats={rows:rows.length,missing_or_conflicting_identity:0,duplicate_identity:0,already_current:0,previously_attempted:0,eligible:0};
  const selected=[];
  for(const row of rows){
    const target=legalStatusTarget(row);
    if(!target){stats.missing_or_conflicting_identity++;continue;}
    if(counts.get(target.inn)!==1){stats.duplicate_identity++;continue;}
    if(savedProofValid(row,row.__evidence?.fns_legal_status,now)){stats.already_current++;continue;}
    const signature=identitySignature(target),old=priorOutcomes[target.inn],attempted=Date.parse(old?.attempted_at);
    if(!retryUnavailable&&old?.signature===signature&&Number.isFinite(attempted)&&now>=attempted&&now-attempted<86400000){
      stats.previously_attempted++;continue;
    }
    const eligibility=commercialEligibility(row),grade=txt(row.__final_grade||row["Основание"]).toUpperCase().slice(0,1);
    const closureHint=eligibility.needs_review||eligibility.kind==="ceased"||
      ["ceased","adverse_status_review"].includes(row.__evidence?.fns_legal_status?.status);
    selected.push({row,target,signature,priority:(closureHint?100:0)+(grade==="A"?3:grade==="B"?2:1)});
  }
  selected.sort((a,b)=>b.priority-a.priority||a.target.inn.localeCompare(b.target.inn));
  stats.eligible=selected.length;
  return {selected,...stats};
}
export async function runFnsLegalStatusCheck({result,priorOutcomes={},retryUnavailable=false,signal=null,
  limit=25,maxMs=900000,sessionRunner=withPublicRegistryLookup,onCheckpoint=async()=>{},now=()=>Date.now()}={}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(maxMs)||maxMs<60000||maxMs>3600000)
    throw Error("FNS_LEGAL_STATUS_BAD_BUDGET");
  const plan=planFnsLegalStatus(result,{priorOutcomes,retryUnavailable,now:now()});
  const outcomes={...priorOutcomes},targets=plan.selected.slice(0,limit);
  const stats={eligible:plan.eligible,scheduled:targets.length,processed:0,no_adverse_status:0,ceased:0,
    adverse_status_review:0,unconfirmed:0,pending:plan.eligible,page_navigations:0,stop_reason:"",
    openai_requests:0,saby_requests:0};
  const started=now(),deadline=started+maxMs;
  let lookupRef=null,entered=false,failures=0;
  const save=async()=>{
    stats.pending=Math.max(0,plan.eligible-stats.processed);
    stats.page_navigations=Number(lookupRef?.pages||0);
    stats.elapsed_ms=Math.max(0,now()-started);
    await onCheckpoint({stats:{...stats},outcomes:{...outcomes}});
  };
  if(!targets.length)return {stats,outcomes};
  if(signal?.aborted)throw Error("JOB_CANCELLED");
  try{
    await sessionRunner(async lookup=>{
      entered=true;lookupRef=lookup;
      for(const t of targets){
        if(signal?.aborted)throw Error("JOB_CANCELLED");
        if(now()>=deadline){stats.stop_reason="budget_or_deadline";break;}
        let observed;
        try{observed=await lookupFnsLegalStatus(t.row,lookup,{now:now()});failures=0;}
        catch(error){
          if(signal?.aborted)throw Error("JOB_CANCELLED");
          if(error?.code==="navigation_budget"){stats.stop_reason="budget_or_deadline";break;}
          observed={reason:"fns_unavailable",proof:null};failures++;
          if(/captcha|http_unavailable|route_untrusted|pdftotext_missing|extract_unavailable/i.test(String(error?.code||error?.message||"")))failures=3;
        }
        if(signal?.aborted)throw Error("JOB_CANCELLED");
        const accepted=observed.proof&&applyFnsLegalStatusEvidence(t.row,observed.proof,{now:now()});
        const status=accepted?observed.proof.status:"unconfirmed";
        stats[status]++;stats.processed++;
        outcomes[t.target.inn]={signature:t.signature,status,reason:accepted?observed.reason:
          observed.proof?"fns_extract_stale_or_conflicting":observed.reason,attempted_at:new Date(now()).toISOString()};
        await save();
        if(failures>=3){stats.stop_reason="source_unavailable";break;}
      }
    },{provider:"fns",confirmationMode:"extract",maxPages:limit*3,delayMs:2000});
  }catch(error){
    // Never turn failed SQLite writes or an interrupted paid/other job into
    // a successful source result. Only startup failure is downgraded.
    if(entered||signal?.aborted)throw error;
    stats.stop_reason="browser_unavailable";
  }
  if(!stats.stop_reason&&plan.eligible>stats.processed)stats.stop_reason="company_limit";
  await save();
  return {stats,outcomes};
}
