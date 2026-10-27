# Remote Control for DeepSeek Harness

Open the QR code on your phone — or your iPad — and you get **the real DeepSeek
Harness**: the same sessions, the same streaming output, the same tool
approvals, the same composer. The phone loads the app itself, so there is no
second, stripped-down mobile UI to build, and none to keep in step.

> 中文说明：手机 / iPad 扫码打开，就是电脑上那套**完整的 DeepSeek Harness**——会话
> 列表、流式输出、工具审批、输入框全部原样可用，不需要维护第二套手机界面。手机上
> 侧栏占满整屏、用完自动收起、一次点击即打开会话；电脑**不开任何入站端口**，主机
> 主动向外拨号，手机在 4G/5G 上一样能用。

## What you get

| | |
|---|---|
| **The real app on the phone** | sessions, streaming output, tool approvals and the composer — the app itself, not a cut-down client |
| **A full-screen sidebar on a phone** | below 1024px the sidebar takes the whole screen instead of leaving the conversation a 113px sliver, and it closes itself once you use it |
| **One tap opens a session** | the drawer waits for the tap, never for the press, so the control under your finger always gets it |
| **A public address, no inbound port** | the host dials out to a relay and the relay replays the phone's traffic; your computer never listens for the internet |
| **An access code** | the phone types an 8-digit code once — a photographed QR code is not enough |
| **Trusted devices** | a phone you trust skips the code from then on |
| **Revocation** | take a device offline now, or revoke it until you restore it |
| **A tunnel that survives an event stream** | a response that never ends is forwarded chunk by chunk, so the phone sees the output as it happens |
| **Payloads that fit in a phone's budget** | a busy session's snapshot is gzipped and marked, which is the difference between seconds of "Loading history…" and a fraction of one |
| **A relay that is yours** | the relay is a small standalone server you can deploy on a VPS, or run on your own network |

## The phone experience

The sidebar is a drawer that covers the screen, the way a phone menu does:

<p align="center">
  <video src="docs/demo.mp4" poster="docs/demo-poster.png" width="320" controls playsinline></video>
</p>

The clip is the real app in a 390×664 window: the drawer opens over the
conversation, **one tap** opens the session and closes the drawer, and the
answer streams in while the phone is still in your hand. It was recorded
against a throw-away profile with one seeded conversation — no session, no
plugin and no account of the author's is in it.

```
┌─ 390px phone ───────────────────────────┐
│  deepseek HARNESS                        │
│                                         │
│  + New Session                          │  ← the same button as on the desktop
│                                         │
│  · Plugins                              │
│  · Automation tasks                     │  ← the global panels
│  · English Reader                       │
│                                         │
│  Workspaces                    search  + │
│  ▸ default-workspace                    │
│    ○ New Session                        │
│    ○ a session of your agent             │  ← tap it: the session opens
│    ○ another session                     │     and the drawer closes
└─────────────────────────────────────────┘
```

Nothing is a mock-up of the desktop: it is the desktop app, on a screen that
fits a hand.

## How it works

The design follows [Kimi Code's remote control](https://www.kimi.com/code/docs/en/kimi-code-desktop/remote-control.html):
the host **dials out** to a relay over two WebSockets, the relay replays your
phone's HTTP traffic back through that tunnel, and the QR code carries the
access URL.

```
phone ──HTTPS──▶ relay ──WebSocket──▶ the Harness on your computer
                    ▲                     │
                    └──── tunnel ◀────────┘
```

| Channel | Path | Purpose |
| --- | --- | --- |
| management | `GET /v1/remote/create` | `register` → `register_ack` (the relay publishes the access URL) |
| tunnel | `GET /v1/remote/http?device_id=…` | the phone's HTTP requests, replayed against the local server |

Frames are JSON text; bodies are base64 inside the frame, so a relay can be a
dumb pipe. Two optional capabilities let it take the bytes as they are instead
of paying for the base64 inflation (`binary_body`, `ws_binary_body`), and the
host only uses them when the relay advertises them — an older relay keeps
working.

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
2. Scan the QR code with your phone or iPad.
3. The device asks for the access code — type it once.
4. The device is now listed under **Devices that connected**. Turn on its
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
architecture — the phone layout, the compression, the event stream, the access
code and the trusted devices — and [`relay/README.md`](relay/README.md) for the
deployment guide.

## Development

```bash
cd plugin
npm install
node --test --test-force-exit tests/*.test.js
```

The tests cover the tunnel end to end: the access-code gate, the trusted-device
bypass, the brute-force guard, the revoke chain, and the relay's persistence
across a restart — plus the phone drawer, whose dismissal must never take a
control out from under the finger.

## License

MIT — see [LICENSE](LICENSE).
