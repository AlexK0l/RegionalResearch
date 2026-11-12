# Saby v20: custom three blue dots at the end of 40/220 trucks

## Actual evidence (2026-11-12)

The authenticated headed Saby-only v20 VPS smoke, main 6ca4edb,
verified the same exact legal entity with the existing strict private
INN/KPP/H1 and independent registered public-name proof.

The uploaded 600x920 cropped fleet-panel screenshot shows:

- A white "Автопарк" panel with a funnel/filter icon in its header.
- The bottom of the currently rendered Грузовые truck list, showing
  repeated КАМАЗ model/year rows. Repetition must NOT be deduplicated.
- Immediately after the last visible КАМАЗ entry, a horizontal gray
  capsule with THREE BLUE DOTS appears centered.
- Below that capsule are collapsed "Автобусы 23" and
  "Спецтехника 222" category rows.

The company summary says 220 Грузовые, but browser DOM extraction
has read only 40 individual model/year rows. The single verified
truck-row-containing scroller is at its end, top=max=523.
The v19-v20 pagination probe saw exactly 3 visible controls, one
within the truck section and one at the panel footer, but NO
standard button, page number, next-page, load-more text or
ARIA progress indicator.

A three-dot capsule LOOKS like a loading spinner; the image alone
cannot establish that it is animated or even clickable. Do NOT click
it blindly, call it a subscription gate, or treat the missing rows
as nonexistent. The v20 JSON retains verified contact phone
74956459818 and email, trucks=review, vehiclesVerified=0, deferred=1.

## One focused read-only v21 diagnostic

After strict existing identity validation, private card ID+URL
continuity, truck panel recognition, and observed exhaustion
of its scroll container, the experimental-only code now:

1. Selects the same first-party right-hand fleet panel by its
   "Автопарк" heading and exact advertised "Грузовые 220" count.
2. Locates the physical gap between the LAST model/year row and the
   NEXT vehicle category (such as "Автобусы").
3. Uses geometry (three nearby small circles at a shared y-position)
   to identify a possible three-dot widget.
4. Records boolean indicators: semantic click target, pointer cursor,
   active animation, CSS loading-like vs more-like class, and
   number of interactive controls in this narrow physical gap.
   It does NOT print class names or text.
5. Passively waits at most 11 seconds WITHOUT clicking, scrolling,
   navigating, or modifying any state, then recounts truck rows.
6. Logs ONLY the allowlisted first/second sample booleans,
   capped numbers, and whether the truck-row count changed.

The diagnostic does not change the fleet extraction decision: exactly
220 real individual truck records, verified in an ordered sequence,
are still required before marking the fleet complete. Previously
collected phone/email evidence is preserved.

The standard production Stage12 remains unchanged. No OpenAI,
Google Sheets, SQLite, source research JSON or five-sheet final SAT
XLSX modifications.

## ONE bounded VPS test

Confirm no other process uses the saved Saby browser profile. Keep
the working manually started Xvfb :99 and writable XDG settings.

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
  --result=/opt/regionalresearch/exports/saby-stage12-fleet-panel-v20-20261112.json \
  --limit=1 \
  --public-identity-fallback \
  --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
  --out=/opt/regionalresearch/exports/saby-stage12-fleet-tail-v21-20261112.json
~~~

No --fleet-panel-screenshot flag: the v20 image already exists.
Do not overwrite existing JSON. No site restart, Xvfb restart or
paid research.

Inspect the new [SABY_FLEET_DIAG].fleet_tail object:

- An animated three-dot element or loading-like class with the
  same row count after the passive wait indicates possible stalled
  or slow loading; do not treat the spinner as a "more" button.
- If the 40-row count increases during the passive wait, Saby
  can append rows without clicking; only then investigate a bounded
  DOM-hydration recovery that preserves every real row.
- A semantic button/pointer under the dots, NO animation, and a
  more-like class could justify a very narrow UI click after
  additional exact target validation. Do NOT click merely because
  the screenshot shows dots.
- If no identifiable widget exists, do not repeat an unchanged smoke.
  Inspect a safely scoped browser DOM or ask Saby support for the
  permitted list/availability behavior.

Production Saby remains off until real end-to-end evidence is found.
