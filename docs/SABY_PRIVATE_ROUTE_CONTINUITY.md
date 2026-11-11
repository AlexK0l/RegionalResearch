# Saby Stage12: why v7 reported private_route_changed

## Grounded live VPS observation, 2026-11-11

The source-INN search already succeeds:
- 40 Saby results, of which 11 are branch rows and 28 mention
  a different 10/12-digit registry-like number;
- one unique first-party primary company search candidate;
- Stage12 navigates to the authenticated contractor-info page.

On the optional registered short/full name test v7, the private
requisites verifier performed three delayed hydration polls, then
returned:

    reason=private_route_changed
    hydration_polls=3
    pair_stability_confirmed=false
    requisites_headings=0
    labelled_kpp_lines=0

The former code checked exact equality of the browser URL and initial
URL, which considers ANY updated query parameter/fragment to be a
company change. Authenticated Saby contractor-info supports UI
navigation parameters such as anchor, tab and page. A real SPA can
update those as its selected company panel renders. We do NOT know
from the v7 log whether the observed change was UI-only or a company
identity change, because URL values were deliberately not logged.

## Narrow experimental fix

The opt-in public-identity-fallback verifier now compares first-party
URL structure rather than raw URL bytes:

- Both URLs MUST be HTTPS and belong to exactly profile.saby.ru,
  stay on the SAME /page/contractor-info path (and any unchanged
  path suffix), and contain no URL credentials.
- ONLY a small allowlist of UI params (anchor, tab,
  page, section, subtab, view, panel, mode) and known
  navigation fragment names may change.
- Any other parameter, including opaque contractor-company IDs,
  INN/KPP, new unknown keys, and changed path/origin fails closed.
- Comparison is insensitive to query-parameter ordering but sensitive
  to all parameter values and repetitions.
- Failure logs contain only an allowlisted route_change_reason code;
  success logs can indicate ui_route_updated=true. No URL,
  parameter keys/values, company titles or registration identifiers
  are printed.
- This does NOT itself prove a company match. A delayed private INN+KPP
  must remain identical across two DOM snapshots, the current private
  heading must match the uniquely selected Saby search company name,
  and the canonical public Saby profile must independently verify
  registered full name plus the same exact INN/KPP. Contact/transport
  enrichment remains gated on this chain.

This affects ONLY the explicit opt-in fallback smoke. The ordinary
production Stage12 matching path, source JSON, SQLite checkpoints and
standard SAT final XLSX layout are unchanged.

## One Saby-only VPS acceptance test after merge

Update the repository without restarting the site:

    sudo -u regionalresearch git -C /opt/regionalresearch \
      pull --ff-only origin main

Stop OTHER Saby sessions using the SAME Playwright profile, then run:

    sudo -u regionalresearch env -u DISPLAY \
      HOME=/var/lib/regionalresearch \
      PLAYWRIGHT_BROWSERS_PATH=/home/regionalresearch/.cache/ms-playwright \
      npm --prefix /opt/regionalresearch run saby:smoke -- \
      --inn=7725104641 \
      --name='АКЦИОНЕРНОЕ ОБЩЕСТВО ДОРОЖНО-СТРОИТЕЛЬНАЯ КОМПАНИЯ АВТОБАН' \
      --limit=1 --headless --public-identity-fallback \
      --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
      --out=/opt/regionalresearch/exports/saby-stage12-alias-v8-20261111.json

If the same apparent navigation is UI-only, the verifier will resume
bounded hydration. If a legal-entity query/path change is detected, it
will still return REVIEW and a safe route_change_reason without
attempting public proof or copying company contacts. A genuine success
requires registered_alias_verified, not merely a selected search row
or a renamed browser URL. OpenAI is not involved.
