// Read-only diagnostic of already saved evidence. Never fill an INN or
// promote A/B from a note alone: provenance must be explicit and entity-bound.
const normalized = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").trim();
const unique = (values) => [...new Set(values)];
const validInn = (value) => {
  const d = String(value || "");
  if (!/^(?:\d{10}|\d{12})$/.test(d)) return false;
  const mod = (w) => w.reduce((n, x, i) => n + x * Number(d[i]), 0) % 11 % 10;
  return d.length === 10 ? mod([2,4,10,3,5,9,4,6,8]) === Number(d[9])
    : mod([7,2,4,10,3,5,9,4,6,8]) === Number(d[10]) &&
      mod([3,7,2,4,10,3,5,9,4,6,8]) === Number(d[11]);
};
const urlsInNote = (note) => {
  const fromMarkdown = [...String(note).matchAll(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/g)].map(x=>x[1]);
  const naked = [...String(note).matchAll(/https?:\/\/[^\s)\]]+/g)].map(x=>x[0].replace(/[.,;]+$/, ""));
  return unique([...fromMarkdown, ...naked]).filter(url => {try {return ["https:", "http:"].includes(new URL(url).protocol)} catch {return false}});
};
// Evidence note flags are triage hints only. Never treat a saved assertion
// as independently verified legal identity or permission to reclassify.
const INTERMEDIARY_NOTE = /(?:роль классифицирована как посредник|роль отнесена к intermediaries|организация отнесена к посредник|компания отнесена к посредник|оставлен в intermediaries)/i;
const DISCOVERY_NOTE = /(?:discovery-канал|конечными потенциальными покупателями являются указанные)/i;
const LEGAL_FORM_NOTE = /(?:в исходном названии указана некорректная организационно-правовая форма|некорректная организационно-правовая форма)/i;
const SEPARATE_SUCCESSOR_NOTE = /(?:не объединено с.{0,125}правопреемник|отдельным юридическим лицом и правопреемником)/i;
const GROUP_FLEET_NOTE = /(?:распределение.{0,120}между.{0,95}не раскрыто|общий парк группы.{0,120}не раскрыто)/i;
const SOURCE_NOTE_URL = (row) => (Array.isArray(row.source_urls)?row.source_urls:[])
  .find(url => /^https?:\/\//i.test(String(url))) || "";
const findReviewFlags = (row, notes) => {
  const out=[];
  const name=normalized(row.organization);
  for (const note of notes) {
    const n=normalized(note);
    if (row.sheet==="direct_buyers" &&
        /(?:^журнал|^справочник|^каталог)/i.test(name) && DISCOVERY_NOTE.test(n)) {
      out.push({type:"source_only_in_direct_buyers",proposed_role:"discovery_source",
        evidence_note:note,source_url:SOURCE_NOTE_URL(row)});
    } else if (row.sheet==="direct_buyers" && INTERMEDIARY_NOTE.test(n)) {
      out.push({type:"intermediary_in_direct_buyers",proposed_role:"intermediaries",
        evidence_note:note,source_url:SOURCE_NOTE_URL(row)});
    }
    if (LEGAL_FORM_NOTE.test(n)) {
      out.push({type:"legal_form_mismatch",proposed_role:"verify_registry_legal_form",
        evidence_note:note,source_url:SOURCE_NOTE_URL(row)});
    } else if (SEPARATE_SUCCESSOR_NOTE.test(n)) {
      out.push({type:"separate_legal_successor",proposed_role:"verify_distinct_ogrns",
        evidence_note:note,source_url:SOURCE_NOTE_URL(row)});
    }
    if ((row.replay_grade || row.qualification_status)==="A" && GROUP_FLEET_NOTE.test(n)) {
      out.push({type:"group_fleet_not_entity_attributed",proposed_role:"verify_entity_specific_fleet",
        evidence_note:note,source_url:SOURCE_NOTE_URL(row)});
    }
  }
  return out;
};
function sharedExactSourcePairs(rows) {
  const byUrl=new Map(),pairs=new Map();
  for(const row of rows) {
    if(!row.inn)continue;
    for(const raw of row.source_urls || []) {
      const u=String(raw).trim().toLowerCase().replace(/\/+$/,"");
      if(!/^https?:\/\//i.test(u)) continue;
      const list=byUrl.get(u)||new Map();
      list.set(String(row.canonical_id||row.organization),row);
      byUrl.set(u,list);
    }
  }
  for(const [url,sourceMap] of byUrl.entries()) {
    const group=[...sourceMap.values()];
    if(group.length<2 || group.length>7)continue;
    for(let i=0;i<group.length;i++)for(let j=i+1;j<group.length;j++) {
      const left=group[i],right=group[j];
      if(left.inn===right.inn)continue;
      const ids=[String(left.canonical_id||left.organization),String(right.canonical_id||right.organization)].sort();
      const key=ids.join("|"),state=pairs.get(key)||{ids,organizations:[left.organization,right.organization],inns:[left.inn,right.inn],shared_urls:[]};
      state.shared_urls.push(url);pairs.set(key,state);
    }
  }
  return [...pairs.values()].filter(p=>p.shared_urls.length>=2).map(p=>({...p,
    status:"source_overlap_not_an_identity_or_ownership_proof"}));
}
export function auditReplayEvidence(data) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const owners = new Map();
  for (const r of rows) if (validInn(r.inn)) owners.set(r.inn, [...(owners.get(r.inn)||[]), r]);
  const report = [];
  for (const row of rows) {
    const notes = Array.isArray(row.evidence_notes) ? row.evidence_notes : [];
    const linked = [];
    const unlinked = [];
    for (const note of notes) {
      if (/^(?:final inn:|identity:|подтвержденный инн:)/i.test(normalized(note))) continue;
      const links = urlsInNote(note);
      if (links.length) linked.push({statement:note, source_urls:links, status:"explicit_inline_url_not_independently_verified"});
      else unlinked.push(note);
    }
    const candidates = unique(notes.flatMap(note=>
      [...normalized(note).matchAll(/подтвержденн(?:ый|ого)\s+инн\s*:\s*(\d{10}|\d{12})/gi)]
        .map(m=>m[1]))).filter(validInn);
    const legal = [];
    if (!row.inn) {
      for (const inn of candidates) {
        const conflicts = owners.get(inn)||[];
        legal.push({inn,status:conflicts.length?"already_used_by_another_row":"candidate_requires_legal_verification",
          existing_owners:conflicts.map(x=>({canonical_id:x.canonical_id,organization:x.organization}))});
      }
    }
    // A filled INN does NOT prove that a second "Подтверждённый ИНН"
    // belongs to this same legal person. Preserve the contradictory note.
    const conflictsWithFilled = row.inn ? candidates.filter(inn=>inn!==String(row.inn)) : [];
    report.push({canonical_id:row.canonical_id,organization:row.organization,
      current_grade:row.replay_grade, current_inn:row.inn,
      claims_with_inline_urls:linked, notes_without_inline_urls:unlinked.length,
      candidate_inns_for_review:legal,
      conflicting_inns_in_saved_notes:conflictsWithFilled.map(inn=>({
        inn, status:"manual_entity_provenance_review",
        existing_owners:(owners.get(inn)||[]).map(x=>({
          canonical_id:x.canonical_id,organization:x.organization}))
      })),
      role_and_legal_review_flags:findReviewFlags(row,notes),
      facts_are_not_verified_by_this_audit:true});
  }
  return {source_checkpoint:data.checkpoint||"", source_rows:rows.length,
    no_api_calls:true, source_unchanged:true,
    summary:{fact_records_with_explicit_inline_urls:report.reduce((n,r)=>n+r.claims_with_inline_urls.length,0),
      rows_missing_inn:rows.filter(r=>!r.inn).length,
      inn_candidates_for_manual_review:report.reduce((n,r)=>n+r.candidate_inns_for_review.length,0),
      detected_cross_row_inn_conflicts:report.reduce((n,r)=>n+r.candidate_inns_for_review.filter(x=>x.status==="already_used_by_another_row").length,0),
      filled_rows_with_conflicting_saved_inn:report.filter(r=>r.conflicting_inns_in_saved_notes.length>0).length,
      explicit_role_and_legal_flags:report.reduce((n,r)=>n+r.role_and_legal_review_flags.length,0),
      distinct_inn_candidates_on_blank_rows:new Set(report.flatMap(r=>r.candidate_inns_for_review.map(x=>x.inn))).size},
    shared_source_pairs:sharedExactSourcePairs(rows),
    candidate_inn_groups:[...new Set(report.flatMap(r=>r.candidate_inns_for_review.map(x=>x.inn)))].map(inn=>({
      inn,records:report.filter(r=>r.candidate_inns_for_review.some(x=>x.inn===inn))
        .map(r=>({canonical_id:r.canonical_id,organization:r.organization})),
      status:"manual_review_no_automatic_merge"
    })),
    records:report};
}
