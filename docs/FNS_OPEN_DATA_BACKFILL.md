# Official FNS open-data batch enrichment

The v3 live FNS form run processed 144 pending/reopened rows with zero new
INNs; 145 rows remain missing identifiers. Do not repeat broad name queries.
The VPS confirmed HTTP 200 for the annual headcount ZIP (93,127,783 bytes),
MSP ZIP (2,169,961,249 bytes) and both official XSDs; free disk was 4.2 GiB.

Official dataset passports:
- https://www.nalog.gov.ru/opendata/7707329152-sshr2019/
- https://www.nalog.gov.ru/opendata/7707329152-rsmp/

The annual dataset contains scoped taxpayer and headcount records; the MSP
roster contains legal entity identifiers and registered region/locality parts.
MSP is not a complete EGRUL register. For July-December releases, MSP staff
figures refer to the previous calendar year; January-June to the year before.
Do not infer revenue or treat missing data as zero employees.

Each ZIP is downloaded once into a private temporary directory, SHA-256
recorded, scanned in bounded blocks directly inside ZIP members, and deleted
before the next download. No full extraction or nationwide database.
Maintain at least 2 GiB disk reserve for a local archive. If the initial
disk-reserve check fails, a bounded HTTP Range reader can use the same
official ZIP directly without saving the whole file. This requires a
real 206 response and a stable strong ETag; every block must have the
exact requested Content-Range and the same representation. Read XML
members in physical order, hash every byte of the full archive (including
non-XML members and directory metadata), bound memory to a small block
cache, and keep the same ZIP CRC, XML and provenance checks. If the
origin does not support validated ranges, fail explicitly and preserve
the previous checkpoint. No TLS relaxation, reduced disk reserve or
deletion of unrelated files. Reject nonofficial redirects, unknown
schema declarations, oversized or encrypted members, unsafe XML and corrupt
archives. XSD declaration checking is not full XSD validation. Validate
actual scoped records and legal-entity checksums independently. Unsupported
records are counted and skipped. A failed source is explicit and another
successful source may still produce a new child. Offline fixtures model
documented XML shapes; the November data and live Python TLS are not yet tested.

Example (pin release URLs from the current official passports):

    node scripts/fns-open-data-backfill.js --db=/absolute/checkpoints.sqlite --checkpoint=<UUID> --year=2025

    node scripts/fns-open-data-backfill.js --db=/absolute/checkpoints.sqlite --checkpoint=<UUID> --year=2025 --sshr-url=https://file.nalog.ru/opendata/7707329152-sshr2019/data-20261025-structure-20200408.zip --rsmp-url=https://file.nalog.ru/opendata/7707329152-rsmp/data-10112026-structure-12052026.zip --run

Default is offline plan. Explicit --run creates a NEW immutable child.
Fill missing numeric employee counts only for a unique existing valid INN,
strict registered name, no identity conflict, and consistent official
headcount. Prefer the dedicated annual dataset if figures agree.
Keep existing values, revenue, contacts, Saby evidence and Excel layout.
Exact name/OGRN archive matches for unresolved companies are stored in a
bounded candidate-only sidecar. National name hits and same-region hits
have separate caps, so common nationwide names cannot hide local matches.
A single-source retry retains candidates from other successful sources of
the same report year. MSP region/locality is a priority signal,
not proof that no namesake exists. Never populate an INN from a name hit
or import finance into an unresolved company. A separate confirmation
step must prove source-row linkage. Do not retain personal records.
No OpenAI, Saby, paid API or other browser requests.

FNS_OPEN_DATA_DONE reports child UUID, actual employee additions, candidate
coverage, overflow and failed datasets. A partial-source completion exits 2
but retains successful work. Failed downloads leave the original unchanged.

### First live result (2026-11-25)

The annual headcount scan successfully processed 2,145 XML members and
1,931,395 legal records, with no invalid documents or count mismatches.
It added 11 headcounts (249 -> 238 missing) and retained candidates for
72 of 106 eligible unresolved rows, 23 with overflow. The MSP source was
not downloaded: the 2 GiB free-space reserve correctly blocked it. Resume
from the new child with only the MSP URL; do not re-download the annual
archive or repeat the old name search. Range support has been tested
against synthetic, strictly validated HTTP responses, not yet on the
actual FNS origin. Previous staff values remain untouched.

### Live range interruption and bounded block recovery

The next VPS run proved actual FNS HTTP Range support with a stable strong
ETag and validated ranges through at least 536,870,912 bytes. A later
range returned fewer bytes than promised (FNS_RANGE_TRUNCATED), stopping
the source before any child was saved. The received length alone does not
establish the underlying network/server cause.

Transient truncation, incomplete reads, connection interruption, timeout
and selected temporary HTTP errors now retry only the affected logical
block. A failed range is discarded, a smaller exact range is requested,
and complete subranges are retained in memory. Every response retains the
same strong ETag and exact range validation. No malformed response, changed
representation, throttling, Retry-After or certificate failure is treated
as a retryable body error. Retry backoff is bounded (up to five retries per
logical block and 48 per archive, plus request/byte budgets). Logs report
range offsets and retry counts, not document contents. No whole-archive
retry is automatically initiated. The final SHA-256 still covers the
entire archive, and partial scans are not saved. The previous annual-data
child remains the resume point. Synthetic fixtures verify identical full
hash/scan after interruptions, smaller ranges, persistent-failure bounds,
and immediate rejection of changed representation or throttling. Actual
recovery of the remaining large FNS ZIP still requires a live run.

### One scan for several saved regions (batch mode)

Pass repeated `--checkpoint=<UUID>` options (up to six distinct parents)
to the same command. Use only stable saved results, not active research
snapshots. Default remains a read-only plan. With explicit `--run`, each
specified release is downloaded/range-read and scanned **once** for the union
of requested INNs, OGRNs and names. The combined target set is capped at
4,000 keys (including regional pairs); split larger batches. Each region/name
pair has its own 24-hit cap so a national or different-region overflow cannot
hide a local result. No nationwide database, retained ZIP or new provider.
The existing archive/hash/schema/disk/HTTP/range safeguards remain.

Each parent is reread and fingerprint-checked before applying; if its
payload changed, it is skipped explicitly. A successful parent receives
its own immutable child under a new UUID. The original identity/finance
proof rules and candidate-only behavior apply independently to each parent,
even when the same INN appears in different regions. Only compact plans are
retained while scanning, and each parent payload is loaded separately.
Source errors do not erase previously saved children. No service restart
or automatic scan inside a research job. Run the explicit batch procedure
only when the VPS has sufficient idle resources.

Example (first plan with real saved UUIDs, then add release URL and --run):

    node scripts/fns-open-data-backfill.js --db=/opt/regionalresearch/data/checkpoints.sqlite --checkpoint=<UUID1> --checkpoint=<UUID2> --year=2025
