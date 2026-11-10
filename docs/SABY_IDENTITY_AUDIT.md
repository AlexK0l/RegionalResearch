# Full Saby identity audit (Time4VPS)

This is a read-only identity audit of every original company, **not** a
Stage-12 enrichment or a rewrite of the strict SAT five-sheet workbook.

## Coverage and evidence

Uses all rows of direct_buyers, intermediaries, and leasing, including
companies with existing phones, invalid INNs, and repeated INNs. Every
original row gets a separate stable index. Captures original INN and
company name, Saby's search-row display name, card heading, labelled INN,
registered name/INN/KPP if a structured requisites block is accessible.
If Saby does not show its full legal name in the account SPA, that value
is recorded as missing, **not guessed**.

A matching INN in search results does not automatically verify a company.
The status verified requires matching labelled detail INN and exact INN
plus full legal name in the same requisites section. A short title alone
stays review. Abbreviations and differing legal forms are not accepted
automatically.

## Run the complete Smolensk audit as a background systemd service

Before starting, update the main repository and ensure nobody else is
currently using the browser profile cold-profile-20261110.

    sudo systemd-run --collect --unit=saby-identity-smolensk \
      --property=User=regionalresearch \
      --property=Group=regionalresearch \
      --property=WorkingDirectory=/opt/regionalresearch \
      --property=Environment=HOME=/var/lib/regionalresearch \
      --property=Environment=PLAYWRIGHT_BROWSERS_PATH=/home/regionalresearch/.cache/ms-playwright \
      --property=Environment=SAT_PYTHON_BIN=/opt/regionalresearch/.venv/bin/python \
      /usr/bin/npm --prefix /opt/regionalresearch run saby:identity-audit -- \
      --result=/opt/regionalresearch/SAT_Смоленская_область.json \
      --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
      --headless --resume --batch-size=25 --delay-ms=2000 \
      --out-prefix=/opt/regionalresearch/exports/saby-identity-smolensk-20261110

The unit continues when SSH disconnects. It automatically restarts the
Playwright browser context between batches. Every company is immediately
written to the append-only JSONL journal, and the progress JSON is updated.
It does not send any OpenAI requests, touch the research JSON, write SQLite,
or expose the Saby browser profile over HTTP.

    sudo journalctl -fu saby-identity-smolensk.service
    sudo systemctl status saby-identity-smolensk.service --no-pager
    sudo cat /opt/regionalresearch/exports/saby-identity-smolensk-20261110.progress.json

If interrupted or rate-limited, repeat the same background command after
the previous unit exits. The --resume flag enforces the original JSON's
SHA256 and skips previously journaled rows. Three consecutive UI/browser
errors open a circuit breaker instead of hammering Saby. Do not run
concurrent browser processes with the same persistent profile.

## Outputs and downloading

The output prefix creates:
- .records.jsonl: one original company row per audit record
- .meta.json: original source SHA256, row counts, source path
- .progress.json: progress for live monitoring
- .comparison.json: all company comparisons and unapproved name candidates
- .summary.json: coverage, confidence categories, mismatch statistics
- .xlsx: separate audit spreadsheet, not the SAT reference workbook
- .zip: workbook and important audit files, without login, browser profile,
  SQLite checkpoints or the original source research file

Use a secure scp/sftp connection from your workstation to download the ZIP.
Then upload the ZIP to ChatGPT for full source-vs-Saby comparative analysis
and development of evidence-based short/long legal name matching rules.

Always check summary.completed=true and summary.remaining=0 before treating
the file as the finished 473-row audit.

## Rate limiting and missing data

Default delay is 2 seconds between searches. Depending on Saby page
latency, the full audit can take hours. If a section is missing, it remains
missing; the tool does not claim that Saby has no such legal information.
Never automate manual CAPTCHA or two-factor challenges, and respect
account access and Saby usage policies.
