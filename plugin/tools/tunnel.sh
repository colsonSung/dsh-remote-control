#!/usr/bin/env bash
#
# Put the relay's phone-facing port on the public internet, and tell the
# plugin about it. After this, the QR code in Settings -> Remote Control
# carries a public URL and the phone works from any network.
#
#   ./tools/tunnel.sh            # start a tunnel and set the public address
#   ./tools/tunnel.sh --stop     # stop the tunnel and clear the public address
#
# Two tunnel backends are tried, in order:
#   1. cloudflared  (a stable, well-known path: brew install cloudflared)
#   2. localhost.run over SSH     (no installation, random URL per run)
#
# For a stable URL of your own, deploy the relay on a VPS instead and put its
# address into "Relay server" in the settings page.
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$HERE/.." && pwd)"
STATE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/${DSH_PROFILE:-desktop}}"
STATE_FILE="$STATE_DIR/plugins/remote-control.json"
LOG_FILE="${TMPDIR:-/tmp}/dsh-remote-tunnel.log"

stop() {
  pkill -f "cloudflared tunnel --url" 2>/dev/null || true
  pkill -f "localhost.run" 2>/dev/null || true
  node "$HERE/set-public-address.js" >/dev/null 2>&1 || true
  echo "tunnel stopped, public address cleared"
}

if [ "${1:-}" = "--stop" ]; then
  stop
  exit 0
fi

if [ ! -f "$STATE_FILE" ]; then
  echo "no plugin state at $STATE_FILE — start the Harness with the plugin once first" >&2
  exit 1
fi

# The relay listens on the first free port of the plugin's range.
PORT=""
for candidate in $(seq 56131 56150); do
  if lsof -nP -iTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; then
    PORT="$candidate"
    break
  fi
done
if [ -z "$PORT" ]; then
  echo "no relay port found (56131-56150) — turn Remote Control on in the settings page first" >&2
  exit 1
fi
echo "relay port: $PORT"

URL=""
if command -v cloudflared >/dev/null 2>&1; then
  echo "starting a cloudflared quick tunnel…"
  (cloudflared tunnel --url "http://localhost:$PORT" >"$LOG_FILE" 2>&1 &)
  for _ in $(seq 1 30); do
    URL="$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG_FILE" | head -1 || true)"
    [ -n "$URL" ] && break
    sleep 1
  done
else
  echo "cloudflared is not installed — falling back to localhost.run (random URL per run)"
  (ssh -o StrictHostKeyChecking=no -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
       -R "80:localhost:$PORT" -R "443:localhost:$PORT" nokey@localhost.run >"$LOG_FILE" 2>&1 &)
  for _ in $(seq 1 30); do
    URL="$(sed -e 's/\x1b\[[0-9;]*m//g' "$LOG_FILE" | grep -oE "https://[a-z0-9.-]+\.(loca\.lt|lhr\.life)" | head -1 || true)"
    [ -n "$URL" ] && break
    sleep 1
  done
fi

if [ -z "$URL" ]; then
  echo "the tunnel did not report a URL — see $LOG_FILE" >&2
  exit 1
fi

echo "tunnel url: $URL"
node "$HERE/set-public-address.js" "$URL"
echo
echo "open Settings -> Remote Control and turn the switch on; the QR code now"
echo "carries $URL and the phone can reach it from any network."
echo "stop it again with: $0 --stop"
