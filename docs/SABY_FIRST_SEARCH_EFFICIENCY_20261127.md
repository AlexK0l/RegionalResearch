# First-pass Saby search efficiency (2026-11-27)

The live Tatarstan log measured 201 first-pass visits. Mean time to obtain a
verified card or review: 27.61 s. Catalog navigation 0.63 s, hydration 6.80 s,
baseline DOM 0.42 s, submit 4.00 s, candidate scans 3.08 s, search polling
2.54 s, card scans 1.11 s, card polling 4.31 s, alias proof 2.22 s, and
post-route proof 2.08 s. 152 identities verified, 49 not verified:
27 unconfirmed zero results, 18 unverified legal names, two ambiguous and
two no unique result. The 257 cumulative visit cursor had no saved-card hits:
the first contact pass is not a repeat-card workload.

## Safe reductions

- Fuse the second hydration lookup with the mandatory submission lookup.
  Initial lookup, 1.4 s settle, pre-query baseline, fresh safe lookup
  (same <=3 s bound as the old second lookup), fill and Enter. Never carry
  a locator across hydration. Route rechecked after fresh lookup, before fill.
  Existing action retry and all result / ownership / fleet gates remain.
- Cache geometry, visibility and rendered text in each synchronous DOM
  scan, not across polls, while keeping candidate order, thresholds,
  branch rules, caps and ambiguity rejection unchanged.
- Component telemetry distinguishes initial field wait, settle, field
  lookup, fill, press, action-retry wait, and catalog history outcomes.
  These are nested times, not extra elapsed time.

## Optional warm history experiment

SABY_REUSE_CATALOG_HISTORY_ENABLED defaults to false. Only an exact
previously verified detail route, opened from the exact first-party list,
can request a bounded one-use browser history return. Verify the actual
list URL; otherwise use the normal cold navigation before submitting a
query. Do not skip hydration, baseline, exact-INN result or legal
ownership checks. If initial hydration fails on the warm route, fall back
before dispatching a query. A session-scoped first-party socket tracker
lets the exact-INN observer see retained WebSockets. A socket is not
identity evidence. Never reuse saved browser URLs as fresh proof.

Offline tests establish invariants, not real-site speed. Do not turn on
warm history until a small matched live comparison using the existing
authorized profile shows equal or better identity/phone coverage and
lower time; do not interrupt the current Tatarstan sweep or start a
parallel Saby browser for this. Compare verified successes and review
causes separately. Do not shorten the 18 s search / card windows or turn
unconfirmed zero results into absence. No changes to Saby cursor, fleet
categories, finance rules, checkpoints, queue, auth, dependency or
production settings.
