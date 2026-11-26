// Contact-only enrichment: immutable identity/qualification/finance/fleet.
// No OpenAI or Saby requests. Row-level proof and source outcome ledgers
// make the step resumable and allow a later new-source-only recovery pass.
import {createHash} from "node:crypto";
import {companyEmailCell,mergeCompanyEmail,normalizeEmail} from "./emailContact.js";
import {parsePhoneEntries,formatPhoneCell,explicitPhoneDepartment} from "./phoneExport.js";
import {normalizeRussianPhone} from "./researchCostPolicy.js";
import {contactPublicUrl,contactHost} from "./publicContactHttp.js";
import {createPublicContactHttp} from "./publicContactHttp.js";
import {contactSourceCandidates,contactDirectoryCard,publicContactTarget,lookupPublicCompanyContacts,publicPersonName}
  from "./publicContactParser.js";
const SECTIONS=["direct_buyers","intermediaries","leasing"];
const REVISION=1;
const safeInt=(v,d,min,max)=>{
  const raw=String(v??"").trim(),n=Number(raw);
  return /^\d+$/.test(raw)&&Number.isSafeInteger(n)?Math.min(max,Math.max(min,n)):d;
};
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const txt=x=>String(x??"").trim();
const profile=/закупок|снабжен|главный механик|техническая служба|транспортный отдел|отдел логистики|отдел эксплуатации/iu;
export function publicContactSettings(env=process.env){
  return {
    enabled:String(env.PUBLIC_CONTACTS_ENABLED??"false").toLowerCase()==="true",
    maxCompanies:safeInt(env.PUBLIC_CONTACTS_MAX_COMPANIES,350,1,3000),
    maxRequests:safeInt(env.PUBLIC_CONTACTS_MAX_REQUESTS,750,1,5000),
    maxMs:safeInt(env.PUBLIC_CONTACTS_MAX_MS,720000,15000,3600000),
    checkpointEvery:safeInt(env.PUBLIC_CONTACTS_CHECKPOINT_EVERY,5,1,20)
  };
}
export const publicContactEnabled=env=>publicContactSettings(env).enabled;
export function knownContactLeader(row){
  const s=txt(row?.["Руководитель / ЛПР"]);
  return !!s&&!/^(?:[-—–]+|н\/д|н\.д\.|нет данных|не (?:найден|подтвержд[её]н|установлен|указан)|неизвест)/iu.test(s);
}
export function contactMissingFields(row,{department=false}={}){
  const phones=parsePhoneEntries(row?.["Телефон"]);
  return {phone:!phones.length,email:!companyEmailCell(row),leader:!knownContactLeader(row),
    department:department&&!phones.some(x=>profile.test(x.department))};
}
export const needsAnyContact=row=>{
  const g=contactMissingFields(row);return g.phone||g.email||g.leader;
};
function rowsOf(result){
  return SECTIONS.flatMap(sheet=>(Array.isArray(result?.[sheet])?result[sheet]:[]).map(row=>({sheet,row})));
}
function grade(row){
  return txt(row?.__final_grade||row?.["Основание"]).toUpperCase().slice(0,1);
}
function priority(row,gaps){
  return (gaps.phone?1000:0)+(grade(row)==="A"?300:grade(row)==="B"?200:100)+
    (gaps.email?10:0)+(gaps.leader?3:0)+(gaps.department?1:0);
}
// Actual phone coverage, never substitute "contact ok" (which may be
// email-only). No source lookup and no mutation.
export function contactPhoneCoverage(result){
  const overall={rows:0,with_phone:0,without_phone:0,without_phone_with_inn:0,
    without_phone_without_inn:0},by_grade={},by_sheet={};
  const count=(target,row,has)=>{
    target.rows=(target.rows||0)+1;
    target.with_phone=(target.with_phone||0)+Number(has);
    target.without_phone=(target.without_phone||0)+Number(!has);
    target.without_phone_with_inn=(target.without_phone_with_inn||0)+
      Number(!has&&/^\d{10}(?:\d{2})?$/.test(txt(row["ИНН"])));
    target.without_phone_without_inn=(target.without_phone_without_inn||0)+
      Number(!has&&!/^\d{10}(?:\d{2})?$/.test(txt(row["ИНН"])));
  };
  for(const {row,sheet} of rowsOf(result)){
    const has=parsePhoneEntries(row["Телефон"]).length>0;
    const g=["A","B","C"].includes(grade(row))?grade(row):"other";
    if(!by_grade[g])by_grade[g]={};
    if(!by_sheet[sheet])by_sheet[sheet]={};
    count(overall,row,has);count(by_grade[g],row,has);count(by_sheet[sheet],row,has);
  }
  return {...overall,by_grade,by_sheet};
}
export function planPublicContactEnrichment(result,{priorOutcomes={},retryUnavailable=false,source="html",phoneOnly=false}={}){
  const rows=rowsOf(result),counts=new Map();
  for(const {row} of rows){
    const inn=txt(row?.["ИНН"]);if(inn)counts.set(inn,(counts.get(inn)||0)+1);
  }
  const stats={rows:rows.length,missing_phone:0,missing_email:0,missing_leader:0,
    missing_both:0,missing_identity:0,duplicate_identity:0,no_source:0,
    previously_attempted:0,eligible:0};
  const selected=[];
  for(const {row,sheet} of rows){
    const gaps=contactMissingFields(row,{department:source==="html"&&sheet==="direct_buyers"&&["A","B"].includes(grade(row))});
    stats.missing_phone+=Number(gaps.phone);stats.missing_email+=Number(gaps.email);
    stats.missing_leader+=Number(gaps.leader);stats.missing_both+=Number(gaps.phone&&gaps.email);
    if(phoneOnly&&!gaps.phone)continue;
    if(source==="fns"?!(gaps.email||gaps.leader):!Object.values(gaps).some(Boolean))continue;
    if(phoneOnly){gaps.email=false;gaps.leader=false;gaps.department=false;}
    const target=publicContactTarget(row);
    if(!target){stats.missing_identity++;continue;}
    if(counts.get(target.inn)!==1){stats.duplicate_identity++;continue;}
    const urls=source==="html"?contactSourceCandidates(row).flatMap(x=>x.seedUrls||[x.url]):[];
    if(source==="html"&&!urls.length){stats.no_source++;continue;}
    const id=source+":"+target.inn,signature=hash([target.name,urls]);
    const old=priorOutcomes[id];
    // A new verified-site hint may reopen just that firm's source pass.
    // An unchanged "no contact" or access failure is not blindly retried.
    if(old?.revision===REVISION&&old.signature===signature&&old.reason!=="deferred_budget"&&
      !(retryUnavailable&&["source_unavailable","no_readable_source","fns_unavailable"].includes(old.reason))){
      stats.previously_attempted++;continue;
    }
    selected.push({id,signature,row,sheet,gaps,target,priority:priority(row,gaps)});
  }
  selected.sort((a,b)=>b.priority-a.priority||a.target.inn.localeCompare(b.target.inn));
  stats.eligible=selected.length;
  return {selected,...stats};
}
function ownership(result){
  const phones=new Map(),emails=new Map();
  const add=(map,v,row)=>{
    if(!map.has(v))map.set(v,new Set());
    map.get(v).add(row);
  };
  for(const {row} of rowsOf(result)){
    for(const p of parsePhoneEntries(row["Телефон"]))add(phones,p.phone,row);
    for(const e of companyEmailCell(row).split("; ").filter(Boolean))add(emails,e,row);
  }
  return {phones,emails,add};
}
function proofValid(f,target){
  if(!f||f.inn!==target.inn||f.name!==target.name||
    !["Телефон","Электронная почта","Руководитель / ЛПР"].includes(f.field)||
    !contactPublicUrl(f.source_url)||!contactPublicUrl(f.identity_url)||
    !/^[a-f0-9]{64}$/.test(f.source_sha256||"")||!txt(f.excerpt)||
    txt(f.excerpt).length>300)return false;
  if(!/^[a-f0-9]{64}$/.test(f.identity_sha256||""))return false;
  if(f.method==="fns_extract_exact_entity")return f.source_url==="https://egrul.nalog.ru/index.html"&&
    f.identity_url===f.source_url&&f.source_sha256===f.identity_sha256&&
    /^\d{2}\.\d{2}\.\d{4}$/.test(f.extract_date||"")&&!!f.extract_number;
  if(f.method==="public_directory_exact_inn")return contactDirectoryCard(f.source_url)&&f.identity_url===f.source_url;
  return f.method==="public_html_exact_entity"&&contactHost(f.source_url)===contactHost(f.identity_url);
}
function safeOwner(map,value,row){
  return !map.has(value)||[...map.get(value)].every(x=>x===row);
}
export function applyPublicContactFacts(row,facts,{owners,target=publicContactTarget(row),gaps=contactMissingFields(row)}={}){
  if(!target||publicContactTarget(row)?.inn!==target.inn||
    publicContactTarget(row)?.name!==target.name||!owners)
    return {phone:0,email:0,leader:0,department:0,conflicts:0};
  const beforePhone=parsePhoneEntries(row["Телефон"]),beforeEmail=companyEmailCell(row),
    oldPhone=new Set(beforePhone.map(x=>x.phone));
  const adds=[],accepted=[],emails=[],people=new Map();
  let conflicts=0;
  for(const f of Array.isArray(facts)?facts.slice(0,60):[]){
    if(!proofValid(f,target))continue;
    if(f.field==="Телефон"){
      const number=normalizeRussianPhone(f.value);
      const department=explicitPhoneDepartment(f.department);
      if(!number||!parsePhoneEntries(f.excerpt).some(x=>x.phone===number)||
        !(gaps.phone||gaps.department&&profile.test(department)))continue;
      if(!safeOwner(owners.phones,number,row)){conflicts++;continue;}
      if(oldPhone.has(number)&&!department)continue;
      if(adds.some(x=>x.phone===number)||adds.length>=5)continue;
      adds.push({phone:number,department});accepted.push({...f,value:number,department});
    }else if(f.field==="Электронная почта"&&gaps.email){
      const email=normalizeEmail(f.value);
      if(!email||!f.excerpt.toLowerCase().includes(email)||emails.includes(email)||emails.length>=5)continue;
      if(!safeOwner(owners.emails,email,row)){conflicts++;continue;}
      emails.push(email);accepted.push({...f,value:email});
    }else if(f.field==="Руководитель / ЛПР"&&gaps.leader){
      const match=/^(.+?)\s+\((генеральный директор|исполнительный директор|директор|главный механик|руководитель отдела закупок|начальник отдела снабжения|начальник транспортного отдела)\)$/iu.exec(txt(f.value));
      if(match&&publicPersonName(match[1])&&f.excerpt.toLowerCase().includes(match[1].toLowerCase()))
        people.set(match[1].toLowerCase(),f);
    }
  }
  if(people.size===1&&!knownContactLeader(row)){
    const f=[...people.values()][0];row["Руководитель / ЛПР"]=f.value;accepted.push(f);
  }
  if(adds.length){
    row["Телефон"]=formatPhoneCell([...beforePhone,...adds].map(p=>p.phone+(p.department?" ("+p.department+")":"")));
    for(const p of adds)owners.add(owners.phones,p.phone,row);
  }
  if(emails.length){
    mergeCompanyEmail(row,emails);
    for(const e of emails)owners.add(owners.emails,e,row);
  }
  if(accepted.length){
    const ev=row.__evidence||{};
    const existing=Array.isArray(ev.public_contact_facts)?ev.public_contact_facts:[];
    const now=new Date().toISOString();
    const key=f=>[f.field,f.value,f.source_url].join("|");
    const byKey=new Map(existing.map(f=>[key(f),f]));
    for(const f of accepted)byKey.set(key(f),{...f,verified_at:now});
    // Keep contact proofs separate from qualification source_urls: adding
    // a procurement phone must not inflate A/B/C source diversity.
    row.__evidence={...ev,public_contact_facts:[...byKey.values()].slice(-30)};
  }
  return {phone:Number(!beforePhone.length&&parsePhoneEntries(row["Телефон"]).length>0),
    email:Number(!beforeEmail&&!!companyEmailCell(row)),
    leader:Number(gaps.leader&&knownContactLeader(row)),
    department:Number(adds.some(x=>profile.test(x.department))),conflicts};
}
export async function runPublicContactEnrichment({
  result,env=process.env,signal=null,priorOutcomes={},previousStats=null,
  retryUnavailable=false,phoneOnly=false,clientFactory=createPublicContactHttp,
  lookup=lookupPublicCompanyContacts,shouldPause=()=>false,
  onCheckpoint=async()=>{},onProgress=async()=>{}
}={}){
  const settings=publicContactSettings(env);
  const outcomes={...priorOutcomes},plan=planPublicContactEnrichment(result,{priorOutcomes:outcomes,retryUnavailable,phoneOnly});
  const prior=previousStats?.revision===REVISION?previousStats:{};
  const stats={revision:REVISION,enabled:settings.enabled,
    eligible:plan.eligible,scheduled:0,processed:Number(prior.processed||0),
    phone_added:Number(prior.phone_added||0),email_added:Number(prior.email_added||0),
    leader_added:Number(prior.leader_added||0),department_added:Number(prior.department_added||0),
    conflicts:Number(prior.conflicts||0),http_requests:Number(prior.http_requests||0),
    elapsed_ms:Number(prior.elapsed_ms||0),by_reason:{...prior.by_reason},
    source_error_reasons:{...prior.source_error_reasons},
    pending:plan.eligible,stop_reason:"",openai_requests:0,saby_requests:0,
    phone_only:phoneOnly,phone_coverage_before:prior.phone_coverage_before||contactPhoneCoverage(result)};
  if(!settings.enabled)return {stats,outcomes};
  const started=Date.now(),priorElapsed=stats.elapsed_ms;
  const deadlineAt=started+Math.max(0,settings.maxMs-priorElapsed);
  const client=clientFactory({maxRequests:settings.maxRequests,previousRequests:stats.http_requests,deadlineAt,signal});
  const targets=plan.selected.slice(0,Math.max(0,settings.maxCompanies-stats.processed));
  stats.scheduled=targets.length;
  const owners=ownership(result);
  let dirty=0,processedHere=0,incompleteHere=0;
  const save=async()=>{
    stats.http_requests=client.requests;
    stats.elapsed_ms=priorElapsed+Math.max(0,Date.now()-started);
    stats.pending=Math.max(0,plan.eligible-processedHere+incompleteHere);
    stats.phone_coverage_after=contactPhoneCoverage(result);
    await onCheckpoint({stats:{...stats,by_reason:{...stats.by_reason}},outcomes:{...outcomes}});
    dirty=0;
  };
  console.info("[PUBLIC_CONTACT_PLAN] "+JSON.stringify({source:"html",...stats,
    no_source:plan.no_source,missing_identity:plan.missing_identity,duplicate_identity:plan.duplicate_identity}));
  for(const t of targets){
    if(signal?.aborted){if(dirty)await save();throw Error("JOB_CANCELLED");}
    if(shouldPause()){await save();throw Error("MEMORY_PAUSE_NOT_COMMITTED");}
    if(client.exhausted||Date.now()>=deadlineAt){stats.stop_reason="budget_or_deadline";break;}
    let observed;
    try{observed=await lookup(t.row,client);}
    catch(error){
      if(signal?.aborted){if(dirty)await save();throw Error("JOB_CANCELLED");}
      observed={reason:"source_unavailable",facts:[]};
    }
    if(signal?.aborted){if(dirty)await save();throw Error("JOB_CANCELLED");}
    const gains=applyPublicContactFacts(t.row,observed?.facts,{owners,target:t.target,gaps:t.gaps});
    for(const field of ["phone","email","leader","department"])stats[field+"_added"]+=gains[field];
    stats.conflicts+=gains.conflicts;
    const reason=["verified_contacts","verified_no_contacts","identity_unproven","no_safe_source",
      "source_unavailable","no_readable_source","identity_invalid","deferred_budget"].includes(observed?.reason)?
      observed.reason:"source_unavailable";
    outcomes[t.id]={revision:REVISION,signature:t.signature,reason,
      gains,source_error_reasons:observed?.source_error_reasons||{},attempted_at:new Date().toISOString()};
    stats.processed++;processedHere++;dirty++;
    if(reason==="deferred_budget")incompleteHere++;
    stats.by_reason[reason]=Number(stats.by_reason[reason]||0)+1;
    for(const [key,n] of Object.entries(observed?.source_error_reasons||{})){
      if(!/^CONTACT_[A-Z_]{1,45}$/.test(key)||!Number.isSafeInteger(n)||n<0)continue;
      stats.source_error_reasons[key]=Number(stats.source_error_reasons[key]||0)+n;
    }
    if(dirty>=settings.checkpointEvery||shouldPause())await save();
    if(shouldPause())throw Error("MEMORY_PAUSE_NOT_COMMITTED");
    if(processedHere%10===0)await onProgress({...stats,current:processedHere,total:targets.length});
    if(reason==="deferred_budget"){stats.stop_reason="budget_or_deadline";break;}
  }
  if(!stats.stop_reason&&plan.eligible>processedHere)stats.stop_reason="company_limit";
  await save();
  console.info("[PUBLIC_CONTACT_DONE] "+JSON.stringify(stats));
  return {stats,outcomes};
}
export const publicContactOwnership=ownership;
export const PUBLIC_CONTACT_REVISION=REVISION;
