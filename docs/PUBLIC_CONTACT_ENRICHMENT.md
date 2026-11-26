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


## Phone-first follow-up

All missing-phone rows now precede email/leader-only rows in the paid and
public-source queues, with A/B/C preserved within each cohort. Saby sorts
phone gaps first within the existing fresh/retry fairness boundaries.
Stage11's existing bounded individual retry allowance is applied to
source-attributed primary answers with no phone, before secondary batches;
omitted phone results retain their separate recovery pass. No web/cost
limit is increased. Retry IDs and used allowance survive checkpoint resume.
A second query cannot overwrite previously found email/leader, and all new
phone claims still pass the existing global ownership check.
The HTML reader also accepts a complete visible number in a separate cell
immediately after a standalone telephone label, never masked digits.

Run saved-data recovery with --phone-only --run to read only companies
without phones from already cited public HTML. It writes a new checkpoint,
adds only phone values and their provenance, and keeps a separate
public_phone_backfill_outcomes ledger. Do not combine with --fns:
EGRUL is not a telephone source. With no --run the same flag is dry plan.
Track CONTACT_PHONE_COVERAGE at Stage11/final and phone_coverage_before/after
in backfill output. A generic successful contact lookup (email or director)
is no longer used as the measure of phone coverage.

Baseline from the saved Leningrad-region JSON on 25 Nov 2026:
608 commercial rows; 228 have phones, 380 do not; 252 of the latter have
an INN (245 legal-entity and 7 twelve-digit records), 128 lack one.
Saby reported 91 added phones. Among the 252 missing-phone rows with INN,
219 have no saved Saby evidence and 33 have it. Two collected Saby
numbers already belong to other rows and remain withheld.
This is a saved-data observation, not a live test or a promise of yield.

## Retaining actual paid contact source URLs

A valid Stage11 answer may contain a specific contact or directory page even
when no official website or phone was returned. Save eligible cited and
phone-recovery URLs separately as public_contact_source_hints (maximum eight).
They are only untrusted candidate URLs, not new qualification evidence or
confirmed contacts. A late continuation can recover these hints from an
existing version-2 primary-results ledger by unique exact canonical ID.

The public HTML pass can start from a second explicitly cited contact page
on the same corporate host, without inventing a link. The selected URL
signature includes this second seed, so a new same-host source can reopen a
previously attempted company. The existing three-host, five-attempt-per-host,
request/time/company limits, exact name/INN proof, actual link requirement
for cross-page ownership, robots and safe HTTP rules stay unchanged. Each
public directory card remains isolated. No new paid search allowance.

A completed phone-only retry without a number also retains its cited URLs
as hints, without changing contact status or inflating recovered-phone counts.
