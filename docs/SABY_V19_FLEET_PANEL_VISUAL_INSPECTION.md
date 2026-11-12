# Saby v19: no pagination signals, capture the actual fleet panel once

## Grounded VPS result, 2026-11-12

The user installed main 6ce2e6b and ran a Saby-only headed smoke
with the known Chromium profile and verified XDG directories.

- Company INN 7725104641 passed all three first-party private
  identity snapshots and the matching canonical public legal entity.
- The private Saby fleet tile announces 220 cargo vehicles.
- Only 40 vehicle rows could be observed from the scrolled fleet panel.
  The sole row-containing scroller is at the end: top=max=523.
- No next-page, numbered-page, loading, range or load-more signals
  were found. The safe fleet_pagination diagnostic found THREE
  interactive controls in the panel: one in the truck section and
  one in the footer. Their purpose is NOT proven.
- Saved contact phone 74956459818 and one email remain unchanged.
  The uploaded v19 JSON contains contacts=collected, trucks=review,
  vehiclesVerified=0, transportsAdded=0, deferred=1.
- No claim can be made that all 220 trucks are listed or that the
  visible 40 rows are the full fleet. No full paid OpenAI run needed.

## Why the next step is visual rather than another blind retry

The code has already tried browser launch recovery, strict identity
matching, opening the fleet widget, hydration, safe same-card URL
navigation, successive virtual windows, selecting the actual
row-container scroller, bounded extra scrolls and pagination controls.
There is no evidence that more scrolling or clicks on unidentified
controls will recover vehicles 41..220. Repeating the same smoke with
unchanged code and only new filenames is not useful.

## One opt-in fleet-panel screenshot (v20), NOT production

The smoke now supports the flag:

  --fleet-panel-screenshot

It is accepted only with BOTH:

  --result=EXISTING_SAFE_SABY_JSON
  --public-identity-fallback

A screenshot is attempted only if the company has already passed the
usual strict legal identity proof, the collection is still in REVIEW,
contacts were verified, a right-hand fleet panel with the EXACT
announced truck count was observed, the single fleet scroller reached
the end, and the full first-party card ID + route continuity still
passes.

Only the matching RIGHT-HAND fleet side panel is cropped and saved.
Neither page-level screenshots nor unrelated company documents are
captured. The screenshot file is local on the user's VPS, mode 0600,
created exclusively: a previously existing file is NEVER overwritten.
It is NOT stored in the research JSON, Excel, SQLite, checkpoints or
GitHub. Be aware the private panel image MAY contain names and truck
models: do not share it publicly. The user may upload it privately to
this chat for interface review, then remove the local image if desired.

### One bounded VPS command

Do not run any second Chromium process on the same saved profile.
Keep the working manually started Xvfb :99. No site restart, full
region research, paid OpenAI or Playwright installation.

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
  --result=/opt/regionalresearch/exports/saby-stage12-fleet-pagination-v19-20261111.json \
  --limit=1 --public-identity-fallback \
  --fleet-panel-screenshot \
  --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
  --out=/opt/regionalresearch/exports/saby-stage12-fleet-panel-v20-20261112.json
~~~

If successful, the terminal logs a single:

  [SABY_FLEET_SNAPSHOT] {"status":"saved","file_path":"..."}

The expected local PNG name is:

  /opt/regionalresearch/exports/saby-stage12-fleet-panel-v20-20261112.fleet-panel.png

Do not pre-create it and choose a NEW output basename if either the
JSON or PNG already exists.

To make a copy accessible for a private chat upload, use an SCP/SFTP
file transfer from your own machine. Never copy the private Chromium
profile, cookies or credentials for this task.

If the screenshot says panel_not_located, company_route_changed,
capture_failed or similar, do not repeat the identical smoke: use
that exact fixed error as the next diagnostic input. Share the user
visible terminal log and, if generated, the panel PNG.

## Acceptance/stop decision

After inspecting the real panel image:

- if a specific authorized show-more/page switch is VISIBLY
  present, implement a narrow selector for that control and verify the
  card owner and EACH additional vehicle-window or page boundary;
- if the panel visibly shows a preview limit/subscription gate or no
  way to access all 220, record the fleet as unavailable/incomplete.
  Do not bypass access restrictions, fabricate 180 vehicles or mark
  the count verified in Stage12;
- if a browser panel widget clips controls, identify the correct
  viewport/accordion layout before any additional modifications.

The underlying production Stage12 path stays off/unmodified, and the
strict 5-sheet SAT XLSX/phone formatting remain unchanged.
