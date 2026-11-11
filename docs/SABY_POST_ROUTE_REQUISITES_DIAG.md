# Saby v10: isolate late authenticated owner requisites before any more route rules

## Actual Time4VPS evidence, 2026-11-11

The Saby search itself is resolved: 40 result rows, of which 11 are
branches and 28 contain foreign legal-entity INNs; the one remaining
candidate is opened. The optional alias verifier aborts on hydration poll
2: `private_route_changed / non_ui_query_changed`. The safe delta says
exactly one non-UI query key was **removed**. The already-implemented
exception for exact `source=internal` removal did not help, so that
specific hypothesis is not supported. Stop expanding URL allowlists.

The earlier snapshot had 28 labelled INNs and zero KPP labels.
At the end of the same smoke, a read-only private-owner structure probe
reported a single selected-company H1 and one visible KPP label, but
no small DOM region isolating the selected heading with its INN. This
is an **observation**, not legal-company identity proof. The ordinary
Saby card still reports `legal_name_not_verified`; there are zero
contact/fleet updates and zero OpenAI calls.

Earlier independent Saby source row 8 audit retained one matching
authenticated INN/KPP pair; a separate public requisites check for
INN 7725104641, KPP 504301001 returned a verified short/full-name
link on the same public Saby legal profile. That supports pursuing
a deterministic owner-link, not assuming private DOM success.

## Read-only diagnostic, no new acceptance path

Re-use the already proven `recoverSabyDetailRequisitePair` and
`diagnoseSabyPrivateRequisiteFields` on the CURRENT visible authenticated
DOM at the end of an unsuccessful, explicitly opt-in smoke. Return only:
- a fixed reason code from the parser;
- whether it found one target-labelled INN+KPP candidate;
- a fixed parsing-basis code, if any;
- numerical counts for requisites headings, INN/KPP labels, and audited pairs.

A company match is NOT established by these observations. A 9-digit
value is never logged, and no unredacted company text, URL, token, phone,
email or credential is returned by the diagnostic function or persisted.
The in-memory DOM text is discarded as soon as the bounded parser is
finished. It cannot authorize contacts, trucking figures or a public
profile call. The existing selection and URL identity gates remain
unchanged. No production mode flag, SQLite, original JSON or final
5-sheet SAT XLSX changes.

## Decision after ONE fresh live sample

When Ubuntu and Windows CI succeed, pull the merged change. With no
other Saby process using the same saved profile, run one Saby-only smoke,
using a fresh output filename (no paid research):

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
  --out=/opt/regionalresearch/exports/saby-stage12-owner-pair-20261111.json
```

Inspect `[SABY_PRIVATE_OWNER_DIAG].late_requisites`, plus
`[SABY_PUBLIC_ALIAS_DIAG]`. The latter is expected to continue to
return REVIEW because this change is diagnostic only.

- If `candidate_pair_present=true`, the late private section holds
  one *candidate* INN/KPP pair. Next engineering step is a distinct
  re-verification approach that begins fresh after SPA navigation and
  still requires two independent scoped private snapshots and exact
  canonical public registered name+INN/KPP proof.
- If `no_scoped_inn_kpp` persists, then one visible KPP label is not
  in an unambiguous legal-owner section. Stop tweaking URL logic and
  inspect the actual authenticated owner panel manually or through a
  tightly bounded structure-only DOM investigation.
- If `audit_inn_conflict` or `audit_kpp_ambiguous`, the current
  surface mixes entities and MUST stay REVIEW.

The goal is one material evidence-gathering run, not indefinitely
repeating the same smoke or widening search. If this diagnostic still
cannot establish owner scope, return to manual evidence or a separate
canonical first-party identity source before integrating contacts.
