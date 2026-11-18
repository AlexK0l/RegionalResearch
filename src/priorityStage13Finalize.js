// Stage13 output corrections: commercial buyer/channel separation and explicit
// e-mail fields. Uses already saved evidence only: no search, Saby or OpenAI.
// A lease agreement naming the company as LESSOR is not proof it operates a
// semitrailer to carry its own cargo.
import {companyEmailCell,EMAIL_COLUMN} from "./emailContact.js";

const str=x=>String(x??"");
const normalized=x=>str(x).normalize("NFKC").toLocaleUpperCase("ru-RU")
  .replace(/Ё/g,"Е").replace(/[‐‑‒–—−]/g,"-").replace(/\s+/g," ").trim();
const isObject=x=>x&&typeof x==="object"&&!Array.isArray(x);
const channelList=["direct_buyers","intermediaries","leasing"];

function evidenceNotes(row){
  return Array.isArray(row?.__evidence?.notes)?row.__evidence.notes.map(str):[];
}
/**
 * A role transfer needs explicit same-company commercial-role evidence.
 * A mention of another company's lease agreement is NOT enough.
 * Do not classify by company name or the presence of "лизинг" alone.
 */
export function stage13CommercialRole(row){
  const name=normalized(row?.["Организация"]);
  const a=str(row?.__a_evidence),notes=evidenceNotes(row);
  if(!name)return null;
  // No hard-coded lessor brand names or company-name heuristics: rely
  // solely on explicit role attribution preserved for this legal entity.
  // An explicit channel designation overrides a misleading company name.
  const intermediary=notes.find(n=>
    /(?:роль|компания)\s+(?:классифицирована\s+как|отнесена\s+к)\s*(?:intermediaries|посредник)/iu.test(n)||
    /роль\s*:\s*(?:продавец|посредник|дилер)/iu.test(n));
  if(intermediary)return {channel:"intermediaries",
    reason:"explicit_intermediary_role_in_saved_evidence",evidence:intermediary.slice(0,320)};

  // Selected A evidence is company-bound; when it identifies this company as
  // lessor, the fact that it holds property is not a direct-cargo use case.
  // A display name may include an alias/group after " / ". Check the
  // first named legal entity, not the entire display label, against evidence.
  const key=name.split(/\s+\/\s+/u)[0]
    .replace(/^(?:ООО|ПАО|АО|ОАО|ЗАО|ИП)\s*/u,"")
    .replace(/[«»"']/gu,"").trim();
  const evidence=normalized(a).replace(/[«»"\x27]/gu,"");
  const position=key.length>=5?evidence.indexOf(key):-1;
  const selectedNamesCompany=position>=0;
  // Require the grammatical lessor role immediately after the ROW company
  // name. A lease agreement that mentions another lessor later in the
  // sentence must NOT reclassify a lessee as a financing channel.
  const sameCompanyRole=position<0?"":evidence.slice(position+key.length,position+key.length+105);
  // Support real source language ("прямо указано", "выступало") but
  // only when the lessor role immediately follows THIS row's company.
  // A role for another party later in the note must never transfer a lessee.
  const selectedLessor=selectedNamesCompany&&
    /^\s*(?:ПРЯМО\s+)?(?:УКАЗАН[АОЫ]?|ВЫСТУПАЕТ|ВЫСТУПАЛ[АО]?|ЯВЛЯЕТСЯ|НАЗВАН[АОЫ]?)\s+ЛИЗИНГОДАТЕЛ[А-ЯЁ]*/u.test(sameCompanyRole);
  const explicitRole=notes.find(n=>
    /(?:^|[;.]\s*)роль\s*:\s*лизингодател[а-яё]*(?:\s*\/\s*реализатор)?/iu.test(n)||
    /не\s+(?:конечный|непосредственный)\s+эксплуатант/iu.test(n));
  if(selectedLessor||(selectedNamesCompany&&explicitRole))
    return {channel:"leasing",
      reason:selectedLessor?"selected_company_is_explicit_lessor":"explicit_lessor_not_operator",
      evidence:(selectedLessor?a:explicitRole).slice(0,420)};
  return null;
}

function identityKey(row){
  const inn=str(row?.["ИНН"]).trim();
  if(/^\d{10}$|^\d{12}$/.test(inn))return "inn:"+inn;
  // Missing INN: safe duplicate detection on exact normalized name only.
  return "name:"+normalized(row?.["Организация"]);
}
function mergeSameEntity(existing,row){
  // Preserve all evidence and contacts if the same legal entity already
  // exists in the channel; never overwrite independent legal entities.
  const left=isObject(existing.__evidence)?existing.__evidence:{},
    right=isObject(row.__evidence)?row.__evidence:{};
  const unique=(a,b)=>[...new Set([...(Array.isArray(a)?a:[]),
    ...(Array.isArray(b)?b:[])])];
  existing.__evidence={...right,...left,
    notes:unique(left.notes,right.notes),
    source_urls:unique(left.source_urls,right.source_urls)};
  for(const key of ["Телефон","Руководитель / ЛПР","Управляющая компания",
    "Следующее действие","Основание","Техника/сегмент"]){
    if(!str(existing[key]).trim()&&str(row[key]).trim())existing[key]=row[key];
  }
  existing[EMAIL_COLUMN]=companyEmailCell(existing)||companyEmailCell(row);
  const ids=unique(existing.__stage13_merged_original_ids,
    [identityKey(row)]).filter(Boolean);
  existing.__stage13_merged_original_ids=ids;
}
export function stage13RouteCommercialRoles(result){
  if(!Array.isArray(result?.direct_buyers)||
     !Array.isArray(result?.intermediaries)||
     !Array.isArray(result?.leasing))
    throw new TypeError("Stage13 commercial routing requires buyer, intermediary and leasing arrays");
  const initial={direct_buyers:result.direct_buyers.length,
    intermediaries:result.intermediaries.length,leasing:result.leasing.length};
  const moved=[],retained=[],deduplicated=[];
  const existing={
    intermediaries:new Map(result.intermediaries.map(r=>[identityKey(r),r])),
    leasing:new Map(result.leasing.map(r=>[identityKey(r),r]))
  };
  for(const row of result.direct_buyers){
    const rule=stage13CommercialRole(row);
    if(!rule){retained.push(row);continue;}
    const channel=result[rule.channel],key=identityKey(row),
      prior=existing[rule.channel].get(key);
    if(prior){
      mergeSameEntity(prior,row);
      deduplicated.push({company:row["Организация"],key,channel:rule.channel});
    }else{
      row.__stage13_commercial_role={
        status:"reassigned",from:"direct_buyers",to:rule.channel,
        rule:rule.reason,evidence:rule.evidence
      };
      channel.push(row);
      existing[rule.channel].set(key,row);
    }
    moved.push({company:row["Организация"],inn:row["ИНН"]||"",
      from:"direct_buyers",to:rule.channel,
      score_before_move:row["Итоговый коэффициент"]??null,
      rule:rule.reason,evidence:rule.evidence});
  }
  result.direct_buyers=retained;
  const final={direct_buyers:retained.length,
    intermediaries:result.intermediaries.length,leasing:result.leasing.length};
  const beforeTotal=Object.values(initial).reduce((a,b)=>a+b,0),
    afterTotal=Object.values(final).reduce((a,b)=>a+b,0);
  if(beforeTotal!==afterTotal+deduplicated.length)
    throw new Error("Stage13 commercial routing lost rows without accounted deduplication");
  return {version:1,initial,final,moved_count:moved.length,
    deduplicated_count:deduplicated.length,
    preserved_count:afterTotal,moved,deduplicated};
}
export function stage13PopulateExplicitEmails(result){
  const counts={total:0,filled:0,created:0,sections:{}};
  for(const section of channelList){
    const rows=Array.isArray(result?.[section])?result[section]:[];
    let filled=0;
    for(const row of rows){
      if(!isObject(row))continue;
      const had=Object.prototype.hasOwnProperty.call(row,EMAIL_COLUMN);
      const email=companyEmailCell(row);
      row[EMAIL_COLUMN]=email;
      if(!had)counts.created++;
      if(email){filled++;counts.filled++;}
      counts.total++;
    }
    counts.sections[section]={total:rows.length,filled};
  }
  return counts;
}
export function finalizeStage13CommercialOutput(result){
  const roles=stage13RouteCommercialRoles(result);
  const emails=stage13PopulateExplicitEmails(result);
  return {roles,emails,paid_calls:0,saby_calls:0};
}
