# Saby v18: 40 of 220 trucks, actual truck-row scroller reaches its end

## Grounded Time4VPS result (2026-11-11)

The user ran one authenticated, headed Saby-only smoke on main
b0beb0f, DISPLAY=:99, with proven writable XDG configuration/cache
directories and the same saved test browser profile. Identity was
independently verified after three private first-party snapshots and
the canonical registered Saby public profile. Contacts were retained.

The safe diagnostic established:

- Saby first-party fleet tile announces 220 cargo vehicles;
- selected private fleet side panel is visible;
- 40 individual visible truck rows can be parsed;
- exactly ONE scrollable container is found;
- selected scrollable container contains 46 raw vehicle-related leaves
  and the truck category heading;
- scrollTop = 523 and its maximum is 523; at end = true;
- one movement produced no further rows, then subsequent movement
  could no longer advance; stop reason scroll_not_advanced;
- company remains deferred=1 and truck evidence remains review.

The actual user-uploaded v18 result was inspected: saved phone is
74956459818, contacts=collected, trucks=review, no verified truck
inventory is present, vehiclesVerified=0, transportsAdded=0. There is
no full-research or OpenAI usage.

**This is NOT a reason to increase blind scroll attempts again.**
At the end of the only actual row-containing scroller, a constant
40-row result may mean an explicit next-page button, a load-more link,
a fixed Saby preview limit, or a separate unrecognized navigation
mechanism. v18 does not establish which.

## v19: diagnostic ONLY

The opt-in collector now performs ONE read-only page.evaluate against
the first-party contractor detail, after it has:

- already completed the existing strict private/public identity proof;
- opened the independently recognized truck panel with the same 220
  count;
- observed the actual row scroller hit the end without a fresh
  overlapping window;
- verified the company's opaque detail-card ID and strict URL
  continuity again.

The diagnostic selects the same right-side first-party fleet panel
by its visible "Автопарк" heading and exact "Грузовые 220" count.
It returns ONLY allowlisted, capped counters/booleans:

- number of matching nested panel candidates;
- total visible interactive elements, how many are in the truck
  section vs the side-panel footer, and how many are unlabeled;
- show-more / load-more controls;
- next-page controls and how many are disabled;
- numbered page controls and current-page markers;
- pagination/navigation landmarks and range/page indicators;
- ellipsis and loading indicators;
- whether the scoped vehicle scroller is already at its end.

No raw DOM text, full URL, browser profile path, company name,
INN/KPP, model, phone, email, cookies, CSS selector, or private
document text is returned or printed.

The fields appear in the existing [SABY_FLEET_DIAG] line under
fleet_pagination. No new clicking, scrolling, page navigation,
data writes, fleet count acceptance or retry is introduced.

The normal production Saby Stage12 path remains unchanged.
The strict five-sheet final SAT XLSX structure and phone-cell format
are unchanged; no OpenAI, SQLite or Google Sheets actions.

## One bounded acceptance after CI and merge

Check that no parallel browser uses the saved Saby profile. Keep the
manually active Xvfb :99 and the proven XDG paths unchanged.

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
  --result=/opt/regionalresearch/exports/saby-stage12-fleet-scroll-v18-20261111.json \
  --limit=1 --public-identity-fallback \
  --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
  --out=/opt/regionalresearch/exports/saby-stage12-fleet-pagination-v19-20261111.json
~~~

Do not overwrite v18 JSON. This is not a paid region research run and
does not alter the saved input JSON. A normal site restart or
Xvfb restart is unnecessary.

Read the single safe [SABY_FLEET_DIAG] output:

- fleet_pagination.show_more_controls / load_more_controls > 0:
  inspect that specific first-party control before adding a
  strictly validated load-more implementation.
- fleet_pagination.next_page_controls > 0 or
  navigation_landmarks / page_current_markers / range_indicators > 0:
  investigate explicit pagination, preserving all records and
  verifying every page boundary and the exact sum of 220 vehicles.
- all control and pagination counts zero, with unlabeled controls:
  the side panel may use icon-only controls; request a targeted
  authorized UI observation rather than attempting blind clicks.
- fleet_pagination.status=panel_not_found:
  the independently matched panel structure changed. Do not infer
  a zero vehicle count or loosen identity gates.

The company stays deferred until all 220 real vehicles (including
distinct instances of identical models) are proved via an exact
counted, contiguous sequence or a separately verified paginated
sequence. If v19 has no visible navigation clues, STOP repeated
unmodified Saby smokes; inspect the actual fleet panel visually
or instrument its specific known structure once before any further
collection changes.
