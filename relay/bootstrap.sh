#!/usr/bin/env bash
#
# Install the DeepSeek Harness remote-control relay on a Debian/Ubuntu VPS.
#
#   curl -fsSL <this-file> | sudo bash -s -- --domain rc.example.com
#
# It installs Node.js 22 when missing, creates a `dsh-relay` service account,
# writes a systemd unit, obtains a Let's Encrypt certificate through certbot,
# and puts nginx in front of the relay. The relay token is printed at the end —
# paste it into the Harness under "Settings → Remote Control → Relay server".
#
set -euo pipefail

DOMAIN=""
EMAIL=""
PORT="8080"
RELAY_TOKEN=""
INSTALL_DIR="/opt/dsh-relay"

usage() {
  cat <<'USAGE'
usage: bootstrap.sh --domain <host> [--email <addr>] [--port <port>] [--token <secret>]

  --domain   public hostname of the relay, e.g. rc.example.com (required)
  --email    address for the Let's Encrypt account (default: admin@<domain>)
  --port     port the relay listens on (default: 8080)
  --token    shared secret; generated when omitted
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --token) RELAY_TOKEN="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [ -z "$DOMAIN" ]; then
  echo "error: --domain is required" >&2
  usage
  exit 1
fi
EMAIL="${EMAIL:-admin@$DOMAIN}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------- prerequisites
if ! command -v node >/dev/null 2>&1; then
  log "installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version

if ! command -v nginx >/dev/null 2>&1; then
  log "installing nginx and certbot"
  apt-get update -y
  apt-get install -y nginx certbot python3-certbot-nginx
fi

# --------------------------------------------------------------------- payload
log "installing the relay into $INSTALL_DIR"
mkdir -p "$INSTALL_DIR/src"
cp "$(dirname "$0")/server.js" "$INSTALL_DIR/server.js"
cp "$(dirname "$0")/src/relay-server.js" "$INSTALL_DIR/src/relay-server.js"
cp "$(dirname "$0")/src/relay-protocol.js" "$INSTALL_DIR/src/relay-protocol.js"
cp "$(dirname "$0")/package.json" "$INSTALL_DIR/package.json"

id dsh-relay >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin dsh-relay
chown -R dsh-relay:dsh-relay "$INSTALL_DIR"

cd "$INSTALL_DIR"
npm install --omit=dev --no-audit --no-fund

if [ -z "$RELAY_TOKEN" ]; then
  RELAY_TOKEN="$(openssl rand -base64 32 | tr -d '\n')"
fi

# --------------------------------------------------------------------- systemd
log "writing the systemd unit"
cat > /etc/systemd/system/dsh-relay.service <<UNIT
[Unit]
Description=DeepSeek Harness remote-control relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dsh-relay
Group=dsh-relay
WorkingDirectory=$INSTALL_DIR
Environment=RELAY_TOKEN=$RELAY_TOKEN
Environment=RELAY_PUBLIC_URL=https://$DOMAIN
Environment=PORT=$PORT
Environment=HOST=127.0.0.1
ExecStart=/usr/bin/node $INSTALL_DIR/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=$INSTALL_DIR

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now dsh-relay
systemctl --no-pager --lines=5 status dsh-relay || true

# ----------------------------------------------------------------------- nginx
log "configuring nginx for $DOMAIN"
cat > /etc/nginx/sites-available/dsh-relay <<NGINX
map \$http_upgrade \$connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 80;
  listen [::]:80;
  server_name $DOMAIN;

  location / {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$connection_upgrade;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
  }
}
NGINX

ln -sf /etc/nginx/sites-available/dsh-relay /etc/nginx/sites-enabled/dsh-relay
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# ----------------------------------------------------------------------- tls
log "requesting a certificate for $DOMAIN"
certbot --nginx --non-interactive --agree-tos --email "$EMAIL" --redirect -d "$DOMAIN" || {
  echo "certbot failed — the relay is reachable over http://$DOMAIN only" >&2
}

cat <<DONE

relay is running

  url     https://$DOMAIN
  token   $RELAY_TOKEN
  service systemctl status dsh-relay

Next: in the Harness open Settings -> Remote Control, put the url into
"Relay server" and the token into the relay's RELAY_TOKEN, then turn
Remote Control on. The QR code will carry https://$DOMAIN/<device-id>/?rc=1
DONE
