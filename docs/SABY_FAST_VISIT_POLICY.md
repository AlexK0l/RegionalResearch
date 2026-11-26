# Faster full Stage12 without reducing coverage

New production sweeps default to `SABY_FAST_PASS_ENABLED=true`. The durable
v1 cursor stores its chosen strategy; old in-progress cursors remain on the
original four passes. A newly requested sweep may use the new strategy.
The phase names, max company limit (0 = all eligible), and no overall
regional deadline are unchanged.

1. First pass: companies with missing phone/email, phone priority preserved.
   Contacts first. During the same verified card visit, read already-visible
   financial data and the truck tile if requested. A quick finance read is
   a single DOM snapshot, never a lazy scroll or a guessed fiscal year.
   A quick fleet is accepted only for the same verified contractor, an
   explicit complete count and all models (including explicit zero).
   Partial or ambiguous previews remain missing.
2. Contact retry: only companies still missing phone/email; the same
   opportunistic visible details can be retained. No slow fleet overlay
   or finance scroll delays regional phone coverage.
3. Full details: every remaining finance/fleet gap uses the original full
   finance scroll and fleet traversal. Companies with existing contacts
   are also included. No quick read consumes this full attempt.
4. Full detail retry: preserve the existing truck retry and accompanying
   financial recovery; unresolved gaps remain explicit for continuation.

Save a separate strict observed first-party route hint even if no widget
gave a useful fact. A hint is never contact evidence, section completion,
or proof of identity. Direct navigation still requires fresh scoped INN
and name verification, with the existing full-search fallback on failure.
Never invent a card ID or reuse a different company's card. Contact DOM
ancestor inspection uses one read with the original bounded fallback.
Fix the old contact catch block referencing an undefined exception.
Requested-section readiness polling retains bounded waits; it no longer
waits for irrelevant widgets on optimized visits.

Timing is persisted with the existing v1 cursor and safe aggregate
`saby_stats.timing`. `SABY_SECTION_TIMING` logs numeric task measurements
only (no URL, company, phone, DOM or credentials). It records saved-card
and full-search time, search/identity, requested-widget readiness, contact,
finance and fleet reads, and SQLite checkpoint time. Session open/close,
admission and delay are accumulated separately. Search/card and substeps
overlap by design; do not sum them as independent time. The final
checkpoint's own write time and failed browser calls without a returned
record may not be fully represented. Timing from old checkpoints is absent,
not zero elapsed work. Full sweep remains distinct from zero unresolved
gaps. No new OpenAI calls, browser parallelism, workbook changes or
historical database edits.

Default delay stays at the previously configured `SABY_DELAY_MS`.
Optional `SABY_ADAPTIVE_DELAY_ENABLED=true` permits a lower explicitly
configured `SABY_ADAPTIVE_DELAY_MIN_MS` (at least 750 ms, never greater than
the normal delay) after four fast successful visits; failures/slow visits
reset, systemic failures back off. Keep it disabled until real source
behavior has been measured. Do not shorten safety timeouts or increase
browser concurrency to claim a faster sweep.

Offline tests prove the reduced number of visits on complete and partial
fixtures and preserve exact full-section coverage/cursor recovery. Real
speedup, lazy widget behavior and source throughput need the next normal
regional run on VPS; do not rerun old regions or interrupt active Saby.
