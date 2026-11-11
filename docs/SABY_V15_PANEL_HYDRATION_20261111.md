# Saby v15: asynchronous fleet panel opening blocks window stitching

## Verified VPS result, 2026-11-11

With `main 3b7e545` on Time4VPS, one headed opt-in Saby smoke
for INN 7725104641 again confirmed the selected legal entity using
three stable authenticated private snapshots and the canonical public
registered name, INN and KPP.

The new fleet-window collector did not start. Its sanitized output was:

- `preview_status=found`, `expected_trucks=220`;
- `parsed_vehicle_rows=3` (only the card's small preview);
- `side_panel_observed=false`, `fleet_panel_title=false`;
- `stitch_reason=panel_not_observed`;
- `window_count=null`, `scroll_moves=null`;
- `deferred=1`, `transportUpdates=0`.

The uploaded v15 JSON still contains the previously validated phone
`74956459818`, an email, `contacts=collected`, `trucks=review`,
`vehiclesVerified=0`, and does NOT invent fleet data.

Earlier v14 on the SAME company and saved profile did open the side
panel, with `side_panel_observed=true` and 40 available rows.
This difference made the panel-opening code the narrow next target,
not the legal-entity search nor the already-tested row assembler.

## Exact regression found in source

The original headed collector clicked the verified `Грузовые` preview
and waited in a bounded loop for the side panel to hydrate, retrying
opening at most once. The new opt-in v15 path clicked once and called
`readWindow()` **immediately**. If the panel had not mounted yet,
it assigned `panel_not_observed` and skipped collection.

This code defect explains how a valid, asynchronously mounted panel
could be missed; whether this fully explains the live v15 outcome is
still a hypothesis until a new on-site sample.

## v16 narrow fix

A new offline-testable `openSabyFleetPanelWithHydration` helper:

1. Captures the original VERIFIED private contractor-detail URL before
   interacting. If it changes during the panel-opening sequence, aborts.
2. Clicks the originally verified, bounded preview rectangle.
3. Polls for the strict same-card side panel in a bounded series of up
   to 20 polls spaced 400 ms apart.
4. If it sees the panel title or a second truck category label but
   cannot match the strict expected 220 count, it **does not click
   again**: another click could close the already open panel. It
   returns `panel_unrecognized`, preserving REVIEW/deferred.
5. Only when there is no sign of any open panel, tries the same preview
   click ONE more time with the same bounded wait.
6. Only after the panel has been independently recognized does the
   existing conservative scroll reset and overlapping-window collector
   start. The exact count, model validation and non-deduplication
   requirements have not been weakened.

New sanitized diagnostic counters include
`panel_open_attempts` (0..2), `panel_wait_polls` (0..50) and
`panel_title_seen` (boolean). These reveal whether the panel was
seen but failed strict recognition, without exposing private company
information, models, phone/email, page DOM or URLs.

Only the experimental `--public-identity-fallback` branch changes;
ordinary Stage12, XLSX layout, source research, SQLite, Google Sheets,
OpenAI and production setup remain unchanged.

## One bounded acceptance on the already working VPS

After Ubuntu/Windows CI passes and PR is merged:

```bash
sudo -u regionalresearch git -C /opt/regionalresearch pull --ff-only origin main
sudo -u regionalresearch git -C /opt/regionalresearch rev-parse --short HEAD

sudo -u regionalresearch env \
  HOME=/var/lib/regionalresearch \
  DISPLAY=:99 \
  XDG_CONFIG_HOME=/home/regionalresearch/.config/regionalresearch-saby \
  XDG_CACHE_HOME=/home/regionalresearch/.cache/regionalresearch-saby \
  PLAYWRIGHT_BROWSERS_PATH=/home/regionalresearch/.cache/ms-playwright \
  npm --prefix /opt/regionalresearch run saby:smoke -- \
  --result=/opt/regionalresearch/exports/saby-stage12-fleet-window-v15-20261111.json \
  --limit=1 --public-identity-fallback \
  --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
  --out=/opt/regionalresearch/exports/saby-stage12-fleet-panel-v16-20261111.json
```

Keep the manually running Xvfb :99; do not restart the site or
overwrite v15. Do not run two browsers with the same saved profile.
This is Saby-only (zero OpenAI calls).

Send only safe `[SABY_FLEET_DIAG]`, `[SABY_CARD]`, final summary
and the new JSON. Interpret `deferred=0` as a candidate success
ONLY when `collection.trucks=verified`, `count=220` and all
220 matching model/year rows really exist in the JSON.

If the panel opens but row assembly still fails, use the distinct
`window_count`, `scroll_moves`, `stitch_reason` to troubleshoot
the exact scrollbar or list structure. Do not repeat the unchanged
smoke indefinitely or fabricate the missing vehicle rows.
