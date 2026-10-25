# Remote Control for DeepSeek Harness

Drive this agent from your phone: scan the QR code in **Settings → Remote
Control**, or open the access link on any other device.

The phone loads the *real* Harness web app through a tunnel, so there is no
phone-specific UI to maintain: sessions, streaming output, tool approvals and
the composer all work exactly as they do on the desktop.

---

## How it works

The design follows Kimi Code's remote control, whose transport is public (the
`@moonshot-ai/remote-control` package of the Kimi CLI). The host never opens an
inbound port for the internet; it **dials out** to a relay over two WebSockets:

```
phone ──HTTPS──▶ relay ──WebSocket──▶ host (this process)
                    ▲                     │
                    └──── tunnel ◀────────┘
```

| Channel | Path | Purpose |
| --- | --- | --- |
| management | `GET /v1/remote/create` | `register` → `register_ack` (the relay publishes the access URL) |
| tunnel | `GET /v1/remote/http?device_id=…` | the phone's HTTP requests, replayed against the local server |

Frames are JSON text; bodies are base64 inside the frame, so a relay can be a
dumb pipe. The wire contract lives in `src/relay-protocol.js`.

### Devices you can take offline, and devices you can revoke

The device list is persisted by the relay, so a device that is away still shows
up and can still be managed:

* **Take offline** — disconnects it right now. It reconnects by itself a
  moment later, so this is a "kick it now" action, not a lockout.
* **Revoke access** — refuses the device at the door, reconnects included, until
  you press *Restore access*. The refusal is persisted, so it survives a relay
  restart.

### Trusted devices

A phone that unlocks once keeps a credential of its own (`dsh-device`, 180
days). The owner sees every such phone in **Devices that connected** and can
mark one as **trusted**: from then on that phone walks straight in, without the
access code. The list and the trust decisions live in the relay's own state
file, so they survive a relay restart.

A phone that is only *known* still has to type the access code; untrusting a
phone takes effect at its next visit.

### Two factors: the link and the access code

The link is only half the credential. A device registers an **access key** (122
bits, in the link) and a **passcode** (8 digits, never in the link). The relay
serves the phone an unlock page until the passcode is typed; a correct code
leaves a relay session cookie behind (24 hours), and only then does the phone
reach the agent.

So a photographed QR code is not enough: the passcode lives in the Harness
settings page, is separate from the link, and can be rotated on its own —
rotating it invalidates every unlocked phone at once.

Guessing is bounded on both sides: a caller that fails five times is locked out
for ten minutes (the lock belongs to the caller, so a stranger cannot lock the
owner's phone out), and a device accepts at most 60 guesses an hour from
everybody together.

### What the relay may and may not see

* The relay **never** holds a Harness credential. The launch token that lets a
  phone obtain a session cookie is injected by the host on the way out, so the
  token exists only in this process.
* The relay authenticates the host with a shared secret (Bearer header or the
  `kimi-code.bearer.<token>` WebSocket subprotocol).
* The phone's traffic reaches the Harness server as an ordinary authenticated
  browser peer — the same authority, the same cookie rules, the same origin
  fence as the desktop.

### Two relay modes

| Mode | When to use | How |
| --- | --- | --- |
| **bundled** (default) | phone and computer on the same network | the plugin starts a relay inside this process and listens on the LAN; the QR carries `http://<lan-ip>:<port>/<device-id>/?rc=1&from=dsh_desktop` |
| **external** | phone anywhere on the internet | deploy `../remote-control-relay` on a public host and paste its URL into *Relay server* in the settings page |

An external relay is the "cloud" half: same protocol, same QR, but the phone
opens a public URL instead of a LAN address.

### Getting a public URL

Three routes, in order of how much they cost you:

| Route | What you run | Public URL | Notes |
| --- | --- | --- | --- |
| **Your own VPS** | `../remote-control-relay/bootstrap.sh --domain rc.example.com` | `https://rc.example.com` | stable, own domain, TLS included; the Harness only needs *Relay server* = that URL |
| **A tunnel in front of the bundled relay** | `cloudflared tunnel --url http://localhost:56131` (or `ssh -R 80:localhost:56131 nokey@localhost.run`) | `https://<random>.trycloudflare.com` | zero setup, no account; set *Public address* to that origin so the QR carries it |
| **A reverse proxy you already run** | nginx → the relay's port | your own domain | same as the VPS row, but the relay runs elsewhere |

The Harness dials **out** to the relay, so the relay never needs to reach your
computer — that is why a plain VPS in another country works, and why a tunnel
in front of the bundled relay is enough.

On a server that already runs nginx, keep the relay on loopback and let nginx
terminate TLS; the details and the exact commands are in
[`../remote-control-relay/README.md`](../remote-control-relay/README.md).

Whatever the route, the access link carries a per-device key
(`?k=…`): the relay refuses the device without it and then hands the phone its
own `dsh-rc` session cookie, so the app's absolute asset and API URLs keep
working while the link stays the credential.

---

## The settings page

* **Remote Control is on** — starts the relay and the tunnel. Turning it off
  closes both.
* **QR code** — encodes the access URL; *Copy link* and *Open link* sit under it.
* **Keep this computer awake and online** — the phone drives a live agent, so
  the host must stay awake.
* **Access code** — the 8 digits a phone must type, with *Copy code* and
  *Change code*.
* **Devices that connected** — every phone that unlocked once, with a trust
  switch (a trusted phone skips the access code) and a remove action.
* **Remote device management** — every device the relay knows: the alias, the
  `platform - dsh-desktop/version` line, an online dot, and a `⋯` menu with
  *Rename* and *Take offline*.
* **Relay server** — point the host at an external relay, or leave it empty to
  use the bundled one.

The page registers itself in the `settings.section` slot, so it appears in the
Settings navigation next to *General*, *Models*, *Plugins* and *Agent presets*.

---

## Files

| Path | Role |
| --- | --- |
| `index.js` | Host half: relay lifecycle, the `/api/remote-control` route, QR generation |
| `client.js` | Client half: the *Remote Control* settings section |
| `src/relay-protocol.js` | The wire contract shared by host and relay |
| `src/relay-server.js` | The relay: phone-facing proxy, device channels, management API |
| `src/relay-client.js` | The host side of the tunnel |
| `src/device-store.js` | Durable device identity and the shared secret |
| `tests/` | 35 tests: relay unit suites plus an end-to-end tunnel test |
| `../remote-control-relay/` | The standalone relay for cloud deployments |

---

## How the host talks to the settings page

The page posts to the exact Fetch route `/api/remote-control`, registered with
`ctx.connection.fetch.register(...)`. The Connection service authenticates the
caller with the same browser session the rest of the app uses, so no extra
credential is needed. (The generic `rpc.handle` channel registry only supports
the shared `/api` channel, so a feature-specific route is the supported way to
add a host endpoint.)

---

## Security notes

* The shared secret is stored with mode `0600` under the profile directory
  (`<profile>/plugins/remote-control.json`). Rotating it invalidates every
  relay holding the old value.
* The passcode is stored next to it. Rotating it invalidates every unlocked
  phone and every relay session.
* The phone receives an ordinary browser session cookie for this host. It is
  therefore an **owner** peer: it can do everything the desktop can. That
  matches Kimi Code's model (the phone is the account holder), and it is why
  the link must not be shared.
* A relay deployment should sit behind TLS. Plain HTTP leaks the session
  cookie to anyone on the path.
