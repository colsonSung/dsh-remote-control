# Remote Control relay

The relay is the public half of DeepSeek Harness *Remote Control*. The Harness
on your computer dials **out** to this relay, the relay replays your phone's
HTTP traffic back through that tunnel, and the phone ends up loading the real
Harness web app. Your computer never opens an inbound port.

```
phone ──HTTPS──▶ relay (this) ──WebSocket──▶ Harness on your computer
```

## What a real deployment looks like

On an Alibaba Cloud Linux / Debian server with a domain, this is the whole
setup (it is what `bootstrap.sh` automates):

```bash
# 1. Node.js 22
curl -fsSL -o node.tar.xz https://nodejs.org/dist/v22.21.0/node-v22.21.0-linux-x64.tar.xz
tar -xf node.tar.xz -C /usr/local --strip-components=1

# 2. the relay
mkdir -p /opt/dsh-relay/src && cd /opt/dsh-relay
cp server.js package.json . && cp src/*.js src/
npm install --omit=dev
useradd --system --no-create-home --shell /sbin/nologin dsh-relay
chown -R dsh-relay:dsh-relay /opt/dsh-relay

# 3. systemd
cat > /etc/systemd/system/dsh-relay.service <<UNIT
[Unit]
Description=DeepSeek Harness remote-control relay
After=network-online.target
[Service]
User=dsh-relay
WorkingDirectory=/opt/dsh-relay
Environment=RELAY_TOKEN=<the plugin's secret>
Environment=RELAY_PUBLIC_URL=https://<the public origin>
Environment=PORT=8080
Environment=HOST=127.0.0.1
ExecStart=/usr/local/bin/node /opt/dsh-relay/server.js
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl enable --now dsh-relay

# 4. nginx + TLS (the relay stays on loopback)
certbot certonly --webroot -w /var/www/certbot -d <the public origin>
# then a vhost: proxy_pass http://127.0.0.1:8080 with Upgrade/Connection headers
```

**The public origin must be its own hostname** (`rc.example.com`), not a path
under an existing site: the Harness web app loads its assets and opens its
event socket with relative URLs under the device directory, so a dedicated host
keeps every request on the relay. A path prefix works too, as long as nothing
else on that origin claims `/assets/` or `/api/`.

**Without a domain** you can use a wildcard DNS name that resolves to the
server's address, for example `rc.101-133-229-162.sslip.io` (sslip.io and
nip.io answer any `*.sslip.io` name with the matching IP). Let's Encrypt issues
a certificate for it, and the relay is reachable at
`https://rc.101-133-229-162.sslip.io`.

## Install it on a VPS (recommended)

On a Debian/Ubuntu server with a domain pointing at it:

```bash
git clone <this repo> dsh-relay && cd dsh-relay
sudo ./bootstrap.sh --domain rc.example.com --email you@example.com
```

The script installs Node.js 22 when missing, writes a `dsh-relay` systemd unit,
puts nginx in front of the relay and obtains a Let's Encrypt certificate. It
prints the relay token at the end.

Then, in the Harness: **Settings → Remote Control → Relay server**, paste
`https://rc.example.com`, press *Use relay*, and turn Remote Control on. The
QR code and the access link now point at the public relay.

`bootstrap.sh` flags: `--domain` (required), `--email`, `--port` (default
8080), `--token` (generated when omitted).

## Run it

```bash
npm install
RELAY_TOKEN="$(openssl rand -base64 32)" \
RELAY_PUBLIC_URL="https://rc.example.com" \
PORT=8080 node server.js
```

| Variable | Meaning |
| --- | --- |
| `RELAY_TOKEN` | **required** — the shared secret the Harness presents |
| `RELAY_PUBLIC_URL` | the URL a phone opens (defaults to `http://localhost:<port>`) |
| `PORT` / `HOST` | listen port (8080) and bind address (`0.0.0.0`) |
| `TLS_CERT` / `TLS_KEY` | PEM files; when both are set the relay serves HTTPS |
| `RELAY_LOG=debug` | per-request logging |
| `RELAY_STATE` | where the phone list is persisted (default `/var/lib/dsh-relay/state.json`) |

