# Saby v27: accepted live fleet tree and guarded production rollout

## Acceptance on 12 November 2026 (real Time4VPS, Saby-only)

The operator ran `npm run saby:smoke` against the previously saved v26 JSON
with `--limit=1 --public-identity-fallback --fleet-tail-click` and a
persistent headed Chromium profile. The source JSON was unchanged.

VPS commit: `8193cc9`. The process reported:
`checked=1`, `review=0`, `contactUpdates=0`,
`transportUpdates=1`, `deferred=0`, `browserError=null`,
`openai_requests=0` and `google_sheets_writes=0`.

The resulting v27 output was independently examined:

- The same registered DSK Avtoban legal identity had the expected INN/KPP.
- Previously verified phone and email were retained.
- `collection.contacts=collected`; `collection.trucks=verified`.
- Exactly **220 separate vehicle records** match the announced 220 trucks.
- 19 vehicle records have `year=null` and were preserved.
- Duplicate model/year entries were preserved, not collapsed into a fleet total.
- No VIN, plate, or registration-metadata-only model records were found in
  the output. `vehiclesVerified=220`, `partialResults=0`, `deferred=0`.
- `Наличие транспорта` was written into the existing field; the strict
  five-sheet workbook structure is not changed.

This is a successful **one-company** live integration proof. It does not prove
that every Saby company card behaves identically. The full region pipeline and
the normal production Stage 12 were not used in this smoke.

## Exact production rollout contract

This branch introduces **only** an opt-in promotion of the proven
Wasaby tree to the ordinary Stage 12 path.

The new `SABY_FLEET_TREE_PRODUCTION_ENABLED` flag defaults to `false`.
The new tree is chosen for a production Stage 12 run ONLY when:

1. `SABY_STAGE12_ENABLED=true` (Stage 12 is deliberately enabled);
2. `SABY_FLEET_TREE_PRODUCTION_ENABLED=true` (separate v27 acceptance);
3. `SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED=true` (independent first-party
   registered legal identity);
4. `SABY_MAX_COMPANIES=1` (one company initially, NOT all);
5. `SABY_HEADLESS=false` and headed Chromium/Xvfb is available;
6. `SABY_SMOKE_ONLY` is absent (smoke has its own explicit flag).

All other configurations retain the existing collector. In particular,
simply merging this PR or leaving Stage 12 disabled does not start Saby.

Unchanged guarantees: first-party company/INN/KPP and stable Saby route,
bounded re-read/re-click, exactly counted individual vehicle rows, no
unverified fleets, phone preservation, SQLite checkpoint/deferred behavior,
no altered qualification or XLSX layout. Production never writes the
opt-in DOM screenshot or private fleet diagnostics.

## Operator checklist before enabling in production

1. Let active research jobs finish, download any desired results, and verify
   current SQLite/artifact backups. Do not modify `.env` or restart services
   while research is running.
2. Confirm that `regionalresearch-saby-xvfb` is active and enabled.
   **The v27 transcript showed `systemctl is-active ...` = `inactive`
   despite the successful one-off headed smoke.** This must be resolved
   before treating headed Chromium as an unattended always-available service.
   Check:
   `systemctl status regionalresearch-saby-xvfb --no-pager`,
   `systemctl is-enabled regionalresearch-saby-xvfb`,
   `pgrep -a Xvfb`, and
   `sudo -u regionalresearch env DISPLAY=:99 xdpyinfo`.
   Use `docs/SABY_VPS_HEADED.md` for the supported service setup, not
   temporary concurrent Chromium processes.
3. Keep the previously tested authenticated Saby profile accessible only
   to the dedicated user, and never run two Chromium instances on that profile.
4. Merge only after CI passes and review. On a scheduled restart, set the six
   values above in the server's private `.env` and verify effective service
   environment includes `DISPLAY=:99`. Never commit secrets or the profile.
5. Use one saved-checkpoint or explicitly approved low-risk one-company run
   with Stage 12. Compare evidence/phone/transport and checkpoint updates.
   No new full paid regional research is required for the smoke.
6. Observe Saby failures, review/deferred counts, browser resource usage,
   backup health, and Stage 12 deadline before extending scope.
   Increasing `SABY_MAX_COMPANIES` above 1 does NOT automatically extend
   the new collector: a separate reviewed rollout is required.
7. Roll back by setting
   `SABY_FLEET_TREE_PRODUCTION_ENABLED=false` or
   `SABY_STAGE12_ENABLED=false`, then restart after active jobs finish.
   Do not remove or overwrite SQLite, logs, XLSX or auth profile.

No automated deployment, env mutation, production restart or paid research is
performed by this PR.
