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
    report.push({canonical_id:row.canonical_id,organization:row.organization,
      current_grade:row.replay_grade, current_inn:row.inn,
      claims_with_inline_urls:linked, notes_without_inline_urls:unlinked.length,
      candidate_inns_for_review:legal,
      facts_are_not_verified_by_this_audit:true});
  }
  return {source_checkpoint:data.checkpoint||"", source_rows:rows.length,
    no_api_calls:true, source_unchanged:true,
    summary:{fact_records_with_explicit_inline_urls:report.reduce((n,r)=>n+r.claims_with_inline_urls.length,0),
      rows_missing_inn:rows.filter(r=>!r.inn).length,
      inn_candidates_for_manual_review:report.reduce((n,r)=>n+r.candidate_inns_for_review.length,0),
      detected_cross_row_inn_conflicts:report.reduce((n,r)=>n+r.candidate_inns_for_review.filter(x=>x.status==="already_used_by_another_row").length,0)},
    records:report};
}
