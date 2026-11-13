# Saby Stage 12: fair deferred queue across checkpoint continuations

## Evidence from the real Smolensk export (2026-11-13)

The user supplied a finalized JSON research export, a strict-template XLSX,
and an audit XLSX from the production Saby-only continuation:

- Original commercial population remains 473 (459 direct buyers,
  10 intermediaries, 4 leasing); no company was created by Saby.
- Exactly 25 direct buyers contain verified, first-party Saby evidence.
- 12 of them contain strictly verified truck inventories: 207 distinct
  vehicles (each inventory has count equal to the vehicles array length).
- Only 10 of these 25 have BOTH required Saby contacts and verified trucks.
  2 verified fleets lack collected contacts; the other 13 have missing or
  review truck sections.
- The structured data is preserved in five fixed XLSX tabs. No phone cell
  contains the Saby source name, and all nonempty phone entries are 11-digit
  numbers with delimiters.
- 96 older commercial rows are still missing INN and cannot be matched
  through the strict Stage12 INN rule; this feature does not invent them.

## Problem

The Stage12 loop built the next attempt's queue directly from the eligible
companies after removing completed INNs. **Reviewed but incomplete firms
remain eligible**, and the fixed priority sort puts uncontacted rows first.
An unresolved firm can therefore appear near the front on *every* 30-minute
Saby-only attempt, preventing the engine from ever reaching many untouched
companies. This is especially important for company-specific nonmatches
that produce no trusted Saby evidence at all.

This is a queue fairness issue, **not permission to accept partial fleet
information**. The fix preserves strict identity verification and required
contacts+fleet completion for direct buyers.

## Implementation

- New `saby_attempted_inns` checkpoint array records pending companies
  that received a real Stage12 attempt. It is written after each company
  when `SABY_CHECKPOINT_EVERY=1`, and in terminal checkpoints.
- In a later Saby-only run, **unattempted INNs are processed before previously
  attempted but deferred INNs**. Existing within-group priority still applies.
- After every pending firm has had a first attempt, a new sweep begins,
  allowing previously reviewed firms to be retried. Nothing is permanently
  blacklisted.
- Old checkpoints with no cursor derive initial attempts conservatively
  from trusted, INN-bound, first-party Saby section evidence only. An
  unrelated phone or mere presence of an INN does not count as an attempt.
  Previous no-match visits without stored evidence cannot be reconstructed
  from XLSX alone; after this update new visits are recorded persistently.
- In-memory and durable checkpoints are isolated to the new child job.
  The original full-research SQLite record stays unchanged.
- `runCheckpointedSabyStage12`, the Stage12 pipeline boundary and the
  Saby-only continuation all carry the cursor. A new full run starts with an
  empty cursor; a resumed run reads the saved one.
- `freshScheduled` and `retryScheduled` are added to Stage12 statistics,
  without changing the XLSX template.

## Safety

No new OpenAI, Google Sheets, paid tool calls, discovery or extra network
traffic. Only the **order** of already-eligible, INN-verified Saby queries
changes. One Playwright session, timeout `STAGE12_MAX_MS`, circuit breaker,
per-company checkpoint, phone provenance, truck count and grade preservation
remain intact.

## Checks

`test/saby-fair-deferred-queue.test.js` covers:
1. Three two-company passes reach all six new firms before a fourth pass
   retries reviewed ones;
2. Legacy checkpoint compatibility for trusted partial Saby evidence;
3. Child SQLite checkpoint lineage and durability across two Saby-only runs;
4. Invalid, duplicated and completed INN entries in the cursor cannot
   suppress eligible companies.

No production VPS changes are made by this PR. Wait for Ubuntu/Windows
CI, then deploy only when no research is running, after exporting XLSX/JSON
and backing up SQLite using the existing `backup_sqlite.py` script.
