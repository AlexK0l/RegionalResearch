# Saby v8: value-free route change and owner hydration diagnostic

## Grounded VPS observation (2026-11-11)

The opt-in smoke on commit `da557b7` searched source INN 7725104641:
40 rows, 11 branches, 28 foreign-INN company rows, one primary candidate.
The first private detail check found 28 INN-labelled lines, zero KPP lines
and zero requisites headings. After three hydration polls, the current URL
differed in a **non-UI query parameter**. The verifier correctly returned
`private_route_changed / non_ui_query_changed`, REVIEW=1, verified=0.
This does not establish whether Saby switched legal entities or
is replacing a temporary SPA routing token.

## Narrow experiment only

The opt-in alias fallback remains fail-closed: a non-UI query change still
rejects that company *before* public registered proof and contacts/fleet.
A new aggregate diagnostic on that rejection records only counts of
non-UI query keys added, removed, or changed, and UI keys changed.
No key names, values, URLs, query strings, company details, cookies,
contacts, DOM snapshots or credentials are emitted.

After the rejected attempt, the already existing private owner diagnostic
can observe the *current* Saby detail surface, if and only if it remains
the exact same first-party detail route category. Its output is counters
and booleans only. Observed owner headings, KPP labels and requisites
are NOT verification and cannot enable enrichment.

## One bounded follow-up

First confirm GitHub CI on Ubuntu and Windows is green and merge the PR.
Do not restart the service or enable the experimental alias in production.
Ensure no other browser process is using the saved Saby test profile.

```bash
sudo -u regionalresearch git -C /opt/regionalresearch pull --ff-only origin main
sudo -u regionalresearch env -u DISPLAY \
  HOME=/var/lib/regionalresearch \
  PLAYWRIGHT_BROWSERS_PATH=/home/regionalresearch/.cache/ms-playwright \
  npm --prefix /opt/regionalresearch run saby:smoke -- \
  --inn=7725104641 \
  --name='АКЦИОНЕРНОЕ ОБЩЕСТВО ДОРОЖНО-СТРОИТЕЛЬНАЯ КОМПАНИЯ АВТОБАН' \
  --limit=1 --headless --public-identity-fallback \
  --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
  --out=/opt/regionalresearch/exports/saby-stage12-alias-v9-20261111.json
```

Share console lines `[SABY_PUBLIC_ALIAS_DIAG]` and
`[SABY_PRIVATE_OWNER_DIAG]`, plus the final summary. The JSON output
does not include these console-only diagnostics.

## How to interpret the output

- `non_ui_values_changed>0`: a stable non-UI field changed; keep REVIEW.
  It is not safe to auto-accept that identity transition.
- `non_ui_added/non_ui_removed>0`: dynamic routing state is possible,
  but still not identity proof; inspect the post-route owner indicators.
- `selected_heading_scoped_inn=false`: private owner binding has not
  been demonstrated, even if a broad page block contains the source INN.
- No late KPP/requisites: stop speculative parsing and consider the
  authenticated view incomplete/limited.
- Only independently matching stable private INN/KPP, matching selected
  owner heading, and canonical public registered name plus identical
  INN/KPP may lead to `registered_alias_verified`.

No OpenAI, source research JSON, SQLite, ordinary production Stage12
match rules, or five-sheet SAT XLSX modifications.
