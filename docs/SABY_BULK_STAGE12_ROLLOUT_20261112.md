# Saby Stage 12 — bulk verified fleet tree (November 2026)

## Purpose

Remove the **one-company guard only for the explicitly accepted structured
Wasaby fleet collector**. The real Time4VPS v27 one-company Saby-only test on
12 November 2026 verified all 220/220 advertised trucks with registered
first-party INN/KPP, stable company card, preserved contacts, zero deferrals,
and zero OpenAI/Google Sheet operations.

This change does **not** claim that every possible Saby UI is verified.
Unrecognised cards, incomplete tree rows and unmatched legal entities must
continue to produce review/deferred status rather than invented vehicles.

## Activation

All gates must be present on the actual RegionalResearch server process:

```dotenv
SABY_STAGE12_ENABLED=true
SABY_FLEET_TREE_PRODUCTION_ENABLED=true
SABY_PUBLIC_IDENTITY_FALLBACK_ENABLED=true
SABY_HEADLESS=false
SABY_MAX_COMPANIES=0
SABY_PROFILE_DIR=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110
SABY_CHECKPOINT_EVERY=1
```

- `0` now uses the **verified semantic fleet tree** for **all eligible
  pending** Stage 12 firms. It is **not** a cap on the whole public Saby
  business directory; only companies already found and legally verified by
  the research pipeline are eligible.
- A positive integer from `1` to `20000` caps firms per run but
  **still uses the new fleet collector** when the other flags are enabled.
- Invalid/missing limits do not activate the structural production path.
- `SABY_FLEET_TREE_PRODUCTION_ENABLED=false` or
  `SABY_STAGE12_ENABLED=false` disables the new path.
- The original `--fleet-tail-click` test remains **one-company smoke-only**.
  It does not inherit the bulk production flag.
- No screenshots are captured by production, even if a leftover snapshot
  opt-in is present in `.env`.

The production flag is off by default in `.env.example`. Existing user
VPS configuration stays unchanged until the operator edits its private .env.

## Runtime and correctness boundaries

- The existing `runSabyStage12` visits firms **sequentially**, and
  `withSabyBrowser` serializes concurrent jobs to prevent multiple
  Chromium contexts using the same persistent profile in one process.
  Never independently run the smoke CLI with the production profile while
  a Stage 12 job is active.
- Identity verification remains first-party, tied to the company INN/KPP
  and stable Saby detail route. Never accept branch, related-company or
  different-org truck lists.
- An exact complete vehicle-row count, valid model and optional year are
  required before fleet verification. Identical models are distinct cars.
  Registration numbers and VIN do not become vehicle entries.
- Existing phone provenance and valid phone-only formatting, existing
  transport text, A/B/C qualification and the 5-sheet styled XLSX are
  preserved.
- The existing Stage12 deadline remains `STAGE12_MAX_MS`, default
  `1800000` (30 minutes), configurable up to `7200000` (120 minutes).
  **All eligible is not a promise to finish unlimited firms within this
  deadline**; unvisited or partial firms remain deferred in the durable
  checkpoint. `SABY_CIRCUIT_AFTER` guards repeated errors and
  `SABY_DELAY_MS` paces requests.
- `SABY_CHECKPOINT_EVERY=1` is recommended for unattended bulk processing.
  The Stage 12 loop checkpoints completed/deferred INNs after each company
  when set to 1, and at its end.
- Saby Stage12 makes no paid OpenAI requests. **Starting a new full regional
  study through the web UI still runs the earlier paid stages.** This PR
  does not add an automatic no-paid Stage12-only resume endpoint; it only
  records remaining work and supports resumption using the existing
  checkpoint machinery.

## Time4VPS deployment sequence

1. Do not change configuration or restart while a full study is active.
   Download finished XLSX/JSON first; check SQLite and artifact backups.
2. Verify the managed Xvfb display is `active` and `enabled`, and
   `DISPLAY=:99` works for user `regionalresearch`.
3. Verify the existing Saby profile, browser install, writable XDG dirs,
   and `regionalresearch.service.d/saby-xvfb.conf` drop-in.
4. Wait for CI on both Linux and Windows, then merge. Pull `main` to the
   VPS only during an idle window; do not rerun the installer.
5. Edit **only** the existing `SABY_MAX_COMPANIES=1` to
   `SABY_MAX_COMPANIES=0`, optionally
   `SABY_CHECKPOINT_EVERY=1`. Keep exact tested absolute profile path.
   Review `STAGE12_MAX_MS` for the intended population.
6. Restart the Node service once (only during idle). Check
   `systemctl is-active regionalresearch regionalresearch-saby-xvfb`
   and `curl -fsS http://127.0.0.1:10000/health`.
7. A future suitable research that reaches Stage 12 will process all
   eligible pending firms until the deadline/circuit-breaker. Watch
   `processed`, `verified`, `vehiclesVerified`, `deferred`,
   source identity and final XLSX, not only the HTTP health check.

### Rollback

Set `SABY_MAX_COMPANIES=1` for a bounded verification run, or
`SABY_STAGE12_ENABLED=false` to disable Saby. Restart only when idle.
Never delete SQLite, checkpoints, logs, exports, .env or browser profile.

## Offline regression

`test/saby-bulk-stage12.test.js` validates that an all-companies Stage 12
job uses one browser session, visits every eligible INN once, preserves
duplicate vehicles, writes per-company checkpoints and resumes only the
deferred firm while retaining an already verified phone. Separate production
gate tests check `0`, positive limits, invalid configuration and
production screenshot isolation. No live Saby/API usage occurs in these tests.
