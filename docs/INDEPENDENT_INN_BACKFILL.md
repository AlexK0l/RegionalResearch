# Independent INN backfill (public registries)

The operator can recover missing INNs in one explicitly selected saved study,
without restarting discovery, OpenAI or the authenticated Saby browser.
This is a standalone supplemental stage, to run before another finance-only
Saby pass. It is **not automatically enabled in a new full study** until
the live name-search layout has been validated on the VPS.

## Plan and execute

    node scripts/independent-inn-backfill.js --db=/absolute/checkpoints.sqlite --checkpoint=<UUID> --limit=146

This default mode only reads SQLite. The counts include all missing-INN
rows, with or without finance data. A run requires explicit --run:

    node --env-file-if-exists=.env scripts/independent-inn-backfill.js --db=/absolute/checkpoints.sqlite --checkpoint=<UUID> --run --limit=146 --max-pages=1500

Use your normal Playwright runtime/Chromium cache. The script opens a
separate headless context, does not log in to Saby, and creates a new
child checkpoint saved after each row. Public pages can be unavailable
or restricted; the tool does not bypass access controls.

For a bounded pilot use --limit=10 --max-pages=100. To continue, take the
child_checkpoint from INDEPENDENT_INN_CHILD or INDEPENDENT_INN_DONE.
The INDEPENDENT_INN_PLAN on that child shows remaining unprocessed IDs.
Rows reviewed without proof are not blindly repeated. A temporary
navigation failure or navigation budget leaves the interrupted row pending.
The max-pages limit bounds top-level page navigations, not website
subresources.

## Evidence and policy

- Use the existing missing-INN queue and strict legal-form/name policy.
- Prefer an unopposed, unoccupied saved Saby public INN/KPP hint; otherwise
  search VBR's public search page by original legal name. Do not fabricate
  profile slugs. Read the observed VBR company's labelled registration block,
  legal address and active status.
- A complete search needs an explicit result count, matching query input,
  fully inspected distinct company links, and no visible pagination.
  A positive, unique source address/registered identifier or a complete
  search with unique exact legal name and precise original locality must
  connect the candidate to the row. Never infer region from INN prefix.
- Check the same INN, KPP, OGRN, full/short legal names and active status in
  the independent T-Bank registry page. Verify checksums. Both sites are
  aggregators, not official FNS extracts.
- Missing proof, ambiguous names, brands, branch labels, IP records
  (not supported by these legal-entity parsers), prior contradictions and
  already-owned identifiers remain in review. An inactive competing
  exact-name entity is not silently removed from the ambiguity check.
- Write only a previously blank INN and its identity provenance; retain
  all commercial fields, rows, comments other than the INN line, prior
  Saby financial outcomes and the immutable parent checkpoint.
- No OpenAI, no Saby, no paid search, no automatic merges or deletions.
  The first live run is needed to verify the public UI layouts and actual
  recovery rate; mock regressions do not establish that rate.

Download the result from the existing checkpoint export endpoint, using
the child UUID. Continue Saby finance only for newly eligible INNs once
the recovered identity evidence has been checked.
