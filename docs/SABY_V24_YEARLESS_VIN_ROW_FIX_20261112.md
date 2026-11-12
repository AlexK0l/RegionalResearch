# Saby v24: three-dot control still there; yearless model and VIN metadata exposed a row-count bug

## User's real Time4VPS result, November 12, 2026

The user ran a second, single-company headed Saby-only experiment
on main 7792089. Both v23 and v24 return the same structural result:

- strict private first-party H1/INN/KPP identity and canonical
  registered public identity verified, matching a single company;
- Saby advertises **220 Грузовые**;
- first verified three-dot UI interaction expands the DOM;
- raw fleet parser reports **102 rows** after one click;
- the same first-party fleet scroller reaches top=max=1893
  (3 additional movements);
- the second click is **NOT** attempted because the safety gate
  returns fleet_tail_batches.reason=tail_not_ready;
- phone 74956459818 and email avtoban@avtoban.ru remain saved;
  trucks=review, transportsAdded=0, vehiclesVerified=0, deferred=1;
- OpenAI requests=0; no Google Sheets or source JSON writes.

The user uploaded a fresh cropped 600x920 Saby fleet-panel screenshot.
At the NEW bottom (after expansion), the same gray capsule with
three blue dots is visibly located below the final SCANIA truck
model/year entry, followed by the collapsed "Автобусы 23" and
"Спецтехника 222" categories.

CRITICAL additional evidence in that screenshot:

- A legitimate row "КАМАЗ K3456" has **NO year**.
- Several real trucks have subordinate gray text lines starting
  with **"VIN:"**, and at least one has an extra registration-plate
  line, **"ГРЗ ТС:"**.
- Existing sidePanelTrucks() extracted every DOM text leaf containing
  letters as a candidate model. It could falsely treat VIN and
  registration-plate lines as **separate vehicles**.
- Existing observeSabyFleetTail() and locateSabyFleetTailClick()
  counted ONLY leaves matching "model, YYYY"; they missed valid
  yearless model rows and did not use the same inclusion rules as
  the actual collector.

Therefore the old count "102" refers to collected DOM candidate
rows, NOT necessarily 102 actual vehicles. Neither the source
announced 220 nor a 102-line parser output permits a verified fleet.

## Focused v25 fix

1. Add ONE shared fixed pattern for excluding Saby truck-row
   metadata and UI labels (VIN, ВИН, ГРЗ ТС, госномер, ПТС, СТС,
   category names, "Показать ещё" etc.). No arbitrary company/model
   names or INN-specific special cases.
2. The truck preview, side-panel collector, three-dot passive
   observer, and guarded click geometry use the SAME fixed
   exclusions (passed explicitly into Chromium DOM evaluates).
3. A model with no year, such as "КАМАЗ K3456", IS accepted as one
   real truck with year=null. A subordinate VIN/plate is NEVER
   counted as an additional truck.
4. appendSabyTruckWindow validates EVERY real model label using
   that same pattern, and rejects false 220th records created
   from VIN/plate text. Duplicate valid model/year rows remain
   independent, ordered records and are NOT deduplicated.
5. If the additional-batch guard still refuses the second click,
   its value-free last_tail sample now shows bounded numbers
   (truck model leaves and dot candidates) and booleans
   (visible gap, animation/pointer, loading status). It never
   includes raw DOM text, models, VIN, INN/KPP, phone, URLs,
   browser data, or credentials.

Everything continues to run ONLY in the one-company headed Saby
smoke with explicit --public-identity-fallback and --fleet-tail-click.
The 3-extra-click cap, per-batch stability, first-party card ID
continuity, exact 220-row completion criterion and time limits
stay unchanged.

The ordinary production Stage12 remains off; the strict original
five-sheet SAT XLSX layout, phone-only phone cells, SQLite, and
original research JSON are untouched. No paid OpenAI requests.

## One VPS acceptance after PR CI and merge

Make sure no second Chromium uses the saved authenticated profile.
Keep the existing Xvfb :99, working XDG directories and browser
binary; no restart or new browser installation.

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
  --result=/opt/regionalresearch/exports/saby-stage12-fleet-inspection-v24-20261112.json \
  --limit=1 \
  --public-identity-fallback \
  --fleet-tail-click \
  --profile=/home/regionalresearch/saby-auth-test/data/cold-profile-20261110 \
  --out=/opt/regionalresearch/exports/saby-stage12-fleet-corrected-v25-20261112.json
~~~

No screenshot flag. The genuine v24 screenshot already explains
the error; a second identical picture is unnecessary. Use a new
basename if output already exists.

If the next run reports fleet_tail_batches.status=complete,
independently inspect the v25 JSON: exactly 220 individual real
truck model/year entries, correct original company INN/KPP,
saved phone, and trucks=verified. The VIN metadata is NOT to
become a row with model "VIN: ...".

If status=incomplete, use the structured last_tail safe sample
to determine whether the next issue is missing geometry, no
visible truck category, changed row count, lack of pointer
cursor, or another specific cause. Do NOT repeat unchanged
smokes, lower the identity requirement, or assume 220 vehicles
from the category badge.
