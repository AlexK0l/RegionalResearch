// Deterministic offline review queues for completed regional/Saby runs.
// This module NEVER fills missing legal identifiers, changes grades, or
// promotes incomplete Saby sections. It prepares evidence-led follow-ups.
import {buildMissingInnRecoveryQueue} from "./sabyMissingInnRecovery.js";
import {
  disclaimsSelectedTrailerEvidence,selectedADirectBuyerIsOnlyInference
} from "./productionFinalQuality.js";
import {companyEmailCell} from "./emailContact.js";

const SECTIONS=["direct_buyers","intermediaries","leasing"];
const str=v=>String(v??"").trim();
const pickUrls=(row,limit=6)=>
  [...new Set((row?.__evidence?.source_urls||[])
    .filter(v=>typeof v==="string"&&/^https?:\/\//i.test(v)))]
    .slice(0,limit);
const list=value=>Array.isArray(value)?value:[];

function classifyAClaim(row,claim,sheet){
  const explicitNegative=disclaimsSelectedTrailerEvidence(claim);
  const inferred=sheet==="direct_buyers"&&selectedADirectBuyerIsOnlyInference(claim);
  return {
    priority:explicitNegative||inferred?"highest":"high",
    issue:explicitNegative?"selected_claim_disclaims_trailer_evidence":
      inferred?"selected_claim_only_inference":"claim_source_unattributed",
    action:explicitNegative||inferred
      ?"Проверить основание A заново; при отсутствии прямого доказательства направить на переквалификацию."
      :"Подтвердить, какой конкретно URL доказывает выбранное утверждение A; общий список ссылок недостаточен."
  };
}

/** Returns a read-only, identity-safe work queue from exported final JSON. */
export function buildPostSabyRemediation(payload){
  const source=payload?.final_result&&typeof payload.final_result==="object"
    ?payload.final_result:payload;
  if(!source||SECTIONS.some(section=>!Array.isArray(source[section])))
    throw new TypeError("Expected final_result with three commercial arrays");
  const rows=SECTIONS.flatMap(sheet=>source[sheet].map(row=>({sheet,row})));
  const companyById=new Map(rows
    .filter(({row})=>str(row.__canonical_id))
    .map(({row,sheet})=>[str(row.__canonical_id),{row,sheet}]));
  const missingInn=buildMissingInnRecoveryQueue(payload);
  const qa=payload?.final_quality_gate||source.final_quality_gate||{};
  const aReview=list(qa.a_claim_attribution_review).map(entry=>{
    const found=companyById.get(str(entry.canonical_id));
    const row=found?.row||{};
    const selected=str(entry.selected_a_evidence);
    return {
      canonical_id:str(entry.canonical_id),
      sheet:found?.sheet||"",
      organization:str(entry.organization||row["Организация"]),
      inn:str(row["ИНН"]),
      original_grade:str(row.__final_grade),
      a_rule:str(entry.a_rule),
      selected_claim:selected,
      claim_source_status:str(entry.status||"missing_claim_source"),
      potential_sources:pickUrls(row),
      ...classifyAClaim(row,selected,found?.sheet),
      auto_reclassified:false
    };
  });
  const partial=[],notCaptured=[];
  for(const {sheet,row} of rows){
    const inn=str(row["ИНН"]);
    const evidence=row.__evidence?.saby;
    if(!evidence){
      if(inn)notCaptured.push({
        canonical_id:str(row.__canonical_id),
        sheet,organization:str(row["Организация"]),inn,
        action:"Повторять Saby только при новом способе идентификации/доступности источника; ранее подтверждённые данные не затирать."
      });
      continue;
    }
    // Never classify a mismatching Saby card as company-owned evidence.
    const trusted=inn&&str(evidence.inn)===inn&&
      /^https:\/\/profile\.saby\.ru\//i.test(str(evidence.source_url));
    if(!trusted){
      partial.push({
        canonical_id:str(row.__canonical_id),sheet,
        organization:str(row["Организация"]),inn,
        contacts:"untrusted",trucks:"untrusted",vehicles:null,
        email:companyEmailCell(row),
        reason:"saby_identity_or_source_not_verified",
        action:"Повторно проверить юрлицо и принадлежность карточки Saby. Не переносить сведения другой организации.",
        saby_source_url:""
      });
      continue;
    }
    const contacts=str(evidence.collection?.contacts)||"missing";
    const trucks=str(evidence.collection?.trucks)||"missing";
    const transportNeeded=sheet==="direct_buyers";
    if(contacts==="collected"&&(!transportNeeded||trucks==="verified"))continue;
    partial.push({
      canonical_id:str(row.__canonical_id),sheet,
      organization:str(row["Организация"]),inn,contacts,trucks,
      vehicles:Number.isSafeInteger(Number(evidence.trucks?.count))
        ?Number(evidence.trucks?.count):null,
      email:companyEmailCell(row),
      reason:contacts!=="collected"&&transportNeeded&&trucks!=="verified"
        ?"contacts_and_fleet_missing":
        contacts!=="collected"?"contacts_missing":"fleet_missing",
      action:contacts!=="collected"&&transportNeeded&&trucks!=="verified"
        ?"Нужны оба раздела. Повторять после изменения способа извлечения Saby."
        :contacts!=="collected"
        ?"Сохранить подтверждённый автопарк; отдельно получить контактный раздел."
        :"Сохранить подтверждённые контакты/email; отдельно подтвердить раздел грузовых ТС.",
      saby_source_url:str(evidence.source_url)
    });
  }
  const nonemptyEmail=rows.filter(({row})=>companyEmailCell(row)).length;
  return {
    version:1,region:str(payload?.region||source.region),
    summary:{
      commercial_rows:rows.length,
      missing_inn:missingInn.summary.missing_inn,
      missing_inn_with_valid_candidates:missingInn.summary.with_valid_candidate,
      a_claims_missing_source:aReview.length,
      a_claims_highest_risk:aReview.filter(x=>x.priority==="highest").length,
      saby_partial:partial.length,
      saby_unverified_or_absent:notCaptured.length,
      companies_with_email:nonemptyEmail,
      rows_auto_changed:0,openai_calls:0,saby_calls:0
    },
    missing_inn:missingInn.rows,
    a_claim_source_review:aReview,
    saby_partial:partial,
    saby_not_captured:notCaptured,
    warning:"Рабочая очередь, а не подтверждение фактов: ИНН и источники A требуют независимой проверки. Отсутствие сведений Saby не означает отсутствия транспорта."
  };
}
