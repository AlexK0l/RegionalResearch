# Smolensk: verified-name public requisites follow-up (without resweeping)

Previous read-only Saby research covered 473 companies, and eight records
contained exact INN+KPP in the Saby contractor card but no full registered
company name. The follow-up reads only those eight **known** canonical
public Saby profiles; KPP is taken exclusively from the completed first
audit and is NEVER guessed or hardcoded.

## Safety and evidence requirements

- Source JSON SHA256 must equal first audit metadata.
- Source INN, observed detail INN and observed requisites INN must all
  agree, and the audit must hold one observed 9-digit KPP.
- Open only https://saby.ru/profile/{INN}-{KPP} and refuse redirects to
  an untrusted route. No generic public search form is needed.
- Full registered name must be immediately under the actual registered
  'Реквизиты' heading with exact labelled INN and KPP in that same block.
  A navigation tab and 'О компании' summary do NOT count.
- Compare the original name against either this registered name or the
  **short headline of the same public company card**, without ever
  overriding a legal-form conflict.
- Report proof and original/registered names in a separate JSON. Do NOT
  automatically attach contacts, transport or an INN to any research row.
- This is first-party Saby supporting evidence, not a signed FNS extract.
  If Saby and EGRUL conflict, require review.

## VPS check for exactly eight old observed INN+KPP pairs

After updating the code, ensure the previous Saby browser task has finished
and the authorized profile is not locked by another Chromium process:

    cd /opt/regionalresearch
    sudo -u regionalresearch env -u DISPLAY \
      HOME=/var/lib/regionalresearch \
      PLAYWRIGHT_BROWSERS_PATH=/home/regionalresearch/.cache/ms-playwright \
      npm --prefix /opt/regionalresearch run saby:public-requisites-check -- \
      --result=/opt/regionalresearch/SAT_Смоленская_область.json \
      --audit=/opt/regionalresearch/exports/saby-identity-smolensk-20261110.comparison.json \
      --headless \
      --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
      --out=/opt/regionalresearch/exports/saby-public-requisites-smolensk-20261110.json

This command does not reopen all 473 companies. It targets the eight
records whose KPP was observed and confirmed by source/detail INN, and
retains errors as review. No OpenAI or SQLite writes.

## Regenerate missing INN review queue with owner safeguards

The old queue contained 6 hints for 96 missing INNs:
- 1 contradicted claim;
- 1 checksum-invalid claim;
- 2 values already belonging to a different research row, one with
  a different legal form and one with an entirely different company name;
- 2 apparently matching candidate companies that require independent
  verification and liquidation-status analysis.

The revised queue now distinguishes foreign-company ownership and
legal-form conflicts from possible duplicates. Use a NEW output prefix
to avoid overwriting the first review:

    sudo -u regionalresearch env \
      SAT_PYTHON_BIN=/opt/regionalresearch/.venv/bin/python \
      npm --prefix /opt/regionalresearch run saby:missing-inn-queue -- \
      --result=/opt/regionalresearch/SAT_Смоленская_область.json \
      --out-prefix=/opt/regionalresearch/exports/saby-missing-inn-smolensk-v2-20261110

Both are independent audit files: the final SAT XLSX template,
production Stage12, source JSON and SQLite remain unchanged.

## Live result and next **single-card** test (2026-11-10)

The actual Time4VPS run processed all eight known INN/KPP profiles but
returned `review / requisites_unavailable` for **8/8**, with an empty
`public_short_name` in every record. The missing headline is important:
we do **not** yet know whether the public SPA is unloaded, blocked, or
missing its registered fields. Merely weakening the string comparison
would be unsafe. The existing source and checkpoint were not changed.

The verifier now polls longer, can scroll once to the exact first-party
requisites link if present, samples the terminal requisites section even
if the visible page text is very long, and emits only small diagnostics:
HTTP status, length of visible/DOM text, number of H1 tags, whether a H1
has text, and whether relevant field labels or a challenge are visible.
No raw HTML, cookies, login state or contact data is reported.

**Run only sample #8**, which has independently observed real public Saby
requisites, with a brand-new `--out` to avoid overwriting old evidence.
Do not run other Saby jobs using the same authenticated Playwright profile
at the same time:

```bash
sudo -u regionalresearch env -u DISPLAY \
  HOME=/var/lib/regionalresearch \
  PLAYWRIGHT_BROWSERS_PATH=/home/regionalresearch/.cache/ms-playwright \
  npm --prefix /opt/regionalresearch run saby:public-requisites-check -- \
  --result=/opt/regionalresearch/SAT_Смоленская_область.json \
  --audit=/opt/regionalresearch/exports/saby-identity-smolensk-20261110.comparison.json \
  --indexes=8 --headless \
  --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
  --out=/opt/regionalresearch/exports/saby-public-diagnostic-8-20261110.json
```

Upload this small JSON instead of repeating the eight-page test or the
full regional search. If the page is empty or presents a browser challenge,
do not bypass it or claim registered identity. If the registered fields
render but no parser result is produced, adapt parsing with safe bounded
DOM field evidence. Production Stage12 remains unchanged.
