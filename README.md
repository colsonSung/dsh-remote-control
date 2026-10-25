# Remote Control for DeepSeek Harness

Control your DeepSeek Harness agent from your phone. Scan a QR code, open the
link, and you get the **real** Harness web app on your phone — sessions,
streaming output, tool approvals and the composer, all on top of the agent
running on your computer.

The design follows [Kimi Code's remote control](https://www.kimi.com/code/docs/en/kimi-code-desktop/remote-control.html):
the host **dials out** to a relay, the relay replays your phone's HTTP traffic
back through that tunnel, and the QR code carries the access URL. Your computer
never opens an inbound port.

```
phone ──HTTPS──▶ relay ──WebSocket──▶ the Harness on your computer
                    ▲                     │
                    └──── tunnel ◀────────┘
```

## What you get

| | |
|---|---|
| **A settings page** | `Settings → Remote Control`: a switch, a QR code, an access code, a device list |
| **Public access** | the relay can live on a VPS; the phone works on 4G/5G |
| **An access code** | the phone has to type an 8-digit code once — a photographed QR code is not enough |
| **Trusted devices** | phones you trust skip the access code from then on |
| **Revocation** | take a device offline now, or revoke it until you restore it |
| **A mobile layout** | the sidebar collapses by itself when you open a session |

## Install

### 1. The plugin

```bash
git clone https://github.com/colsonSung/dsh-remote-control.git
cd dsh-remote-control
./install.sh              # installs into the profile of the running Harness
```

`install.sh` takes an optional profile name (`./install.sh web`) and is
idempotent. It installs the package into the profile and adds the bundle row to
`<profile>/cordis.patch.yml`. **Restart the Harness afterwards** — the host
half of a plugin is loaded at start-up.

Manual equivalent:

```bash
dsh plugin --profile web add ./plugin
```

```yaml
# <profile>/cordis.patch.yml
- insert:
    - id: remote-control
      name: 'dsh-remote-control'
```

### 2. A relay (only needed for public access)

On a Linux server with a domain:

```bash
cd relay
sudo ./bootstrap.sh --domain rc.example.com --email you@example.com
```

The script installs Node.js 22, writes a `dsh-relay` systemd unit, puts nginx
in front of it and obtains a Let's Encrypt certificate. It prints the relay
token at the end.

Without a server of your own, the plugin can also open a tunnel for you:

```bash
plugin/tools/tunnel.sh      # cloudflared or localhost.run, then sets the public address
```

### 3. Point the plugin at the relay

`Settings → Remote Control → Relay server`, paste `https://rc.example.com`,
press **Use relay**, then turn the switch on. The QR code now carries the
public URL.

Leave the field empty to use the relay **bundled with the app** — it listens on
your local network, needs no server and no account.

## Using it

1. Press **Copy code** to read the 8-digit access code.
2. Scan the QR code with your phone.
3. The phone asks for the access code — type it once.
4. The phone is now listed under **Devices that connected**. Turn on its
   **trust** switch and it will not ask again.

The access code never travels in the URL, so the QR code alone is not enough to
control the agent.

## Security model

| Layer | What it does |
|---|---|
| **Access key** | 122 random bits in the link; the relay refuses a link without it |
| **Access code** | 8 digits, typed once, never in the URL; rotates independently of the link |
| **Device credential** | 180-day cookie on the phone; lets the owner recognise it and trust it |
| **Brute-force guard** | five wrong codes lock the caller out for ten minutes; a device accepts 60 guesses an hour in total |
| **Revocation** | a revoked device is refused at the door, reconnects included, until you restore it |

The relay never holds a Harness credential: the launch token that lets a phone
obtain a session cookie is injected by the host on the way out.

**Treat the access link and the access code as one secret.** Anyone with both can
control the agent — which means running commands in your workspace.

## Layout

```
plugin/     the DeepSeek Harness plugin (host + client)
relay/      the standalone relay server, deployable on a VPS
```

See [`plugin/README.md`](plugin/README.md) for the protocol and the
architecture, and [`relay/README.md`](relay/README.md) for the deployment
guide.

## Development

```bash
cd plugin
npm install
node --test --test-force-exit tests/*.test.js
```

The tests cover the tunnel end to end: the access-code gate, the trusted-device
bypass, the brute-force guard, the revoke chain, and the relay's persistence
across a restart.

## License

MIT — see [LICENSE](LICENSE).
