# Saby v13: exact fleet failure stage, without repeating blind smokes

## What was established on Time4VPS on 2026-11-11

The v11 one-company smoke verified source INN 7725104641 with three
independent private owner snapshots and the canonical Saby public
registered identity. One normalized phone and one email were preserved.

The v12 headed attempt failed BEFORE the browser opened because Chromium
Crashpad exited with SIGTRAP (`--database is required`). A completely
fresh profile also failed in headed mode. A fresh profile started
successfully only after **both writable XDG configuration and cache
directories** were explicitly supplied.

The v13 smoke therefore ran in headed Chromium under existing manually
started Xvfb `:99`, using:

```bash
XDG_CONFIG_HOME=/home/regionalresearch/.config/regionalresearch-saby
XDG_CACHE_HOME=/home/regionalresearch/.cache/regionalresearch-saby
```

The company passed exact private/public legal identity proof again,
phone updates were correctly zero (the number was already saved),
and `deferred=1` correctly kept the unresolved direct-buyer truck
section. The terminal did NOT distinguish whether the fleet widget was
missing, an overlay could not be closed, or the vehicle list could not
be read. The v13 output JSON was not attached when this change was made,
so the exact `collection.trucks` status is not yet independently known.
There is no basis to label the company as having zero trucks.

## Instrumentation only, NO speculative fleet recovery

Only in an explicitly opted-in Saby-only smoke, the collector now emits
**one** `[SABY_FLEET_DIAG]` event when a fleet section is not confirmed.
Ordinary production Stage12 remains quiet and unchanged. It contains fixed reason and phase codes,
and safe booleans and counters for:

- whether the exact `Автопарк компании` heading is visible;
- whether a `Контакты и телефоны` overlay still covers the card;
- whether a fleet side panel and `Грузовые` category labels appear;
- whether a unique truck summary tile was recognized;
- when such a tile exists: its *count* and the number of vehicle rows
  parsed, whether a side panel appeared, whether its category expanded.

Possible reasons: `contact_overlay_not_closed`,
`fleet_heading_missing`, `truck_preview_missing`,
`truck_preview_ambiguous`, `truck_count_invalid`,
`vehicle_rows_incomplete`, `fleet_interaction_failed`.

No company names, INNs, KPPs, phone/email values, vehicle model names,
raw errors, browser profile paths, DOM text, cookies or raw URLs are
printed. The diagnostic never marks a fleet as verified, modifies
Playwright selectors or changes the research result. Existing partial
checkpoint semantics and strict five-sheet SAT XLSX are unchanged.

## One materially new test, after Ubuntu/Windows CI and merge

Use the **existing v13 output** to preserve already confirmed contacts.
The virtual X server `:99` is running manually on this host (the
`regionalresearch-saby-xvfb.service` systemd unit was not installed).
Do not kill the active Xvfb process, install/restart services or modify
the browser profile merely for this smoke. Confirm no other Chromium
session uses the saved Saby profile.

```bash
sudo -u regionalresearch git -C /opt/regionalresearch pull --ff-only origin main

sudo -u regionalresearch env \
  HOME=/var/lib/regionalresearch \
  DISPLAY=:99 \
  XDG_CONFIG_HOME=/home/regionalresearch/.config/regionalresearch-saby \
  XDG_CACHE_HOME=/home/regionalresearch/.cache/regionalresearch-saby \
  PLAYWRIGHT_BROWSERS_PATH=/home/regionalresearch/.cache/ms-playwright \
  npm --prefix /opt/regionalresearch run saby:smoke -- \
  --result=/opt/regionalresearch/exports/saby-stage12-fleet-headed-v13-20261111.json \
  --limit=1 --public-identity-fallback \
  --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
  --out=/opt/regionalresearch/exports/saby-stage12-fleet-diagnostic-v14-20261111.json
```

The output filename must be fresh. Do not start the full paid regional
research; this smoke has no OpenAI calls and does not write SQLite or
the original JSON. Share the `[SABY_FLEET_DIAG]` line, the final
summary and v14 JSON. If v14 succeeds with `trucks=verified` (including
an explicitly verified count of zero), inspect the actual model list
for nonzero counts before rollout.

## Stop rules

- `contact_overlay_not_closed`: identify the safe UI close control.
  Do NOT bypass the overlay or scrape underlying unrelated content.
- `fleet_heading_missing`: determine whether this legal entity has
  an authorized fleet section at all. Do not conclude zero vehicles.
- `truck_preview_missing/ambiguous`: investigate the exact DOM
  structure of that first-party fleet panel, not the legal-entity search.
- `vehicle_rows_incomplete`: compare the announced truck count with
  the visible listed rows before a targeted pagination/expansion fix.
- `fleet_interaction_failed`: browser event needs focused investigation
  before changing selectors.

Do not repeat unmodified smokes if the new diagnostic still indicates
the same unresolved stage. The optional production Stage12 remains OFF
until contacts and fleet handling are independently validated.

## Later production configuration (not needed for this smoke)

The optional `deploy/time4vps/regionalresearch-saby-xvfb.conf.example`
now includes the two writable XDG paths, in addition to `DISPLAY=:99`
and `SABY_HEADLESS=false`. This is only an EXAMPLE, not an installed
service. Before installing it, the two directories must exist and be
owned by `regionalresearch` with mode 0700. Confirm the display systemd
unit is actually installed and no manually started Xvfb conflicts with
`:99`. Do not restart the production backend during active jobs.
