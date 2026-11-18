# Saby search/navigation hardening, 2026-11-18

## Evidence (Time4VPS)
Chromium self-test passed, `regionalresearch` and
`regionalresearch-saby-xvfb` were active; `DISPLAY=:99` was reachable.
The full Leningrad Stage12 attempt nonetheless saw:
- `locator.fill` / `locator.press` 6000ms timeouts while accessing the
  same list search field, including after it had been detected as visible;
- one `page.goto(... company-list-prof)` timeout at 45000ms;
- a separate 45-truck card with 3 preview rows, unable to open a verified
  full fleet panel, left `trucks=pending`;
- `SABY_CIRCUIT_OPEN` after three consecutive systemic failures among
  nine attempts. Do not confuse that guard with a completed regional sweep.

## Changes
- `openCompany` waits for navigation **commit**, not `domcontentloaded`
  and independently polls for a safe input on the exact Saby company
  *list* route. Redirects to sign-in/other pages are refused.
- Search selects only a visible, enabled **and editable** field with
  allowed type; readonly/credential/multiple ambiguous inputs remain
  blocked.
- If the selected Wasaby field detaches or fails Playwright actionability
  checks during fill or Enter, at most **one** retry runs a fresh safe
  selection on the same list route. There is no blind page keyboard
  fallback, no guessed field, and no user input or exception text in
  retry logs.
- If both attempts fail, the company remains deferred, the systemic
  error counter still increments, and the original circuit breaker
  remains active. The source/parent SQLite checkpoint is never rewritten
  by Saby-only continuation.

## Scope and limitations
This mitigates known search input and navigation timeouts, but does
**not** assert that full fleet panels are now readable. A full fleet
remains unverified unless every vehicle is independently observed in
the same registered company tree. Saby UI/network performance and
the true root of missing fleet panels still require a **single,
controlled headed browser smoke** on the VPS with no active production
Saby job or conflicting browser profile.

## Rollout
1. Wait for GitHub CI, back up SQLite and ensure no research job is
   running before restarting the Node service.
2. Update `main` and restart only when safe, then verify `/health`.
3. Run at most **one** Saby headed smoke against an already vetted firm
   (same verified profile), without OpenAI or full research.
4. Review `SABY_SEARCH_RETRY`, `SABY_SEARCH_DIAG`,
   `SABY_FLEET_DIAG`, `SABY_CIRCUIT_OPEN`, and the smoke JSON.
5. Only after a stable smoke and an explicit choice of continuation
   should the remaining regional Saby-only queue run. A long sweep is
   guarded by a circuit breaker, deadline and per-company checkpoints.
