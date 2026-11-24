// Independent legal-identity recovery, never a finance/contact collector.
// Strictly preserve source rows and existing INNs. No region-specific rules.
import {auditSourceRows,auditLegalForm} from "./sabyIdentityAudit.js";
import {buildMissingInnRecoveryQueue,verifiedInnChecksum}
  from "./sabyMissingInnRecovery.js";
import {sabyInn,sabyNameTokens} from "./sabyEnrichment.js";
import {sameRegisteredName,canonicalIndependentRegistryRoute}
  from "./sabyIndependentNameBridge.js";
import {isVbrCompanyUrl} from "./sabyIndependentVbrBridge.js";
import {isFnsSourceUrl} from "./independentInnFns.js";
import {identityOgrns,normalizedOgrn} from "./legalIdentity.js";

const clean=v=>String(v??"").normalize("NFKC").replace(/\s+/gu," ").trim();
const key=v=>clean(v).toLowerCase().replace(/ё/g,"е")
  .replace(/[^a-zа-я0-9]+/gu," ").trim();
const sourceForm=name=>{
  const value=clean(name);
  for(const [form,pattern] of [
    ["ФГУП",/^(?:ФГУП|ФЕДЕРАЛЬНОЕ ГОСУДАРСТВЕННОЕ УНИТАРНОЕ ПРЕДПРИЯТИЕ)(?=$|[\s«"])/iu],
    ["ГУП",/^(?:ГУП|ГОСУДАРСТВЕННОЕ УНИТАРНОЕ ПРЕДПРИЯТИЕ)(?=$|[\s«"])/iu],
    ["МУП",/^(?:МУП|МУНИЦИПАЛЬНОЕ УНИТАРНОЕ ПРЕДПРИЯТИЕ)(?=$|[\s«"])/iu]
  ])if(pattern.test(value)||new RegExp(",\\s*"+form+"$","iu").test(value))return form;
  return auditLegalForm(value);
};
export function registeredSourceName(name,record){
  const form=sourceForm(name);
  return Boolean(form&&form!=="ИП"&&
    sourceForm(record?.full_name)===form&&sourceForm(record?.short_name)===form&&
    (sameRegisteredName(name,record.full_name)||
     sameRegisteredName(name,record.short_name)));
}
const unsafeName=name=>!sourceForm(name)||sourceForm(name)==="ИП"||
  !sabyNameTokens(name).length||/[\/;]|(?:^|\s)(?:филиал|представительство|бренд|группа компаний)(?:\s|$)/iu.test(name);
const occupiedRisk=new Set([
  "candidate_legal_form_conflict","candidate_inn_used_by_other_company",
  "possible_duplicate_or_related_company","conflicting_candidate_inns"
]);
const validPublicHint=(url,inn,kpp)=>{
  try{
    const u=new URL(String(url||""));
    return u.protocol==="https:"&&u.hostname==="saby.ru"&&
      !u.port&&!u.username&&!u.password&&!u.search&&!u.hash&&
      u.pathname==="/profile/"+inn+"-"+kpp;
  }catch{return false;}
};
function usableHint(target){
  const claims=target.candidates||[];
  if(claims.length!==1)return null;
  const c=claims[0];
  if(!c.checksum_valid||c.rejected_claim||c.ownership_risk!=="not_occupied")
    return null;
  const urls=(c.sources||[]).filter(x=>x.kind==="saby_public_profile_link")
    .map(x=>x.source_url);
  const matching=[...new Set(urls.flatMap(url=>{
    const m=/\/profile\/\d{10}-(\d{9})$/.exec(String(url||""));
    return m&&validPublicHint(url,c.inn,m[1])?[m[1]]:[];
  }))];
  return matching.length===1?{inn:c.inn,kpp:matching[0]}:null;
}
const locality=v=>key(String(v||"").replace(
  /^\s*(?:(?:г|п|пгт|пос|д|с)\.\s*|(?:г(?:ород)?|п|пгт|пос(?:елок|ёлок)?|село|деревня)\s+)/iu,""));
function preciseLocalityValue(sourceCity){
  const value=clean(sourceCity);
  if(!value||value.length>120||/[\/;(),]/u.test(value)||
     /область|район|р-н|регион|округ|республика|край|не указан|не определ|уточня/iu.test(value))
    return "";
  const expected=locality(value);
  return expected.length>=3&&/[а-яa-z]/iu.test(expected)?expected:"";
}
export function preciseLocalityMatch(sourceCity,registryAddress){
  const expected=preciseLocalityValue(sourceCity);
  if(!expected)return false;
  return String(registryAddress||"").split(",").some(part=>{
    if(/^\s*(?:ул(?:ица)?\.?|проспект|пр-кт|пер(?:еулок)?\.?|шоссе|д(?:ом)?\.?\s*\d|корпус|помещение|офис|кв(?:артира)?\.?)\s*/iu.test(part))return false;
    return locality(part.replace(/^\s*\d{6}\s+/u,""))===expected;
  });
}
// Exact locality names can repeat across regions. In the FNS name-only
// path the research region must also occur explicitly in the address;
// do not infer it from the INN/KPP prefix. Anchored source identifiers
// and exact legal addresses do not need this weaker geographical proof.
function preciseRegionMatch(region,address){
  const normalize=value=>locality(String(value||"")
    .replace(/^\s*\d{6}\s*/u,"")).split(/\s+/u).filter(Boolean)
    .map(word=>({обл:"область",респ:"республика",авт:"автономный",окр:"округ"}[word]||word))
    .sort().join(" ");
  const expected=normalize(region);
  return !!expected&&String(address||"").split(",").some(part=>
    normalize(part)===expected);
}
function addressMatches(row,address){
  const stored=clean(row?.["Юридический адрес"]||
    row?.__evidence?.identity_verification?.legal_address);
  return stored.length>=20&&/\d/.test(stored)&&
    /улица|ул\.|проспект|пр-кт|шоссе|переулок|пер\./iu.test(stored)&&
    key(stored)===key(address);
}
function hasExactSourceAddressConflict(row,address){
  const explicit=clean(row?.["Юридический адрес"]||
    row?.__evidence?.identity_verification?.legal_address);
  return Boolean(explicit&&!addressMatches(row,address));
}
function trustedRegistryItem(item){
  if(!item?.record)return false;
  return item.provider==="fns"?
    isFnsSourceUrl(item.url,item.record.inn):
    (!item.provider||item.provider==="vbr")&&
      isVbrCompanyUrl(item.url,item.record.ogrn);
}
// Identity fields are valid even when the FNS search result has no
// postal address. Address and active status are checked separately.
function validRegistryIdentifiers(record){
  return Boolean(record&&/^\d{10}$/.test(record.inn)&&
    verifiedInnChecksum(record.inn)&&/^\d{13}$/.test(record.ogrn)&&
    normalizedOgrn(record.ogrn)===record.ogrn&&/^\d{9}$/.test(record.kpp)&&
    record.full_name&&record.short_name);
}
function validRecord(record,provider){
  return Boolean(validRegistryIdentifiers(record)&&record.address&&
    (record.active===true||(provider==="fns"&&record.active===null)));
}
function matchingIndependentRecord(item,second,target){
  const a=item?.record,b=second?.record;
  return Boolean(trustedRegistryItem(item)&&validRegistryIdentifiers(a)&&
    b&&(canonicalIndependentRegistryRoute(second.url,a.ogrn)||
      (item.provider==="fns"&&isVbrCompanyUrl(second.url,a.ogrn)&&
        !new URL(second.url).hash))&&
    b.inn===a.inn&&b.kpp===a.kpp&&b.ogrn===a.ogrn&&
    registeredSourceName(target.organization,a)&&registeredSourceName(target.organization,b)&&
    sameRegisteredName(a.full_name,b.full_name)&&sameRegisteredName(a.short_name,b.short_name));
}
function withVerifiedIndependentAddress(item,second,target){
  if(item.provider!=="fns"||item.record.address||
    !matchingIndependentRecord(item,second,target)||!second.record.address)
    return item;
  return {...item,record:{...item.record,address:second.record.address},
    address_source_url:second.url};
}
// Resolve addresses of all exact-name FNS candidates (including inactive
// competitors) before using geography to choose one. A missing address is
// NOT evidence that a competitor is in another region. Use the same
// independently verified record for the final confirmation, avoiding
// duplicate navigation. The cap is per source row; broader searches
// remain incomplete/ambiguous, never silently narrowed to a single card.
export async function hydrateFnsSearchAddresses(search,target,lookup){
  const confirmations=new Map();
  if(search?.state!=="observed"||!Array.isArray(search.records))
    return {search,confirmations};
  const records=[];
  let reads=0;
  for(const item of search.records){
    if(item.provider!=="fns"||!trustedRegistryItem(item)||
      !validRegistryIdentifiers(item.record)||
      !registeredSourceName(target.organization,item.record)||
      item.record.address){
      records.push(item);continue;
    }
    const ogrn=item.record.ogrn;
    if(!confirmations.has(ogrn)&&reads<8){
      reads++;
      confirmations.set(ogrn,await lookup.confirm(ogrn,item.record));
    }
    const second=confirmations.get(ogrn);
    records.push(withVerifiedIndependentAddress(item,second,target));
  }
  return {search:{...search,records},confirmations};
}
export function chooseIndependentInnCandidate({row,target,search,owners=new Set(),region=""}){
  const review=(reason,candidates=[])=>({status:"review",reason,candidates});
  if(unsafeName(target.organization))return review("source_legal_name_unresolved");
  if(occupiedRisk.has(target.decision)||target.candidates?.some(c=>c.rejected_claim)||
    row?.__evidence?.legal_identity_conflicts?.length)
    return review("source_identity_conflict");
  if(clean(row["ИНН"]))return review("nonempty_invalid_inn");
  if(search?.state!=="observed")return review("registry_search_unconfirmed");
  const observed=Array.isArray(search.records)?search.records:[];
  // An inactive or unverified exact-name entity is still a conflicting
  // name candidate; do not use active status alone to resolve its owner.
  const allExact=observed.filter(item=>trustedRegistryItem(item)&&
    registeredSourceName(target.organization,item.record));
  const exact=allExact.filter(item=>validRecord(item.record,item.provider));
  const unique=[...new Map(exact.map(item=>[item.record.ogrn,item])).values()];
  const candidates=[...new Map(allExact.filter(item=>
    validRegistryIdentifiers(item.record)).map(item=>[item.record.ogrn,item])).values()]
    .map(({record,url})=>({inn:record.inn,kpp:record.kpp,
      ogrn:record.ogrn,source_url:url}));
  const hint=usableHint(target);
  const storedOgrns=identityOgrns(row);
  if(storedOgrns.length>1)return review("source_ogrn_conflict",candidates);
  // For address/name-only identity, an unread competing address prevents
  // a unique geographical choice even if another candidate is local.
  // A saved exact identifier may narrow the set, but its own required
  // address and locality checks still must pass.
  const unresolvedAddress=allExact.some(item=>item.provider==="fns"&&
    !item.record.address&&(!hint||(item.record.inn===hint.inn&&item.record.kpp===hint.kpp))&&
    (!storedOgrns.length||item.record.ogrn===storedOgrns[0]));
  if(unresolvedAddress)return review("registry_address_unavailable",candidates);
  const anchored=unique.filter(({record})=>
    !hasExactSourceAddressConflict(row,record.address)&&
    (storedOgrns.length===0||storedOgrns[0]===record.ogrn)&&
    (!hint||(hint.inn===record.inn&&hint.kpp===record.kpp))&&
    (addressMatches(row,record.address)||
      (hint&&hint.inn===record.inn&&hint.kpp===record.kpp&&
        (!preciseLocalityValue(row["Город/район"])||
          preciseLocalityMatch(row["Город/район"],record.address)))||
      (storedOgrns.length===1&&storedOgrns[0]===record.ogrn&&
        preciseLocalityMatch(row["Город/район"],record.address))));
  let match,sourceBasis;
  if(anchored.length===1){
    match=anchored[0];
    sourceBasis=addressMatches(row,match.record.address)?"same_legal_address":
      hint?"same_saved_public_inn_kpp":"same_saved_ogrn_and_locality";
  }else if(anchored.length>1){
    return review("registry_identity_ambiguous",candidates);
  }else{
    if(hint||storedOgrns.length||unique.some(({record})=>
      hasExactSourceAddressConflict(row,record.address)))
      return review("source_requisites_conflict",candidates);
    // A single visible result is not proof of completeness. Only a
    // positively observed complete list, fully inspected, may disambiguate
    // an exact legal name using a specific original locality.
    const sourceGeography=item=>
      preciseLocalityMatch(row["Город/район"],item.record.address)&&
      (item.provider!=="fns"||preciseRegionMatch(region,item.record.address));
    const local=unique.filter(sourceGeography);
    const localConflicts=allExact.filter(sourceGeography);
    if(!search.complete||!search.allCardsRead||local.length!==1||
      new Set(localConflicts.map(item=>item.record.ogrn)).size!==1)
      return review(local.length>1||unique.length>1||localConflicts.length>1?
        "registry_identity_ambiguous":unique.length?
        "source_link_not_proven":"registry_no_exact_legal_name",candidates);
    match=local[0];
    sourceBasis="complete_name_search_exact_locality";
  }
  if(owners.has(match.record.inn))return review("inn_already_owned",candidates);
  return {status:"candidate",sourceBasis,provider:match.provider||"vbr",
    record:match.record,url:match.url,
    ...(match.address_source_url?{address_source_url:match.address_source_url}:{}),candidates};
}
export function verifyIndependentInnCandidate(selection,second,target){
  const review=reason=>({status:"review",reason,candidates:selection?.candidates||[]});
  if(selection?.status!=="candidate")return selection;
  const a=selection.record,b=second?.record;
  if(!validRecord(a,selection.provider)||
    !matchingIndependentRecord(selection,second,target)||b.active!==true||
    (selection.address_source_url&&
      (selection.address_source_url!==second.url||!b.address||key(a.address)!==key(b.address))))
    return review("independent_registry_disagreement");
  return {status:"verified",reason:"two_registry_identity_verified",
    source_basis:selection.sourceBasis,source_provider:selection.provider||"vbr",
    inn:a.inn,kpp:a.kpp,ogrn:a.ogrn,
    legal_name:a.full_name,short_name:a.short_name,legal_address:a.address,
    legal_address_source_url:selection.address_source_url||selection.url,
    source_urls:[selection.url,second.url]};
}
function entries(checkpoint){
  if(checkpoint?.version!==1||
     !["full","saby"].includes(checkpoint.source_mode)||
     !["saby","completed"].includes(checkpoint.phase)||
     (checkpoint.source_mode==="full"&&checkpoint.phase!=="completed")||
     !Array.isArray(checkpoint.final_result?.statistics))
    throw Error("REGISTRY_INN_CHECKPOINT_NOT_READY");
  const all=auditSourceRows(checkpoint);
  const ids=new Set();
  for(const e of all){
    const id=clean(e.row?.__canonical_id);
    if(!/^[a-z0-9_.:-]{1,100}$/i.test(id)||ids.has(id)||
      ["__proto__","constructor","prototype"].includes(id))
      throw Error("REGISTRY_INN_CANONICAL_ID_MISSING_OR_DUPLICATE");
    ids.add(id);
  }
  return all;
}
const REOPEN_ON_FNS=new Set(["registry_search_unconfirmed",
  "source_link_not_proven","registry_no_exact_legal_name"]);
export function planIndependentInnBackfill(checkpoint,{limit=10000,targetId="",provider="vbr"}={}){
  if(!["vbr","fns"].includes(provider)||!Number.isSafeInteger(limit)||limit<1||limit>10000)
    throw Error("REGISTRY_INN_BAD_LIMIT");
  const all=entries(checkpoint);
  const byId=new Map(all.map(e=>[clean(e.row.__canonical_id),e.row]));
  const previous=checkpoint.independent_inn_backfill_outcomes||{};
  const queue=buildMissingInnRecoveryQueue(checkpoint).rows;
  // A changed independent source justifies one new attempt for old VBR
  // discovery failures. No reset of conflicts, already-owned INNs or
  // FNS outcomes. The original parent and its reviews remain immutable.
  const reopen=t=>{
    const old=previous[t.original_canonical_id];
    return provider==="fns"&&old?.status==="review"&&
      (!old.provider||old.provider==="vbr")&&REOPEN_ON_FNS.has(old.reason);
  };
  const reopened=queue.filter(reopen).length;
  const pending=queue.filter(t=>!Object.hasOwn(previous,t.original_canonical_id)||reopen(t));
  // Prior credible identifiers, then actual legal names, then brands.
  const tier=t=>usableHint(t)?0:unsafeName(t.organization)?2:1;
  pending.sort((a,b)=>tier(a)-tier(b));
  const selected=(targetId?pending.filter(t=>t.original_canonical_id===targetId):
    pending).slice(0,limit);
  if(targetId&&selected.length!==1)throw Error("REGISTRY_INN_TARGET_NOT_PENDING");
  return {total:all.length,missing:queue.length,pending:pending.length,
    scheduled:selected.length,previously_reviewed:queue.length-pending.length,
    reopened_from_vbr:reopened,provider,
    saved_public_hints:pending.filter(usableHint).length,
    legal_name_unresolved:pending.filter(t=>unsafeName(t.organization)).length,
    selected,byId};
}
// The actual FNS form must work for an existing, independently evidenced
// company and its registered name BEFORE running any missing-INN queue.
// This health check never writes a row or consumes a review allowance.
export async function checkFnsRegistryCanary(checkpoint,lookup){
  const candidates=entries(checkpoint).map(e=>e.row).filter(row=>{
    const inn=sabyInn(row["ИНН"]),ev=row.__evidence||{};
    const finance=ev.saby_finance_backfill,identity=ev.identity_verification;
    return inn.length===10&&verifiedInnChecksum(inn)&&
      !unsafeName(row["Организация"])&&!ev.legal_identity_conflicts?.length&&
      ((finance?.inn===inn&&/^https:\/\/profile\.saby\.ru\//.test(finance.source_url||"")&&
        Number.isFinite(Date.parse(finance.verified_at)))||
       (identity?.inn===inn&&Array.isArray(identity.source_urls)&&identity.source_urls.length>0));
  }).sort((a,b)=>{
    // Prefer ordinary commercial legal entities with previously verified
    // finance evidence. Do not pick the longest title (which can select
    // a municipal company in bankruptcy) as the only service canary.
    const rank=row=>{
      const form=sourceForm(row["Организация"]);
      const commercial=["ООО","АО","ПАО","ОАО","ЗАО"].includes(form);
      return Number(commercial)*2+Number(Boolean(row.__evidence?.saby_finance_backfill));
    };
    return rank(b)-rank(a)||clean(a["Организация"]).length-clean(b["Организация"]).length;
  });
  if(!candidates.length)return {verified:false,reason:"fns_canary_missing"};
  let lastReason="fns_canary_inn_unverified";
  const tried=new Set();
  for(const row of candidates){
    const inn=sabyInn(row["ИНН"]);
    if(tried.has(inn))continue;
    if(tried.size>=3)break;
    tried.add(inn);
    const sourceTarget={organization:row["Организация"]};
    const first=await lookup.search(sourceTarget,{inn});
    const matches=(first?.records||[]).filter(item=>
      item.provider==="fns"&&trustedRegistryItem(item)&&
      validRegistryIdentifiers(item.record)&&item.record.inn===inn&&
      registeredSourceName(sourceTarget.organization,item.record));
    if(first?.state!=="observed"||matches.length!==1){
      lastReason="fns_canary_inn_unverified";continue;
    }
    const item=matches[0],a=item.record;
    // A stopped/non-active entity is not a service outage. Try another
    // known legal entity, within a hard bound of three distinct INNs.
    if(a.active===false){lastReason="fns_canary_entity_inactive";continue;}
    const confirmation=await lookup.confirm(a.ogrn,a);
    const canonicalTarget={organization:a.full_name};
    if(!matchingIndependentRecord(item,confirmation,canonicalTarget)){
      lastReason="fns_canary_confirmation_unverified";continue;
    }
    if(confirmation.record.active!==true){
      lastReason="fns_canary_entity_inactive";continue;
    }
    const resolved=withVerifiedIndependentAddress(item,confirmation,canonicalTarget);
    if(!resolved.record.address){
      lastReason="fns_canary_address_unavailable";continue;
    }
    const proof=verifyIndependentInnCandidate({...resolved,status:"candidate",
      sourceBasis:"canary"},confirmation,canonicalTarget);
    if(proof.status!=="verified"){
      lastReason="fns_canary_confirmation_unverified";continue;
    }
    const byName=await lookup.search(canonicalTarget,null);
    if(byName?.state!=="observed"||!(byName.records||[]).some(value=>
      value.provider==="fns"&&trustedRegistryItem(value)&&
      validRegistryIdentifiers(value.record)&&
      value.record.inn===inn&&value.record.ogrn===a.ogrn&&value.record.kpp===a.kpp&&
      registeredSourceName(a.full_name,value.record))){
      lastReason="fns_canary_name_unverified";continue;
    }
    if(byName.complete!==true||byName.allCardsRead!==true){
      lastReason="fns_canary_name_incomplete";continue;
    }
    return {verified:true,reason:"verified"};
  }
  return {verified:false,reason:lastReason};
}

export async function runIndependentInnBackfill({
  checkpoint,sourceId,childId,limit=1,targetId="",provider="vbr",lookup,onCheckpoint,
  onProgress=()=>{}
}){
  if(typeof lookup?.search!=="function"||typeof lookup?.confirm!=="function"||
    typeof onCheckpoint!=="function"||
    !sourceId||!childId||sourceId===childId)
    throw Error("REGISTRY_INN_INVALID_RUN");
  const parent=structuredClone(checkpoint);
  const plan=planIndependentInnBackfill(parent,{limit,targetId,provider});
  const all=entries(parent);
  const owners=new Set(all.map(e=>sabyInn(e.row["ИНН"])).filter(Boolean));
  const outcomes={...(parent.independent_inn_backfill_outcomes||{})};
  const stats={scheduled:plan.scheduled,processed:0,added:0,review:0,
    pending:plan.pending,stop_reason:""};
  const now=new Date().toISOString();
  const snapshot={...parent,created_at:now,updated_at:now,
    independent_inn_backfill_source_job_id:sourceId,
    independent_inn_backfill_root_job_id:parent.independent_inn_backfill_root_job_id||sourceId,
    independent_inn_backfill_outcomes:outcomes,independent_inn_backfill_stats:stats};
  const save=async()=>{
    snapshot.updated_at=new Date().toISOString();
    stats.pending=plan.pending-stats.processed;
    await onCheckpoint(structuredClone(snapshot));
  };
  await save();
  for(const target of plan.selected){
    const id=target.original_canonical_id,row=plan.byId.get(id);
    let result;
    if(unsafeName(target.organization))result={status:"review",reason:"source_legal_name_unresolved"};
    else if(occupiedRisk.has(target.decision)||
      target.candidates?.some(c=>c.rejected_claim)||
      row.__evidence?.legal_identity_conflicts?.length)
      result={status:"review",reason:"source_identity_conflict"};
    else if(clean(row["ИНН"]))result={status:"review",reason:"nonempty_invalid_inn"};
    else{
      try{
        const rawSearch=await lookup.search(target,usableHint(target));
        const {search,confirmations}=provider==="fns"?
          await hydrateFnsSearchAddresses(rawSearch,target,lookup):
          {search:rawSearch,confirmations:new Map()};
        const selection=chooseIndependentInnCandidate({row,target,search,owners,
          region:parent.region});
        if(selection.status==="candidate"){
          const ogrn=selection.record.ogrn;
          const second=confirmations.has(ogrn)?confirmations.get(ogrn):
            await lookup.confirm(ogrn,selection.record);
          result=verifyIndependentInnCandidate(selection,second,target);
        }else result=selection;
      }catch(error){
        stats.stop_reason=["navigation_budget","registry_http_unavailable",
          "registry_route_untrusted","registry_browser_unavailable","registry_confirmation_unavailable",
          "registry_search_unresponsive","fns_invalid_query","fns_form_unavailable",
          "fns_query_input_unavailable","fns_submit_button_unavailable",
          "fns_query_not_set","fns_exact_checkbox_unavailable",
          "fns_exact_checkbox_not_selected","fns_submit_failed",
          "fns_captcha_required","fns_search_token_missing","fns_search_token_conflict",
          "fns_response_unreadable","fns_result_unavailable","fns_submit_unobserved"].includes(error?.code)?
          error.code:"registry_browser_unavailable";
        await save();
        break;
      }
    }
    if(result.status==="verified"){
      // The second check happens immediately before the only CRM write.
      // Never overwrite an existing value or introduce a duplicate INN.
      if(clean(row["ИНН"])||owners.has(result.inn)){
        result={status:"review",reason:"inn_already_owned"};
      }else{
        const evidence=row.__evidence||{};
        const proof={...result,method:"independent_registry_backfill",
          verified_at:new Date().toISOString()};
        row["ИНН"]=result.inn;
        row.__evidence={...evidence,identity_verification:proof,
          source_urls:[...new Set([...(Array.isArray(evidence.source_urls)?
            evidence.source_urls:[]),...result.source_urls])],
          notes:[...new Set([...(Array.isArray(evidence.notes)?evidence.notes:[]),
            "Подтверждённый ИНН: "+result.inn+
            "; ОГРН "+result.ogrn+". Независимая сверка двух реестров."])]};
        // Keep all other existing comment lines verbatim.
        if(typeof row.__comment==="string"&&/^ИНН:[^\r\n]*$/imu.test(row.__comment))
          row.__comment=row.__comment.replace(/^ИНН:[^\r\n]*$/imu,"ИНН: "+result.inn);
        owners.add(result.inn);
        stats.added++;
      }
    }
    if(result.status!=="verified")stats.review++;
    outcomes[id]={...result,provider};
    stats.processed++;
    await save();
    await onProgress({...stats});
  }
  return {snapshot,stats:{...stats},childId};
}
