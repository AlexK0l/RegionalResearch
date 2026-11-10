# Saby on Time4VPS: headed Chromium on a managed Xvfb display

## Verified behavior (2026-11-10)

- Linux Chromium with `--headless`: automatic sign-in and INN identity verification worked, but the contractor detail did not show either contact or fleet widgets.
- The same account, browser cache and company in headed Chromium with `DISPLAY=:99` extracted both a phone and fleet data (`contactUpdates:1`, `transportUpdates:1`).
- Therefore this VPS should use headed Chromium on the virtual X display. VNC is only a debugging aid, not a runtime dependency.
- If the required widgets do not render, Stage 12 must defer the company rather than incorrectly recording a completed Saby enrichment.

## Installation on the already configured VPS

Do not run the one-time `install.sh` again. Make sure no research is running and download completed outputs before restarting.

1. Stop the manually started debug-only processes (not while another Playwright run is using the display):

```bash
sudo -u regionalresearch pkill -x x11vnc || true
sudo -u regionalresearch pkill -x Xvfb || true
```

2. Install the managed display and the optional backend drop-in:

```bash
sudo install -m 644 /opt/regionalresearch/deploy/time4vps/regionalresearch-saby-xvfb.service /etc/systemd/system/regionalresearch-saby-xvfb.service
sudo install -d -m 755 /etc/systemd/system/regionalresearch.service.d
sudo install -m 644 /opt/regionalresearch/deploy/time4vps/regionalresearch-saby-xvfb.conf.example /etc/systemd/system/regionalresearch.service.d/saby-xvfb.conf
sudo systemctl daemon-reload
sudo systemctl enable --now regionalresearch-saby-xvfb.service
sudo systemctl is-active regionalresearch-saby-xvfb.service
sudo -u regionalresearch env DISPLAY=:99 xdpyinfo >/dev/null && echo DISPLAY_OK
```

Before the backend restart, verify that the installed Playwright Chromium browser is at `/home/regionalresearch/.cache/ms-playwright` on **this host**. The supplied drop-in sets `PLAYWRIGHT_BROWSERS_PATH` to that location because the base service used a different `HOME`. Adjust it if your browser cache lives elsewhere. The drop-in explicitly sets `DISPLAY=:99` and `SABY_HEADLESS=false` for the backend, overriding those values in `.env`.

Xvfb has `-nolisten tcp` and restarts after failure. No SSH tunnel, VNC service, X11 TCP listener or open inbound port is required in production.

3. Keep `SABY_STAGE12_ENABLED=false` until a new Saby-only smoke succeeds:

```bash
cd /opt/regionalresearch
sudo -u regionalresearch env HOME=/home/regionalresearch DISPLAY=:99 SAT_PYTHON_BIN=/opt/regionalresearch/.venv/bin/python SAT_XLSX_TEMPLATE_PATH=/opt/regionalresearch/data/SAT_reference_template.xlsx npm --prefix /opt/regionalresearch run saby:smoke -- --inn=6027087063 --name='ООО «Дорстройсервис»' --limit=1 --xlsx
```

This smoke does not call OpenAI, does not change the source research JSON or SQLite and creates separate JSON/XLSX files. Inspect evidence and workbook before rollout. Do not run the smoke CLI simultaneously with a production research that uses the same Saby browser profile.

4. For a cautious rollout set `SABY_STAGE12_ENABLED=true` and `SABY_MAX_COMPANIES=1` in `/opt/regionalresearch/.env`. After active studies end, restart and verify:

```bash
sudo systemctl restart regionalresearch
sudo systemctl is-active regionalresearch regionalresearch-saby-xvfb
curl -fsS http://127.0.0.1:10000/health
```

Increase the limit only after checking evidence, contacts, truck inventory and the strict XLSX. Stop/debug via `journalctl -u regionalresearch` if the browser cannot start.

## Rollback

Set `SABY_STAGE12_ENABLED=false`, restart the backend when safe. To fully disable the virtual display, remove the optional backend drop-in, reload systemd, and stop/disable the `regionalresearch-saby-xvfb` service. Never delete `.env`, SQLite, Saby browser profiles or research artifacts.
