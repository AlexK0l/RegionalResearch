# Scoped markup-first full-card collector

The supplied 2026-11-27 rendered Gazprom card is approximately 1.4 MB.
It includes loaded application scripts and serialized state (not necessarily
this company), an explicit own INN row, compact/expanded H1, a main contact
block with "Еще 59", a rounded revenue banner without a fiscal year,
an employee range, four vehicle category tiles and measurement clones.
The independent vehicle navigation total and detailed finance table are
not mounted in that snapshot. Never treat the preview as complete.

## Implementation

Use Chromium's already-parsed HTML, not page.content() plus a second HTML
parser. Transfer only bounded structured widget observations, not the
authenticated full document, scripts, cookies, global stores or raw
network responses. No extra dependency, no disk HTML cache.

* Identity: one fast exact scope check on the unique contractor card,
  visible explicitly labelled own INN, and matching complete visible H1
  titles using the same legal-name normalization. Any other layout or
  alias uses the existing broad/independent ownership verification in
  the same evaluation. Route stability is mandatory for the fast proof.
* After fresh identity proof, one combined DOM projection of requested
  contacts, finances and all-category fleet. The same finance/vehicle
  parsers also serve the original collectors. An absent or ambiguous
  section is not completion. Contacts are scoped to the actual own
  main-contact block, not related companies or global page text.
* Skip section readiness/duplicate collection only when all requested
  fields of that section can be filled. Revenue still requires a
  validated accounting year; staff ranges are not numbers. Complete
  fleet needs independent total, every category and every vehicle row.
  If all vehicles are already proved in the snapshot, do not open the
  drawer. Otherwise retain the original full fleet/finance/contact
  path and targeted second pass. No direct/private API calls.
* The observed "Еще N" contact marker is counted, not interpreted as
  missing-data proof. Completing the phone/email CRM fields does NOT
  claim that every hidden contact record was extracted. This patch
  does not introduce an unverified extra-contact drawer selector:
  the existing collector remains the fallback for missing fields.
* No cursor, scope, checkpoint, dependency, memory admission or paid
  budget changes. Explicit SABY_MARKUP_FAST_PATH_ENABLED=false reverts
  both new fast paths at a safe restart; default true. Prior strategies
  retain their collectors (only exact scoped identity can accelerate).

Telemetry: markup_ms, markup_scans, markup_scope_hits, markup_owner_hits
(primary search), markup_contacts_hits, markup_financial_hits,
markup_fleet_hits, markup_contacts_more. Counts are in the existing
SABY_SECTION_TIMING records and durable totals. No data values logged.

A 7 h / 648-company pass is about 39 s per company. Previous timings
show search and fresh ownership dominate; local extraction already
takes fractions of a second for some sections. This version removes
redundant DOM calls, avoids broad scans for exact owner layouts, and
skips active fleet operations for already complete previews. It cannot
remove Saby server/network latency or prove live coverage/speed without
a matched sample. Offline regression tests cover proof, ambiguity,
partial previews, route drift and fallback. Do not restart a running
region only to run a separate live benchmark.
