# Saby-only: one uninterrupted sweep of the remaining regional queue

## Why earlier runs stopped around 52-60 firms

The production Stage 12 has an independent wall-clock budget:
`STAGE12_MAX_MS` defaults to **1,800,000 ms (30 minutes)** and is
hard-clamped at 2 hours. In the latest Smolensk Saby-only job, 52 firms
were examined in approximately one bounded attempt; the queue contained
312 still-unfinished firms. Earlier jobs each required another manual
click after their time budget. This is unnecessary for Saby-only runs.

This change **does not** claim that every firm can be fully enriched:
an exact-INN miss, a failed legal-name verification, or absent contact/
fleet widgets must remain `deferred`. One sweep means *one honest attempt
per still-eligible unfinished company*, not fabrication of missing data.

## New Saby-only execution model

- `SABY_ONLY_MAX_MS` defaults to **43,200,000 ms (12 hours)** and is
  bounded to 30 minutes–24 hours. It applies only to Saby-only
  continuations and can be configured without changing paid research.
- The standard full paid research Stage12 retains its original
  `STAGE12_MAX_MS=1,800,000` default and maximum of 2 hours.
- Existing `SABY_MAX_COMPANIES` safety override is respected. **For one
  complete regional pass, ensure `SABY_MAX_COMPANIES=0` in the VPS
  `.env` before starting.** If it is 60 or another nonzero number,
  the collector will deliberately stop after that number despite 12h.
- Saby-only saves `saby_completed_inns`, `saby_deferred_inns`,
  `saby_attempted_inns`, and `final_result` after **each** company,
  even if `SABY_CHECKPOINT_EVERY` is set to a higher number for ordinary
  research. The parent checkpoint remains unchanged.
- Companies that were already completed are skipped. The pending
  queue prioritizes never-visited INNs before previously deferred ones.
  Each unresolved INN is visited **once within this sweep**.
- Checkpoint stats now distinguish `maxDurationMs`,
  `deadlineReached`, and `fullSweepCompleted`. A completed sweep may
  legitimately have `deferred>0` without being a failure.
- UI says `Вся очередь Saby проверена` after a complete sweep and
  explicitly calls a further run a **retry**. It does not imply that
  remaining companies were fully enriched.
- Existing protections remain: headed Playwright, registered company
  INN/name match, circuit break after repeated systemic errors, one
  shared browser/profile at a time, explicit cancellation, and no
  OpenAI/other paid stages. No changes to the XLSX layout or phones.

## VPS rollout

1. Finish/download any currently active jobs. Do not restart an active
   study. Ensure the last XLSX/JSON are saved.
2. Back up `data/checkpoints.sqlite` with the existing
   `deploy/time4vps/backup_sqlite.py` snapshot script.
3. Check `SABY_MAX_COMPANIES=0` (and `SABY_STAGE12_ENABLED=true` +
   existing Saby fleet opt-in) in `.env`. No change is needed if zero.
4. `sudo -u regionalresearch git -C /opt/regionalresearch pull --ff-only origin main`.
5. Restart the service **only if no jobs are running**.
6. Check `curl -fsS http://127.0.0.1:10000/health` after the server
   has fully started. Choose Smolensk, then **Продолжить только Saby
   (без OpenAI)** once. Leave the VPS process running. The browser tab
   itself need not stay open; jobs run in the Node service.
7. The job can take several hours. Download its XLSX and JSON after
   completion **before** restarting the service, and inspect the
   `saby_stats.fullSweepCompleted` / `deadlineReached` fields in its
   saved SQLite checkpoint.

## Recovery behavior

A server crash, system restart, real browser outage, an explicit
`SABY_MAX_COMPANIES` guard, or reaching the 12h budget can still
interrupt the sweep. The durable checkpoint preserves the latest
completed INNs and the attempted cursor so a later Saby-only
continuation can resume without repeating already-finished firms.
The app does not automatically resurrect a running in-memory job after
a Node.js process restart.

The long-run time budget is a *ceiling*, not a promise about Saby
availability or about obtaining contacts/fleet data for each INN.
