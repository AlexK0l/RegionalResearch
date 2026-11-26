# Real-source category coverage follow-up
The user's 2026-11-26 screenshot and actual HTML of РусФиш show
two vehicles: Легковые PEUGEOT PARTNER VP 2023 and Коммерческие
PEUGEOT BOXER 2024. No Грузовые tile. Prior truck-only test missed
this actual fleet. Two manually checked cards lack a fleet widget.
No widget does NOT establish zero vehicles.
Real HTML has 2 real summary items and 11 measurement clones with
invisible-tile-item-* keys. Separate side menu total "2 всего".
Exact widget/category/counter/model selectors, real keys, and total
reconciliation. No raw HTML or account data committed.
New SABY_ALL_VEHICLE_CATEGORIES_ENABLED=true flag for a fresh
contact-first cursor, default false, existing strict tree gate.
Legacy cursor stays truck-only. Small complete fleets require one
DOM read; larger category inventories use the existing tree and
footer protocol generalized to exact categories. No inferred zero,
no conversion of passenger/vans to trucks. Full JSON stores
whole-fleet evidence separately; existing truck evidence retained.
Incomplete whole fleets remain unresolved; complete individual categories
are saved separately with their own observation dates and carried only
when the new reconciled count still matches. Never synthesize a verified
whole fleet from different visits. New contradictory observations reopen
the whole-fleet gap. Existing complete small-fleet reads avoid scrolling.
Full reads may use the exact bounded profile scroller to reveal a lazy
summary, whereas quick reads never scroll. Nontruck summaries in
existing transport field and comments, no column/sheet additions.
Stage13 deterministic transport parser excludes the new Saby summary
just like the old truck summary. No assumed trailer points.
Stats fleetCategoryScope records the metric scope. The existing
matched acceptance comparison measures trucks only; do not compare
whole-fleet counts against it. Validate real category disclosure
before enabling in production. No new paid searches or VPS updates.


## Targeted live functional check
Use the existing private matched cohort file (no new paid research, no
new full-region plan). With the same clean checkout and exclusive stopped
service guard as the existing benchmark, run:
node --expose-gc --max-old-space-size=512 --env-file=/opt/regionalresearch/.env scripts/saby-fleet-acceptance.js --run --vehicle-probe --select-inns=1000012304,1000002634,1000001542 --idle-confirmed --cohort=/private/previous-cohort.json --out=/private/category-probe.json
Exactly the three selected rows and one positive truck control from the
same saved cohort. The selector fails if a requested company is absent;
it does not silently substitute. The expected manual observations:
1000012304 has two vehicles, one in each of Легковые and Коммерческие.
The other two had no displayed fleet widget; unknown is allowed, never
invented zero. The truck control must preserve the original exact
model/year multiset. A changed source fact requires review. Report is
private, model/year facts stay out of journal. Read the report rather
than comparing incompatible truck-only vs all-category metrics.
This targeted probe does NOT establish regional speed improvement.
