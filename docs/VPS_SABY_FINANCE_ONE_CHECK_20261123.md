# Saby finance: one-company safe diagnostic

This run uses the existing SQLite checkpoint. Never launch while a full study or another Saby session is active.

1. Verify service and commit: `git -C /opt/regionalresearch rev-parse --short HEAD` (the required fix was merged in `2d151fa4`).
2. Use the existing `scripts/saby-finance-backfill.js` in read-only mode with `--db=/opt/regionalresearch/data/checkpoints.sqlite --checkpoint=add5a597-ca3b-41eb-add0-d6694a2748bb`.
3. Confirm `unvisited` and `scheduled` in `SABY_FINANCE_BACKFILL_PLAN` are positive before requesting a run. If not, stop.
4. With no active jobs, back up the live SQLite using `deploy/time4vps/backup_sqlite.py` and test `--run --limit=1` using the existing headed Chromium/Xvfb environment.
5. Review `SABY_POST_ROUTE_DIAG` and `SABY_FINANCE_BACKFILL_DONE` without modifying the original checkpoint. No OpenAI calls are made.

For the executable, fail-closed wrapper see the accompanying local artifact `vps-saby-finance-one-check.sh` in the ChatGPT audit handoff; the wrapper is NOT installed on VPS by this PR.
