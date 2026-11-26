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
Incomplete whole fleets remain unresolved; only separately verified
truck data are saved on partial success. Nontruck summaries in
existing transport field and comments, no column/sheet additions.
Stage13 deterministic transport parser excludes the new Saby summary
just like the old truck summary. No assumed trailer points.
Stats fleetCategoryScope records the metric scope. The existing
matched acceptance comparison measures trucks only; do not compare
whole-fleet counts against it. Validate real category disclosure
before enabling in production. No new paid searches or VPS updates.
