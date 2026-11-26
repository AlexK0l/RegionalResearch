# Live follow-up: category summary visibility and hydration (2026-11-26)

PR163's four-company live probe completed with four unknown whole fleets.
Its positive truck control preserved two exact vehicles. The two manual
no-widget controls remained unknown. The nontruck positive had an exact
heading in both full attempts, but the new summary reader returned missing.
Manual browser diagnostics then confirmed one visible exact widget, one
navigation total (2), two direct real tiles, visible inner containers,
and matching model titles. Do not change selectors or remove the
independent total/identity proof on that evidence.

The legacy heading-readiness check is not a proof that summary tiles and
the navigation counter have mounted. On a full visit ONLY after the existing
exact heading is found, retry a missing summary at most three times with
350ms passive waits. No extra navigation, clicks, scroll, repeated whole
cohort, or relaxed identity/category/count/model checks. No wait in quick
contact reads; do not change the old truck-only path.

Emit [SABY_VEHICLE_SUMMARY_DIAG] for the all-category full reads with INN,
initial/after_heading phase, fixed reasons and capped structural counts.
Do not print raw DOM, model strings, IDs, URLs or exceptions. Distinguish
route rejection, missing/nonunique widgets/navigation/counters, invalid
category/total reconciliation and evaluate errors. The actual rejection
cause on the VPS is not established until the new live trace is available.
The feature stays default off. Reuse the existing private cohort and
select only the known nontruck positive; the CLI adds the existing truck
positive control automatically. Prior no-widget controls need not be
revisited for this diagnostic; no new regional or OpenAI work.
