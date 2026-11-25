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
Maintain at least 2 GiB disk reserve. Reject nonofficial redirects, unknown
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
