# Public GIR BO revenue backfill

After completing both FNS open-data archives, the saved study contains 608
rows, 463 with INN and 370 with staff figures. There are 74 unresolved rows
with archive candidates (23 have one distinct INN, 28 have an MSP candidate
in region 47, two match a saved OGRN, zero have an exact observed locality
match). Archive overlap is not source-row identity evidence. Preserve the
candidate sidecar; do not repeat the archive scans or assign name-only INNs.

This independent supplemental pass instead fills missing numeric revenue for
eligible rows with existing unique valid legal-entity INN and registered name.

The public search and report-list JSON response shape was inspected on
2026-11-25 at the public bo.nalog.gov.ru website. It is an undocumented
frontend interface, not the paid REST subscription. Exact known routes:
advanced-search/organizations/search (query, page=0, size=20), and
nbo/organizations/{id}/bfo/. The annual period is type 12, revenue field is
financialResult.current2110 (OKUD 0710002), not gainSum alone, total income,
net profit or a previous-year value. The live JSON projection had no unit.
A PDF returned through an external retrieval path had different identifiers
from the requested report; this does not establish an origin-server defect,
but it illustrates why the PDF is independently checked before conversion.

The parser requires exact unique search INN, valid OGRN and compatible
saved OGRN, registered full/short name, report and correction identifiers,
matching INN/KPP in the report structures, latest annual period up to the
specified year, published correction and standard KND. It downloads the
corresponding official PDF and uses pdftotext -layout to verify the cover's
INN/KPP, extraction number (KND, INN, year, correction), explicit thousand
rubles unit and exact line 2110, including current/previous-year columns.
No filename-only proof, no null-to-zero conversion, no guessed units,
no use of an annual record for a different company. Unsupported layouts
remain in review. The PDF fixtures are synthetic based on observed
public report structure; real PDF layout and VPS network behavior still
require validation. The hash records downloaded bytes, not signature
verification.

The standalone command is offline by default; explicit --run makes a new
child checkpoint. Existing numbers, staff/contacts, FNS archive candidates,
other financial evidence and export layout stay unchanged. Save after every
row and leave the active row pending on a transport failure. Stop on denial,
throttling or repeated unrecognized proof layouts. No access bypass, paid
API, redirects, parallel requests or broad name search. Bounded JSON/PDF
memory, timeouts and minimum request spacing. Proven revenue is stored in
whole rubles, with period, source and PDF hash in evidence and comment.

    node scripts/girbo-backfill.js --db=/absolute/checkpoints.sqlite --checkpoint=<UUID> --year=2025
    node scripts/girbo-backfill.js --db=/absolute/checkpoints.sqlite --checkpoint=<UUID> --year=2025 --run

Use the child checkpoint from GIRBO_DONE when continuing; the completed
rows are not repeated for the same report-year ceiling. GIRBO_PROGRESS
and GIRBO_DONE report aggregate counts only. No personal data or PDF files
are persisted. This is not yet integrated into the main pipeline.
