# Saby: Stage12 private detail hydration race (2026-11-11)

## Grounded VPS evidence (smoke v6)

The optional Saby Stage12 search now returns exactly ONE primary candidate
out of 40 first-party result rows, after excluding 11 branches and 28
other-INN company-group entries. It navigates to /page/contractor-info.

The first optional verification (~3 seconds after clicking) sees:
- 28 labelled INN lines;
- 0 labelled KPP lines;
- 0 "Реквизиты" headings;
- 0 fully audited INN/KPP pairs.

The later read-only private owner diagnostic (after the Stage12 wait)
observes a visibly different DOM:
- 5130 characters, 2 visible INN labels;
- 1 KPP label and 1 "Реквизиты" leaf;
- the selected company name among the headings;
- BUT the heading is not tied to a small owner-scoped INN region,
  and there is no visible first-party Saby profile link with INN/KPP.

The evidence suggests that Saby has a late/hydrating private detail
page. The two DOM observers use different selectors, so this is NOT
proof by itself that any given INN/KPP values belong to the company.
No KPP may be guessed or taken from a related-company list.

## Narrow, guarded repair (experimental mode ONLY)

- Preserve the existing strict private INN/KPP parser and the audited
  corroboration fallback.
- After the early one-time requisites tab attempt, poll the SAME
  authenticated detail route up to 17 x 950 ms ONLY while no paired
  numbers have been found. Stop immediately on ambiguous/conflicting
  numbers or a route change. Try to open a requisites tab at most once
  if its safe explicit control becomes visible during rendering.
- Any new private pair found during this delayed hydration must appear
  identically in TWO successive DOM snapshots. Do not mix old
  headings from one render with newer KPP fields from another.
- Require a currently visible private heading matching the exact
  previously selected *Saby search result name* (not the long source
  name). Then still demand independent canonical public registered
  name/INN/KPP proof with identical numbers. The public page is
  opened once and only after stable, scoped private proof.
- No phone/truck collection, Stage12 verification or mutation is
  possible on a still-ambiguous, unhydrated or wrong-owner card.
- The diagnostic adds only safe integer hydration_polls and boolean
  pair_stability_confirmed. Source JSON, SQLite, default production
  Stage12, final SAT XLSX format and browser profile stay untouched.

## Next bounded VPS validation

After CI and merge, when no other process uses the same Saby profile:

    sudo -u regionalresearch git -C /opt/regionalresearch pull --ff-only origin main

    sudo -u regionalresearch env -u DISPLAY \
      HOME=/var/lib/regionalresearch \
      PLAYWRIGHT_BROWSERS_PATH=/home/regionalresearch/.cache/ms-playwright \
      npm --prefix /opt/regionalresearch run saby:smoke -- \
      --inn=7725104641 \
      --name='АКЦИОНЕРНОЕ ОБЩЕСТВО ДОРОЖНО-СТРОИТЕЛЬНАЯ КОМПАНИЯ АВТОБАН' \
      --limit=1 --headless --public-identity-fallback \
      --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
      --out=/opt/regionalresearch/exports/saby-stage12-alias-v7-20261111.json

A genuine success must show registered_alias_verified only after
stable private INN/KPP, matching current private search-title heading,
and registered public full name + exact INN/KPP. Failure must remain
review and report the last actually observed private field counters.
Do not enable the experimental flag in the production service without
that independent live acceptance.
