# Saby: why an authenticated detail has 28 INNs and zero KPP fields

## Confirmed Time4VPS result from single-company smoke v5

The authenticated Saby search itself is FIXED and proven by live evidence:

    observed=40, branches=11, foreign_inn_rows=28,
    primary_candidates=1, reason=unique_primary_after_exclusions

The selected row opens a profile.saby.ru /page/contractor-info route.
The existing private-card detector reports the expected INN appears in
a sufficiently large page block, but the source long name is not in the
visible heading, which can be a legitimate short-name alias.

However the optional registered-alias proof fails BEFORE opening the
already-verified public Saby profile:

    reason=no_scoped_inn_kpp
    requisites_headings=0
    labelled_inn_lines=28
    labelled_kpp_lines=0
    audited_pairs=0
    requisites_tab_opened=false

This is NOT a formatting/parser failure. The authenticated page
exposes 28 INN labels, but NO KPP or named requisites section, and
none of the exact first-party requisites tab/button/link locators.
It could be an unhydrated company panel, a company-group/related-entity
surface, or a limited-access detail view. The existing hasScopedInn
does not alone disambiguate those cases because it can be true for a
broad page block containing multiple companies.

Do NOT guess KPP, click the first row again, turn off registered-name
checks, assume 28 INNs belong to the target, or repeat the solved
40-row search diagnostic.

## The next one-shot read-only investigation

When the optional smoke reaches this exact failure, it now outputs
[SABY_PRIVATE_OWNER_DIAG] with only allowlisted structural fields:

- selected_name_in_headings: whether a visible detail heading matches
  the UNIQUE head-company search result's displayed name
- selected_heading_scoped_inn: whether that matched heading has an
  ancestor containing a labelled exact target INN but no other INN,
  within a small bounded area (observation only, not identity proof)
- h1_count, heading_count, main_regions,
  visible_text_chars: whether a company detail has hydrated
- visible_inn_labels, visible_kpp_labels,
  requisites_label_leaves, requisites_role_controls,
  related_company_headings: what parts of the private UI rendered
- public_same_inn_profile_links,
  public_distinct_kpp_links: counts ONLY of visible first-party
  Saby public profile links ending in the exact target INN and
  a 9-digit KPP. No URLs/KPPs or unrelated page content are logged.

These flags will distinguish a wrong/subsidiary surface from the real
owner card or a restricted/unhydrated page, and determine whether a
first-party canonical public link could supply a KPP candidate without
guessing. A link candidate alone never verifies a legal identity.

This only runs on --public-identity-fallback and ONLY if the exact
private failure is no_scoped_inn_kpp. No Stage12 acceptance or
phone/fleet behavior changes. The ordinary strict Stage12 continues to
use the existing code.

## Run ONE smoke on Time4VPS

First update main after CI:

    sudo -u regionalresearch git -C /opt/regionalresearch pull --ff-only origin main

With no other Playwright process using the authenticated test profile:

    sudo -u regionalresearch env -u DISPLAY \
      HOME=/var/lib/regionalresearch \
      PLAYWRIGHT_BROWSERS_PATH=/home/regionalresearch/.cache/ms-playwright \
      npm --prefix /opt/regionalresearch run saby:smoke -- \
      --inn=7725104641 \
      --name='АКЦИОНЕРНОЕ ОБЩЕСТВО ДОРОЖНО-СТРОИТЕЛЬНАЯ КОМПАНИЯ АВТОБАН' \
      --limit=1 --headless --public-identity-fallback \
      --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
      --out=/opt/regionalresearch/exports/saby-stage12-alias-v6-20261111.json

Share the console output including [SABY_PRIVATE_OWNER_DIAG].
The v5 JSON/source project, SQLite, production configuration and SAT
XLSX layout are not modified. There are no OpenAI calls. Do not enable
the experimental alias fallback in the production service until the
private selected-company identity is demonstrably connected to the
registered public profile.
