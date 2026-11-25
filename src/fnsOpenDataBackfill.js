// Official open-data enrichment; archive-name hits are candidates, NOT identity proof.
import {auditSourceRows} from "./sabyIdentityAudit.js";
import {verifiedInnChecksum,buildMissingInnRecoveryQueue} from "./sabyMissingInnRecovery.js";
import {identityOgrns,normalizedOgrn} from "./legalIdentity.js";
import {registeredSourceName} from "./independentInnBackfill.js";
const FIELD="Численность";
const clean=v=>String(v??"").normalize("NFKC").replace(/\s+/gu," ").trim();
const token=v=>clean(v).toLowerCase().replace(/ё/g,"е").replace(/[^a-zа-я0-9]+/gu," ").trim();
const forms=[
 ["фгуп","федеральное государственное унитарное предприятие"],["гуп","государственное унитарное предприятие"],
 ["муп","муниципальное унитарное предприятие"],["ооо","общество с ограниченной ответственностью"],
 ["пао","публичное акционерное общество"],["оао","открытое акционерное общество"],
 ["зао","закрытое акционерное общество"],["ао","акционерное общество"]];
export function archiveNameKey(value){
  const s=token(value);
  for(const [form,long] of forms){
    for(const p of [long,form])if(s.startsWith(p+" "))return form+":"+s.slice(p.length+1);
    if(s.endsWith(" "+form))return form+":"+s.slice(0,-form.length-1);
  }
  return "";
}
const validInn=v=>typeof v==="string"&&/^\d{10}$/.test(v)&&v!=="0000000000"&&verifiedInnChecksum(v);
const number=v=>(typeof v==="number"||typeof v==="string"&&/^\d+$/.test(v.trim()))&&Number.isSafeInteger(Number(v))&&Number(v)>=0;
const innOf=row=>clean(row["ИНН"]);
const unsafe=row=>!archiveNameKey(row["Организация"])||
  /[\/;]|(?:^|\s)(?:филиал|представительство|бренд|группа компаний|обособленное подразделение)(?:\s|$)/iu.test(row["Организация"]||"");
