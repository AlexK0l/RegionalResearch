// Offline evidence-first queue for recovering missing source INNs.
// Candidates are not verified and are NEVER assigned to any company row.
import {auditSourceRows} from "./sabyIdentityAudit.js";
import {sabyInn,sabyNameTokens} from "./sabyEnrichment.js";

export function verifiedInnChecksum(raw) {
  const inn=sabyInn(raw);
  if(!inn||/^0+$/.test(inn))return false;
  const check=weights=>weights.reduce((acc,w,i)=>acc+w*Number(inn[i]),0)%11%10;
  if(inn.length===10)
    return check([2,4,10,3,5,9,4,6,8])===Number(inn[9]);
  return check([7,2,4,10,3,5,9,4,6,8])===Number(inn[10]) &&
    check([3,7,2,4,10,3,5,9,4,6,8])===Number(inn[11]);
}
const text=value=>String(value??"").trim();
const nameKey=value=>sabyNameTokens(value).join(" ");
const validEvidenceUrl=value=>{
  try {
    const u=new URL(text(value));
    if(!["http:","https:"].includes(u.protocol)||u.username||u.password)
      return "";
    return u.origin+u.pathname;
  } catch {return "";}
};
const extractTextInnCandidates=value=>{
  const matches=[];
  const source=text(value).slice(0,18000);
  const re=/(?:^|[^\p{L}])(?:ИНН|INN)(?:\s*(?:организации|юрлица|контрагента|[/\\]\s*КПП))?\s*[:№#—-]?\s*(\d{10}|\d{12})(?!\d)/giu;
  for(const m of source.matchAll(re)){
    const offset=m.index||0;
    const neighborhood=source.slice(Math.max(0,offset-100),
      Math.min(source.length,offset+135));
    const conflicted=/не\s+(?:был\s+)?подтвержд[её]н|неверн(?:ый|ое)|ошибочн|отклонен|не\s+соответствует/iu.test(neighborhood);
    matches.push({inn:m[1],conflicted});
  }
  return matches;
};
function candidateRowsFromSource(sourceEntries,allEntries) {
  const owners=new Map(),nameMatches=new Map();
  for(const entry of allEntries) {
    const row=entry.row||{},inn=sabyInn(row["ИНН"]);
    if(!inn)continue;
    if(!owners.has(inn))owners.set(inn,[]);
    owners.get(inn).push({index:entry.index,organization:text(row["Организация"])});
    const key=nameKey(row["Организация"]);
    if(!key)continue;
    if(!nameMatches.has(key))nameMatches.set(key,new Set());
    nameMatches.get(key).add(inn);
  }
  return sourceEntries.map(entry=>{
    const row=entry.row||{},evidence=row.__evidence||{};
    const claims=new Map();
    function push(inn,kind,{conflict=false,url=""}={}) {
      const value=sabyInn(inn);
      if(!value)return;
      if(!claims.has(value))
        claims.set(value,{inn:value,checksum_valid:verifiedInnChecksum(value),
          sources:[],rejected_claim:false,existing_owners:owners.get(value)||[]});
      const claim=claims.get(value);
      claim.sources.push({kind,source_url:validEvidenceUrl(url)});
      if(conflict)claim.rejected_claim=true;
    }
    const blocks=[
      ["row_comment",row.__comment],
      ["evidence_comment",evidence.comment],
      ["evidence_notes",...(Array.isArray(evidence.notes)?evidence.notes:[])],
      ["research_basis",row["Основание"]]
    ];
    for(const [kind,...values] of blocks) {
      for(const value of values)
        for(const found of extractTextInnCandidates(value))
          push(found.inn,kind,{conflict:found.conflicted});
    }
    const verification=[
      evidence.identity_verification,
      evidence.inn_verification,
      evidence.identity,
      row.__identity_verification
    ];
    for(const item of verification) {
      if(!item||typeof item!=="object")continue;
      const inn=sabyInn(item.inn??item["ИНН"]);
      if(!inn)continue;
      const isRejected=item.verified===false ||
        /^(?:rejected|unverified|mismatch|not_verified)$/i.test(text(item.status));
      push(inn,"structured_identity_evidence",{
        conflict:isRejected,url:item.source_url||item.url
      });
    }
    const links=[...(Array.isArray(evidence.source_urls)?evidence.source_urls:[]),
      row.__source_url,row["Сайт"],row["Источник"]].filter(Boolean);
    for(const url of links) {
      try {
        const parsed=new URL(text(url));
        if(parsed.hostname!=="saby.ru"||parsed.protocol!=="https:")continue;
        const m=/^\/profile\/(\d{10}|\d{12})-\d{9}\/?$/.exec(parsed.pathname);
        if(m)push(m[1],"saby_public_profile_link",{url});
      } catch { /* Ignore non-URL notes or unsafe hosts. */ }
    }
    const alias=nameKey(row["Организация"]);
    for(const inn of nameMatches.get(alias)||[])
      push(inn,"same_normalized_name_in_other_source_row");
    const candidates=[...claims.values()].sort((a,b)=>
      Number(b.checksum_valid)-Number(a.checksum_valid)||
      a.inn.localeCompare(b.inn));
    for(const c of candidates){
      c.sources=[...new Map(c.sources.map(s=>[JSON.stringify(s),s])).values()];
    }
    const usable=candidates.filter(c=>c.checksum_valid&&!c.rejected_claim);
    const decision=usable.length===0?"external_registry_search_required":
      usable.length>1?"conflicting_candidate_inns":
      usable[0].existing_owners.length?"possible_duplicate_or_related_company":
      "independent_registry_confirmation_required";
    return {
      index:entry.index,section:entry.group,section_row:entry.group_row,
      original_canonical_id:text(row.__canonical_id),
      organization:text(row["Организация"]),
      existing_inn:text(row["ИНН"]),
      candidates,decision,verified_inn:"",
      auto_filled:false,
      next_action:decision==="external_registry_search_required"?
        "Найти точное юрлицо в ЕГРЮЛ/ЕГРИП по названию и подтверждающим данным.":
        "Независимо подтвердить ИНН, юридическое имя, ОГРН, адрес и текущий статус."
    };
  });
}
export function buildMissingInnRecoveryQueue(raw){
  const all=auditSourceRows(raw);
  const missing=all.filter(entry=>!sabyInn(entry.row?.["ИНН"]));
  const rows=candidateRowsFromSource(missing,all);
  const byDecision={};
  for(const row of rows)
    byDecision[row.decision]=(byDecision[row.decision]||0)+1;
  return {
    summary:{
      total_source_rows:all.length,
      missing_inn:rows.length,
      groups:Object.fromEntries(["direct_buyers","intermediaries","leasing"]
        .map(group=>[group,rows.filter(r=>r.section===group).length])),
      by_decision:byDecision,
      with_any_inn_hints:rows.filter(r=>r.candidates.length>0).length,
      with_valid_candidate:rows.filter(r=>
        r.candidates.some(c=>c.checksum_valid&&!c.rejected_claim)).length,
      auto_filled:0,openai_requests:0,web_requests:0
    },
    rows,
    warning:"Сведения являются только кандидатами. Совпадение ИНН, "+
      "названия, URL или контрольных цифр само по себе не доказывает юрлицо."
  };
}
