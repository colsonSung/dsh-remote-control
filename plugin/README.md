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

Two capabilities let a relay take the bytes as they are instead of paying for
the base64 inflation, and both are optional — the host only uses them when the
relay advertises them, so an older relay keeps working:

| Capability | What it buys |
| --- | --- |
| `binary_body` | the body of an HTTP response travels as one binary message |
| `ws_binary_body` | the payload of a WebSocket travels as one binary message |

### The big payloads are compressed

Opening a conversation on the phone pulls one snapshot of that session: on a
busy session that is megabytes of JSON, and the tunnel of a remote relay is
exactly where the bytes are scarce. The same payload crosses the link twice
(host to relay, relay to phone), so the host gzips it and marks it.

The phone announces that it can inflate such a payload by adding `rcz=1` to
the query of its stream URL. The host takes that parameter out again before
the request reaches the DSH server, and only compresses when the phone asked
for it — a phone that does not know the parameter keeps receiving the payload
as it is. On a session with 2.8 MB of history the snapshot shrinks to about
480 KB, which is the difference between four seconds of "Loading history…" and
a fraction of one.

### An event stream survives the tunnel

`/plugins/events` is an event stream: it never ends, and the phone waits for
the next event. A tunnel that waits for the whole body before answering turns
that into a `504` after thirty seconds, so the host sends the head first and
the body in chunks, and the relay hands every chunk to the phone as it
arrives. The relay keeps such a request alive with an idle window of five
minutes — an event stream says nothing between its events, and the window that
guards a request would cut it while it is perfectly fine.

### The sidebar takes the whole screen on a phone

Below 1024px the app keeps the expanded sidebar as a column beside the
conversation, which leaves the conversation a sliver: on a 393px phone the
sidebar takes 280px and the conversation the remaining 113px. The browser half
therefore gives the sidebar every pixel while it is expanded, and the
conversation goes behind it — the sidebar's own collapse control brings it
back.

The rule is written against the shell's own attributes
(`data-shell-overlay`, `data-sidebar-collapsed`, `data-side="sidebar"`), not
against the build's hashed class names, so it survives a release. If the frame
ever changes shape, the selector stops matching and the app keeps its own
layout.

The rule is a **fallback**: a frame that already carries the sidebar-appearance
plugin's drawer (`sa-frame`) belongs to that plugin, which positions the column
itself and takes the conversation behind it out of the pointer event path. The
grid here only applies on a profile without that plugin, so two plugins never
stretch the same column and the layout does not depend on stylesheet order.

### The drawer closes after the tap, never before it

On a phone the drawer is a modal surface over the conversation: using
something inside it closes the drawer, so the conversation gets the whole
screen back. The dismissal waits for the **click**, never for the press. A
press is the beginning of a gesture, and closing the drawer on it took the
pressed control out from under the finger before the browser dispatched the
click — the click then landed on the conversation behind the drawer and the
control never ran at all. A session row had to be tapped twice to open, and
the first tap looked like it did nothing. By the time the click is dispatched
the drawer is still in place, the control has handled its own tap, and the
drawer closes on the next task.

The sidebar's own collapse control is exempt from the dismissal: it must
stay a toggle rather than become a close.

### The sidebar's own controls are unmistakable on a phone

The shell has both controls already - the panel icon in the expanded
sidebar's top strip and the brand mark in the collapsed rail - but on a
phone they are 28px glyphs in a corner, which is easy to walk past. The
browser half finds them by the accessible name the shell gives them (no
build-hashed class name) and gives them a visible surface and a bigger touch
target. Their size and place do not change, so the control next to them
keeps its own position.

### A refused session is recovered

The Harness app binds its browser-session cookie to one authority, and the
desktop app moves that authority on every restart. The cookie the phone kept
is then worth nothing, and the phone would sit on an empty screen until it
reloaded the page. The host therefore trades its launch token in for a fresh
cookie when the local server refuses the handshake, and opens the stream
again — the phone never notices.

### Devices you can take offline, and devices you can revoke

The device list is persisted by the relay, so a device that is away still shows
up and can still be managed:

* **Take offline** — disconnects it right now. It reconnects by itself a
  moment later, so this is a "kick it now" action, not a lockout.
* **Revoke access** — refuses the device at the door, reconnects included, until
  you press *Restore access*. The refusal is persisted, so it survives a relay
  restart.

### A restart of the relay does not lock the phones out

The session cookie the relay hands a phone is derived from the relay's secret
and the phone's own credential, not random: a relay that restarts (a deploy, a
crash, a reboot) can recompute it. Before, every restart threw the sessions
away, and the app answered `401` until the phone typed the access code again.

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

### The session cookie is bound to the local port

The Harness server mints its browser-session cookie for one **authority**
(`host:port`): the cookie is named `dsh-auth-<base64url(sha256(authority))>`
and its signed payload carries the same authority. The desktop app starts the
web server on an **ephemeral port**, so every restart of the app moves the
authority and invalidates the cookie the phone kept.

The host therefore never assumes that a cookie it sees is still good:

* only the cookie of the *current* authority counts as a session — a cookie
  from an earlier port makes the host trade the launch token in again, and the
  server mints a fresh one;
* a session the server nevertheless refuses (the signing secret changed) is
  recovered by retrying the device root once with the launch token.

Without both, a phone that had unlocked once would be locked out for good by
the next restart of the app: the server would answer `401` and the host would
have no way left to hand the phone a valid session.

### The first load is heavy

The web app is one JavaScript bundle of roughly 9 MB, and it travels through
the tunnel to the relay before the relay can pass it on to the phone. Two
things keep that affordable:

* the host **compresses** every response before it enters the tunnel — the
  bundle shrinks from 9 MB to 3.7 MB — and the phone's browser decompresses it
  on its own;
* a relay that advertises the `binary_body` capability also accepts a body as
  one **binary WebSocket message**, so the body does not pay for the base64
  inflation a JSON frame would cost it.

That leaves the link itself as the bottleneck: on a 4 Mbit/s uplink the first
load still takes about ten seconds. The browser caches the bundle by its
revision hash, so every later load is quick, and the bundled relay on the LAN
does not have this cost at all.

An older relay that does not advertise the capability keeps working: the host
falls back to the base64 body inside the JSON frame.

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
| `client.js` | Client half: the *Remote Control* settings section, and the browser half of the compressed stream protocol |
| `src/relay-protocol.js` | The wire contract shared by host and relay |
| `src/relay-server.js` | The relay: phone-facing proxy, device channels, management API |
| `src/relay-client.js` | The host side of the tunnel |
| `src/device-store.js` | Durable device identity and the shared secret |
| `tools/sync-contract.js` | Writes the wire contract into the browser half and checks it |
| `tests/` | The test suites: relay unit suites, the tunnel end to end, the compression path |
| `../remote-control-relay/` | The standalone relay for cloud deployments |

### The contract exists on both sides

The browser half runs in the page and cannot import `src/relay-protocol.js`,
so the two values it needs — the marker that opens a compressed payload and
the query parameter that announces the support — exist on both sides. The
copy in `client.js` is **generated**:

```
node tools/sync-contract.js          # write the current contract into client.js
node tools/sync-contract.js --check  # fail when client.js is out of date
```

`tests/protocol-contract.test.js` runs the check, so a constant that drifts
fails the suite instead of quietly turning into a phone that waits for the
full megabytes.


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
