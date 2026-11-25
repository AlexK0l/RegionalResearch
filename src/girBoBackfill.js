// Public GIR BO revenue only. Default: exact identity, consistent published
// annual line 2110 across two official JSON endpoints and FNS standard units.
// The original explicit PDF verification remains available.
import {createHash} from "node:crypto";
import {auditSourceRows} from "./sabyIdentityAudit.js";
import {verifiedInnChecksum} from "./sabyMissingInnRecovery.js";
import {identityOgrns,normalizedOgrn} from "./legalIdentity.js";
import {registeredSourceName} from "./independentInnBackfill.js";
import {archiveNameKey} from "./fnsOpenDataBackfill.js";
import {REVENUE_FIELD} from "./preSabyFinancials.js";

export const GIRBO_BASE="https://bo.nalog.gov.ru";
export const GIRBO_UNIT_BASIS="https://www.nalog.gov.ru/rn11/news/activities_fts/16604859/";
export const GIRBO_LEGACY_UNIT_BASIS="https://www.nalog.gov.ru/rn38/news/activities_fts/9684221/";
const SEARCH_REVISION=2;
const text=v=>String(v??"").normalize("NFKC").replace(/\s+/gu," ").trim();
const innOk=v=>typeof v==="string"&&/^\d{10}$/.test(v)&&verifiedInnChecksum(v);
const ogrnOk=v=>typeof v==="string"&&/^\d{13}$/.test(v)&&!/^0+$/.test(v)&&normalizedOgrn(v)===v;
const digits=v=>String(v??"").replace(/<strong>/gi,"").replace(/<\/strong>/gi,"").trim();
const saved=v=>(typeof v==="number"||typeof v==="string"&&/^\d+$/.test(v.trim()))&&Number.isSafeInteger(Number(v))&&Number(v)>=0;
const idOk=v=>Number.isSafeInteger(v)&&v>0;
const dateOk=v=>typeof v==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v));
const kppOk=v=>typeof v==="string"&&/^\d{9}$/.test(v);
const kndOk=v=>["0710099","0710096"].includes(v);
const review=reason=>({status:"review",reason});
const innOf=r=>text(r["ИНН"]);
const safeName=r=>!!archiveNameKey(r["Организация"])&&
  !/[\/;]|(?:^|\s)(?:филиал|представительство|бренд|группа компаний|обособленное подразделение)(?:\s|$)/iu.test(r["Организация"]||"");
