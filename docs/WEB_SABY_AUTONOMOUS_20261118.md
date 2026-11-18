# Browser-first Saby-only continuation and durable downloads

As of 2026-11-18, RegionalResearch already has a full, audited
Leningrad result in checkpoint
`2f5abeaa-8ec7-4101-b5b7-70e7e4355999`, as well as a separately
recovered 558-company export. There is no need to restart paid discovery,
INN lookup or contact searches.

## User-facing workflow

1. Open the normal RegionalResearch HTTPS page.
2. Select **Ленинградская область**.
3. Prefer the prominent **Продолжить только Saby (без OpenAI)** over
   **Начать новое исследование**.
4. Monitor the progress (company count, verified additions and
   per-company checkpoint saves). You may leave/reopen the web page.
5. If Saby is temporarily unstable, up to two new headed Chromium
   *sessions* are attempted automatically, resuming the saved
   eligible/attempted queues. No repeat of the paid 1–11 stages.
6. If the upstream Saby browser/site remains unusable after bounded
   reconnects, the job reports a **partial** result, keeps
   `phase=saby` in its durable child SQLite checkpoint and exposes
   a continuation action. Do not claim the full fleet is verified
   unless the vehicle rows match the company count.
7. Use **Скачать сохранённый XLSX** / **Скачать сохранённый JSON**
   on the same region page, even after Node is restarted. Exports
   are generated directly from SQLite with the approved five-sheet
   template and zero paid API calls.

The UI explicitly warns before starting a new paid full study when a
checkpoint already exists.

## Safety

- The parent full-research snapshot is immutable. Each Saby-only
  continuation creates a child with its own ID and single-company
  checkpoint writes.
- Browser sessions use the existing exclusive persistent-profile queue
  in `withSabyBrowser`, so parallel studies do not open the same
  profile concurrently.
- Identity matching, exact INN/name guard, private-source provenance,
  verified fleet-count threshold and `SABY_CIRCUIT_OPEN` remain
  unchanged. Two restarts are for transient browser outages only, not
  infinite retries.
- All read-only export routes are inside the existing `/api`
  authentication guard. No arbitrary user-provided JSON is accepted
  as a checkpoint or exported.
- `SABY_MAX_COMPANIES=0` is required for the entire eligible
  pending queue in one job. A positive value intentionally bounds a
  batch and leaves the remaining work for continuation.
- `STAGE13_AI_SABY_ONLY_ENABLED` should remain false for a
  truly zero-OpenAI Saby-only job.

## Deployment to Time4VPS

Only after checking no active jobs:

```bash
cd /opt/regionalresearch
sudo -u regionalresearch python3 deploy/time4vps/backup_sqlite.py \
  --source /opt/regionalresearch/data/checkpoints.sqlite \
  --directory /var/lib/regionalresearch/backups
sudo -u regionalresearch git pull --ff-only origin main
sudo systemctl restart regionalresearch
curl -fsS http://127.0.0.1:10000/health
```

No manual `saby:smoke` or single-company offset/INN test is a
prerequisite for the web workflow. Regression tests run automatically
through GitHub Actions.
