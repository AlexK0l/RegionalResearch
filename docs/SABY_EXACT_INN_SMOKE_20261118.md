# Exact-company Saby smoke (2026-11-18)

## Why the previous smoke was misleading

On the VPS, the operator computed the `--offset` of INN
`7727218041` using `sabyEligibleRows(result).eligible`. However,
`runSabyStage12` first creates the pending queue and moves previously
attempted Saby rows to the end, so an offset into the original eligible
array does **not** address the same company.

The old smoke reported one successful verified 10-truck fleet, but the
generated JSON proves that this was AO Vyborgteploenergo
(INN `4704062064`). AO Azot-Vzryv (INN `7727218041`) remained
`contacts=collected, trucks=review`, with no verified fleet.

## Fix

`npm run saby:smoke` accepts `--target-inn=7727218041` only when
`--result=<existing JSON>`, `--limit=1` and `--offset=0` are set.
Before launching Playwright it looks for exactly one INN in the three
commercial sections, verifies the same eligibility policy as Stage12,
and creates an isolated copy containing just that row.

The private source JSON and checkpoint SQLite remain unchanged.
Smoke output is explicitly marked `saby_smoke_selection.mode=exact_inn`,
records `target_inn` and `target_section`, and contains **only one**
commercial company. This output is for diagnosis, **not** a replacement
for the full regional export.

## Command for Leningrad Azot-Vzryv

Run only with no other Saby browser job using the same persistent
profile. A single smoke uses zero OpenAI calls:

```bash
cd /opt/regionalresearch
sudo -u regionalresearch git pull --ff-only origin main

sudo -u regionalresearch env \
  HOME=/home/regionalresearch \
  DISPLAY=:99 \
  PLAYWRIGHT_BROWSERS_PATH=/home/regionalresearch/.cache/ms-playwright \
  npm run saby:smoke -- \
    --result=/opt/regionalresearch/exports/leningrad-corrected-20261118.json \
    --target-inn=7727218041 \
    --limit=1 \
    --public-identity-fallback \
    --fleet-tail-click \
    --out=/opt/regionalresearch/exports/saby-azot-exact-20261118.json
```

Check the initial `[SABY_SMOKE_TARGET]` line and the resulting JSON
before interpreting `checked` or `vehiclesVerified`. Use a new
output file name; the script refuses to overwrite existing files.

The 45-vehicle fleet is **not** independently confirmed until its
`__evidence.saby.trucks.status=verified` and count exactly match the
full collected vehicle array. If still incomplete, inspect the
allowlisted `SABY_FLEET_DIAG` and fix that separate interaction
rather than relaxing count, identity, or route safety gates.
