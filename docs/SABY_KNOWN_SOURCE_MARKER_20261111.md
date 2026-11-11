# Saby Stage12: v9 late requisites and one removed routing parameter

## Verified v9 Time4VPS evidence (2026-11-11)

The authenticated Saby search for INN 7725104641 returned 40 rows,
excluding 11 branches and 28 foreign-INN rows, leaving a single primary
candidate. Opt-in alias verification aborted on hydration poll 2:
`private_route_changed`, `non_ui_query_changed`.
The value-free URL delta shows precisely ONE **removed** non-UI query key,
zero added and zero changed values. This does **not** reveal which key.
Before the abort, the body had 28 labelled INNs, zero KPP and zero
requisites headings. After the aborted attempt, a read-only private-owner
probe observed 5130 visible characters, one H1 matching the selected
Saby search title, two INN labels, one KPP label, one requisites label,
and three related-company headings. The matching H1 was **not** linked
to an isolated owner-scoped INN. No identity was verified and no phone
or fleet data was copied.

Previously completed read-only Saby audits had observed exact INN/KPP
pairs for this legal entity, so a hydration/navigation race is plausible,
but an unrelated company switch remains possible.

## Narrow hypothesis and code change

Earlier Saby samples in the repository explicitly showed authenticated
first-party detail URLs with a `source=internal` navigation marker.
The URL verifier now tolerates **only the removal** of that exact,
literal marker, and treats it as an allowed UI transition. This is a
hypothesis about the specific removed parameter in v9, **not a
claim that it was the parameter actually observed**.

Everything else is blocked exactly as before:
- HTTPS profile.saby.ru, same exact /page/contractor-info path;
- identical company identifiers, INN, KPP, unknown query keys and values;
- no new or changed source value, no arbitrary unknown-key removals;
- unchanged strict same-section private labelled INN+KPP checks,
  independent second private snapshot, currently selected owner heading,
  canonical public Saby registered FULL NAME + identical INN/KPP proof;
- no automatic enrichment on navigation, a search-row match, an H1
  alone, or a KPP label alone.

The relaxation is used only by `--public-identity-fallback` and remains
disabled in ordinary production Stage12. The research JSON, SQLite,
contact logic, OpenAI costs and strict SAT XLSX remain unchanged.

## Acceptance and stop rule

After Ubuntu/Windows CI and PR merge, run only **one** Saby-only VPS smoke
with a new `--out` filename and the known authenticated test profile.
No service restart, full paid research, or OpenAI calls are needed.
If the failure remains `private_route_changed/non_ui_query_changed`,
the removed parameter was **not** the known source=internal marker (or
additional changes occurred), so **do not** continue broadening URL
allowlists. We must investigate the actual owner panel and legitimate
routing model instead. If the verifier proceeds, accept only an explicit
`registered_alias_verified`, never inferred identity.

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
  --out=/opt/regionalresearch/exports/saby-stage12-alias-v10-20261111.json
```

Share `[SABY_PUBLIC_ALIAS_DIAG]`, any `[SABY_PRIVATE_OWNER_DIAG]`,
and the final summary. Console data contains no raw URLs or tokens.
