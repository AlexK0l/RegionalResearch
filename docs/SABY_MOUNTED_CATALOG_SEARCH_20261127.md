# Search latency: completed-query mounted catalog

Production #177 reported 54 retry visits, 48 full searches, and 45 visits
without a card markup scan. Earlier measured component data show substantial
catalog hydration cost (6.8s average across 201 historical visits) and long
unconfirmed zero-result waits. Those samples are not a controlled comparison.

This change does not shorten the 18-second search or card identity windows,
accept a less precise identity, infer absence from an unconfirmed zero,
reset any cursor, or add another company visit. After the ordinary full
search window and final two stable zero-state reads, a successfully completed
exact HTTP query with no observed pending async work can retain a one-use
navigation hint, including an unresolved search. WebSocket-only evidence,
new loading indicators, failures, changed inputs or changed document identity
cannot authorize this reuse. The next DIFFERENT INN must freshly verify
the mounted document and safe previous field. The submission still
reacquires a safe field, checks stale results, uses the usual candidate
and strict identity proofs, and has the existing cold fallback if the
query was not dispatched. Only the unnecessary cold handler-settle delay
is skipped on this proven mounted route.

Both DOM candidate scans avoid enumerating descendants when the complete
body text has no digit substring of the requested INN. A substring
match still uses all original leaf, geometry, branch, name, duplicate and
ambiguity checks. Compile the consolidation regex once and avoid duplicate
card geometry reads. No new configuration is needed: mounted reuse is
under the existing catalog reuse flag and session socket tracker.

SABY_SEARCH_COMPONENT_TIMING adds catalog_mounted_attempted,
catalog_mounted_hit, catalog_mounted_remembered and mounted_field_proof_ms.
Use these with the existing search and identity timings, separate by
full/retry and outcome. The code and offline regressions establish bounded
behavior, not a measured live speedup or a claim that unconfirmed companies
are absent. Confirm effectiveness in the ordinary next VPS results;
do not replay completed attempts just to benchmark.
