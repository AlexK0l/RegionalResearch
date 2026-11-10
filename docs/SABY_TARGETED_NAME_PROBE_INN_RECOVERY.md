# Saby targeted name probe + offline INN recovery

These are separate READ-ONLY diagnostic commands. They never change research
JSON, SQLite checkpoints, Saby Stage 12 enrichment state, or SAT reference XLSX.
They do not use OpenAI or external paid web search.

## 1. Recover candidates for the missing INNs offline

Use the saved Smolensk research JSON; no browser profile is needed.

    cd /opt/regionalresearch
    sudo -u regionalresearch env \
      SAT_PYTHON_BIN=/opt/regionalresearch/.venv/bin/python \
      npm --prefix /opt/regionalresearch run saby:missing-inn-queue -- \
      --result=/opt/regionalresearch/SAT_Смоленская_область.json \
      --out-prefix=/opt/regionalresearch/exports/saby-missing-inn-smolensk-20261110

Outputs: a separate JSON, XLSX, ZIP at the specified prefix. The tool
searches only saved notes, explicit INN evidence, Saby public-profile paths
and same-name records, checks Russian INN control digits, identifies possible
duplicate entities, and marks every value as an unverified CANDIDATE. It
does not silently complete the missing INNs. To recover unresolved cases,
an external EGRUL/EGRIP verification stage is needed.

## 2. Diagnose the actual Saby name and requisite label layout

The previous 473-row audit produced eight interesting card samples with
a visible INN/KPP but no registered full name. Probe only these eight
source indices, not all 473:

    sudo -u regionalresearch env -u DISPLAY \
      HOME=/var/lib/regionalresearch \
      PLAYWRIGHT_BROWSERS_PATH=/home/regionalresearch/.cache/ms-playwright \
      npm --prefix /opt/regionalresearch run saby:identity-probe -- \
      --result=/opt/regionalresearch/SAT_Смоленская_область.json \
      --indexes=8,95,181,250,291,369,390,408 \
      --headless \
      --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
      --out=/opt/regionalresearch/exports/saby-name-probe-smolensk-20261110.json

This reads visible field labels near 'Название', 'Реквизиты',
'Полное наименование', INN and KPP without dumping the raw page, contacts,
phone numbers, email, cookies or credentials. All name candidates remain
UNVERIFIED until registered name and INN are scoped to the same legal
entity. Do not run a second browser using the same persistent profile
at the same time.

## Download the outputs

From your LOCAL PowerShell (replace IP_VPS):

    scp root@IP_VPS:/opt/regionalresearch/exports/saby-missing-inn-smolensk-20261110.zip "$HOME\Downloads\"
    scp root@IP_VPS:/opt/regionalresearch/exports/saby-name-probe-smolensk-20261110.json "$HOME\Downloads\"

Attach both files for evidence-based repair of the registered-name extractor
and a ranked plan to recover missing INNs. Do not assume lack of an available
name label means that Saby has no official legal name.
