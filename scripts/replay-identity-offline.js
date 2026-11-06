#!/usr/bin/env node
// Reconcile only historical final-INN conflict records. STRICTLY READ ONLY.
// Source: local SQLite checkpoint (including WAL). No web_search or API calls.
import { DatabaseSync } from "node:sqlite";
import { confirmedInnAliasDecision, identityOgrns } from "../src/legalIdentity.js";

const sqlitePath = process.argv[2] || "data/checkpoints.sqlite";
const db = new DatabaseSync(sqlitePath, { readOnly: true });
let checkpoint;
try {
  const row = db.prepare(
    "SELECT id, region, payload FROM research_checkpoints WHERE status = 'completed' AND mode = 'full' ORDER BY updated_at DESC LIMIT 1"
  ).get();
  if (!row) throw new Error("No completed full research checkpoint");
  checkpoint = { id: row.id, region: row.region, ...JSON.parse(row.payload) };
} finally {
  db.close();
}

const groups = new Map();
const rows = Array.isArray(checkpoint.deduped_records) ? checkpoint.deduped_records :
  ["direct_buyers", "intermediaries", "leasing"]
    .flatMap((sheet) => (checkpoint.final_result?.[sheet] || []).map((row) => ({ row })));

for (const record of rows) {
  const original = record?.row || record;
  const notes = Array.isArray(original?.__evidence?.notes) ? original.__evidence.notes : [];
  const matches = [...new Set(notes.flatMap((note) => {
    const matched = String(note).match(/Final INN conflict:\s*ИНН\s*(\d{10}|\d{12})/i);
    return matched ? [matched[1]] : [];
  }))];
  const verified = String(original?.__evidence?.identity_verification?.inn || "");
  for (const inn of matches) {
    if (verified !== inn) continue; // not an independently traceable candidate
    if (!groups.has(inn)) groups.set(inn, []);
    groups.get(inn).push({ ...record, row: { ...original, "ИНН": inn } });
  }
}

const details = [];
let potentialAliasMerges = 0, unresolvedIdentityGroups = 0;
for (const [inn, records] of groups) {
  if (records.length < 2) {
    details.push({ inn, state: "single_conflict_record", organizations: records.map((r) => r.row["Организация"]) });
    continue;
  }
  const partitions = [];
  const pairDecisions = [];
  for (const record of records) {
    let destination = null;
    for (const cluster of partitions) {
      const decisions = cluster.map((member) => confirmedInnAliasDecision(record, member, inn));
      pairDecisions.push(...decisions.map((d) => ({
        organization: record.row["Организация"],
        against: cluster.map((r) => r.row["Организация"]),
        reason: d.reason,
        merge: d.merge,
        ogrnsA: d.ogrnsA,
        ogrnsB: d.ogrnsB
      })));
      if (decisions.every((d) => d.merge)) { destination = cluster; break; }
    }
    if (destination) destination.push(record);
    else partitions.push([record]);
  }
  potentialAliasMerges += records.length - partitions.length;
  if (partitions.length > 1) unresolvedIdentityGroups++;
  details.push({
    inn,
    source_rows: records.length,
    clusters_after_safe_aliases: partitions.length,
    possible_merges: records.length - partitions.length,
    status: partitions.length === 1 ? "merge_candidate" : "manual_review_required",
    legal_entities: partitions.map((cluster) => cluster.map((r) => ({
      organization: r.row["Организация"],
      ogrns: identityOgrns(r.row),
      identity_sources: (r.row.__evidence?.identity_verification?.source_urls || []).slice(0, 3)
    }))),
    pair_decisions: pairDecisions
  });
}
console.log(JSON.stringify({
  input: { sqlite: sqlitePath, checkpoint_id: checkpoint.id, region: checkpoint.region },
  original_contested_inns: groups.size,
  potential_alias_merges: potentialAliasMerges,
  groups_still_requiring_review: unresolvedIdentityGroups,
  important: "Diagnostic only; original SQLite is not modified. No INNs are restored from old cleared values. Candidate merges require a fresh source-aware qualification pass.",
  details
}, null, 2));
