# Stage12: recover missing INNs and avoid redundant Saby query reloads

The last Karelia audit had 60 direct buyers excluded from the Saby
queue and 189 uncertain zero-search events. Vologda had 75 excluded
direct buyers. Those counts do not prove all rows have valid INNs or
that all uncertain searches were lost due to one network problem.

## Search changes (normal production fallback)

Install the existing first-party search transport observer before list
navigation, because Wasaby can establish its WebSocket during page
hydration. Do not count any frames or HTTP requests until the current
exact INN is about to be submitted. Preserve the exact-token checks,
one permitted silent-query recovery, and strict candidate/card proof.
Do not reload when first-party 401/403/429 is observed. This is a
conservative pacing guard, not a bypass or a company-absence conclusion.
Stop the observer in finally, including failed hydration/navigation.
A final zero search is still uncertain without appropriate evidence;
re-scan once after the existing 500ms two-sample wait to catch a late
valid candidate. Check text before geometry for unrelated message nodes.

## Optional official INN preparation

`SABY_INN_RECOVERY_ENABLED=false` by default. Enable only after real
FNS VPS acceptance. A new full study (or late resume before the first
valid Stage12 cursor) may recover missing INNs from the already qualified
rows using the existing independent FNS search and official PDF extract
proof. No extra OpenAI requests. Require a successful known-company
canary, precise identity evidence, unique INN ownership, canonical IDs,
and existing safe registry rules. No assignment from a name alone.
The default navigation budget is 3000 per preparation launch.
The public browser uses the same exclusive browser admission reservation;
close it and release before GIRBO/Saby. No parallel extra Chromium.
Prior per-row outcomes and the mutated result are checkpointed before the
Saby plan is frozen; no completed paid stages are rerun. Terminal registry
failure leaves unresolved INNs explicit, and normal Saby can continue.
Cancellation, cooperative memory pause and storage errors propagate.
No old checkpoint mutation; the existing standalone independent-INN
child CLI remains unchanged for historical sources. Saby-only
continuations still use the existing verified row list (no automatic
registry preparation in that mode).

Existing registry policy covers exact supported company legal names, not
arbitrary brands, disputed/nonempty identifiers, IPs or ambiguous owners.
The stage is optional because real FNS availability and conversion have
not been established for these regions. No changes to Excel structure,
A/B/C, Stage13 scoring or API costs. Offline fixture tests do not prove
actual Saby speedup or registry yield. Do not update an active VPS.
