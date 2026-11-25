# Independent contact enrichment

Enabled explicitly by PUBLIC_CONTACTS_ENABLED=true. No new model or paid
search budget. Stage11 now selects phone, email and leader gaps independently;
the singleton schema has the same name/INN/source requirements as batch items.
Saby includes email-missing leasing and intermediary companies even with an
existing telephone. New HTML pass before paid contacts and a remaining/new
source pass after Saby share one cumulative 350-company / 750-request /
12-minute budget by default (70% prepass, 30% reserved for later hints),
with no added pipeline stage or XLSX column.
Checkpoint version stays 1. Earlier checkpoints without these ledgers resume
normally. A completed Stage11 resume does not replay paid contact work.

HTML reads only already cited, contact-like pages or proposed official-site
hints and bounded actual same-host hyperlinks. Names and labelled INNs must
agree with the row; linked contact pages also require the same explicit
legal name. Explicit cited exact cards of supported public directories are
checked individually, not searched or crawled. No guessed emails or domains.
Phone and email ownership conflicts are held rather than blindly copied.
Only missing fields and explicitly labelled useful department numbers are
added; classification and finance are untouched. Proof includes exact page
and identity page, content hashes, field, observed excerpt, INN, date.
Contact-specific URLs are not added to the A/B/C qualification source list.
Each source attempt is recorded separately from "no contact"; an unchanged
source is not retried just because the field is still empty. A new site
hint can reopen that company. Normal resume retains the request/time budgets.

Security/limits: HTTP(S) only, no credentials/query parameters/custom ports,
public IPv4 resolved and pinned, same-host redirects only, TLS verification,
robots policy, 1 MiB body cap, 8-second HTTP request timeout, 750ms global
spacing in the service, cooldown on denial/rate limits, no browser for HTML,
no Javascript execution, no challenge or access-control bypass. Unknown
formats and ambiguous identities are deliberately not accepted. HTML parsers
are conservative; JS-only, inaccessible or nonstandard pages may not yield
contacts. Do not treat the absence of a parsed email as proof of no email.

Optional PUBLIC_CONTACTS_FNS_ENABLED=true adds a bounded official EGRUL
pass after Saby, using the existing normal public form + complete PDF
verification. Only explicitly labelled current email and uniquely scoped
executive fields are read. A separate default cap of 25 companies, one
registry browser at a time, and source failure circuit apply. Requires
pdftotext and Chromium. Default off until a real live sample is validated
and RAM availability is checked; offline fixtures are not live validation.

Saved data: npm run contacts:backfill -- --db=/absolute/checkpoints.sqlite
--checkpoint=<UUID> (dry plan); add --run for actual HTML recovery. Add
--fns or --fns-only for official extracts. --retry-unavailable reopens
source outages only. The child uses the original export-compatible phase
and source mode, saves after each company, never supersedes/overwrites the
parent, and keeps an in-progress marker. Re-run on that child to resume.
CLI budgets are per invocation, not the production study's paid budget.
Do not run standalone browser/HTTP backfill concurrently with research on
a small VPS. Existing authenticated download endpoints serve the child.

Current scope: already cited HTML, actual linked corporate pages, selected
cited directory cards and opt-in official extracts. New source discovery
still uses existing bounded OpenAI search. Maps, uncited directory search,
procurement PDF parsing, JS-only contact pages and guessing contacts are
not automated by this release. No claim of live coverage or guaranteed
yield until measured on actual regional data.
