# Stage 12 full-card sweep

The measured primary search + ownership proof costs 27.61 s per visit
(201 Tatarstan visits). Reopening cards for separate region-wide contact,
finance and fleet passes repeats that cost.

Enable SABY_FULL_CARD_PASS_ENABLED=true for the new full_card_v3 strategy.
New installs using .env.example opt in; an existing .env needs this explicit
flag. The existing Saby scope and category options are unchanged. For an
all-commercial/all-category deployment retain their true settings.

* First full visit: exact-INN/legal identity verification, contacts first,
  full financials and full required vehicle inventory. Missing contacts do
  not block other requested sections. The same card ownership safeguards
  remain; separate readiness waits and the complete fleet collector apply.
* Second pass: only gaps with an unused attempt. A missing widget/partial
  vehicle inventory is not verified zero or completion. No repeated
  collection of a complete section; preserve verified facts.
* Each requested section gets at most two visit attempts, even on failed
  identity/search. All unresolved facts remain deferred. Completion of the
  finite sweep does not assert 100% data coverage.

## Checkpoints

Only an explicitly opted-in unfinished legacy cursor migrates. Preserve its
planned INNs, original attempt keys, stats, verified rows, scope/category
settings, and accumulated timings. Old contact passes consume contact
attempts only; quick detail observations never consume full attempts.
Legacy full detail and retry keys plus explicit v2 combined detail masks
seed the per-section visit budget. Fold an unspent contact retry into a
remaining first full details visit where possible.

The v3 cursor retains the legacy keys and stores new per-visit section
masks in full_card_attempts. It is persisted before acquiring Chromium.
Restart/pause/rotation restores the exact masks and bounded budgets;
disabling the flag cannot downgrade a pinned v3. Missing/contradictory
masks fail closed. A finished legacy cursor is not reopened implicitly.
Explicit Saby-only continuation of an exhausted v3 may plan a NEW sweep
under the existing rules, but a memory resume never resets its cursor.

New v3 pass indexes are 0..2, old indexes 0..4. Admission checkpoint
summary and Saby-only continuation share the cursor's own phase count.
No database schema, pipeline version, paid budgets or dependencies change.

The initial full visit can take longer than a contact-only visit; compare
elapsed time to finish the ENTIRE region and actual verified phone, email,
revenue, employees and complete fleet coverage, not contact-pass speed.
Offline tests check scheduling/ownership invariants, not live Saby speed.
Warm catalog history is still independently disabled by default.
