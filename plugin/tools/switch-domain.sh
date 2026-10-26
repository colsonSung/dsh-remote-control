#!/usr/bin/env bash
#
# Switch the remote-control relay to your own domain, end to end.
#
#   ./tools/switch-domain.sh rc.hyacinthml.cn
#
# 1. waits until the hostname resolves to this machine's public address,
# 2. asks the server to issue the certificate, rewrite nginx, and point the
#    relay's advertised URL at the new name,
# 3. points the Harness plugin at the new relay,
# 4. verifies the public access link.
#
# The DNS record itself is added in the domain provider's console: an A record
# for the hostname pointing at the server's public IP.
#
set -euo pipefail

HOST="${1:?usage: switch-domain.sh <hostname>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$HERE/.." && pwd)"
SSH_TARGET="${DSH_RELAY_SSH:-aliyun-hyacinth}"
RELAY_URL="https://$HOST"
STATE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/${DSH_PROFILE:-desktop}}"
STATE_FILE="$STATE_DIR/plugins/remote-control.json"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

log "waiting for $HOST to resolve"
for _ in $(seq 1 120); do
  IP="$(dig +short "$HOST" A | head -1 || true)"
  if [ -n "$IP" ]; then
    log "$HOST -> $IP"
    break
  fi
  sleep 5
done
IP="$(dig +short "$HOST" A | head -1 || true)"
if [ -z "$IP" ]; then
  echo "!! $HOST does not resolve yet — add the A record and run this again" >&2
  exit 1
fi

log "switching the relay on the server"
ssh -o ConnectTimeout=20 "$SSH_TARGET" "/opt/dsh-relay/switch-domain.sh $HOST"

log "pointing the Harness plugin at the new relay"
python3 - "$STATE_FILE" "$RELAY_URL" <<'PY'
import json, sys, pathlib
path = pathlib.Path(sys.argv[1])
state = json.loads(path.read_text())
state['relayUrl'] = sys.argv[2]
state['publicAddress'] = ''
path.write_text(json.dumps(state, indent=2) + '\n')
print('relayUrl ->', state['relayUrl'])
PY

log "verifying the public link"
DEVICE_ID="$(python3 -c "import json;print(json.load(open('$STATE_FILE'))['deviceId'])")"
KEY="$(python3 -c "import json;print(json.load(open('$STATE_FILE'))['accessKey'])")"
LINK="$RELAY_URL/$DEVICE_ID/?rc=1&from=dsh_desktop&k=$KEY"
echo "    $LINK"
CODE="$(curl -sk -o /dev/null -w '%{http_code}' "$LINK")"
echo "    index status: $CODE"
if [ "$CODE" = "200" ]; then
  log "the new address works"
else
  echo "!! the relay is reachable but the device is not registered yet — start Remote" >&2
  echo "   Control in the Harness and reload this page" >&2
fi
