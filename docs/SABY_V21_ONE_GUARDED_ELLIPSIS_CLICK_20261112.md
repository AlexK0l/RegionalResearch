# Saby v21: guarded single click of the exact three-dot fleet-tail capsule

## Real VPS evidence (2026-11-12)

User ran the one-company headed Saby-only smoke on main 6b94cda,
with working DISPLAY=:99, private writable XDG directories, and the
existing authenticated browser profile. Strict legal identity passed:
the selected private contractor had stable verified INN/KPP/H1 and
matching independent canonical registered public identity.

The screenshot v20 showed a horizontal small gray capsule with
three blue dots between the final visible КАМАЗ model/year row and
the next vehicle category, "Автобусы 23". The v21 diagnostic now
confirms the **specific** element:

- three_dot_cluster=true; small_dot_candidates=3;
- dot_pointer_cursor=true;
- dot_semantic_click=false;
- dot_animated=false; dot_loading_class=false;
- gap_interactive_elements=0;
- truck_row_count=40 before and after 11,000 ms passive waiting;
- only one real vehicle-row scrollbar, already at its end;
- zero recognized standard pagination/load-more controls;
- Saby advertises 220 Грузовые, but 40 actual model/year rows are visible.

The v21 JSON confirms saved phone 74956459818 and email, no verified
fleet data, and deferred=1. Cursor:pointer is stronger evidence of
interaction than a screenshot, but NOT proof of what the widget does.

## v22 experiment: ONE click only with explicit --fleet-tail-click

The one-company smoke offers this NEW optional flag only when ALL
of --result, --limit=1, --public-identity-fallback, and headed
Chromium (no --headless) are specified.

SabyBrowserSettings additionally requires BOTH the smoke-only env
flag and experimental opt-in. The default production Stage12
never performs this click.

Only after the normal strict identity, same opaque company-card ID,
private URL continuity, exact 220-truck side-panel summary, exhausted
verified vehicle-row scroller, and a SECOND read-only tail observation
has again proved 3 steady circles plus a pointer cursor and NO
loading animation, the code:

1. Recounts exactly the same 40 model/year rows in the currently
   rendered truck section.
2. Geometrically locates exactly THREE small dots in the narrow gap
   between the final truck row and next vehicle category, checks
   unique horizontal grouping, hit testing, first-party panel owner,
   pointer cursor and absence of destructive link/form/label/animation.
   No query selector guess, arbitrary "..." text click, or generic
   pagination button click.
3. Clicks the center of the three dots AT MOST ONCE. No repeat click,
   no changing vehicle categories, no downloads/forms.
4. Polls the independently verified same-company fleet panel for
   a small bounded number of ticks and records sanitized counters:
   rows_before, rows_after, list-replaced vs list-extended vs unchanged,
   panel still present, click attempted and samples.
5. If the clicked panel presents additional rows, only incorporate
   them when their full original prefix or a unique contiguous boundary
   can be proven by the existing strict ordered-row assembler.
   **Only exact 220 valid real truck rows** allow a complete fleet.
   If no change, a replaced same-length page or uncertainty, preserve
   contacts and defer the company. No invented 180 vehicles.

No browser screenshot needed; the private v20 PNG was already
provided. No raw model text, full DOM, HTML/CSS classes, title,
company IDs, phone/email, URL, cookies, or profile contents are
printed. Only a fixed allowlist is exposed as
[SABY_FLEET_DIAG].fleet_tail_click.

The five-sheet SAT XLSX structure and phone-column requirement
remain untouched. No paid OpenAI, Google Sheets, SQLite or
production-site restart.

## ONE bounded Time4VPS v22 acceptance after CI and merge

Confirm the saved browser profile is not in use by another process.
Keep Xvfb :99 and XDG paths as-is. Use a FRESH --out filename.

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
  --result=/opt/regionalresearch/exports/saby-stage12-fleet-tail-v21-20261112.json \
  --limit=1 \
  --public-identity-fallback \
  --fleet-tail-click \
  --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
  --out=/opt/regionalresearch/exports/saby-stage12-fleet-tail-click-v22-20261112.json
~~~

Interpretation:

- fleet_tail_click.status=rows_extended: genuine extra rows were
  observed. Verify whether they retained an exact prefix; complete
  the fleet ONLY if exactly all 220 verified records are in JSON.
- fleet_tail_click.status=rows_replaced: Saby replaced the visible
  window; no continuity established. Do not merge or assume the
  remaining 180 models. Investigate an explicit page position before
  further action.
- fleet_tail_click.status=rows_unchanged: the click had no measured
  effect on visible trucks. Do not repeat unchanged smokes.
- fleet_tail_click.status=target_missing/target_ambiguous/
  target_not_pointer/target_not_at_end: no click was performed.
- fleet_tail_click.status=company_changed: never accept truck data
  after switching company details.
- If transportsAdded>0 and deferred=0, inspect the new JSON
  independently: collection.trucks=verified, exactly 220 model/year
  records, unchanged verified phone and no XLSX layout changes.

Do not turn on the experimental click in production from a single
smoke. Real Saby UI behavior and source data completeness must be
validated first. If v22 is inconclusive, STOP repeated identical
smokes and consider direct first-party UI investigation or provider
support, not unbounded new fallbacks.
