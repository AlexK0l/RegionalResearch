# Saby Stage12: recovering private-card INN/KPP (2026-11-11)

## Live signal

After PR #36 the user's Time4VPS opt-in smoke for INN 7725104641
successfully selected a single head-office candidate from 40 search rows:

    [SABY_SEARCH_FILTER_DIAG]
    observed=40, branches=11, foreign_inn_rows=28,
    primary_candidates=1, reason=unique_primary_after_exclusions

The browser then entered the authenticated company detail
(route=detail, hasInn=true, hasScopedInn=true, detailContentPresent=true)
but the source legal name did not match its abbreviated title and the
optional public verifier was blocked by reason=no_scoped_inn_kpp.

This does NOT mean Saby has no KPP. The completed earlier read-only
Saby audit captured exact private detail INN + requisites INN/KPP pairs
for eight source rows, including this source company. It used a
55-line requisites extractor and could open a real requisites tab.
Stage12's fallback used a stricter 45-line parser that stops at
"О компании", even if that is merely an intermediate heading.

## Correction, only for explicit Saby alias smoke

- Preserve the strict same-section private parser first.
- If it finds no pair, use the audited requisites extractor only as
  corroborating evidence. Independently reread all labelled INNs and
  KPPs within a bounded 55-line first-party "Реквизиты" block;
  permit the intermediate "О компании" heading but stop at contacts,
  related companies, branches and other unrelated sections.
  Any conflicting number still fails closed.
- If no usable pair, click at most ONE visible exact first-party
  "Реквизиты" tab/button/link. Stay within the same authenticated
  detail route and repeat the bounded read once.
- This private pair is still only a CANDIDATE. The canonical public
  Saby registered section must prove full legal name and the identical
  INN/KPP, and the private title must match that same public registered
  identity. Otherwise return REVIEW before any contact transfer.
- The feature remains disabled in production. No source JSON, SQLite,
  final SAT XLSX structure or ordinary Stage12 path changes.

## Single VPS acceptance test

Update main after successful CI:

    sudo -u regionalresearch git -C /opt/regionalresearch pull --ff-only origin main

Run once, when no other Saby process uses the same browser profile:

    sudo -u regionalresearch env -u DISPLAY \
      HOME=/var/lib/regionalresearch \
      PLAYWRIGHT_BROWSERS_PATH=/home/regionalresearch/.cache/ms-playwright \
      npm --prefix /opt/regionalresearch run saby:smoke -- \
      --inn=7725104641 \
      --name='АКЦИОНЕРНОЕ ОБЩЕСТВО ДОРОЖНО-СТРОИТЕЛЬНАЯ КОМПАНИЯ АВТОБАН' \
      --limit=1 --headless --public-identity-fallback \
      --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
      --out=/opt/regionalresearch/exports/saby-stage12-alias-v5-20261111.json

The result must show either verified registered identity with a
private_pair_basis or a precise REVIEW reason. No further diagnosis
of the already-fixed 40 search rows is needed. Do not enable the
public fallback in production before the real full chain passes.
