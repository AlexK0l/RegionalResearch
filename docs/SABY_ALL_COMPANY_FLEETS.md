# Complete truck fleet coverage across all commercial companies

Fresh production Stage12 sweeps now require truck coverage for direct buyers,
intermediaries, and leasing companies. The default is
`SABY_ALL_COMPANY_FLEETS_ENABLED=true`. No change to the strict five-sheet
workbook, A/B/C rules, Stage13 coefficients, or OpenAI budgets.

A v1 pass stores `fleet_scope` (all_commercial_v1 or direct_buyers_v1).
Older active v1 cursors lacking that field retain the direct-only scope and
their exact attempted section keys. A new explicit Saby-only child from an
exhausted cursor can pick up real gaps across all three sheets, including old
completed checkpoints with an empty deferred list. The source is immutable.
Legacy injected diagnostic collectors retain the existing direct-only plan.
The actual server and contact-first continuation validate the same fresh plan.
An explicit environment opt-out affects only new sweeps.

Speed: Stage12 builds a transient per-entry section-gap index using the
existing strict truck/finance/contact validators; only the visited row is
revalidated after a browser visit. Previously each task's snapshot validated
the entire saved model/year inventory at least twice, even when just one row
changed. This index is rebuilt from the durable rows on every resume. It is
not a substitute for fresh identity proof or per-task SQLite persistence.
Keep existing visit strategy, short visible reads, RAM rotation and full
details retries; do not add visits for already verified required sections.

`saby_stats.fleetCoverage` is a Stage12 snapshot (before Stage13 role routing):
target rows, eligible, invalid, duplicate, positive, zero, unknown and verified
vehicle count, including breakdown by sheet. Invalid/duplicate rows remain
blocked and unknown, not zero. Eligible rows are unique INNs. Unknown includes
all unresolved/blocked target rows. No new raw private data in statistics.
The existing organization comment in intermediary/leasing exports carries
the verified truck count and grouped model/year inventory, including for rows
reassigned after Stage12. Only very large presentation notes are capped; full
validated evidence remains in JSON. No new Excel columns or sheets.

Offline tests cover scope, cursor compatibility, no unnecessary visits,
all-group continuation after legacy completion, positive/zero/unknown counts,
and read-only idempotent export notes. Live Saby coverage and speed still
require matched VPS measurement. This does not resolve the missing-INN,
duplicate-identity or uncertain result-grid cases; it makes them visible.
Do not interrupt an active investigation or automatically revisit old regions.