function conflict(row){
  const inn=innOf(row),ev=row.__evidence||{};
  return Boolean(ev.legal_identity_conflicts?.length||identityOgrns(row).length>1||
    [ev.identity_verification,ev.saby,ev.saby_finance_backfill].some(e=>e?.inn&&inn&&clean(e.inn)!==inn));
}
function checkedRows(cp){
  if(cp?.version!==1||!["full","saby"].includes(cp.source_mode)||!["saby","completed"].includes(cp.phase)||
    (cp.source_mode==="full"&&cp.phase!=="completed")||!Array.isArray(cp.final_result?.statistics))
    throw Error("FNS_OPEN_DATA_CHECKPOINT_NOT_READY");
  const rows=auditSourceRows(cp).map(e=>e.row),ids=new Set();
  for(const r of rows){
    const id=clean(r.__canonical_id);
    if(!/^[a-z0-9_.:-]{1,100}$/i.test(id)||ids.has(id)||["__proto__","constructor","prototype"].includes(id))
      throw Error("FNS_OPEN_DATA_BAD_ROW_ID");
    ids.add(id);
  }
  return rows;
}
export function planFnsOpenData(cp){
  const rows=checkedRows(cp),freq=new Map();
  for(const row of rows)if(validInn(innOf(row)))freq.set(innOf(row),(freq.get(innOf(row))||0)+1);
  const staff=rows.filter(r=>!number(r[FIELD])&&validInn(innOf(r))&&freq.get(innOf(r))===1&&!unsafe(r)&&!conflict(r));
  const missing=buildMissingInnRecoveryQueue(cp).rows;
  const byId=new Map(rows.map(r=>[clean(r.__canonical_id),r]));
  const candidates=missing.map(t=>byId.get(t.original_canonical_id)).filter(r=>r&&!innOf(r)&&!unsafe(r)&&!conflict(r));
  return {rows,staff,candidates,total:rows.length,employees_missing:rows.filter(r=>!number(r[FIELD])).length,
    missing_inn:missing.length,targets:{inns:[...new Set(staff.map(innOf))],
      ogrns:[...new Set(candidates.flatMap(identityOgrns).filter(v=>v.length===13))],
      names:[...new Set(candidates.map(r=>clean(r["Организация"])))]}};
}
function trustedSource(s){
  if(!["sshr","rsmp"].includes(s?.kind)||!Number.isSafeInteger(s.report_year)||
    !/^\d{4}-\d{2}-\d{2}$/.test(s.release||"")||!Number.isSafeInteger(s.bytes)||s.bytes<=0||
    !/^[a-f0-9]{64}$/.test(s.sha256||"")||!/^[a-f0-9]{64}$/.test(s.schema_sha256||""))return false;
  const prefix="https://file.nalog.ru/opendata/7707329152-"+(s.kind==="sshr"?"sshr2019":"rsmp")+"/";
  if(typeof s.url!=="string"||!s.url.startsWith(prefix))return false;
  const m=/^data-(\d{8})-structure-(\d{8})\.zip$/.exec(s.url.slice(prefix.length));
  return !!m&&s.schema_url===prefix+"structure-"+m[2]+".xsd";
}
function validRecord(r,s){
  return !!r&&validInn(r.inn)&&(s.kind==="sshr"?!r.ogrn:/^\d{13}$/.test(r.ogrn||"")&&normalizedOgrn(r.ogrn)===r.ogrn)&&
    typeof r.full_name==="string"&&r.full_name.length<=1000&&!!r.full_name&&typeof r.short_name==="string"&&r.short_name.length<=500&&
    (s.kind==="rsmp"?r.as_of===s.release:[s.report_year+"-12-31",(s.report_year+1)+"-01-01"].includes(r.as_of))&&
    typeof r.member==="string"&&/\.xml$/i.test(r.member)&&r.member.length<=400&&typeof r.document_id==="string"&&r.document_id.length<=100;
}
function exactName(row,r){
  const key=archiveNameKey(row["Организация"]),full=r.full_name,short=r.short_name||full;
  return !!key&&[full,short].some(n=>archiveNameKey(n)===key)&&registeredSourceName(row["Организация"],{full_name:full,short_name:short});
}
function bucket(a,group,key){
  if(!a?.hits?.[group]||!Array.isArray(a?.overflow?.[group]))throw Error("FNS_OPEN_DATA_SCAN_INVALID");
  const rows=Object.hasOwn(a.hits[group],key)?a.hits[group][key]:[];
  if(!Array.isArray(rows)||rows.length>24||rows.some(r=>!validRecord(r,a.source)))throw Error("FNS_OPEN_DATA_RECORD_INVALID");
  return {rows,overflow:a.overflow[group].includes(key)};
}
const regionKey=s=>token(s).split(" ").map(x=>({обл:"область",респ:"республика",окр:"округ",авт:"автономный"}[x]||x)).filter(Boolean).sort().join(" ");
const cityKey=s=>token(s).replace(/^(?:город|г|поселок|пос|пгт|п|село|с|деревня|д)\s+/u,"");
const proof=(r,s)=>({source:"FNS_OPEN_DATA",dataset:s.kind,source_url:s.url,release:s.release,
  report_year:s.report_year,as_of:r.as_of,archive_sha256:s.sha256,member:r.member,document_id:r.document_id});
