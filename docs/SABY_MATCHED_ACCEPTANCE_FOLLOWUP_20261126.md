# Live acceptance follow-up: preserve fleet recovery and remove repeat visits

Real 12-company paired test on 2026-11-26:
6791f1e: 833096 ms, 34 attempts, 2 positive fleets / 4 vehicles.
50018b7: 887982 ms, 33 attempts, 3 positive fleets / 6 vehicles.
Both sweeps completed. No old verified fleet was lost. The gained fleet was
a previously verified positive control, not a new unknown-company discovery.
Fleet time increased by 64019 ms, total time by 54886 ms. Throughput improved
but the elapsed-time goal failed. Nine originally unknown fleets remained
unknown in both versions. The contact discrepancy concerns two additional
email addresses collected by the baseline, not a deletion from the source
cohort; all input phone/email and existing financial facts survived. The
reports alone do not show why those extra emails were absent in the candidate.
Do not change the identity or contact parser based on a hash difference.

New opt-in strategy `SABY_COMBINE_RETRY_DETAILS_ENABLED=true` (default false)
for NEW production contact-first cursors only: after all first contact
visits finish, run the first full details attempt on the existing contact
retry visit. Read contacts first. Retain the independent 7s details readiness
allowance and strict fleet recovery. A per-section durable marker records
ONLY an actual started full read on the freshly verified same card. If a
section was never reached, or identity changed, the normal details phase
still attempts it. The details_retry phase remains unchanged. Neither
quick data nor an unsuccessful navigation can consume a full attempt.
No fake attempt keys, no lost unresolved companies, no new time cap, no
pacing change. Cursor strategy and markers survive pauses and rotations;
older cursor semantics are preserved. Added INN to numeric visit timing
diagnostic (not raw data); reduced equivalent redundant DOM layout work
for fleet diagnostics and identity existential checks.

The flag is intentionally OFF for deployment until live acceptance.
Reuse the existing protected cohort and reports, with the previous
acceptance CLI from 50018b7, unchanged profile, settings, dependencies and
baseline; run only the candidate, with the new strategy explicitly enabled.
Save stdout/stderr to a protected file (no raw page/credentials). Compare
both prior reports with the new candidate. Since the strategy is the
experimental variable, report its explicit setting separately; all common
benchmark policy fields must match. Review the two missing incremental
emails; do not silently suppress the contact regression criterion. Do not
rerun 12-company baselines merely to measure the new scheduling change.
Actual speed and coverage are still unverified. This change does not solve
remaining unknown fleet widgets or add other vehicle categories.
