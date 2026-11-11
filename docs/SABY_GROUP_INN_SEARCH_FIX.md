# Saby: exact-INN company group in authenticated search (2026-11-11)

## Observed VPS evidence

The user-provided read-only diagnostic for INN 7725104641 shows that the
authenticated Saby results load after 0.9 s and stabilize by 2.4 s,
remaining unchanged at 4.8 s.

All 40 candidate rows are clickable list divs in a single scroll area;
there are 33 distinct display titles and no overlapping duplicates:
- row 1: main company, short title DSK Avtoban, AO;
- rows 2-12: eleven explicitly named branches/subdivisions;
- rows 13-40: 28 other company rows, each with an additional DIFFERENT
  10- or 12-digit registry-like number.

The report does not expose the actual content or meaning of that extra
number; it is treated conservatively as a possible foreign INN. These
are NOT forty independent matches of the source INN, and a search hit
is not proof of an organisation's legal identity.

## Safe candidate logic (OFF by default)

1. Use the complete, non-truncated list of Saby search cards.
2. Exclude rows containing a full-length 10/12-digit number different
   from the source INN; this intentionally favors review over accidental
   cross-company enrichment. Do not interpret KPP (9) or OGRN (13/15)
   as foreign INNs.
3. Exclude titles explicitly identifying a branch, subdivision or
   representative office using Unicode word boundaries.
4. Only then apply the 20 distinct primary-candidate ambiguity cap and
   the existing exact-name/unique-source-INN candidate selector.
5. Candidate selection is NOT verification: authenticated detail must
   present the exact scoped INN + KPP, and canonical public Saby
   registered requisites must confirm the correct legal name and same
   INN/KPP. Otherwise Stage12 cannot write contact/transport changes.

No hardcoded firm aliases, INNs or exception lists. Regular Stage12
without the explicit smoke flag, SAT XLSX schema, original regional
JSON and SQLite checkpoints remain unchanged.

## VPS test after merging

Update main:

    sudo -u regionalresearch git -C /opt/regionalresearch pull --ff-only origin main

Run when no other Chromium process holds the test profile:

    sudo -u regionalresearch env -u DISPLAY \
      HOME=/var/lib/regionalresearch \
      PLAYWRIGHT_BROWSERS_PATH=/home/regionalresearch/.cache/ms-playwright \
      npm --prefix /opt/regionalresearch run saby:smoke -- \
      --inn=7725104641 \
      --name='АКЦИОНЕРНОЕ ОБЩЕСТВО ДОРОЖНО-СТРОИТЕЛЬНАЯ КОМПАНИЯ АВТОБАН' \
      --limit=1 --headless --public-identity-fallback \
      --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
      --out=/opt/regionalresearch/exports/saby-stage12-alias-v4-20261111.json

Expected search-level diagnostic approximately:
observed=40, branches=11, foreign_inn_rows=28,
primary_candidates=1. This is NOT a promise of Stage12 verification:
the detail and registered-name proof may still correctly return review.