export function applyFnsOpenData(cp,archives,{sourceId,childId,now=new Date().toISOString()}={}){
  if(!sourceId||!childId||sourceId===childId||!Array.isArray(archives)||!archives.length||
    archives.some(a=>!trustedSource(a.source))||new Set(archives.map(a=>a.source.kind)).size!==archives.length||
    new Set(archives.map(a=>a.source.report_year)).size!==1)throw Error("FNS_OPEN_DATA_SOURCE_INVALID");
  const snapshot=structuredClone(cp),plan=planFnsOpenData(snapshot);
  const stats={total:plan.total,employees_before:plan.employees_missing,staff_eligible:plan.staff.length,
    employees_added:0,employees_conflict:0,employees_unmatched:0,missing_inn:plan.missing_inn,
    candidate_eligible:plan.candidates.length,candidate_rows:0,candidate_region_locality_rows:0,
    candidate_overflow_rows:0,inn_added:0,openai_requests:0,saby_requests:0};
  for(const row of plan.staff){
    const inn=innOf(row),ogrns=identityOgrns(row),observed=[];
    let ambiguous=false;
    for(const a of archives){
      const b=bucket(a,"by_inn",inn);
      if(b.overflow){ambiguous=true;continue;}
      for(const r of b.rows){
        if(r.inn!==inn||!exactName(row,r)||(r.ogrn&&ogrns.length&&r.ogrn!==ogrns[0])){ambiguous=true;continue;}
        if(Number.isSafeInteger(r.employees)&&r.employees>=0&&r.employees<=999999999)observed.push({r,s:a.source});
      }
    }
    if(ambiguous||new Set(observed.map(x=>x.r.employees)).size>1){stats.employees_conflict++;continue;}
    if(!observed.length){stats.employees_unmatched++;continue;}
    observed.sort((a,b)=>Number(b.s.kind==="sshr")-Number(a.s.kind==="sshr"));
    const {r,s}=observed[0],old=row.__evidence||{};
    row[FIELD]=r.employees;
    row.__evidence={...old,fns_open_data_staff:{...proof(r,s),inn,employees:r.employees,
      verification:"exact_unique_saved_inn_and_registered_name",verified_at:now},
      source_urls:[...new Set([...(Array.isArray(old.source_urls)?old.source_urls:[]),s.url])]};
    row.__comment=[String(row.__comment||""),"ФНС, среднесписочная численность за "+s.report_year+
      " г.: "+r.employees+"; "+s.url].filter(Boolean).join("\n");
    stats.employees_added++;
  }
  const candidates={},occupied=new Set(plan.rows.map(innOf).filter(Boolean));
  for(const row of plan.candidates){
    const id=clean(row.__canonical_id),key=archiveNameKey(row["Организация"]),ogrns=identityOgrns(row);
    const list=[],seen=new Set();
    let overflow=false;
    for(const a of archives){
      for(const b of [bucket(a,"by_name",key),...ogrns.map(o=>bucket(a,"by_ogrn",o))]){
        overflow||=b.overflow;
        for(const r of b.rows){
          if(!exactName(row,r)||occupied.has(r.inn)||(ogrns.length&&r.ogrn&&r.ogrn!==ogrns[0]))continue;
          const k=a.source.kind+":"+r.inn+":"+r.ogrn+":"+r.document_id;
          if(seen.has(k))continue;
          if(list.length>=48){overflow=true;continue;}
          seen.add(k);
          const localities=Array.isArray(r.localities)?r.localities.filter(s=>typeof s==="string"&&s.length<=250):[];
          const city=cityKey(row["Город/район"]);
          const precise=city.length>=3&&!/область|район|регион|округ|край|республика/u.test(city);
          list.push({...proof(r,a.source),inn:r.inn,ogrn:r.ogrn,full_name:r.full_name,short_name:r.short_name,
            region_code:r.region_code,region_name:r.region_name,localities,
            region_locality_match:!!r.region_name&&regionKey(r.region_name)===regionKey(snapshot.region)&&precise&&localities.some(x=>cityKey(x)===city),
            saved_ogrn_match:ogrns.length===1&&r.ogrn===ogrns[0],status:"candidate_only"});
        }
      }
    }
    if(list.length||overflow){
      list.sort((a,b)=>Number(b.saved_ogrn_match)-Number(a.saved_ogrn_match)||Number(b.region_locality_match)-Number(a.region_locality_match)||a.inn.localeCompare(b.inn));
      candidates[id]={records:list,overflow,requires_independent_identity_confirmation:true};
      if(list.length)stats.candidate_rows++;
      if(list.some(x=>x.region_locality_match))stats.candidate_region_locality_rows++;
      if(overflow)stats.candidate_overflow_rows++;
    }
  }
  stats.employees_after=stats.employees_before-stats.employees_added;
  snapshot.created_at=now;snapshot.updated_at=now;
  snapshot.fns_open_data_source_job_id=sourceId;
  snapshot.fns_open_data_root_job_id=cp.fns_open_data_root_job_id||sourceId;
  snapshot.fns_open_data_sources=archives.map(a=>({...a.source,scan:a.stats}));
  snapshot.fns_open_data_candidates=candidates;
  snapshot.fns_open_data_stats=stats;
  return {snapshot,stats};
}
