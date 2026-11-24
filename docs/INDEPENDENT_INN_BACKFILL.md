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
child checkpoint saved after each row. The default provider is `fns`.
The default FNS confirmation mode is `extract`; install `pdftotext`
(`poppler-utils` on Ubuntu). Before creating a child it checks up to three
previously evidenced legal entities by INN, downloads and parses a complete
current official EGRUL extract, and checks that a registered-name query
returns the same known identity. In extract mode a positive but incomplete
name result passes service-health preflight with
`verified_name_search_incomplete` and `name_search_complete:false`. This
does not authorize a missing-INN assignment. Each unanchored company
still requires a complete search, otherwise it is marked
`registry_name_search_incomplete` without unnecessary PDF downloads.
`--confirmation=registry` retains the previous third-party confirmation route
and strict complete-name preflight.
A company-specific non-active status does not establish a service outage. If this live preflight fails, no row is visited and no child
is created. The optional `--provider=vbr` retains the old search route.
Public pages can be unavailable or restricted; CAPTCHA or access denial
stops the run. The tool does not bypass access controls.

For a bounded pilot use --limit=10 --max-pages=100. To continue, take the
child_checkpoint from INDEPENDENT_INN_CHILD or INDEPENDENT_INN_DONE.
The INDEPENDENT_INN_PLAN on that child shows remaining unprocessed IDs.
Rows reviewed without proof are not blindly repeated. Switching from VBR
to FNS reopens only the three old discovery-failure categories once;
identity conflicts and existing FNS review decisions are not reset. A temporary
navigation failure or navigation budget leaves the interrupted row pending.
The max-pages limit counts top-level page navigations and official extract
download attempts, not website subresources. The extract count is reported
separately.

## Evidence and policy

- Use the existing missing-INN queue and strict legal-form/name policy.
- Prefer an unopposed, unoccupied saved Saby public INN/KPP hint; otherwise
  submit the original legal name in the normal public EGRUL search form.
  Extract mode does not require the broken styled exact-name checkbox:
  it accepts a name-only assignment only from a positively observed
  complete result set with exact local registered-name matching.
  Observe only the corresponding submitted request and correlated response. No direct undocumented API calls,
  manufactured session tokens or CAPTCHA bypass. The optional legacy VBR
  route reads only observed canonical company links.
- A complete search needs a positively bound exact query, an explicit
  result count and fully parsed distinct records without truncation.
  FNS 1.9.2 search rows may omit the address. They remain identity
  candidates; extract mode reads the current address from the official
  PDF, after exact INN/KPP/OGRN and full/short name matching. The legacy
  confirmation mode instead uses the independently matched requisites
  panel, preserving address provenance. Inspect up to eight missing-address
  exact-name candidates per research row; an unread competing address
  blocks a geography-only assignment, including inactive namesakes.
  A positive, unique source address/registered identifier or a complete
  search with unique exact legal name and precise original locality must
  connect the candidate to the row. Never infer region from INN prefix.
- Check the same INN, KPP, OGRN, full/short legal names and active status in
  the complete, current official PDF downloaded by the visible FNS form.
  Verify identifier checksums, page count and sequence, the same OGRN on
  every page, the document date/number, separate current legal-name,
  address, registration and tax sections, and absence of adverse current
  status sections. Missing proof blocks auto-write. Legacy registry mode
  still requires an independent active-status confirmation.
- The extract proof records its generation date/number, page count, SHA-256,
  status basis and the actual public FNS form URL. It is one official source,
  not two independent registries. HTTPS certificate validation stays enabled.
  The hash identifies the bytes examined; the PDF signature is not separately
  cryptographically verified. The PDF and extracted personal data are not
  retained in the checkpoint. The normal public form is the only download path.
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

## Legacy registry confirmation-provider failures

With `--confirmation=registry`, FNS discovery first uses the canonical T-Bank OGRN
card. The card reader waits for the committed HTTPS document and polls
bounded company-scoped requisites, not unrelated assets. If confirmation
is unavailable, the alternative VBR search uses the same exact OGRN and
only a unique, observed, trusted company link. An explicit inconsistent
or non-active T-Bank record is not overridden by another provider. VBR
cannot serve as both discovery and independent confirmation.

The navigation budget includes the fallback. A provider is disabled for
the run after access denial, an untrusted route, or two consecutive
technical failures. Access controls are not bypassed. If both providers
are disabled, the interrupted row stays pending. The
INDEPENDENT_INN_REGISTRY_DIAG records the provider, stage, HTTP status,
allowlisted transport category, address presence and active status,
without raw exceptions, private data, or transient session tokens.

## Live validation status

The 2026-11-24 VPS probe downloaded a 174465-byte current FNS PDF for
7811285487 and Poppler successfully extracted the first pages. The known
first-page layout is covered by a fixture with a synthetic tax-section
continuation. Full-document parsing and normal name-query identity must pass the live
preflight before processing the saved queue. On 2026-11-24 the first live
run downloaded three PDFs and matched complete 29- and 17-page extracts;
one other PDF failed row-number validation. The known companies appeared
in name search but completeness was unproven. The updated preflight
separates service health from per-row uniqueness. Name search diagnostics
report counts, total proof and page flags, not company names or IDs.
The actual recovery rate and the cause of the incomplete search still
need live validation.
