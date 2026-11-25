# Public GIR BO revenue backfill

The standalone pass fills missing revenue for eligible rows with an existing
unique valid legal-entity INN and registered name. No discovery, Saby, OpenAI
or paid API; preserve all existing numeric values, other fields and FNS
archive candidate evidence. Source checkpoints are immutable.

## Live evidence and revised default (2026-11-25)

The first VPS run scheduled 131 of 296 missing-revenue rows, completed
zero rows and stopped with GIRBO_HTTP_UNAVAILABLE on its third request.
The two preceding JSON requests succeeded and produced an annual candidate;
the third request was the PDF fetch. The previous code discarded the exact
transport cause, so the PDF HTTP status/redirect is not known. No revenue
was written. Do not repeat the same PDF-dependent mass run.

The public search and report-list JSON response shapes were inspected at
bo.nalog.gov.ru. The official 2025 card at organizations-card/4294939
shows line 2110 as 204955838 in thousands of rubles; the live search bfo
gainSum and report financialResult.current2110 both match that amount,
year, annual type 12 and correction 2. This is evidence for the normalized
unit, not a company-specific exception in the algorithm. FNS explicitly
states the ordinary reporting unit in:
- https://www.nalog.gov.ru/rn11/news/activities_fts/16604859/ (2025)
- https://www.nalog.gov.ru/rn38/news/activities_fts/9684221/ (earlier forms)

Default confirmation=json checks exact unique search INN, valid OGRN,
compatible saved identity, registered full/short name, active legal entity,
standard KND 0710099/0710096, latest annual type 12 up to the requested
year, published correction, linked report identifiers and INN/KPP, then
requires BOTH JSON projections to agree on the annual period, form,
correction number/dates and explicit current line 2110/gainSum.
If the search summary is absent, mixed-period, different, unpublished,
or the figures disagree, leave the row in review. Never convert null to
zero or infer a scale from magnitude. Convert verified thousands of rubles
to integer rubles. The two endpoints are projections of the same official
source, not independent registries. This mode does not claim to have
downloaded a PDF; it saves the structured evidence and its projection
SHA-256, the search/report URLs and FNS unit basis. The hash is not a
signature or hash of the full HTTP body.

Public frontend routes (undocumented, may change):
advanced-search/organizations/search?query=...&page=0&size=20
nbo/organizations/{id}/bfo/

The original explicit --confirmation=pdf remains available for a separate
review pass. It additionally checks cover identity, period, correction,
unit and exact current/previous 2110 from pdftotext -layout. It requires
Poppler. Neither mode follows redirects or bypasses access restrictions.
The new GIRBO_HTTP_DIAG logs request stage, HTTP status or safe transport
code, without outputting company identifiers or report contents.

    node scripts/girbo-backfill.js --db=/absolute/checkpoints.sqlite --checkpoint=<UUID> --year=2025
    node scripts/girbo-backfill.js --db=/absolute/checkpoints.sqlite --checkpoint=<UUID> --year=2025 --confirmation=json --run

Default is offline plan; --run creates a new child, saves every row, stops
on denial, throttling, transport failure or repeated unrecognized source
shape. Completed rows are not repeated in the same mode/revision/year.
Other financial and contact fields and the workbook layout remain unchanged.
No new PDF dependency for JSON mode. Actual structured-mode yield on the
VPS still requires validation. This remains a standalone supplemental pass,
not yet integrated into the full pipeline.

## Production integration

Live structured-mode run on 2026-11-25 finished all 131 eligible records:
64 verified revenue additions, 67 review, 230 public HTTP requests, no
OpenAI/Saby calls, no pending records. Missing revenue fell from 296 to 232.
Review: 32 no exact INN, 17 report identity unproven, 9 structured identity
unproven, 9 no usable line 2110. Do not replay the same completed queue.

GIRBO_STAGE_ENABLED=true explicitly activates the validated JSON algorithm
before Saby in new full studies and late/Saby-only continuations. Finance
runs independently even when Saby is disabled on a full or late study. No
new company discovery or paid work is triggered. The existing stage-12
checkpoint callback persists verified revenue and the outcome ledger per
row. Resume skips same-mode/revision/year completed rows. Browser reconnects
with the same result do not rerun this finance pass. A transport stop leaves
pending records and does not prevent the following Saby/priority stages.
Cancellation and storage failures propagate. The Saby browser time budget
is separate in full studies; the Saby-only outer job still has its total cap.

The public HTTP collector is shared by CLI and production. Within a process
one request at a time, at least 1500 ms between starts; cooldown on denial,
transport failure or rate limiting, including Retry-After. Per-study default
300 companies / 600 requests / 15 minutes. The cooldown is in process memory,
not a distributed cross-process lock: do not run standalone finance and live
research simultaneously against this source. No redirects or aggressive
retries. Stage settings default off for existing deployments until explicitly
enabled. Archive-based employee/INN discovery remains a standalone pass;
a full national archive must not be downloaded independently by every study.
