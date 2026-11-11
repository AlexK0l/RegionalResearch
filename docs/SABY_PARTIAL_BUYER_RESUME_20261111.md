# Saby v11: successful legal identity and contacts, unverified buyer fleet

## Actual uploaded VPS JSON (2026-11-11)

The user provided `saby-stage12-post-route-v11-20261111.json`,
one single-company direct-buyer smoke for INN 7725104641.
The strict post-route identity gate passed and `contacts=collected`.
One normalized telephone (74956459818) was added without an unsupported
department; one email (avtoban@avtoban.ru) was available only as evidence
and in the existing Excel comment. **No transport was verified.**
The record reports `collection.trucks=review`,
`failed_sections=["trucks"]`, `partialResults=1`,
`transportsAdded=0` and no verified truck inventory.

The old Stage12 incorrectly wrote `verified=1`, `deferred=0`
and checkpointed this direct buyer as completed when its contact
section succeeded. This hides unresolved fleet from subsequent
checkpoint resumptions. A failure to read the truck widget is NOT a
confirmed zero fleet. Its underlying browser error is not in the
sanitized JSON, so the exact failure cause remains unknown.

## Narrow correction

- Save verified source contacts immediately (phone numbers only in the
  `Телефон` cell; departments only when explicitly visible).
- **For direct buyers**, mark the INN completed only once *both*
  `contacts=collected` and `trucks=verified` are established.
  `trucks=verified,count=0` is a valid confirmed empty fleet, but
  `trucks=review/missing` is not.
- Intermediaries and leasing companies require the contacts section
  only; their completion status does not depend on the truck widget.
- Partial buyer status remains `verified=1` for independently verified
  legal identity + the useful contact enrichment, and
  `partialResults=1` signals incomplete extraction. Unlike before,
  the INN remains in `deferredInns` and is not in `completedInns`.
- When a subsequent identity-verified attempt obtains the fleet but
  not a fresh phone widget, carry prior Saby contacts **only** for the
  same first-party detail card identifier, or the same unambiguous
  registered KPP. Different card IDs or conflicting KPPs never combine
  contacts with transport. A previously verified phone is never deleted
  from the research row on retry.
- Reconcile legacy `saby_completed_inns`: if persisted Saby evidence
  explicitly has an unresolved required section, reopen that INN and
  keep it in the checkpoint queue until verified. Do not assume that
  a legacy row with missing provenance is incomplete.
- Explicit status counters and relevant section errors stay sanitized:
  never persist raw error strings, Playwright DOM, credentials or browser
  profiles in any audit/evidence file.

No change to source JSON, Stage 1-11 discovery, paid OpenAI usage,
company inclusion policy, or the strict 5-sheet SAT XLSX layout.

## One targeted headed Saby-only VPS follow-up, after CI

Prior Time4VPS evidence (`docs/SABY_VPS_HEADED.md`) confirms the
managed `DISPLAY=:99` allows headed Chromium to expose the fleet
widget that was previously absent in headless mode. Reuse the **v11
output as input**; it already contains the verified contact evidence,
so no paid research or manual re-entry is needed.

Before the browser run, verify the managed virtual display:

```bash
sudo systemctl is-active regionalresearch-saby-xvfb
sudo -u regionalresearch env DISPLAY=:99 xdpyinfo >/dev/null && echo DISPLAY_OK
```

Ensure no parallel Chromium process uses the same saved test profile.
Run with `DISPLAY=:99`, deliberately **without** `--headless`:

```bash
sudo -u regionalresearch git -C /opt/regionalresearch pull --ff-only origin main

sudo -u regionalresearch env \
  HOME=/var/lib/regionalresearch \
  DISPLAY=:99 \
  PLAYWRIGHT_BROWSERS_PATH=/home/regionalresearch/.cache/ms-playwright \
  npm --prefix /opt/regionalresearch run saby:smoke -- \
  --result=/opt/regionalresearch/exports/saby-stage12-post-route-v11-20261111.json \
  --limit=1 --public-identity-fallback \
  --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
  --out=/opt/regionalresearch/exports/saby-stage12-fleet-headed-v12-20261111.json
```

Use a new `--out` name if it already exists; do not overwrite the
v11 file. No production site restart, full research, SQLite updates,
Google Sheets writes or OpenAI calls.

Expected possible results:
- If fleet status is `verified` (including count=0), previous
  collected contacts and current fleet can be merged ONLY for the
  same proven company/card, and the INN is marked fully completed.
- If fleet remains `review/missing`, v12 retains the previously
  verified phone, `partialResults>0` and `deferred=1`. This is a
  **correct**, honest partial result requiring a separate UI/fleet
  investigation; do not simply loop another full Saby smoke.
- If identification fails in headed mode, no new company enrichment
  or completion is granted; preserve the v11 file unmodified.

Share the sanitized terminal log and new JSON. We need to inspect
`__evidence.saby.collection`, the actual truck count and model list
only if verified, and confirm the phone cell still contains only
phone numbers and optional proven department labels.
