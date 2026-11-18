# Saby-only from a fully audited Stage13 priority checkpoint

## Problem
A research can finish Stage 13 but crash before persisting the final
`completed` snapshot. For Leningrad 2026-11-18 the original full SQLite
checkpoint is `phase=priority` (job id
`2f5abeaa-8ec7-4101-b5b7-70e7e4355999`), with all 56/56 model
decisions, existing contact and Saby results, and 457 Saby deferrals.
The `recover:priority:offline` command produced a separate audited
customer-facing Excel/JSON, but intentionally did not alter SQLite.

Previously the UI's Saby-only selector rejected `priority` snapshots
and could not continue Stage12 from that proven existing dataset.

## Behavior
For full-research, resumable `priority` SQLite sources **only**:
- First run the same strict synchronous, offline reconstruction used by
  `recover:priority:offline`, in memory. It checks four complete
  result arrays; saved Stage11, Stage12 and Stage13 states; full AI model
  coverage; source-field immutability; and no commercial row loss.
- Any missing or incomplete data fails closed
  (`SABY_PRIORITY_SNAPSHOT_INCOMPLETE`). A regular earlier unfinished
  job is **not** a Saby-only source.
- Completed Stage13 classification reuses cached verdicts; no OpenAI,
  identity, discovery or contacts requests are made by this validation.
- The last audited commercial role routing is applied in memory.
  The original SQLite payload is unchanged.
- `GET /api/checkpoints?region=...` can offer the existing **only
  Saby (no OpenAI)** action for that specific checkpoint id. A newer
  Saby-only child supersedes it in the selector.
- Starting that action creates a different child Saby checkpoint with
  immutable provenance (`saby_continuation_source_job_id` and root job).
  The original failed job and prior corrected exports remain available.
- Saby itself is a real browser integration; its one-pass, auth/profile
  and circuit-breaker requirements are **not bypassed**. Do not start a
  large Saby pass until the VPS Chromium/Xvfb systemic failure is diagnosed.

## VPS: verification before Saby
1. Confirm the newest `main` passes CI and the running service is not
   processing an existing job. Back up SQLite before any restart.
2. Confirm Xvfb is active, DISPLAY=:99 is reachable for the service user,
   and the Playwright browser profile/binary paths are valid. Avoid
   disclosing cookies or `.env` secrets.
3. A browser-only smoke on a single verified firm can be used **when no
   research uses the same Saby profile**.
4. The in-memory recovery must not be exported as a new **full**
   checkpoint or used to repeat an earlier paid pipeline.
5. Select the saved region and use `Продолжить только Saby (без OpenAI)`
   only after the browser failure is resolved; completion is defined as
   *one guarded attempt per previously unfinished eligible company*, not
   confirmation for every firm.

## Offline regression
`node --test test/saby-priority-failed-finalization.test.js`.
The tests exercise complete/incomplete checkpoint acceptance, legal role
and final QA retention, immutable source, and a fake browser child run;
they make no network/Saby/OpenAI calls.
