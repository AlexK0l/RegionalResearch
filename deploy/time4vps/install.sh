#!/usr/bin/env bash
# One-time bootstrap for fresh Ubuntu/Debian; does not start paid research.
set -euo pipefail
APP_USER=regionalresearch
APP_HOME=/var/lib/regionalresearch
APP_DIR=/opt/regionalresearch
[[ "$(id -u)" -eq 0 ]] || { echo "Use sudo/root" >&2; exit 1; }
. /etc/os-release
case "$ID" in
  ubuntu|debian) ;;
  *) echo "Only Ubuntu/Debian supported by this script" >&2; exit 1 ;;
esac
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg git python3 python3-venv python3-pip sqlite3 caddy
node_ok=0
if command -v node >/dev/null; then
  major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
  if [[ "$major" =~ ^[0-9]+$ ]] && [[ "$major" -ge 22 ]]; then node_ok=1; fi
fi
if [[ "$node_ok" != 1 ]]; then
  script="$(mktemp)"
  trap 'rm -f "$script"' EXIT
  curl -fsSL https://deb.nodesource.com/setup_22.x -o "$script"
  bash "$script"
  apt-get install -y nodejs
fi
node --version
npm --version
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$APP_HOME" --shell /usr/sbin/nologin "$APP_USER"
fi
mkdir -p "$APP_HOME/backups" "$APP_DIR"
if [[ ! -d "$APP_DIR/.git" ]]; then
  if [[ -n "$(ls -A "$APP_DIR")" ]]; then
    echo "Refusing to overwrite existing non-git directory $APP_DIR" >&2; exit 1
  fi
  git clone --branch main --single-branch https://github.com/AlexK0l/RegionalResearch.git "$APP_DIR"
fi
mkdir -p "$APP_DIR/data" "$APP_DIR/logs" "$APP_DIR/exports"
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$APP_HOME"
chmod 700 "$APP_HOME/backups"
(cd "$APP_DIR" && runuser -u "$APP_USER" -- env HOME="$APP_HOME" npm ci)
if [[ ! -x "$APP_DIR/.venv/bin/python" ]]; then
  runuser -u "$APP_USER" -- python3 -m venv "$APP_DIR/.venv"
fi
runuser -u "$APP_USER" -- "$APP_DIR/.venv/bin/python" -m pip install --disable-pip-version-check 'openpyxl==3.1.5'
if [[ "$(printenv INSTALL_CHROMIUM || true)" == "1" ]]; then
  (cd "$APP_DIR" && ./node_modules/.bin/playwright install-deps chromium)
  runuser -u "$APP_USER" -- env HOME="$APP_HOME" \
    PLAYWRIGHT_BROWSERS_PATH="$APP_HOME/.cache/ms-playwright" \
    "$APP_DIR/node_modules/.bin/playwright" install chromium
fi
if [[ ! -f "$APP_DIR/.env" ]]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
fi
install -m 644 "$APP_DIR/deploy/time4vps/regionalresearch.service" /etc/systemd/system/regionalresearch.service
install -m 644 "$APP_DIR/deploy/time4vps/regionalresearch-backup.service" /etc/systemd/system/regionalresearch-backup.service
install -m 644 "$APP_DIR/deploy/time4vps/regionalresearch-backup.timer" /etc/systemd/system/regionalresearch-backup.timer
systemctl daemon-reload
echo "Base setup complete. Paid research NOT started."
echo "Next: read $APP_DIR/deploy/time4vps/README.md, upload .env and Excel template,"
echo "then run check-ready.sh, enable regionalresearch.service and configure Caddy."
