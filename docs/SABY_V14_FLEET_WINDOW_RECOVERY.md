# Saby v14: verify complete fleets across virtualized list windows

## Grounded Time4VPS v14 observation (2026-11-11)

Real one-company Saby-only headed Chromium smoke:
- Git main `3503e27`, `DISPLAY=:99`, writable
  `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` explicitly configured.
- 40 search rows -> 11 branches, 28 foreign-INN rows, one primary.
- Selected legal entity was verified with three fresh stable
  authenticated private INN/KPP/H1 snapshots and matching independent
  public registered name, INN and KPP.
- The old Saby phone remained stored; no new OpenAI/search calls.
- `[SABY_FLEET_DIAG]` reported:
  `phase=vehicles`, `reason=vehicle_rows_incomplete`,
  `exact_fleet_heading=true`, `fleet_panel_title=true`,
  `contact_overlay_title=false`, `side_panel_observed=true`,
  `preview_status=found`, `expected_trucks=220`,
  `parsed_vehicle_rows=40`, `expanded=false`.
- No complete fleet was written and the INN stayed `deferred=1`.

This establishes that Saby's current card advertises 220 cargo vehicles,
but our extractor confirmed only 40 individual rows. Whether subsequent
rows are rendered by virtual scrolling, lazy append, or pagination still
needs real UI verification. Do not treat missing 180 as zero vehicles.

## Proven source defect

`sidePanelTrucks` used to increment an internal scroll position but
`ownTrucks` only retained the longest SINGLE panel snapshot. If the
visible DOM has a fixed 40-row window, reading 40 successive windows
still leaves exactly 40 parsed vehicles. The returned count was
correctly rejected rather than silently short-counted.

## Strict opt-in progressive recovery

**Only for explicitly opted-in Saby smoke**
(`--public-identity-fallback`), and only once the company has passed
the existing legal identity verification:

1. Open the same authenticated side panel containing the strict
   `Грузовые 220` summary (or a different independently observed
   integer count). Rewind its scrollable list to the beginning.
2. Read ordered, currently rendered model/year rows; scroll by no more
   than approximately 60% of viewport height and wait for new rows.
3. A later window is appended ONLY when it either extends the exact
   existing DOM prefix or has **exactly one verifiable overlapping
   suffix/prefix boundary**. Never deduplicate identical truck models:
   two identical rows may represent two different vehicles.
4. A missing/ambiguous overlap, unchanged window, nonmoving scroll
   container, invalid model/year, unexpected extra entries, or timeout
   results in INCOMPLETE; zero counts and missing rows are never
   fabricated.
5. Only when the in-order assembled vehicles total **exactly the
   independently stated Saby truck count**, and each model/year passes
   existing strict validation, the source may be marked
   `trucks=verified`. Otherwise the formerly confirmed contacts are
   preserved and the direct buyer remains in `deferred`.

The normal production Stage12 extraction path remains unchanged until
an actual on-site acceptance test confirms the virtualized collector.
Raw vehicle models and page text are held only in ephemeral Node memory
and never emitted in the safe `[SABY_FLEET_DIAG]` line. The diagnostic
gains three allowlisted fields: `window_count`, `scroll_moves` and
`stitch_reason`.

No change to company discovery, OpenAI costs, source JSON or SQLite,
preexisting final SAT workbook columns, tabs, formatting or phones.

## One bounded Saby-only acceptance after Ubuntu and Windows CI

Check that no other process uses the known test browser profile.
Keep the known working manually started Xvfb `:99` as-is;
do not install or restart services for this smoke.

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
  --result=/opt/regionalresearch/exports/saby-stage12-fleet-diagnostic-v14-20261111.json \
  --limit=1 --public-identity-fallback \
  --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
  --out=/opt/regionalresearch/exports/saby-stage12-fleet-window-v15-20261111.json
```

Use a fresh output filename; the source v14 JSON stays unchanged.

Inspect stdout:
- `[SABY_CARD] post_route_registered_identity_verified`
- if incomplete: `[SABY_FLEET_DIAG]` with `window_count`,
  `scroll_moves`, `stitch_reason`, and `parsed_vehicle_rows`
- `deferred` and `transportUpdates` are aggregate indicators,
  not independent proof of vehicle list completeness.

Inspect the new JSON:
- `final_result.direct_buyers[0].__evidence.saby.collection.trucks`;
- if verified: `trucks.count` must be 220 and
  `trucks.vehicles.length` must be 220, with plausible model/year
  entries and proper aggregation in `Наличие транспорта`;
- existing confirmed phone must remain the same, and the `Телефон`
  cell must contain only phone numbers and explicitly proven departments.

If v15 reports `scroll_not_advanced`, the actual fleet list may have
a different scroll container or pagination control. Investigate that
particular first-party UI structure instead of increasing retry counts
or changing legal-identity gates.
If `ambiguous_overlap`, Saby may have repeated indistinguishable
items; use native stable row indices/IDs to confirm placement, never
deduplicate the models.

No full paid research, no backend restart, no new platform change.