Then, in the Harness: **Settings → Remote Control → Relay server**, paste
`https://rc.example.com`, and press *Use relay*. The QR code and the access
link now point at the public relay.

The token must match the one in the Harness plugin store
(`<profile>/plugins/remote-control.json`, key `secret`).

## Deploy it

### systemd + nginx

```ini
# /etc/systemd/system/dsh-relay.service
[Unit]
Description=DSH remote-control relay
After=network.target

[Service]
Environment=RELAY_TOKEN=…
Environment=RELAY_PUBLIC_URL=https://rc.example.com
Environment=PORT=8080
ExecStart=/usr/bin/node /opt/dsh-relay/server.js
Restart=always
User=relay

[Install]
WantedBy=multi-user.target
```

```nginx
server {
  listen 443 ssl http2;
  server_name rc.example.com;
  ssl_certificate     /etc/letsencrypt/live/rc.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/rc.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;   # the tunnel's WebSocket
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 3600s;                  # long-lived tunnels
  }
}
```

The relay speaks plain HTTP or HTTPS; put it behind a TLS-terminating proxy as
above — a phone session cookie must never travel in clear text.

### Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY src ./src
RUN npm install --omit=dev
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
```

## The access link is only half the credential

A device registers an `access_key` (in the link) and a `passcode` (never in the
link). The relay answers a phone with an unlock page until the passcode is
typed; a correct code leaves a `dsh-rc` session cookie (24 hours) behind, and
only then does the phone reach the agent.

Guessing is bounded twice over: a caller that fails five times is locked out
for ten minutes — the lock belongs to the caller, so a stranger cannot lock the
owner's phone out — and a device accepts at most 60 guesses an hour from
everybody together.

Rotating the passcode on the Harness side invalidates every unlocked phone and
every relay session at once.

## Known phones and trust

A phone that unlocks once keeps a credential of its own (`dsh-device`, 180
days) and shows up in the device list. The owner marks a phone as **trusted**,
and from then on it skips the access code.

## Managing devices and phones

| Call | Body | Effect |
| --- | --- | --- |
| `GET /v1/remote/devices` | — | every device the relay has seen, online or away |
| `POST /v1/remote/devices/<deviceId>/alias` | `{"alias":"…"}` | rename |
| `POST /v1/remote/devices/<deviceId>/offline` | — | disconnects it now; it reconnects by itself |
| `POST /v1/remote/devices/<deviceId>/revoke` | `{"revoked":true}` | refuses the device, reconnects included, until restored |
| `GET /v1/remote/devices/<deviceId>/phones` | — | the phones that reached the device |
| `POST /v1/remote/devices/<deviceId>/phones/<phoneId>/trust` | `{"trusted":true}` | mark a phone trusted |
| `POST /v1/remote/devices/<deviceId>/phones/<phoneId>/alias` | `{"alias":"…"}` | rename a phone |
| `POST /v1/remote/devices/<deviceId>/phones/<phoneId>/remove` | — | forget a phone |

The list, the trust flags, the device registry and the revocations live in the
relay's state file (`RELAY_STATE`, default
`/var/lib/dsh-relay/state.json`) and survive a relay restart. The device's own
credentials (access key, access code) are not stored: the host registers them
again on every start.

## Operations

| Task | Call |
| --- | --- |
| list devices | `GET /v1/remote/devices` with `Authorization: Bearer <token>` |
| rename a device | `POST /v1/remote/devices/<id>/alias` with `{"alias":"…"}` |
| take a device offline | `POST /v1/remote/devices/<id>/offline` |

## Security

* The relay only ever sees a **bearer credential** for the device channel; it
  never holds a Harness session credential — the Harness injects its own launch
  token on the way out.
* Everything the phone sends is replayed to that device and nothing else.
* Rotating the secret in the Harness (`remote-control.json` → `secret`, or the
  plugin's *rotate* action) invalidates every relay holding the old value.
