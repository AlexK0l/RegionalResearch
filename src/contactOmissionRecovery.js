// Deterministic, bounded recovery for companies OMITTED by the model's
// multi-company contact response. A researched "not_found" with an actual
// source is never retried. The caller remains responsible for all hard
// web-search and dollar-limit checks.
const numberBetween = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
};

export function contactOmissionRecheckLimits(env = process.env) {
  return {
    batches: numberBetween(env.OPENAI_CONTACT_OMISSION_RECHECK_BATCHES, 8, 0, 12),
    batchSize: numberBetween(env.OPENAI_CONTACT_OMISSION_RECHECK_BATCH_SIZE, 3, 2, 4),
    reservedWebForPhoneConflicts: 6
  };
}

export function planContactOmissionRechecks(
  rows, unsearchedIds, completedIds, idOf, priorityOf,
  limits = contactOmissionRecheckLimits()
) {
  const outstanding = unsearchedIds instanceof Set ? unsearchedIds :
    new Set(Array.isArray(unsearchedIds) ? unsearchedIds : []);
  const done = completedIds instanceof Set ? completedIds :
    new Set(Array.isArray(completedIds) ? completedIds : []);
  const seen = new Set();
  const eligible = (Array.isArray(rows) ? rows : []).filter(row => {
    const id = String(idOf(row) || "");
    if (!id || !outstanding.has(id) || done.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).sort((a,b) => Number(priorityOf(b) || 0) - Number(priorityOf(a) || 0));
  const size = numberBetween(limits.batchSize, 3, 2, 4);
  const maxGroups = numberBetween(limits.batches, 8, 0, 12);
  const selected = eligible.slice(0, maxGroups * size);
  const groups = [];
  for (let i=0; i<selected.length; i+=size) groups.push(selected.slice(i,i+size));
  return { groups, eligible: eligible.length, selected: selected.length,
    deferredWithoutRecheck: eligible.length - selected.length };
}