const conflicting=r=>{
  const ev=r.__evidence||{},inn=innOf(r);
  return !!(ev.legal_identity_conflicts?.length||identityOgrns(r).length>1||
    [ev.identity_verification,ev.saby,ev.saby_finance_backfill].some(v=>v?.inn&&text(v.inn)!==inn));
};
export function planGirBoBackfill(cp,{limit=10000,year=new Date().getUTCFullYear()-1,confirmationMode="json"}={}){
  if(cp?.version!==1||!["full","saby"].includes(cp.source_mode)||
    !["completed","saby"].includes(cp.phase)||
    (cp.source_mode==="full"&&cp.phase!=="completed")||
    !Array.isArray(cp.final_result?.statistics)||
    !["json","pdf"].includes(confirmationMode)||
    !Number.isSafeInteger(limit)||limit<1||limit>10000||
    !Number.isSafeInteger(year)||year<2019||year>new Date().getUTCFullYear()-1)
    throw Error("GIRBO_BAD_PLAN");
  const rows=auditSourceRows(cp).map(e=>e.row);
  const ids=new Set(),freq=new Map();
  for(const r of rows){
    const id=text(r.__canonical_id);
    if(!/^[a-z0-9_.:-]{1,100}$/i.test(id)||ids.has(id)||["__proto__","prototype","constructor"].includes(id))
      throw Error("GIRBO_BAD_ROW_ID");
    ids.add(id);
    if(innOk(innOf(r)))freq.set(innOf(r),(freq.get(innOf(r))||0)+1);
  }
  const gaps=rows.filter(r=>!saved(r[REVENUE_FIELD]));
  const counts={no_valid_legal_inn:0,duplicate_inn:0,unresolved_legal_name:0,identity_conflict:0,previously_reviewed:0};
  const eligible=[];
  for(const r of gaps){
    const inn=innOf(r),id=text(r.__canonical_id),old=cp.girbo_backfill_outcomes?.[id];
    if(!innOk(inn)){counts.no_valid_legal_inn++;continue;}
    if(freq.get(inn)!==1){counts.duplicate_inn++;continue;}
    if(!safeName(r)){counts.unresolved_legal_name++;continue;}
    if(conflicting(r)){counts.identity_conflict++;continue;}
    if(old?.year_ceiling===year&&old.inn===inn&&old.search_revision===SEARCH_REVISION&&
      old.confirmation_mode===confirmationMode){counts.previously_reviewed++;continue;}
    eligible.push({id,inn,row:r});
  }
  return {total:rows.length,missing:gaps.length,eligible:eligible.length,
    selected:eligible.slice(0,limit),year_ceiling:year,...counts};
}
export function selectGirBoOrganization(row,payload){
  const inn=innOf(row),stored=identityOgrns(row);
  if(!innOk(inn)||stored.length>1||!safeName(row)||conflicting(row))return review("source_identity_conflict");
  if(!payload||!Array.isArray(payload.content)||!Number.isSafeInteger(payload.totalElements)||
    payload.totalElements<0||payload.totalElements!==payload.content.length||
    payload.number!==0||payload.first!==true||payload.last!==true||
    payload.content.length>20)return review("search_response_incomplete");
  const matching=payload.content.filter(x=>digits(x?.inn)===inn);
  if(matching.length!==1)return review(matching.length?"search_ambiguous":"no_exact_inn");
  const r=matching[0],short=digits(r.shortName);
  if(!idOk(r.id)||!ogrnOk(r.ogrn)||!short||/<|>/u.test(short)||
    (stored.length&&stored[0]!==r.ogrn))return review("search_identity_unproven");
  const b=r.bfo;
  const searchSummary=b&&typeof b==="object"&&!Array.isArray(b)?{
    period:b.period,knd:b.knd,isCb:b.isCb,gainSum:b.gainSum,
    actualBfoDate:b.actualBfoDate,actualCorrectionNumber:b.actualCorrectionNumber,
    actualCorrectionDate:b.actualCorrectionDate,bfoPeriodTypes:b.bfoPeriodTypes
  }:null;
  return {status:"candidate",inn,ogrn:r.ogrn,organization_id:r.id,short_name:short,
    status_code:r.statusCode,search_summary:searchSummary};
}
export function selectGirBoAnnualReport(row,org,reports,{year=new Date().getUTCFullYear()-1}={}){
  if(org?.status!=="candidate"||!Array.isArray(reports)||reports.length>100)return review("report_response_unproven");
  // Only annual reports, never a partial 2026 report or previous-year column.
  const periods=reports.filter(p=>/^\d{4}$/.test(String(p?.period??""))&&
    Number(p.period)>=2019&&Number(p.period)<=year&&
    Array.isArray(p.typeCorrections)&&p.typeCorrections.some(c=>c?.type===12));
  if(!periods.length)return review("annual_report_unavailable");
  const latest=Math.max(...periods.map(p=>Number(p.period)));
  const recent=periods.filter(p=>Number(p.period)===latest);
  if(recent.length!==1)return review("annual_report_ambiguous");
  const p=recent[0],items=p.typeCorrections.filter(c=>c?.type===12);
  if(items.length!==1)return review("annual_correction_ambiguous");
  const c=items[0].correction,info=p.organizationInfo,detail=c?.bfoOrganizationInfo;
  if(!idOk(p.id)||!c||!idOk(c.id)||c.periodType!==12||p.isCb!==false||
    !kndOk(p.knd)||c.knd!==p.knd||p.published===false||
    !Number.isSafeInteger(p.publishedCorrectionNumber)||p.publishedCorrectionNumber<0||
    c.correctionVersion!==p.publishedCorrectionNumber||!dateOk(p.publishedCorrectionDate))
    return review("published_annual_report_unproven");
  if(!info||!detail||info.inn!==org.inn||detail.inn!==org.inn||
    !kppOk(info.kpp)||detail.kpp!==info.kpp||detail.id!==c.id||detail.bfoId!==p.id||
    !registeredSourceName(row["Организация"],{full_name:info.fullName,short_name:org.short_name})||
    !registeredSourceName(row["Организация"],{full_name:detail.fullName,short_name:org.short_name})||
    text(info.fullName).toLowerCase()!==text(detail.fullName).toLowerCase())
    return review("report_identity_unproven");
  const f=c.financialResult;
  if(!f||f.id!==c.id||f.okud!=="0710002"||
    typeof f.current2110!=="number"||!Number.isSafeInteger(f.current2110)||
    f.current2110<0||f.current2110>1e12)return review("revenue_2110_unavailable");
  // Cross-check the report's aggregate if it is provided. A null is not zero.
  if(p.gainSum!=null&&p.gainSum!==f.current2110)return review("revenue_2110_disagreement");
  if(f.previous2110!=null&&(!Number.isSafeInteger(f.previous2110)||f.previous2110<0))
    return review("revenue_previous_unproven");
  return {status:"candidate",inn:org.inn,ogrn:org.ogrn,kpp:info.kpp,
    organization_id:org.organization_id,year:latest,report_id:p.id,detail_id:c.id,
    knd:p.knd,correction_number:c.correctionVersion,published_date:p.publishedCorrectionDate,
    current:f.current2110,previous:f.previous2110??null,
    legal_name:info.fullName,short_name:org.short_name,status_code:org.status_code,
    search_summary:org.search_summary,
    report_summary:{gainSum:p.gainSum,actualBfoDate:p.actualBfoDate,
      actualCorrectionNumber:p.actualCorrectionNumber,actualCorrectionDate:p.actualCorrectionDate},
    source_url:GIRBO_BASE+"/organizations-card/"+org.organization_id,
    search_url:GIRBO_BASE+"/advanced-search/organizations/search?"+new URLSearchParams({query:org.inn,page:"0",size:"20"}),
    report_json_url:GIRBO_BASE+"/nbo/organizations/"+org.organization_id+"/bfo/",
    report_url:GIRBO_BASE+"/download/bfo/pdf/"+org.organization_id+"?period="+latest+"&detailId="+c.id};
}
// Two projections of the SAME official source, not independent registries.
// Standard ordinary annual 0710002 values are in thousands of rubles;
// FNS explicitly states this unit and its public card displays it.
// Require both responses to refer to exactly the same annual correction.
export function verifyGirBoStructuredReport(candidate){
  if(candidate?.status!=="candidate")return review("structured_report_unproven");
  const s=candidate.search_summary,p=candidate.report_summary;
  if(!s||!p||candidate.status_code!=="ACTIVE"||
    !archiveNameKey(candidate.legal_name)||
    archiveNameKey(candidate.legal_name).split(":")[0]!==archiveNameKey(candidate.short_name).split(":")[0]||
    !innOk(candidate.inn)||!ogrnOk(candidate.ogrn)||!kppOk(candidate.kpp)||
    !kndOk(candidate.knd)||!idOk(candidate.organization_id)||!idOk(candidate.report_id)||!idOk(candidate.detail_id)||
    !Number.isSafeInteger(candidate.year)||candidate.year<2019||
    !Number.isSafeInteger(candidate.correction_number)||candidate.correction_number<0||
    !dateOk(candidate.published_date))
    return review("structured_report_identity_unproven");
  if(String(s.period)!==String(candidate.year)||s.knd!==candidate.knd||s.isCb!==false||
    !Array.isArray(s.bfoPeriodTypes)||s.bfoPeriodTypes.length!==1||s.bfoPeriodTypes[0]!==12||
    s.actualCorrectionNumber!==candidate.correction_number||
    p.actualCorrectionNumber!==candidate.correction_number||
    !dateOk(s.actualBfoDate)||!dateOk(s.actualCorrectionDate)||
    s.actualBfoDate!==p.actualBfoDate||s.actualCorrectionDate!==p.actualCorrectionDate)
    return review("structured_annual_correction_unproven");
  if(!Number.isSafeInteger(candidate.current)||candidate.current<0||
    !Number.isSafeInteger(s.gainSum)||!Number.isSafeInteger(p.gainSum)||
    s.gainSum!==candidate.current||p.gainSum!==candidate.current)
    return review("structured_2110_disagreement");
  const rub=candidate.current*1000;
  if(!Number.isSafeInteger(rub)||rub<0||rub>1e15)return review("revenue_scale_unproven");
  const projection={inn:candidate.inn,ogrn:candidate.ogrn,kpp:candidate.kpp,
    organization_id:candidate.organization_id,report_id:candidate.report_id,detail_id:candidate.detail_id,
    year:candidate.year,knd:candidate.knd,correction_number:candidate.correction_number,
    published_date:candidate.published_date,search:s,report:p,current2110:candidate.current};
  return {status:"verified",reason:"girbo_annual_2110_json_verified",revenue_rub:rub,
    revenue_year:candidate.year,unit:"thousand_rubles",row_code:"2110",
    verification:"matching_official_search_and_published_annual_report",
    unit_basis_url:candidate.year>=2025?GIRBO_UNIT_BASIS:GIRBO_LEGACY_UNIT_BASIS,
    projection_sha256:createHash("sha256").update(JSON.stringify(projection)).digest("hex"),projection};
}
function labelled(page,label,value){
  const matches=[...page.matchAll(new RegExp("(?:^|\\n)\\s*"+label+"\\s+([0-9]+)(?=\\s|$)","giu"))];
  return matches.length>0&&matches.every(m=>m[1]===value);
}
function parseCell(value){
  const v=String(value||"").trim().replace(/\u00a0|\u202f/gu," ");
  if(/^[-—–]$/u.test(v))return null;
  if(!/^(?:\d+|\d{1,3}(?: \d{3})+)$/u.test(v))return undefined;
  const n=Number(v.replace(/ /g,""));
  return Number.isSafeInteger(n)?n:undefined;
}
// pdftotext -layout is important: column boundaries are multiple spaces,
// whereas thousands within a number are separated by one space. Unknown
// layouts are reviewed, not guessed or converted from a PDF filename alone.
export function verifyGirBoPdfText(candidate,raw){
  if(candidate?.status!=="candidate"||typeof raw!=="string"||raw.length>8*1024*1024)
    return review("pdf_text_unavailable");
  const pages=raw.replace(/\r/g,"").split("\f").filter(p=>p.trim());
  if(!pages.length||pages.length>500)return review("pdf_pages_unproven");
  const cover=pages[0];
  const compact=text(cover);
  if(!/Информация из Государственного информационного ресурса бухгалтерской/iu.test(compact)||
    !labelled(cover,"ИНН",candidate.inn)||!labelled(cover,"КПП",candidate.kpp))
    return review("pdf_identity_unproven");
  const number=new RegExp("(?:^|\\s)"+candidate.knd+"_"+candidate.inn+"_"+candidate.year+"_([0-9]{3,})_\\d{8}_[a-f0-9-]{20,}(?=\\s|$)","iu");
  const m=number.exec(compact);
  if(!m||Number(m[1])!==candidate.correction_number)return review("pdf_period_correction_unproven");
  // FNS cover specifies the monetary unit; do not infer a scale from JSON.
  if(!/(?:^|\n)\s*Единица измерения\s*:?\s+Тыс\.\s*руб\.(?:\s|$)/iu.test(cover)||
    /Единица измерения\s*:?\s+(?:млн|рубли|руб\.)/iu.test(cover))
    return review("pdf_unit_unproven");
  const financial=pages.filter(p=>/Отч[её]т о финансовых результатах/iu.test(p)&&
    /(?:^|\D)0710002(?:\D|$)/u.test(p)&&
    labelled(p,"ИНН",candidate.inn)&&labelled(p,"КПП",candidate.kpp));
  if(financial.length!==1)return review("pdf_financial_page_unproven");
  const page=financial[0],lines=page.split("\n");
  const line=lines.filter(s=>/^\s*(?:[\d.,-]+\s{2,})?Выручка(?:\s*\d{1,2})?\s+2110(?:\s|$)/iu.test(s));
  if(line.length!==1)return review("pdf_2110_row_unproven");
  const before=lines.slice(0,lines.indexOf(line[0])).join(" ");
  // Require the report's actual current/previous year column order.
  const years=[...before.matchAll(/(?:19|20)\d{2}/g)].map(x=>Number(x[0]));
  const currentAt=years.indexOf(candidate.year),previousAt=years.indexOf(candidate.year-1);
  if(currentAt<0||previousAt<=currentAt)return review("pdf_year_columns_unproven");
  const row=/^\s*(?:[\d.,-]+\s{2,})?Выручка(?:\s*\d{1,2})?\s+2110\s{2,}(.+?)\s*$/iu.exec(line[0]);
  if(!row)return review("pdf_2110_columns_unproven");
  const cells=row[1].trim().split(/[ \t]{2,}/u);
  if(cells.length!==2||parseCell(cells[0])!==candidate.current||
    parseCell(cells[1])!==candidate.previous)
    return review("pdf_2110_value_disagreement");
  const rub=candidate.current*1000;
  if(!Number.isSafeInteger(rub)||rub<0||rub>1e15)return review("revenue_scale_unproven");
  return {status:"verified",reason:"girbo_annual_2110_pdf_verified",revenue_rub:rub,
    revenue_year:candidate.year,unit:"thousand_rubles",row_code:"2110"};
}
export async function runGirBoBackfill({checkpoint,sourceId,childId,limit=10000,
  year=new Date().getUTCFullYear()-1,confirmationMode="json",lookup,onCheckpoint,onProgress=()=>{}}){
  if(!sourceId||!childId||sourceId===childId||typeof lookup?.search!=="function"||
    typeof lookup?.reports!=="function"||!["json","pdf"].includes(confirmationMode)||
    (confirmationMode==="pdf"&&typeof lookup?.pdf!=="function")||
    typeof onCheckpoint!=="function")throw Error("GIRBO_BAD_RUN");
  const snapshot=structuredClone(checkpoint),plan=planGirBoBackfill(snapshot,{limit,year,confirmationMode});
  const outcomes={...(snapshot.girbo_backfill_outcomes||{})};
  const stats={scheduled:plan.selected.length,processed:0,added:0,review:0,pending:plan.eligible,
    missing_before:plan.missing,missing_after:plan.missing,stop_reason:"",
    confirmation_mode:confirmationMode,by_reason:{},openai_requests:0,saby_requests:0};
  const now=new Date().toISOString();
  Object.assign(snapshot,{created_at:now,updated_at:now,girbo_backfill_source_job_id:sourceId,
    girbo_backfill_root_job_id:checkpoint.girbo_backfill_root_job_id||sourceId,
    girbo_backfill_outcomes:outcomes,girbo_backfill_stats:stats});
  const save=async()=>{
    stats.pending=plan.eligible-stats.processed;
    stats.missing_after=plan.missing-stats.added;
    snapshot.updated_at=new Date().toISOString();
    await onCheckpoint(structuredClone(snapshot));
  };
  await save();
  let schemaFailures=0;
  for(const target of plan.selected){
    const {row,inn,id}=target;
    let result,candidate;
    try{
      const org=selectGirBoOrganization(row,await lookup.search(inn));
      result=org;
      if(org.status==="candidate"){
        candidate=selectGirBoAnnualReport(row,org,await lookup.reports(org.organization_id),{year});
        result=candidate;
        if(candidate.status==="candidate"&&confirmationMode==="json"){
          result=verifyGirBoStructuredReport(candidate);
        }else if(candidate.status==="candidate"){
          const pdf=await lookup.pdf(candidate);
          result=verifyGirBoPdfText(candidate,pdf?.text);
          if(result.status==="verified"){
            if(typeof pdf?.sha256!=="string"||!/^[a-f0-9]{64}$/.test(pdf.sha256))
              result=review("pdf_provenance_unproven");
            else result={...result,pdf_sha256:pdf.sha256};
          }
        }
      }
    }catch(error){
      const allowed=["GIRBO_REQUEST_BUDGET","GIRBO_HTTP_DENIED","GIRBO_RATE_LIMITED","GIRBO_HTTP_UNAVAILABLE",
        "GIRBO_RESPONSE_UNPROVEN","GIRBO_PDFTOTEXT_MISSING","GIRBO_PDF_SIZE_LIMIT"];
      stats.stop_reason=allowed.includes(error?.message)?error.message:"GIRBO_SOURCE_UNAVAILABLE";
      await save();break;
    }
    // A series of unrecognized source response shapes suggests a changed
    // service contract. Do not burn through the queue or mark it exhausted.
    if(["search_response_incomplete","report_response_unproven","published_annual_report_unproven",
      "pdf_identity_unproven","pdf_period_correction_unproven","pdf_unit_unproven",
      "pdf_financial_page_unproven","pdf_2110_row_unproven","pdf_year_columns_unproven",
      "pdf_2110_columns_unproven","pdf_2110_value_disagreement"].includes(result.reason))
      schemaFailures++;
    else schemaFailures=0;
    if(schemaFailures>=3){
      stats.stop_reason="GIRBO_CONSECUTIVE_PROOF_FAILURES";await save();break;
    }
    if(result.status==="verified"){
      if(saved(row[REVENUE_FIELD])||innOf(row)!==inn)result=review("source_row_changed");
      else{
        const detail={source:"GIR_BO",inn,ogrn:candidate.ogrn,kpp:candidate.kpp,
          source_url:candidate.source_url,report_id:candidate.report_id,
          detail_id:candidate.detail_id,correction_number:candidate.correction_number,
          published_date:candidate.published_date,revenue_rub:result.revenue_rub,
          revenue_year:result.revenue_year,unit:result.unit,row_code:"2110",
          verification:result.verification||"official_pdf_and_json",
          ...(confirmationMode==="json"?{search_url:candidate.search_url,
            report_json_url:candidate.report_json_url,unit_basis_url:result.unit_basis_url,
            projection_sha256:result.projection_sha256,projection:result.projection}:{
            report_url:candidate.report_url,pdf_sha256:result.pdf_sha256}),
          verified_at:new Date().toISOString()};
        row[REVENUE_FIELD]=detail.revenue_rub;
        const ev=row.__evidence||{};
        const proofUrl=confirmationMode==="json"?detail.source_url:detail.report_url;
        row.__evidence={...ev,girbo_finance_backfill:detail,
          source_urls:[...new Set([...(Array.isArray(ev.source_urls)?ev.source_urls:[]),proofUrl])]};
        row.__comment=[String(row.__comment||""),"ГИР БО, выручка за "+detail.revenue_year+
          " г. (строка 2110): "+detail.revenue_rub+" руб.; "+proofUrl].filter(Boolean).join("\n");
        stats.added++;
      }
    }
    if(result.status!=="verified")stats.review++;
    outcomes[id]={status:result.status,reason:result.reason,inn,year_ceiling:year,
      search_revision:SEARCH_REVISION,confirmation_mode:confirmationMode,
      ...(result.status==="verified"?{revenue_year:result.revenue_year,revenue_rub:result.revenue_rub}:{})};
    stats.processed++;
    stats.by_reason[result.reason]=(stats.by_reason[result.reason]||0)+1;
    await save();
    await onProgress({...stats});
  }
  return {snapshot,stats:{...stats}};
}

export const girboPdfHash=buffer=>createHash("sha256").update(buffer).digest("hex");
