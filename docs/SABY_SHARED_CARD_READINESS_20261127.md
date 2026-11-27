# Share passive hydration during full-card Stage 12

Live sample after deployment of #169: 13 visits, mean 31.34 s per visit
(median 29.62, max 59.34), plus mean 2.32 s checkpoint. Four saved-card
hits and nine full searches. The search_card_ms average of 18.02 s is
over ALL 13 visits (zeros for saved hits), so full-search visits average
about 26.03 s. Passive readiness averaged 6.06 s, maximum 16.39 s; fleet
5.29 s, finance 0.40 s and contacts 0.16 s. These are mixed section
masks, not a matched before/after throughput experiment.

The full-card scheduler remains unchanged. Its old collector gave each
requested section a fresh passive wait of up to seven seconds, even
though all widgets belong to the same freshly verified SPA card. The new
collector starts one monotonic seven-second window at identity proof.
Contacts wait/read first; finance and fleet can use the remaining time.
A later section ALWAYS gets a fresh guarded visibility read even after
the deadline. Fleet readiness now follows contact overlay closure. It
uses the installed Playwright's visible locator filter (with legacy
lookup fallback), never a guessed selector or cached data.

Do not interpret the passive deadline as a missing-data verdict. Full
financial scroll/hydration recovery and exact fleet heading/summary/tree
recovery remain intact, including all count and company continuity
guards. The bounded second pass still retries unresolved sections.
No change to search timeout, legal identity proof, visit attempts,
category scope, per-company checkpoint, memory admission or billing.
The only intentionally shorter waiting is redundant passive time
between sections of one full-card visit. A slow/virtualized widget may
still need active recovery or the next visit. Offline tests cannot prove
live coverage or acceleration.

SABY_SHARED_CARD_READINESS_ENABLED defaults to true for full-card only;
explicit false restores the independent readiness windows on a normal
safe service restart. Do not restart an active study just to compare
modes. Monitor actual complete fleet/phone/finance coverage and total
region time. ready_contacts_ms, ready_financials_ms and ready_fleet_ms
are subdivisions of ready_ms, not additional elapsed time. Existing
cumulative timings remain; compare new individual SABY_SECTION_TIMING
records rather than mixed old totals.
