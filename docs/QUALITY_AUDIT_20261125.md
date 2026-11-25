# Offline commercial-output quality audit (2026-11-25)

Scope: exported Leningrad study, 608 active records (585 direct buyers,
19 intermediaries, 4 leasing), 315 review, 91 excluded. The export was
from a saved partial Saby checkpoint, not a new research run.

- XLSX opened and ZIP integrity passed. Five tabs, email before phone,
  608 commercial rows and numeric finance matched JSON. All company and
  basis notes present; phone display differences were separator spacing.
- INN 463, revenue 376, employees 370, phone 228, email 253, both contacts
  186, neither 313. No active duplicate current canonical ID or valid INN.
- All 64 GIR BO additions matched saved proof INN/amount and projected
  row 2110 x 1000; all projection hashes matched. 63 reports for 2025 and
  one for 2024. All 11 FNS staff additions matched saved INN/employee proof.
  This was an offline consistency check, not a live re-verification.
- 94 A, 70 B, 444 C. 22 A records lacked a unique exact claim URL.
  41 A/B records lacked INN; 63 A/B had neither phone nor email.
  96 overlapping historical source IDs across review/excluded and active
  lineage, none between active survivors. No claim that all 96 represent
  duplicate firms.
- A real merged survivor had archived original legal names with different
  explicit numeric designations. Its neighbor was also present as a
  separately identified company. Correct the generic merge rule rather
  than hard-code the affected names or reuse a reference region.
- Two selected A notes explicitly described insufficient trailer proof.
  A separate independently positive note may still qualify as A; never
  promote the negative note itself.
- 40 company comments said "Email: не найден" despite a populated email
  cell. Export should reflect the current cell while retaining source
  provenance.

Changes: numbered-name conflicts block fuzzy and shared-INN merges at
early canonicalization and later alias boundaries; all members must be
pairwise compatible. A final quality gate retains already contaminated
merged originals in REVIEW rather than deleting evidence. Insufficiency
of trailer proof is rejected by both candidate selection and final QA.
Export synchronizes stale email lines and strips empty citation labels.
No paid calls, no new regional research, no change to workbook columns.
The existing uploaded checkpoint remains unchanged; these safeguards
apply on subsequent qualification/export, not retroactively to the
already downloaded file. A fresh offline requalification and independent
evidence review are required before claiming the historical data fixed.
