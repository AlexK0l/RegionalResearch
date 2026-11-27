# Saby navigation efficiency: 27 November 2026

From the supplied production journal (52 Tver details_retry timing
records), 28 saved-card hits averaged 2.53s for navigation/identity
and 20.60s total visit; the 24 remaining records averaged 34.67s for
navigation (including unsuccessful saved-card attempt if present)
and 40.40s total visit. Four of those 24 tried a saved URL and missed.
These are observational, nonmatched groups, not a guaranteed speedup.
The 75 Tatarstan first-contact records all used full search; average
navigation/identity 26.01s, average full visit 28.58s.

Reuse validated private-card hints for legacy section cursors as well
as optimized cursors, even when no widget supplied usable data.
Preserve the route observed immediately after identity proof, not a
later widget route. Never replace an existing conflicting card ID/KPP
or store an unknown query parameter. Reopening a hint still requires
fresh scoped INN and name proof, otherwise full search. No new identity
acceptance path, no changes to attempts, budgets, section coverage,
time limits, pacing, or cursor semantics. A missing widget is still
missing. No new operator flag required.

The DOM scanner memoizes exact-INN predicates for a single synchronous
read. For validated digit tokens it rejects unrelated raw text before
normalization/layout; the same boundaries, geometry, visibility,
branch/ambiguity rules and caps are retained. Cache never spans polls.

New SABY_SEARCH_COMPONENT_TIMING log breaks down catalog navigation,
hydration, baseline read, submission, candidate scans, poll wait,
card verification, public alias and post-route proof. Nested in the
existing visit timing; sum is not the total due to other operations.
Only counts and elapsed milliseconds. Existing timing and result
schema unchanged apart from the internal navigation hint.

Live full-region improvement has not been measured. Validate during
the next ordinary production study; no need to repeat already paid
discovery or run an extra large Saby sweep.
