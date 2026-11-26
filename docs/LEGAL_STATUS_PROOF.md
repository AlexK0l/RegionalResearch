# Legal status: conservative cessation proof

The final qualification gate may exclude a company only when a saved
status claim is attributed to that company's exact INN and a specific
official registry URL. A substring match, another labelled INN, explicit
negation, planned liquidation or exclusion, cancelled decisions, branch
closure or a contradictory active-status label are not proof of cessation.
Such cases remain commercial eligibility review signals, not confirmed
active status. The existing source and evidence are retained.

This is an offline structural safeguard for both production qualification
and offline replay. It does not independently download an EGRUL record and
does not claim to recheck all legal statuses. Independent live verification
of the current legal status remains a separate task. No added OpenAI or
browser requests, workbook changes or retroactive edits of old exports.

## Independent official extract check

The bounded status-only CLI uses the existing public FNS UI, searches an
exact checksum-valid legal INN, requires one complete record and matching
registered name, OGRN/KPP and a current complete downloaded extract. It
stores document date, number, hash, page count, matched entity and status
in the current child checkpoint, with a separate readable company comment.
The current opt-in FNS contact pass also retains the status of an extract
it already downloads, without an extra lookup. No model prompt or extra
Saby request. The official form URL is stored with the exact document proof;
no fabricated entity-specific download URL.

A current complete extract without adverse status is recorded as
`no_adverse_status`, not a guarantee of active commercial operations.
Bankruptcy, proposed exclusion, unreliable records and other adverse
status without explicit completed cessation are `adverse_status_review`.
A separate, uniquely numbered current cessation section with a valid
past termination date and actual termination method can yield `ceased`.
The new parser branch is synthetic-fixture tested; the live layout of a
terminated company's extract still needs verification. All statuses stay
in reviewable evidence/comments. **No automatic removal from commercial
sheets, grade/priority change, or update of the original saved database.**

Run only when the VPS has no active research/browser work. Plan first;
explicit --run creates a separate child and checkpoints each attempt.
Default limit 25, max 100 per invocation; current proofs are not repeated,
unconfirmed attempts are not immediately repeated unless explicitly
requested. The source may decline access; CAPTCHA/transport failures stop
the pass, not prove closure.

    node scripts/fns-legal-status-backfill.js --db=/opt/regionalresearch/data/checkpoints.sqlite --checkpoint=<completed-UUID> --limit=25

Add `--run` only to perform the real official registry requests. Requires
the existing Playwright Chromium and pdftotext setup. This is opt-in and
does not launch automatically in every regional study.
