#!/usr/bin/env bash
# Preflight only; never starts research or prints API credentials.
set -euo pipefail
APP_DIR=/opt/regionalresearch
ENV_FILE="$APP_DIR/.env"
[[ "$(id -u)" -eq 0 ]] || { echo "Run as root" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "Missing .env" >&2; exit 1; }
[[ "$(stat -c %a "$ENV_FILE")" == "600" ]] || { echo "chmod 600 required for .env" >&2; exit 1; }
[[ -r "$APP_DIR/data/SAT_reference_template.xlsx" ]] || { echo "Missing Excel template" >&2; exit 1; }
node --env-file="$ENV_FILE" -e '
for (const key of ["OPENAI_API_KEY","API_ACCESS_TOKEN"]) {
  const value=String(process.env[key]||"").trim();
  if (!value || value.includes("your_openai_key_here") ||
      (key==="API_ACCESS_TOKEN" && value.length<32)) {
    console.error("Invalid or missing "+key);
    process.exitCode=1;
  }
}
if (process.env.BIND_HOST!=="127.0.0.1") {
  console.error("Set BIND_HOST=127.0.0.1 behind Caddy");
  process.exitCode=1;
}
const count=Number(process.env.MAX_ACTIVE_FULL_JOBS||2);
if (!Number.isFinite(count) || count<1 || count>10) {
  console.error("MAX_ACTIVE_FULL_JOBS must be within 1..10");
  process.exitCode=1;
}
'
runuser -u regionalresearch -- test -r "$APP_DIR/data/SAT_reference_template.xlsx"
runuser -u regionalresearch -- test -w "$APP_DIR/data"
runuser -u regionalresearch -- test -w "$APP_DIR/logs"
runuser -u regionalresearch -- "$APP_DIR/.venv/bin/python" -c 'import openpyxl'
echo "Preflight passed: credentials present, private loopback bind, template, Python, storage."
