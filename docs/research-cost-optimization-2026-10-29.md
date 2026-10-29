# Research-cost optimization (standalone local experimental branch)

This branch is **NOT yet a validated $20–25 full-run configuration**.
No OpenAI API billing was incurred by the implementation or offline tests.
Use the standalone `feature/evidence-first-cost-quality-20261028` branch without an open pull request. Do not merge into `main` or run a paid pilot without explicit approval.

## Why the old full run was expensive

Smolensk baseline measured 3,601 \`web_search\` calls (~$36.01 at the
configured $0.01/call) plus ~$6.94 estimated model tokens (~$42.95 total).
Most web calls were outside the nine discovery directions. A full market run
on the previous experimental branch measured ~$43.38 and 3,640 calls.

The price and token estimates are **diagnostic**, not a billing-statement
guarantee. The reference v4 is **benchmark-only** and never search input.

## New default phase control

| Environment variable | Default | Meaning |
| --- | ---: | --- |
| OPENAI_MAX_RESEARCH_COST_USD | 25 | Estimated cumulative USD, including model tokens |
| OPENAI_FULL_WEB_MAX_CALLS | 1850 | Global total tool calls |
| OPENAI_FULL_WEB_DISCOVERY_MAX_CALLS | 1050 | All nine stages + geographical gaps |
| OPENAI_FULL_WEB_IDENTITY_MAX_CALLS | 600 | Legal identification and mandatory final INN |
| OPENAI_FULL_WEB_ENRICHMENT_MAX_CALLS | 190 | Data enrichment (management/revenue/headcount) |
| OPENAI_FULL_WEB_CONTACTS_MAX_CALLS | 270 | All contact search and phone conflict checks |
| OPENAI_FULL_WEB_STATISTICS_MAX_CALLS | 12 | Regional statistics |
| OPENAI_FULL_WEB_OTHER_MAX_CALLS | 70 | Other web lookups |

Phase maxima are **independent ceilings**, not sums of guaranteed spends.
All phases compete for one global quota. Before a concurrent Responses
request starts, its *max_tool_calls* are reserved atomically. Actual response
tool calls are counted, and unspent reservations are released on completion
or error. Partial last slots reduce \`max_tool_calls\` automatically.

An estimated cost cap is NOT equivalent to a financial provider hard cap:
prices may differ, in-flight model token charges can settle after requests,
and Billing may use different tariffs. Do not advertise "$25 guaranteed".

## Search consolidation

- Discovery remains broad: the nine source directions are unchanged.
- Final-INN lookup stays mandatory for qualifying companies. If a fact is
  ALREADY visible in the SAME source excerpt containing the confirmed INN
  and value, it can be reused for contacts/leadership/revenue/etc. There is
  **no additional web search** for these bonus facts. Conflicting INNs,
  unsourced facts, wrong legal entities, and unsupported unit conversions
  are rejected.
- Enrichment defaults to 4 entities per batch, 1 web call per batch, 20
  structural fallbacks across the run; blank but valid answers do not retry.
- Contact search defaults to 5 legal entities per batch with at most
  2 web calls, cited results only with matching \`id\` and legal INN. A
  missing/mismatched batch item is **not** considered a researched failure;
  bounded one-call individual fallbacks (maximum 30, only A/B) are allowed.
- A second phone search is no longer automatic. Maximum 12 such one-call
  requests for grade A with exact INN and a sourced official site. If the
  first search found only a leader, it does not itself justify an extra call.
- Existing 90-day, same-INN verified contact reuse remains enabled.
- Budget exhaustion in enrichment/contacts preserves unfinished IDs in
  checkpoint for continuation, rather than writing a fake "not found".

Configurable rollback: \`OPENAI_CONTACT_BATCH_ENABLED=false\` restores
single-company first lookups (still bounded by per-phase/global budgets).
Use this only after measuring the impact on contact quality.

## Checkpoint and risk control

Each checkpoint records \`api_usage\`: cumulative paid-tool counts per
scope, total model tokens, estimated cost and configured limits. Resuming
restores prior recorded spending, preventing hidden reset to $0.
Legacy checkpoints may lack detailed token attribution; prior recorded web
counts are restored conservatively when available.

If discovery reaches its spending ceiling, the current stage's completed
candidate data and branch diagnostics are saved and the full job **stops**:
it MUST NOT claim successful nine-stage discovery. Resume can continue when
the user explicitly raises the allowed budget. Optional contact/enrichment
omissions are documented as deferred, not fabricated negatives.

**Local Windows operation:** Use GitHub Desktop to select the experimental branch, fetch/pull, and run `npm test` followed by `npm run local` in your local repository directory. No Render operations are needed. The local `.env` overrides application defaults and must be reviewed before paid research. Never commit `.env` or change the API key. Back up SQLite with the application stopped. PR #12 was closed without merge; it is not part of the ongoing workflow.

## Offline validation and remaining go/no-go gate

Run \`npm test\` (Node >=22) for unit and integration fixtures. In
particular: \`test/research-cost-policy.test.js\`,
\`test/phase-budget-reservation.test.js\`, existing qualification
and legal-identity tests, plus synthetic SQLite replay. They require no
OpenAI account or API calls.

Private checkpoint replay, when run locally:

\`\`\`powershell
node scripts/replay-checkpoint-qualification.js data/checkpoints.sqlite --checkpoint=d22c925b-dc87-40c7-9291-37bd2f42f688 --out=exports/qualification-savings-check
\`\`\`

This is a **qualification replay**, not proof of fresh research coverage or
contact yield. It does not incur token/web costs.

After explicit approval for a paid pilot, check (1) total USD and calls by
phase, (2) INN recall and legal conflicts, (3) confirmed phone/director
yield versus old run, (4) A evidence precision, and (5) **non-decreasing
priority discovery recall** against the independently provided v4 benchmark:
41/100 priority identities and 13/43 green on the last full run. Do not
silently trade lost leads or contact quality for cheaper API usage.

If the experimental research cannot complete within $25 without weakening
core identity coverage, report the deficit and stop with a recoverable
checkpoint. Do not fake completion or promote questionable leads to grade A.


## GitHub Desktop — separate-branch workflow

1. Open RegionalResearch in GitHub Desktop, then choose **Current Branch → feature/evidence-first-cost-quality-20261028** (not `main`).
2. Choose **Fetch origin** / **Pull origin**. Do not merge into `main` and do not create a pull request.
3. With the backend stopped, back up `data/checkpoints.sqlite` outside the repository. When the database is in use, the `-wal` and `-shm` files also matter.
4. Compare the actual, untracked local `.env` with the updated `.env.example`. Remove stale duplicate keys. Editing `.env.example` does **not** update the local `.env`.
5. Verify Node 22+, then execute `npm test`. Perform the private checkpoint qualification replay with a fresh `--out` directory; this replay makes no paid API calls.
6. Only after explicit approval, execute `npm run local` and start the chosen region. Monitor cost, quality and checkpoint diagnostics.

**Branch-only status:** PR #12 is closed without merge. All future changes in this project go to the named branch until the user explicitly directs otherwise.
