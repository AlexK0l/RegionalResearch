# Saby: fresh post-route owner identity re-verification (v11)

## Why this is needed

One-company Time4VPS smoke v10 for INN 7725104641:

- Saby search: 40 rows -> exclude 11 branch rows and 28 rows with
  foreign INNs -> one primary company candidate.
- Early private detail text (during SPA loading): 28 INN labels,
  no visible KPP or actual requisites block.
- The old experimental alias verifier rejects `private_route_changed /
  non_ui_query_changed` after a single unknown query parameter disappears.
  No further URL allowlist expansion is acceptable.
- A late, read-only snapshot of the CURRENT detail shows a matching
  selected-company heading, 2 INN labels and 1 KPP label.
  Its strict bounded private parser reports
  `unique_requisite_pair / strict_private_block`,
  `audited_pairs=1`, `audited_exact_pairs=1`.
- However the matching H1 does not share a small isolated INN ancestor
  in the DOM, so this late snapshot alone cannot verify ownership.
- An earlier independent audit and canonical public Saby requisites check
  established the public registered-name link for this exact company,
  INN 7725104641 and observed KPP 504301001. That is precedent for
  testing the full identity chain, not permission to hardcode a KPP.

## New, isolated Stage12 experimental identity gate

The **original** private-route check is unchanged and still rejects
unknown query-key changes. A separate fresh proof is attempted only if:

1. The old opt-in verification was rejected specifically for a
   `non_ui_query_changed`, and the privacy-safe URL delta says exactly
   one non-UI query parameter was REMOVED (no additions, value changes,
   or UI query changes). This is a filter, NOT trust in the removed key.
2. At the END of the existing bounded private-card render window, the
   CURRENT browser URL is HTTPS profile.saby.ru contractor-info.
   There is no new search, no repeat company click, and no forced
   navigation back to an old URL.
3. Two fresh independently read private DOM snapshots, separated by
   a short wait, each contain exactly one visible H1 matching the
   originally selected unique Saby search company.
   The headline is identical between both snapshots.
4. Each snapshot contains exactly one strict same-section labelled
   INN+KPP pair for the source INN, with one audited exact pair and
   no competing audited pair. The KPP is identical across snapshots.
   The changed URL is never itself used to verify any legal identity.
5. A separate first-party canonical public Saby profile is opened from
   the observed private KPP. Its full registered company name, source
   name, public short name, INN and exact KPP must pass the EXISTING
   strict verifier. No public lookup without prior private proof.
6. The authenticated original detail URL must stay byte-for-byte stable
   during this post-route proof. After the public profile returns,
   a THIRD private DOM snapshot must still contain the same selected
   H1 and the exact same strict private INN/KPP pair. Then the existing
   public-name/private-title association validator must also accept.

Only after all six conditions does Stage12 get a verified identity and
become eligible to **attempt** contact/fleet retrieval. Missing contact
or fleet widgets remain incomplete and must never be manufactured.

No arbitrary URL query key is newly whitelisted. Production fallback
remains off by default and is used only with
`--public-identity-fallback`. There is no OpenAI/web-search billing,
source research JSON modification, SQLite change, Google Sheets write
or SAT XLSX layout change.

Only sanitized `[SABY_POST_ROUTE_DIAG]` information is logged:
booleans, number of private reads, and fixed safe reason codes;
never private URLs, company titles/INNs/KPPs, raw DOM, cookies, email,
phone or account credentials.

## One bounded live acceptance test

After Ubuntu/Windows offline CI and PR merge, make sure **no other**
Saby/Chromium process is using the existing test profile.

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
  --out=/opt/regionalresearch/exports/saby-stage12-post-route-v11-20261111.json
```

The command uses Saby only, no OpenAI. The JSON output filename must
be unique. No service restart, install script or full paid research.

Share `[SABY_PUBLIC_ALIAS_DIAG]`, `[SABY_PRIVATE_OWNER_DIAG]`,
`[SABY_POST_ROUTE_DIAG]`, any `[SABY_CARD]` and final stage summary.

An acceptable positive identity result requires
`[SABY_POST_ROUTE_DIAG] accepted=true` AND
`[SABY_CARD] post_route_registered_identity_verified`.
Then examine contact and fleet results SEPARATELY before enabling this
experimental fallback in production. A `REVIEW` with a precise
`SABY_POST_ROUTE_DIAG` reason must remain the outcome otherwise.

If the selected H1 is disconnected from the previously selected
search candidate, or if private INN/KPP ownership is ambiguous,
do NOT loosen these conditions; investigate the first-party active
company panel manually or via narrow read-only structure diagnostics.
