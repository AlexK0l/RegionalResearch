# Saby: comparison of default headless, new-headless and headed Chromium

## Why

On the same Time4VPS VPS, Playwright default headless confirmed the Saby
legal entity but did not display contacts/fleet. Headed Chromium under Xvfb
successfully extracted both. In Playwright, default Chromium headless uses
a separate headless shell; setting channel to "chromium" enables new headless
using the full browser. Therefore comparing three modes is necessary
before concluding Saby always requires a virtual display.

## Run without touching the production application

Use the existing test worktree and its previously authenticated test profile.
Do not run a production Stage 12 job with the same profile concurrently.
The backend and SQLite are not involved. This runs 3 real Saby company
lookups and uses no OpenAI/Google API.

    cd /home/regionalresearch/saby-auth-test
    sudo -u regionalresearch env HOME=/home/regionalresearch DISPLAY=:99 \
      npm --prefix /home/regionalresearch/saby-auth-test run saby:diagnose -- \
      --inn=6027087063 --name='ООО «Дорстройсервис»' \
      --profile=/home/regionalresearch/saby-auth-test/data/headless-profile

The command runs, sequentially:

1. headless_shell: Playwright default, separate Chromium headless shell
2. headless_chromium: Playwright new headless, channel="chromium"
3. headed_chromium: full browser with DISPLAY=:99, without visible monitor

The saved JSON report contains only route fingerprints (SHA256 of host,
path and query key names), API response codes, response sizes/hashes, boolean
presence markers for contacts/fleet and browser DOM flags. Network bodies,
raw paths, query values, headers, cookies, email addresses, phones, company
names and raw page contents are NOT saved. Endpoints may be invoked with
different inputs/identities across sessions, so body hashes are only a
comparison hint, not a guarantee that information is equal.

Run the network comparison as an investigation; it does NOT alter the
production browser flag or Stage 12. All profile launches are sequential
to avoid Chromium profile locking.

### Reading the result

- If headless_chromium extracts contacts/fleet while headless_shell fails,
  the strongest supported cause is the default headless-shell implementation.
  Run a separate free Saby smoke with SABY_BROWSER_CHANNEL=chromium
  and --headless before considering changing VPS production settings.
- If both headless modes fail while headed succeeds, compare DOM flags and
  XHR/fetch statuses. It may be an interface behavior difference, browser
  presentation feature, access restriction, or timing. Do not claim a
  specific cause from zero contacts alone.
- If HTTP endpoints exist in headed but not headless, compare the hashed
  route IDs and response markers to locate the missing API/request chain.
- If both receive the same responses but UI flags differ, investigate
  browser rendering/DOM rather than new API searches.
- If websocket frames differ, inspect WebSocket traffic privately instead
  of assuming XHR covers all Saby data.

Output JSON path is printed at the end. Share only the generated JSON
report, not Saby cookies or .env.

### Optional private screenshots

Pass --screenshots if the safe network report is not sufficient. PNGs
are written with mode 0600 next to the JSON. They may contain personal
information, phone numbers and session UI; inspect and redact them locally
before sharing. Do not upload them to GitHub.

## Production safety

Keep SABY_STAGE12_ENABLED=false until a stable solution is verified.
Do not re-authenticate repeatedly, and do not attempt to bypass CAPTCHA,
SMS verification or access controls. Keep the working headed + Xvfb
configuration as a fallback.
