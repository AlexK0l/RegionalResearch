# Saby-only SQLite continuation (no paid research stages)

## Background

Ordinary `mode=resume` re-enters `runResearchPipeline` and can rerun
OpenAI/Google-assisted stages. A finalized full research with
`saby_deferred_inns` must be resumable **without** using that paid path.

This feature introduces an explicitly different `mode=saby_only`. It is a
browser-only Stage 12 job using the existing verified Wasaby fleet collector.
It does not import the OpenAI client, invoke the research pipeline or require
`OPENAI_API_KEY`.

## Preconditions

- VPS uses a working `regionalresearch-saby-xvfb` service (headed display
  `DISPLAY=:99`) and the existing authenticated persistent Saby profile.
- Production has explicit `SABY_STAGE12_ENABLED=true`,
  `SABY_FLEET_TREE_PRODUCTION_ENABLED=true`,
  `SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED=true`,
  `SABY_HEADLESS=false`, and `SABY_MAX_COMPANIES=0` (or an explicit
  positive integer cap).
- SQLite has a **previously finalized** full or Saby-only snapshot with
  phase `saby` or `completed`, correct pipeline version, unchanged
  `final_result` arrays (direct_buyers, intermediaries, leasing, statistics),
  and `saby_deferred_inns` nonempty.
- The source is loaded by ID from server-side SQLite. User-supplied
  JSON/checkpoint payloads are **never** accepted by this mode.
- No active full/resume/Saby-only job for the same region. All three modes
  use the same region-reserving in-process queue, so they cannot race.

## From the existing web UI

When a checkpoint has Saby deferrals, select that region or completed/failed
job and click **«Продолжить только Saby (без OpenAI)»**.

This is deliberately distinct from «Продолжить исследование (возможны
OpenAI-запросы)». The latter can re-enter earlier stages.

Saby-only runs in the same job UI, logs its own work and exposes the usual
strict-template XLSX, audit XLSX and JSON downloads. The original full
research and its SQLite record remain unchanged. The child snapshot has
`source_mode=saby`, a new job ID, and lineage fields recording the original
research and parent Saby attempt.

If the server restarts, choose the region again. The UI retrieves the
newest eligible non-superseded source from SQLite; older source IDs are
rejected as stale to prevent replaying outdated vehicles or phones.

## API

All endpoints use the existing `/api` authentication and same-origin
protection.

To discover a source:

```
GET /api/checkpoints?region=<region>&mode=full
```

New response field `saby_checkpoint` is metadata only (ID, region, phase,
`saby_deferred`, version); it is null unless the latest source is safe
and has remaining Saby work.

Start a Saby-only continuation with the returned ID:

```json
POST /api/jobs
{"mode":"saby_only","checkpointId":"<SQLite-job-UUID>"}
```

Returns HTTP 202 with a new job ID. Use existing
`GET /api/jobs/:id`, `POST /api/jobs/:id/cancel`,
`GET /api/jobs/:id/checkpoint` and download endpoints.

Source validation errors return HTTP 409 with a code:
`SABY_BULK_NOT_ENABLED`, `SABY_FINALIZED_SOURCE_REQUIRED`,
`SABY_SNAPSHOT_INCOMPLETE`, `NO_SABY_PENDING`,
`SABY_CHECKPOINT_STALE`, or `CHECKPOINT_VERSION_MISMATCH`.

## Correctness and runtime limitations

- No new company discovery, legal qualification change, fee-bearing
  model calls, OpenAI request or Google Sheets write.
- Reuses the same Stage 12 legal identity verification, confirmed fleet
  count, phone provenance and sequential browser session queue.
- `SABY_CHECKPOINT_EVERY=1` writes a new Saby-only snapshot after
  **every completed company**, in addition to the initial and terminal
  snapshots. The source full checkpoint is never overwritten.
- `STAGE12_MAX_MS` still limits a **single** Saby-only attempt (default
  30 minutes). Remaining work stays deferred. To continue a new attempt,
  click the Saby-only button again. This change does not yet implement an
  unbounded background daemon or automatic retries after Saby failures.
- The circuit breaker `SABY_CIRCUIT_AFTER` still stops repeated failures.
  The browser profile is not shared with the separate smoke CLI concurrently.
- The strict styled reference workbook is generated through the existing
  `buildReferenceWorkbookBuffer`; neither column structure nor tab layout
  changes.
- A future full region research still invokes its usual paid stages.
  **Do not press the ordinary full/resume button** for Saby-only continuation.
- If a Saby-only browser launch fails, the child checkpoint survives and
  the original research result remains available.

## Safe rollout on Time4VPS

1. Allow active research to finish; download existing XLSX/JSON first.
2. Back up SQLite using the SQLite backup API or `.backup`, not just
   a raw copy of the WAL database file while it is live. Keep all Saby
   profiles, logs, artifacts and .env.
3. After GitHub CI completes, update `/opt/regionalresearch` from main.
   Do not rerun the installer or change the authenticated profile path.
4. Restart only `regionalresearch` in an idle window. Do **not** restart
   Xvfb unless it is unhealthy.
5. Verify health, select a region with known Saby deferrals and use the
   new Saby-only button. No new paid full research needed.
6. Watch processed/verified/deferred counts, and download/check XLSX.

Rollback: return to the previous known-good commit or disable
`SABY_STAGE12_ENABLED` and restart only when idle. Child snapshots are
stored separately; never delete `checkpoints.sqlite` or Saby profiles.

## Offline tests

`test/saby-only-continuation.test.js` covers checkpoint validity,
wrong versions, no-paid disabled paths, immutability of parent snapshot,
preservation of phone and sales qualification, per-company checkpoints,
cross-attempt deferred-only continuation and new source lineage. No real
browser, Saby account, OpenAI or Google Sheets call is made in CI.
