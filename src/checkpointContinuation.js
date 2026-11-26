// Resume semantics for a completed or interrupted contact phase.
// An unanswered batch item is NOT evidence that a contact was not found.
// These helpers have no I/O and are safe for offline checkpoint regression.
export function restoredDeferredContactIds(checkpoint, eligibleIds, completedIds) {
  const allowed = new Set([...eligibleIds].map(String).filter(Boolean));
  const completed = new Set([...completedIds].map(String).filter(Boolean));
  const deferred = Array.isArray(checkpoint?.contact_unsearched_ids)
    ? checkpoint.contact_unsearched_ids
    : [];
  return new Set(deferred.map(String).filter((id) =>
    id && allowed.has(id) && !completed.has(id)
  ));
}

export function pendingContactRows(rows, completedIds, savedPrimaryResults, idOf) {
  const completed = new Set([...completedIds].map(String).filter(Boolean));
  const primary = savedPrimaryResults instanceof Map
    ? savedPrimaryResults : new Map(Object.entries(savedPrimaryResults || {}));
  return (rows || []).filter((row) => {
    const id = String(idOf(row) || "");
    return !id || (!completed.has(id) && !primary.has(id));
  });
}

export function recordContactAttempt(id, researched, completedIds, unsearchedIds) {
  const key = String(id || "").trim();
  if (!key) return false;
  if (researched) {
    unsearchedIds.delete(key);
    return true; // Caller commits completion only after applying the result.
  }
  completedIds.delete(key);
  unsearchedIds.add(key);
  return false;
}

// A saved primary answer may already have populated all visible fields
// before conflict verification/commit. Keep it eligible on resume without
// requesting the same paid primary answer again.
export function contactResumeCandidates(rows,checkpoint,idOf,needsContact){
  const version=Number(checkpoint?.contact_stats?.version||0);
  const primary=version>=2&&checkpoint?.contact_primary_results&&typeof checkpoint.contact_primary_results==="object"
    ?new Set(Object.keys(checkpoint.contact_primary_results)):new Set();
  const completed=new Set(version>=2&&Array.isArray(checkpoint?.contact_completed_ids)
    ?checkpoint.contact_completed_ids.map(String):[]);
  return (rows||[]).filter(row=>{
    const id=String(idOf(row)||"");
    return needsContact(row)||(id&&primary.has(id)&&!completed.has(id));
  });
}
