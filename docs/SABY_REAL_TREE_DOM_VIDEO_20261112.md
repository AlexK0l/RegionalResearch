# Saby: replace guesswork with the actual Wasaby vehicle-tree protocol (v26)

## User-supplied evidence (2026-11-12)

The user supplied BOTH:

1. A ~74-second browser recording from the selected DSK Avtoban
   first-party Saby contractor card, showing the "Автопарк" drawer,
   repeated manual clicks on three-dot controls between vehicle
   categories, and additional rows appearing.
2. An 87 KB real DOM fragment of the complete side-panel content
   (HTML is NOT committed to GitHub; it contains real VIN/plate data).

The supplied HTML establishes the exact FIRST-PARTY Wasaby widget:

- The active drawer is .controls-StackTemplate-content with caption
  title="Автопарк".
- Individual category rows are [data-qa="item"][item-key]; the
  truck header has the EXACT heading "Грузовые" and exact numeric
  .controls-DecoratorNumber value 220. On the supplied page its
  item-key happens to be "-3", but this is NOT hard-coded.
- Each real vehicle is ONE separate [data-qa="item"] DOM node with
  item-parent-key equal to the selected category item-key and its OWN
  stable item-key (e.g. 22014723, 22014725 in the provided HTML).
- Vehicle label is the first direct <div> child of the row's
  .controls-margin_left-2xs.controls-padding_left-3xl content.
  The following sibling DOM nodes are VIN / ГРЗ ТС metadata, which
  are NOT separate vehicle records.
- The correct group-specific "more" control is nested inside the
  [data-qa="item"][item-key="node-footer--3"] footer. It contains
  [data-qa="navigation-button"].controls-BigSeparator__collapsed,
  and a DESCENDANT with title="Ещё". Crucially, title="Ещё" is
  NOT on the clickable navigation-button itself.
- Other groups (Легковые, Коммерческие, Автобусы, Спецтехника)
  have their OWN group keys, vehicle items and independent footers.
  Clicking an arbitrary three-dot control is incorrect.

An OFFLINE parse of the actual user-provided HTML confirmed its
structure: 24 currently rendered rows in the Грузовые group; other
groups have separate child rows and independent footers. Saby's
advertised truck count is 220, NOT the first-page rendered count.

## Implemented structural solution

A separate module, src/sabyFleetTree.js, is used only by an
EXPLICIT headed Saby-only single-company smoke with BOTH
--public-identity-fallback and --fleet-tail-click. The unchanged
production Stage12 never enters the structural click path.

- Verify the EXISTING strict legal identity gate plus identical
  first-party company card ID and URL before and after every click.
- Select ONLY the visible right-hand "Автопарк" drawer, its unique
  Wasaby list, one exact Грузовые header and its independent
  advertised count.
- Read actual vehicle ROW NODES by their dynamically selected
  item-parent-key; store each unique item-key in memory to
  establish stable ORDERED PREFIX across disclosures.
- Parse ONLY the direct model-label child of each vehicle row;
  treat VIN/plate text as metadata. Preserve legitimate identical
  model/year combinations with different item keys as separate
  trucks. Preserve missing years as year:null.
- Find ONLY the same category's exact node-footer and
  navigation-button with CHILD title="Ещё"; use Playwright's
  locator click auto-scroll to reach the real element rather than
  screen geometry or fragile manual scrollbar progression.
- After each authorized click, poll for a proven INCREASE in the
  number of stable item-key vehicle rows. Stop on changed company,
  changed first-page key/model/year, replacement/virtualization,
  missing/ambiguous controls, no growth, missing data, incorrect
  count, >20 clicks or >175 seconds.
- Complete ONLY with exactly 220 actual vehicle records for the
  exact same previously verified legal entity.
- Do not expose item keys, VINs, plate values or raw DOM in logs,
  JSON evidence, original JSON, final Excel or GitHub. Output
  log: fleet_tree {status,reason,expected,rows,clicks,samples,
  same_company}; models/years appear only in the legitimate
  completed fleet evidence.

The final five-sheet SAT workbook and phone-only phone column
remain byte-layout compatible and untouched. No paid OpenAI,
Google Sheets, database reset, browser profile changes, site
restart or new dependencies.

## Offline verification

The tests model the real DOM contract, dynamically varied category
keys, 24->40->102->164->220 multi-click expansion, 220 unique
item keys including model/year duplicates, valid yearless vehicles,
metadata exclusion, strict replacement and change-of-card guard,
missing button, exhausted click budget, and private log sanitation.

Do NOT run the prior v25 heuristic test. It would repeat obsolete
geometry/VIN diagnostics despite having direct first-party DOM
evidence. Await green CI and merge, then ONE final test using the
same already-working VPS profile and flags.

## Single bounded VPS acceptance after green CI

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
  --result=/opt/regionalresearch/exports/saby-stage12-fleet-inspection-v24-20261112.json \
  --limit=1 --public-identity-fallback --fleet-tail-click \
  --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
  --out=/opt/regionalresearch/exports/saby-stage12-fleet-tree-v26-20261112.json
~~~

Use a FRESH output filename if it already exists. Never delete the
original JSON, prior progress, SQLite, auth profile, or previous PNG.
No screenshot needed.

Acceptance: independent identity proof for the original INN/KPP,
contacts=collected, strict trucks=verified, EXACT 220 independent
model/year entries (unknown year permitted), no VIN/plate pseudo
models, transportsAdded=1, deferred=0, original phone unchanged.
If still incomplete: fleet_tree.reason is now a focused structural
problem (e.g. row_prefix_changed, footer_missing, no_growth)
instead of unknowable tail_not_ready.
