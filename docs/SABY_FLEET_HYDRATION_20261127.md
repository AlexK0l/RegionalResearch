# Fleet hydration optimization from the 20 live visits after #173

The reported 20 visits yielded two fully reconciled vehicle fleets, 13
partial inventories and five missing/unresolved outcomes. In all 20 the
initial summary was not uniquely available. The visible menu recovered
the summary on 15 visits. Very large positive fleet counts consumed
60.7, 101.7 and 85.8 seconds, but only completed category inventories
were retained. The logs do not establish why each category stopped.

* Full production visits can try the existing exact menu recovery before
  repeating passive summary scans, with no second speculative click.
* An already opened drawer has one shared category hydration loop. Each
  pending category is read once per round; ready categories proceed
  immediately. 20 no-progress rounds replace 20 per category. A ready
  category may reveal or hydrate another; re-read before spending a
  further passive wait. The existing overall 175-second deadline and
  strict model/count/group/prefix/route checks are retained.
* Read only the exact validated group-key children/footer instead of
  traversing every vehicle in every other group on every page evaluation.
* A temporary list remount after one successful footer click may recover
  within the original polling window. Contradictions and changed card
  fail closed, and no new click occurs while remounting.
* Log a privacy-safe SABY_FLEET_CATEGORY_TIMING for each attempted group,
  including expected count, actual rows, stop reason, reads/clicks and
  elapsed time. No raw model labels, keys, URL or credentials are logged.
* No change to proof requirements, row data, attempt ledger, skip policy,
  old partial merge semantics or browser/paid request concurrency.
  Explicit SABY_SHARED_FLEET_HYDRATION_ENABLED=false restores old
  per-category hydration and menu ordering. The DOM scope optimization
  and bounded remount handling are independent correctness improvements.

Offline fixtures demonstrate the reduction from 76 waits to 19 for four
unavailable categories. Production speed and the actual causes of
incomplete large lists still require live category telemetry. No missing
group is considered zero; previously verified categories cannot be
promoted to a complete fresh fleet merely because a later count agrees.
