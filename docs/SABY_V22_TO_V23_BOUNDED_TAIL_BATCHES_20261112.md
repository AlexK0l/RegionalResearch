# Saby: proven 40 -> 102 fleet rows, bounded continuation to 220 (v23)

## Real Time4VPS result from v22 (2026-11-12)

The user updated to main e2ecdb9 and ran a headed one-company
Saby-only test. The strict first-party private+registered-public
company identity proof passed. Its Saby fleet announces 220 trucks.

A real first-party click on the stationary, pointer-cursor three-dot
capsule beneath the final truck row expanded the DOM list:
40 -> 102 actual model/year entries, +62. The scrollbar also
expanded: before top=max=523; after top=523, max=1893. The first
102 truck rows were proven to retain the original 40-row prefix.

The user-uploaded v22 JSON independently confirms unchanged phone
74956459818 and email, contacts collected, truck collection review,
vehiclesVerified=0, transportsAdded=0, deferred=1. Nothing was
invented, no OpenAI/Google Sheets calls, no original JSON modifications.

## Bounded opt-in v23 implementation

Only for explicit headed, single-company Saby-only smoke with BOTH
--public-identity-fallback and --fleet-tail-click:

1. After the first click reveals a strictly verified >40 prefix,
   move the actual truck-row scroll container to its NEW bottom,
   reading every intermediate window and verifying sequence continuity.
2. At the new bottom, independently re-check the complete current
   prefix, original card ID, first-party legal identity, same exact
   220-truck category count and the real three-dot geometry.
3. Passively observe the three dots twice 11 seconds apart; require
   an unchanged model-row count, a pointer cursor, exactly 3 dots,
   no animation or loading indicator, and no conflicting gap controls.
4. Execute no more than ONE verified dot click per round; read the
   freshly expanded list, preserving the original complete prefix
   and all duplicate model/year rows as separate vehicles.
5. Bound the continuation to THREE more clicks after the first
   (four total), <=48 new scroll moves, <=20 per round, and an
   85-second phase deadline. Stop immediately if the card changes,
   the list skips/replaces rows, any invalid model/year appears,
   or any tail control is ambiguous.
6. Only exactly 220 real, ordered, individually parsed model/year
   entries allow completion. 102, 164 or 186 rows still require
   deferred=1 with phone/email preserved.

The existing failure diagnostic gains a value-free object named
fleet_tail_batches: fixed status/reason, rows_before, rows_after,
extra_clicks, additional_scroll_moves, rounds, tail_checks and
last_click_status. Never log raw DOM, model names, phone/email,
company ID, URL, or credentials.

The production Stage12 (without explicit flags), original source
JSON/SQLite, paid research, five-sheet Excel layout and phone
format remain unchanged.

## One bounded follow-up on the same VPS, after CI/merge

Ensure the saved Saby profile is not in use by another Chromium.
Keep the established Xvfb :99 and private writable XDG paths.

~~~bash
sudo -u regionalresearch git -C /opt/regionalresearch pull --ff-only origin main
sudo -u regionalresearch git -C /opt/regionalresearch rev-parse --short HEAD

sudo -u regionalresearch env \
  HOME=/var/lib/regionalresearch \
  DISPLAY=:99 \
  XDG_CONFIG_HOME=/home/regionalresearch/.config/regionalresearch-saby \
  XDG_CACHE_HOME=/home/regionalresearch/.cache/regionalresearch-saby \
  PLAYWRIGHT_BROWSERS_PATH=/home/regionalresearch/.cache/ms-playwright \
  npm --prefix /opt/regionalresearch run saby:smoke -- \
  --result=/opt/regionalresearch/exports/saby-stage12-fleet-tail-click-v22-20261112.json \
  --limit=1 --public-identity-fallback --fleet-tail-click \
  --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
  --out=/opt/regionalresearch/exports/saby-stage12-fleet-batches-v23-20261112.json
~~~

Use a fresh --out basename if any output file already exists.
No new screenshot or paid full-region research is needed.

## Interpretation

If deferred=0 and transportsAdded=1, inspect the v23 JSON itself:
correct independently verified INN/KPP, original contact phone/email,
trucks collection verified, truck count 220, exactly 220 real records
with model/year fields, no altered final Excel structure.

If fleet_tail_batches reports incomplete with rows_after <220,
do not treat partial rows as a complete truck inventory. Check the
reported stop reason and number of clicks before any further code
change. A replaced/noncontiguous list is never silently accepted.
If one more batch is needed beyond the bounded click limit, do not
raise the limit without reviewing actual evidence. Production
experimental fallback remains OFF until separately approved.
