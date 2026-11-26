# Follow-up to PR162 matched 12-company acceptance
PR162 d52244a measured 785088ms / 27 visits / 10 full searches /
3 positive fleets / 6 vehicles, against 887982ms / 33 visits /
12 searches / same fleets and facts on 50018b7. Original 6791f1e
was 833096ms / 2 positive fleets / 4 vehicles. No new originally
unknown fleet was found. The original baseline-only two additional
emails remain an unresolved difference, not deletion of source facts.

The VPS per-INN log audit shows 18 full collection attempts across
9 unresolved contractors: 12 missing fleet heading attempts (6
companies), 6 missing truck preview attempts (3 companies). All
18 attempts still had unknown advertised truck count, not proven zero.
Two heading recoveries stopped at scroll step 3 with recovery_unavailable;
that does not prove the scroll wrapper detached, but this is a known
Wasaby behavior in finance and a bounded same-selector retry is safe.
Two legal alias cards spent repeated 20+ seconds proving identity
and one also spent ~9.5s on a saved-route miss. Do not weaken identity.

Fix a real collector blind spot: an already-open, exact first-party
same-company Wasaby vehicle drawer can be structurally readable even
if the geometry-based summary tile cannot be parsed. Discover a
positive count ONLY from the unique exact truck category in the
already observed unique drawer/list; validate the discovered rows,
then require an independent fresh read with identical count/category
and ordered prefix using the existing full semantic collector. No
blind click, no invented zero, no relaxed identity or model validation,
no extra full pass. Retain existing bounded preview and heading
recovery. No claim that the three missing-preview companies actually
had such a drawer: their supplied reduced audit omitted the panel
visibility and category flags. This is a guarded recovery, not live
acceptance proof. At most one positive-count full tree collection per
visit, unchanged strict footer disclosure controls.

Next action: read the already existing detailed fleet DOM diagnostic
flags from the v162 journal for three missing-preview contractors.
If the real drawer/category was not observed, obtain one authorized
manual view of the exact company's fleet heading/drawer, including
the categories and counts; no raw VIN/plate, full HTML, account
information or secrets in GitHub. Do not rerun the matched cohort.
Do not interpret a missing truck category as zero or confuse a
truck-only parser with all vehicle-category coverage.
