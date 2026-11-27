# Saby full-card navigation and repeat-search optimization

- Production full-card jobs default to the observed history return (explicit
  SABY_REUSE_CATALOG_HISTORY_ENABLED=false opts out). At most two back
  operations within 2.5 seconds, same verified card and known UI state
  only; three failures disable history for that browser Page. The existing
  exact INN search, fresh detail verification, browser serial lease,
  pacing, cold fallback and rotation remain. No extra persistent tab.
- The observed normal local=false card URL is now valid as a navigation
  hint; local=true, duplicate/unknown parameters, wrong ID are rejected.
  Old stored-card fallback uses the same strict allowlist. It is not
  ownership proof. Before warm search, pre-existing exact target input or
  candidates cause cold fallback before submitting.
- A hard independent source-name rejection may be reused within one
  company visit only, for the same INN/KPP/source name. No positive
  identity proof, temporary error or title mismatch is cached.
- A new optional scoped-empty proof recognizes exact visible empty labels
  only inside one explicitly labelled company search or selected Companies
  tab surface. It requires a pre-query nonempty baseline, current exact
  input, two stable unblocked samples, finished successful exact-INN XHRs
  and no fresh candidates. An unidentified layout, old empty message,
  ambiguous surface, global spinner, incomplete transport or ordinary
  zero-row review never establishes this proof. No private API call.
  After 3s the proof may end the 18s poll; only this new attestation can
  skip the redundant same-sweep retry. It is persisted with the source
  name and committed attempt, but does not close data gaps, prove company
  liquidation or set fleet to zero. A new explicit sweep can try again.
- Show a provisional upper bound on retry queue size, distinct from all
  unresolved gaps. Log history attempt/hit/fallback, scoped empty hits,
  public rejection reuse in per-visit timings. Prior committed visits
  and section masks survive unchanged, and uncertain failures remain
  retryable according to the existing budgets.

The supplied screenshot proves the global-search visible label and normal
card URL, not the accessible structure of every production catalog or
history behavior. Unknown layouts fall back; live savings and coverage
must be measured before claiming a 10–15s visit. No earlier uncertain
empty result can be upgraded from logs alone. No missing widget is treated
as proven absent data.
