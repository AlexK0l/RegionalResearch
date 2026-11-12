# Saby v26: tree collector blocked by stale-coordinate preview opener

## Actual user-provided VPS evidence (2026-11-12)

The user ran a **single headed, Saby-only** smoke on main
41e6073 with the existing authenticated browser profile.
The original full regional research JSON was not overwritten.
Git HEAD and the source inputs were correct.

Strict identity succeeded:
post_route_registered_identity_verified, private H1+INN/KPP,
independently registered public identity, matching the same
first-party contractor. Saved phone and email remained correct.

The fleet DIAG showed:

- preview_status=found; expected_trucks=220
- parsed_vehicle_rows=3 (only summary preview, not the drawer)
- panel_open_attempts=1
- panel_wait_polls=20
- fleet_ui_route_updated=true and fleet_route_reason=ui_navigation_only
- stitch_reason=preview_click_unavailable
- side_panel_observed=false, fleet_tree=null
- trucks=pending/review, deferred=1, transportsAdded=0
- openai_requests=0, google_sheets_writes=0

This does NOT indicate that the new Wasaby tree row collector failed.
It never started: openSabyFleetPanelWithHydration, inherited from
older v15 flows, tried the original preview tile coordinates and
then refused the second click after a SAFE same-company UI route
update to avoid clicking at stale x/y coordinates.

## v27 narrow remedy

New src/sabyFleetTreeOpening.js is ONLY called by an **explicit
one-company headed Saby-only smoke** with
--public-identity-fallback and --fleet-tail-click. The regular
Stage12 route, UI, original JSON and SAT workbook remain unchanged.

1. Before clicking, verify the current first-party contractor card
   against the original independently verified opaque company ID and
   strict known-Saby UI-route classifier.
2. Inspect the REAL Wasaby tree (user-provided DOM format).
   If the exact same category/count is already visible, start
   collection immediately with ZERO preview clicks.
3. If the exact "Автопарк" StackTemplate drawer is VISIBLE but the
   tree is still hydrating, wait with bounded polls. NEVER toggle
   a visible yet unrecognized drawer closed.
4. Otherwise re-read the unique current "Грузовые 220" preview
   tile and its CURRENT viewport rectangle. The rectangle is
   not reused across SPA UI navigation. Only click while the
   entire unique preview target is in the left region and inside
   the viewport. An unknown/wrong count or ambiguous tile blocks
   the action.
5. After a click, recheck that the same company card is still
   selected. Poll the actual Wasaby tree (not the earlier heuristic
   sidePanelTrucks DOM selector).
6. If the first click updates only safe Saby UI query keys but
   opens NO drawer after bounded hydration, independently re-read
   the preview and allow at most ONE additional CURRENT tile click.
   No arbitrary click coordinates and no bypass of the
   exact original contractor ID/INN/KPP proof.
7. If any new panel contains a different truck count, an ambiguous
   category, unexpected company ID/query, or multiple panels,
   fail closed without collecting vehicles or further clicking.
8. When tree observed, existing src/sabyFleetTree.js can collect
   exact one-vehicle-per-item-key rows and click only the
   dynamic "node-footer--GROUPKEY" child-title "Ещё" button,
   until exactly 220 real vehicles are proven. Model duplicates
   remain distinct, VIN and registration details are not rows,
   yearless models use year=null.

Offline tests reproduce the real v26 failure: first preview click
changes only safe Saby UI URL, the preview rectangle moves,
the second click is remeasured and opens a verified drawer.
Other tests cover pre-opened drawer (zero clicks), still hydrating
panel (never toggle), wrong contractor (zero clicks), wrong truck
count, ambiguous panel, missing preview, two-click limit, bad DOM
exception redaction and untouched ordinary Stage12.

No paid OpenAI, no production site restart, no new package, no
Google Sheets write, no SQLite or original source JSON changes,
no changes to the strict five-sheet Excel template or phone-only
phone cells.

## ONE v27 acceptance on Time4VPS after CI and main merge

~~~bash
sudo -u regionalresearch git -C /opt/regionalresearch pull --ff-only origin main
sudo -u regionalresearch git -C /opt/regionalresearch rev-parse --short HEAD

sudo -u regionalresearch env \
  HOME=/var/lib/regionalresearch \
  DISPLAY=:99 \
  XDG_CONFIG_HOME=/home/regionalresearch/.config/regionalresearch-saby \
  XDG_CACHE_HOME=/home/regionalresearch/.cache/regionalresearch-saby \
  PLAYWRIGHT_BROWSERS_PATH=/home/regionalresearch/.cache/ms-playwright \
  npm --prefix /opt/regionalresearch run saby:smoke -- \
  --result=/opt/regionalresearch/exports/saby-stage12-fleet-tree-v26-20261112.json \
  --limit=1 --public-identity-fallback --fleet-tail-click \
  --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
  --out=/opt/regionalresearch/exports/saby-stage12-fleet-tree-v27-20261112.json
~~~

Do not start a competing Chromium on the same authenticated profile.
Use a fresh output name if the listed path already exists.

If the real tree can be opened, fleet_tree is now a genuine
non-null status, with its bounded rows/clicks/reason; actual
verified completion requires exactly the 220 independent truck
items and confirmed first-party contractor. Never infer
completion from the announced badge, a partial DOM,
or a legacy candidate count.

If the safe retry still cannot open the panel, the output will
distinguish panel_unrecognized, panel_not_observed or
preview_click_unavailable; do NOT simply rerun an unchanged test.
