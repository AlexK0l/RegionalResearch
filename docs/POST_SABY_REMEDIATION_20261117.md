# Post-Saby remediation queues (offline, no paid re-research)

The regional CRM must **not** silently fabricate INNs, classify a disputed
grade A as proven, or treat a missing Saby truck widget as no fleet.

## Generate a separate actionable report

From the VPS project folder, after downloading a completed **full JSON**:

```bash
npm run audit:post-saby -- \
  --result=/path/to/SAT_region.json \
  --out-prefix=/opt/regionalresearch/exports/post-saby-region-20261117
```

Outputs a separate `.json` and `.xlsx`. Choose a fresh prefix every
time: output files are not overwritten. The original JSON, the five-tab
CRM workbook, SQLite checkpoints and running research are not modified.
No requests are made to Saby, OpenAI, the internet or public registers.

The report has five worksheets:
1. Summary of verified limitations and prior collected emails.
2. **Missing INN** with source-local candidate suggestions from existing
   evidence. A candidate is NOT a verified legal identity and is never
   assigned to the entity without independent legal source confirmation.
3. **Unattributed A** with the selected claim and company source URLs,
   clearly marked as only potential sources. An unrelated company-wide
   URL must not become a claim-level citation.
4. **Partial Saby** with exact-INN card status: incomplete contacts,
   unverified fleet, or both. Do not rewrite preserved earlier evidence.
5. **No Saby card**, for firms with INN but no trusted Saby evidence.
   This list is not necessarily the entire Stage12 pending queue.

If `final_quality_gate.a_claim_attribution_review` is absent in the
input, the source-attribution review report will be empty; the program
will NOT claim all A assertions have verified sources.

## Current known Smolensk evidence

At the conclusion of the first full Saby sweep:
- 473 commercial records, 96 without a confirmed INN.
- 21 grade-A selected claims without direct, exact claim-source linkage.
- 107 partially confirmed Saby cards, among 211 with collected evidence.
- Saby had attempted all 369 eligible companies, with 104 completed.
- Previous exported workbook predated the email column and kept emails
  in comments and Saby provenance. PR #68/#69 already added the
  **Электронная почта** column immediately before **Телефон** in the
  three strict CRM sheets and preserved emails across Stage10, QA,
  deduplication and Saby. This report does not fork that implementation.

The audit output lists detailed follow-up work. Closing the unresolved
issues still requires **new identity- and claim-specific evidence**.
It must never auto-promote, guess, or insert another firm's identifier.

## Safety and testing

`node --test test/post-saby-remediation.test.js` tests read-only
operation, invalid identity gating, grade A review priority and Saby
section-specific status. CI runs this without web, OpenAI or Saby.

Continue to use the normal reference exporter for final customer-facing
XLSX; the extra audit workbook is strictly supplementary.
