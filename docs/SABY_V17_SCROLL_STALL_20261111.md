# Saby v17: one scroll moved but no fresh truck rows

## Grounded real VPS result

On 2026-11-11, the headed Saby-only v17 smoke on main
`6631c27` successfully verified the same contractor's legal identity.
The safe diagnostic was:

```text
[SABY_FLEET_DIAG] {
  "phase":"vehicles","reason":"vehicle_rows_incomplete",
  "preview_status":"found","expected_trucks":220,
  "parsed_vehicle_rows":40,
  "window_count":1,"scroll_moves":1,
  "stitch_reason":"window_not_updated",
  "panel_open_attempts":2,"panel_wait_polls":22,
  "side_panel_observed":true,
  "fleet_panel_title":true,"truck_category_labels":2
}
```

The uploaded v17 JSON independently confirms that the original
phone 74956459818 and email remain saved, but
`collection.trucks=review`, `vehiclesVerified=0`,
`transportsAdded=0` and `deferred=1`. No truck models/count
were accepted into the research result.

There is no further legal-identity problem or browser crash.

## Actual code limitation

`collectSabyTruckWindows` previously called `advanceScroll()`
exactly once after the first 40-row window. When the next five
short DOM polls returned the identical window, it immediately
returned `window_not_updated`.

The visible Saby panel could either:

- need several short scroll motions before the next virtualized or
  lazily loaded rows render, OR
- be scrolling the panel/header container instead of the genuine
  list, OR
- have only a fixed 40-row page with a separate next-page control.

The v17 evidence does not distinguish these. **Do not assume any one
mechanism without an additional bounded on-site observation.**

## v18 strictly bounded improvement

Only in the already opted-in Saby branch, and after the full strict
private/public legal identity check:

1. Accumulate vehicle rows only when they extend the previously
   observed complete prefix or have a unique verifiable overlapping
   boundary. NEVER deduplicate identical models or manufacture rows.
2. After a scroll, wait for up to five DOM polls. If the 40-row window
   stays the same, permit up to six further SMALL scrolls, checking
   every intermediate window. Refuse a changed but noncontiguous
   window. Never skip intermediate browser reads.
3. Stop on the first non-moving scroll, more than six consecutive
   unchanged scroll windows, deadline, changed company, invalid models
   or 96 total movements. A preview count of 220 is not proof of
   220 parsed model records.
4. In experimental `window/reset/advance` operations ONLY, prefer
   the innermost scrollable node containing at least 75% of actual
   vehicle-row leaves. The old regular Stage12 `read` selector and
   its original behavior are unchanged.
5. Log only bounded `scroll_candidates`, whether a scroller was
   chosen based on vehicle rows, the number of row leaves within it,
   whether it contains the truck heading, whether it is the whole
   panel, anonymized numeric scroll position/maximum/end-state and
   the number of stale scrolls. Do not log DOM strings, selector
   classes, models, URL, name, phone/email, cookies or profile state.

This may recover a lazily loaded list; if the true fleet UI is
separately paginated or the scroller remains wrong, the same
`deferred=1` protection remains and the geometry narrows the next
change to an actual missing widget instead of an unbounded retry.

## One bounded acceptance test after CI and merge

Do NOT repeat the v17 command without the new code. On the existing
Time4VPS VPS, confirm no other Chromium process uses the saved
Saby test profile, and keep the existing `DISPLAY=:99` + writable
XDG environment unchanged.

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
  --result=/opt/regionalresearch/exports/saby-stage12-fleet-route-v17-20261111.json \
  --limit=1 --public-identity-fallback \
  --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
  --out=/opt/regionalresearch/exports/saby-stage12-fleet-scroll-v18-20261111.json
```

Use a new `--out` path if that filename already exists. No full
research, OpenAI calls, service restarts, Xvfb restart or changes to
source JSON.

Interpret v18:

- `window_count>1`, `parsed_vehicle_rows>40`: verified progress;
  continue only if all 220 genuine model/year rows are accounted for.
- `scroll_at_end=true`, `parsed_vehicle_rows=40`: likely end of
  chosen list and possibly a pagination/next-page widget. Investigate
  that specific UI before touching fleet count logic.
- `scroll_selected_from_vehicle_rows=false`: no reliable
  row-containing scroll container was detected. Investigate DOM
  relationships, not blind scrolling.
- `scroll_selected_from_vehicle_rows=true` but no new rows after
  bounded movements: likely same-row list with a separate pagination
  control or a lazy-load condition not triggered by scrollTop.
- `stitch_reason=unanchored_window/ambiguous_overlap`: never relax
  continuity to accept a guessed 220-vehicle inventory.

If fleet is verified, review the new JSON:
`__evidence.saby.collection.trucks=verified`,
`trucks.count=220`, `trucks.vehicles.length=220`,
all real models/year, `deferred=0`, and unchanged phone.
`transportUpdates` alone is not proof.

The experimental production fallback stays OFF until field-level
verification, and the 5-sheet SAT Excel format remains unchanged.
