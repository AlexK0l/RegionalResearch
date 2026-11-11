# Saby v16: strict same-company fleet SPA navigation (v17 acceptance)

## Actual user VPS observation, 2026-11-11

After Git main `223dd24`, an opt-in one-company Saby-only headed
smoke with persistent profile + working XDG paths found:

- One primary Saby search result after filtering 11 branch rows
  and 28 foreign-INN rows out of 40;
- `[SABY_POST_ROUTE_DIAG] accepted=true`: one selected company
  verified across three stable private snapshots and matching
  canonical public registered full name, INN and KPP;
- `[SABY_FLEET_DIAG]` `preview_status=found`,
  `expected_trucks=220`, `panel_open_attempts=1`,
  `panel_wait_polls=2`, `stitch_reason=detail_changed`,
  `side_panel_observed=false`, `parsed_vehicle_rows=3`;
- `contacts=collected`, `trucks=review`, `deferred=1`;
  all existing contact evidence and phone 74956459818 were retained.

The uploaded v16 JSON confirms no trucks were accepted and no
transport row was fabricated. It does NOT record a post-click browser
URL. Therefore the cause of the change is NOT yet proven to be a
benign UI query update, even though it happened immediately after
the fleet preview click.

## Source code defect and limited change

In v16, the experimental `ownTrucks` branch captured `panelUrl`
and rejected ANY `page.url() !== panelUrl` during fleet opening.
Saby's first-party SPA routinely uses known UI query fields such as
`anchor`, `tab`, `page`, `section`, `subtab`, `view`,
`panel`, `mode`. Those changes do not by themselves establish
legal identity, but they should not invalidate a company that has
ALREADY passed the independent private/public legal identity proof.

This targeted v17 change reuses the EXISTING
`compareSabyPrivateDetailUrl` classifier, and adds further conditions
for fleet UI continuation:

1. Only after the complete existing registered identity proof, the
   original fleet-card URL must be first-party HTTPS Saby contractor
   detail with exactly one nonempty opaque `id` or `contractorId`
   (no username/password, no duplicate identifier query fields).
2. After each fleet preview click, panel DOM read/expansion and scroll,
   both the original and current company-card identifier sets must
   match EXACTLY. Changing or removing the company ID rejects
   collection, even if the title or phone happens to look identical.
3. The URL still has to pass the existing strict Saby URL continuity
   rules: exact same origin and detail path; only preapproved UI
   query/fragment changes (or the already audited one-way removal of
   `source=internal`) are allowed. Unknown changed, removed or
   added query parameters remain fail-closed. No generic ignore-query
   or wide allowlist is introduced.
4. The first click may lead to a verified same-card UI query update.
   If the panel fails to open, reusing outdated coordinate positions
   for a second click after an actual URL change is blocked.
5. Even if exactly 220 vehicle rows are later assembled, the company
   route must still match the original verified card immediately
   before marking the fleet verified.
6. On failure, the company stays in `deferred`; never treat 220
   advertised as 220 parsed models, never remove the known phone.

The `[SABY_FLEET_DIAG]` line gains safe
`fleet_ui_route_updated`, `fleet_route_reason` and
`fleet_route_delta`. These carry boolean/fixed codes/bounded counts
only. No URL or opaque ID, company name, INN/KPP, cookie,
phone, email, raw DOM text or vehicle model is logged.

Only the experimental `--public-identity-fallback` path is
affected. The original identity gate, normal Stage12, source data,
SQLite, full research cost, and strict five-sheet SAT XLSX remain
unchanged.

## One bounded Saby-only acceptance (after Ubuntu + Windows CI)

Ensure the existing test Chromium profile is not in use by another
process. Xvfb `:99` and the private writable XDG directories
already work on Time4VPS. No production-site restart is required.

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
  --result=/opt/regionalresearch/exports/saby-stage12-fleet-panel-v16-20261111.json \
  --limit=1 --public-identity-fallback \
  --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
  --out=/opt/regionalresearch/exports/saby-stage12-fleet-route-v17-20261111.json
```

Use a NEW output filename if the planned one exists.

Share the safe `[SABY_FLEET_DIAG]`, `[SABY_POST_ROUTE_DIAG]`,
`[SABY_CARD]`, and the final summary + output JSON.

### Stop rules

- `fleet_ui_route_updated=true` and new scroll/window diagnostics
  indicate the safe same-card UI route was accepted; investigate
  the actual list scroller or virtual overlap if still deferred.
- `fleet_route_reason=non_ui_query_changed` or
  `company_card_id_changed`: DO NOT whitelist arbitrary URL
  changes. Inspect the UI ownership proof and safe route-delta counts
  first.
- `panel_unrecognized` or `panel_not_observed` after safe UI
  continuation: investigate first-party panel DOM structure, not a
  third speculative URL fallback.
- Full successful fleet acceptance must be independently verified in
  the JSON: `collection.trucks=verified`,
  `trucks.count=220`, exactly 220 individual model/year entries
  with the original contacts unchanged, and `deferred=0`.
  `transportUpdates=1` alone is not proof.

Do not repeat unchanged expensive investigations or enable
experimental production fallback before field-level validation.
