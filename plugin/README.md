# Remote Control for DeepSeek Harness

Drive this agent from your phone: scan the QR code in **Settings → Remote
Control**, or open the access link on any other device.

The phone loads the *real* Harness web app through a tunnel: sessions,
streaming output, tool approvals and the composer use the same behavior as on
the desktop. A small presentation layer adapts that same interface to narrow
screens; it does not replace any session or transport logic.

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

### The conversation itself is phone-sized too

The same narrow-screen stylesheet removes the desktop transcript-width drag
handles and gives the view tabs a thumb-sized target. The view row itself stays
the host's own: it shows the views that fit and folds the rest into its More
menu, which is what a phone wants. Messages keep their own components and
interactions, while code blocks, tables, images and long links are contained
inside the phone viewport.

The resident composer keeps its draft, attachment, command and approval
behavior. On a phone its editor uses 16px text to avoid automatic browser zoom,
its buttons are at least 44px high, and the primary send/stop action also has a
44px minimum width without forcing every tool to take that width. Its icons
never shrink either: a long file name used to squeeze the attachment's icon
into an ellipse. The bottom
seat preserves its baseline spacing and respects the device safe area.
Delivered files change from two columns to one; changed-file paths ellipsize
while their line counts stay visible, and previews keep their own scrolling.

These rules use stable structural attributes such as `data-conversation-content`,
`data-composer-card` and `data-presented-files-row`, plus Harness theme tokens.
They do not replace the Conversation, Composer or Deliverables components, and
they do not add multi-host switching.

### The link in the address bar keeps working

The relay's unlock redirect used to drop the access key, so the URL that stayed
in the phone's address bar — and in every copy the owner made of it — no longer
carried a credential. Another browser opening that address got a bare
`a valid access link is required`, which some browsers offer as a file to
download instead of showing it.

The redirect now keeps the query, so the address bar holds a link that still
opens the agent anywhere. A link that arrives without a key gets a small page
that says what is missing and where to get the real link, instead of a
downloadable text file.

### The phone chrome stays where it is

The rail and the conversation header are ordinary flow content, so anything
that makes the browser scroll the page — a focused field when the keyboard
opens, most of all — takes them off the screen with it. On a phone the rail
and the header are therefore pinned: the rail keeps its column and its own
scroll, and the header sticks to the top while the transcript scrolls under it.

The same focus is what makes iOS zoom the page and leave the composer stretched
across the screen. Every editable control on a phone keeps 16px text, so the
browser has no reason to zoom in the first place.

### A phone menu keeps its surface on a phone

The app's menus are painted by an element that is positioned with CSS anchor
positioning — a feature Chrome has and iOS Safari does not implement yet. On a
phone the surface therefore stayed transparent and the page showed straight
through the menu, which made it unreadable. On narrow screens the menu now gets
an opaque surface of its own, a shadow, and a bound to the viewport, so it
reads as a panel whatever the browser supports.

### A phone can finally boot the app

The web app loads its client modules as one bundle of several megabytes. Pushed
to the phone in a single burst, that bundle defeats WebKit's HTTP/2 receive
window: the transfer stalls, the module import never resolves, the boot promise
never settles, and the phone shows an empty page — while Chrome on the desktop
is fine. The host therefore sends a large response in 64 KiB frames, and the
relay hands it to the phone as it arrives. The same copy of the app also reaches
Safari with `rel="modulepreload"` instead of a classic script preload, which is
the preload a module import can use.

The first load after a change still walks the bundle over the link, so the page
can sit on *Loading plugins…* for a while; the response is cacheable, so the
loads after that are immediate.

### Adding a workspace from the phone needs the desktop too

The folder picker lives on the computer: the phone asks the desktop, and the
desktop shows the operating system's own chooser. The relay gave the host thirty
seconds to answer, which is long enough for a request and far too short for a
person who has to walk over to the computer — the phone reported *Couldn't open
folder* while the chooser was still waiting. That one route now gets five
minutes; every other request keeps the ordinary window.

So the flow is: add the workspace on the phone, pick the folder on the computer
within five minutes, and the phone continues. Without a person at the computer
there is nothing to pick, and the phone waits until the window ends.

### The composer stays above the phone keyboard

A phone keyboard shrinks the visual viewport but leaves the layout viewport
alone, so a composer pinned to the bottom of its scroller ends up behind the
keyboard — the draft is hidden while you type in it. The plugin watches
`visualViewport`, measures how much of the composer the keyboard actually
covers, and lifts the composer by exactly that distance. The measurement
follows the keyboard while it opens, scrolls and closes, and a composer that is
already fully visible is not moved at all.

The Chinese input method on iOS draws a toolbar of its own above the keyboard.
It is painted over the page instead of inside the keyboard, so it never shows
up in the visual viewport, and it would cover the lower half of the composer.
On iOS the composer therefore keeps that room free as well; the toolbar itself
stays where the system puts it.

Whether the composer holds the focus decides that, not a measurement: Safari
scrolls the page to reveal the field, and then nothing of the composer sits
below the visible area any more — the measurement would report "nothing is
covered" while the keyboard and its toolbar still cover the screen. With the
focus in the composer the room is kept; without it, nothing is reserved.

### The Settings panel fits a phone, and a tap never zooms the page

The Settings dialog is a fixed 800px two-column panel on the desktop: a 188px
section rail beside the content column. On a phone that rail squeezes the
content into a few words per line, so the panel stacks instead — the section
rail becomes a horizontally scrolling chip row above a full-width content column
that scrolls on its own. The rule is written against the panel's own
`data-shortcut-modal="settings"` marker, so it survives a release.

A phone also zooms when a control below 16px takes focus, and again on a
double-tap. Form controls therefore use 16px text, and buttons, links and other
tappables carry `touch-action: manipulation`, so a tap never changes the page
zoom.

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

### A device that went quiet comes back on its own

The relay keeps the registration of a device while its channel is open. A
channel that goes quiet without closing — a dropped network, a sleeping
laptop, a NAT that forgets the flow — stays open on the relay, and the relay
then refuses every new registration of that device ("device already
registered"). The computer could not come back at all: the owner saw the
device as offline and the tunnel stayed dead.

Two things prevent that now:

- the relay remembers when it last heard from a device and drops the channels
  of the ones that went quiet, so a stale registration cannot outlive the
  connection it belongs to;
- the host keeps retrying after such a refusal, so the device is back as soon
  as the relay lets go — no restart of the app needed.

A device that is really there keeps its place: a second registration of the
same id is still refused while the first one answers.

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

### One phone is one record

The credential has to survive the way a phone is actually opened: the link
comes from a chat, a QR scanner or a mail, so the first request after it is a
navigation from another site. A `SameSite=Strict` cookie is not sent on such a
navigation, so the phone arrived without its credential, was asked for the
access code again, and landed in **Devices that connected** as a new handset
every single visit. The cookie is `SameSite=Lax` now: it travels with the
link, and still stays away from cross-site POSTs.

A phone that arrives without its credential anyway — a browser that cleared
it, a private tab, a web view with its own storage — continues the record of
the same caller (its address and its User-Agent) instead of starting a new
one. **A trusted record is never continued that way**: the trust belongs to the
phone that proved itself, so a caller without the credential gets a record of
its own and still has to type the access code.

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

The web app is not one bundle any more: it is the app's own code **and** the
client bundle of every installed plugin. Measured on a phone-sized viewport
through the public relay, the first load was **6.3 MB in 104 requests** — and
5 MB of it was the plugin bundles, which compress badly because they are
several megabytes of *minified* JavaScript, concatenated.

Three things keep that affordable:

* the host **compresses** every response before it enters the tunnel, and the
  phone's browser decompresses it on its own;
* the compression is **brotli**, not gzip. Gzip has a window of 32 KB and
  cannot see across the bundles; brotli can see the whole body at once, and
  the big bundle shrinks by 9% more under it (2.3× under gzip, 3.1× under
  brotli) — and brotli compresses *faster* at that quality, which matters
  because the host compresses on the request path and the phone waits;
* a relay that advertises the `binary_body` capability also accepts a body as
  one **binary WebSocket message**, so the body does not pay for the base64
  inflation a JSON frame would cost it.

Every browser that can run the Harness app understands `content-encoding: br`,
so nothing in the browser half has to know about it.

That leaves the link itself as the bottleneck: on a 4 Mbit/s uplink the first
load still takes about ten seconds. The browser caches the bundle by its
revision hash, so every later load is quick, and the bundled relay on the LAN
does not have this cost at all.

An older relay that does not advertise the capability keeps working: the host
falls back to the base64 body inside the JSON frame.

### The phone gets the app in one hop

The server answers the app root with a cookie and a redirect to the clean URL.
Through a relay that redirect costs a whole extra round trip over the link —
and a browser that does not keep the cookie pays it again on every request,
which is a loop the phone never leaves.

The host therefore mints the session itself: one local call, and the phone's
request carries the cookie from then on. The redirect never reaches the phone.

The cookie has to reach the phone as well, and it does — the host hands it
over with the answer. A phone whose jar does not hold the session is a phone
whose every later request is refused, and an app that comes up empty.

And the session the host holds is attached to **every** request of the phone
that does not carry a valid one. A browser that keeps no cookie — a private
window, a browser that blocks it, a page opened before the session existed —
is still answered. The guest never gets it: the launch token and the session
are the owner's credential.

### The stream of the phone is kept alive

The relay cuts a stream that says nothing for five minutes, and a phone that
only reads the conversation says nothing for a long time. The cut costs the
phone its session, and with it the messages that arrived while it was gone.

The host therefore keeps the event stream alive with a comment — the shape
Server-Sent Events defines for exactly this — every minute. The phone's
browser ignores the comment; the relay does not cut the stream.

### The app's own data gets a longer window

A file is answered in a moment: the host reads it and sends it. The app's own
data is work — the session list of a busy machine is megabytes of JSON — and
the host needs the time to build it. A phone that asks for it must not be
told "no answer in time" while the host is still working.

The relay therefore gives the paths under `/api` and `/share` a window of two
minutes, and keeps the ordinary window of thirty seconds for everything else.

### The phone is not offered the inspector of the machine

The inspector is a tool of the desktop: it lives on the machine the app runs
on, and its address is a local one. A phone that is somewhere else cannot
reach it, and a browser that tries asks the person for the permission to
reach the local network — again and again, because the connection is retried
for as long as the page lives.

The tunnel therefore takes the announcement out of the phone's copy of the
document. The inspector's client half reads it when it is there and does
nothing when it is not.

### The controls that act on the computer are gone on a remote page

A page served through the tunnel runs on a device that is not the machine the
agent runs on. Three controls of the conversation header act on that machine,
so from the phone they can only fail:

| Control | What it acts on |
| --- | --- |
| the editor hand-off (VS Code, Finder, Xcode, a terminal) | opens an application on the desktop |
| the Moments quick button | opens a window of the desktop app |
| the live recorder (Minutes) | captures the desktop microphone |

The browser half therefore marks the document with `data-dsh-remote` whenever
the origin is not a loopback address, and the phone layout hides those controls
at every width: a remote device can be as wide as a tablet and still hold no
microphone, no window and no editor. The desktop app (a loopback origin) keeps
all three.

The three were also what pushed the phone header past the screen: on a 440px
phone it measured 544px wide, so the controls at its tail scrolled out of
reach while three dead ones stayed visible.

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
| `src/share-store.js` | Durable share records: the session, the permission, the passcode and the project root |
| `src/share-service.js` | The guest surface: the routes, the passcode, the cookie, the project boundary, the room of the owner |
| `src/share-room.js` | The room of a share: the guests, the locks, and who is writing |
| `src/share-identity.js` | The name and the colour of a guest — the same in every place it is shown |
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

## The log of the plugin

Everything the plugin says goes to the console of the Host (`ctx.logger`), and
to a file of its own: **`<profile>/plugins/remote-control.log`**.

The file is there because the console is not enough. The desktop app keeps
what its console says in memory and writes it into a crash report when it
stops — so a phone that fails at night, when nobody is looking, leaves
nothing behind. The file of the plugin is written as the words are said, and
it is kept for the owner alone (`0600`).

It is rotated when it grows past a megabyte: the live log becomes `.1`, the
one before it becomes `.2`, and the one before that is let go.

```
tail -f ~/.dsh/profiles/desktop/plugins/remote-control.log
```

---

## Sharing one session with a guest

The phone is an **owner**: it holds the host's own browser session and can do
everything the desktop can. A guest is not. A guest gets a link, a passcode and
exactly one session — and none of the owner's credentials.

So a share is not the app. It is a small, self-contained page of its own that
serves one conversation, and the guest never becomes a peer of the Harness
server.

### What the owner gets

The Settings page talks to the same route it already used, with four more
methods:

| Method | Payload | Answer |
| --- | --- | --- |
| `shareCreate` | `{sessionId, permission, title?}` | `{id, link, passcode, permission, createdAt}` |
| `shareList` | — | `{shares: [{id, sessionId, title, permission, passcode, createdAt, lastUsedAt, revokedAt, link, status}]}` |
| `shareDisable` | `{id}` | `{ok: true}` — the link stops working, the record stays |
| `shareDelete` | `{id}` | `{ok: true}` — the record is gone |

`permission` is `read` or `write`. The link is `<relay origin>/s/<id>`; without
a relay there is no link, and `shareCreate` answers `link: null` with a
`reason`.

The records live in `remote-control-shares.json` next to `remote-control.json`,
with mode `0600` — a passcode is a credential:

```json
{
  "version": 1,
  "shares": [
    {
      "id": "s_0123456789ab",
      "sessionId": "…",
      "title": "The shared session",
      "permission": "write",
      "passcode": "12345678",
      "createdAt": 0,
      "lastUsedAt": null,
      "revokedAt": null,
      "projectRoot": "/absolute/path/to/project"
    }
  ]
}
```

### What the guest gets

The guest routes are raw HTTP under `/share/`, registered with
`ctx.webServer.register(...)`. They carry **no** host authentication: the
share's passcode is the only credential, and the host's own session cookie
never reaches them.

| Route | What it does |
| --- | --- |
| `GET /share/<id>` | The guest page. Locked it asks for the passcode, open it shows the conversation |
| `POST /share/<id>/unlock` | Checks the passcode and sets the guest cookie |
| `GET /share/<id>/api/state` | `{share, session, messages}` |
| `GET /share/<id>/api/stream` | The live events, as Server-Sent Events |
| `POST /share/<id>/api/message` | Puts a message into the session — `write` shares only |
| `GET /share/<id>/api/tree?path=` | Lists one directory of the project root |
| `GET /share/<id>/api/trajectory` | The steps of the conversation, as the host's Trajectory tab shows them |
| `GET /share/<id>/api/context` | The files the conversation produced |
| `GET /share/<id>/api/file?path=` | Reads one file inside the project root |
| `GET /share/<id>/api/blob?path=` | Reads one image of the project as bytes |
| `GET /share/<id>/api/asset?name=mermaid` | The mermaid library, for the documents that carry a diagram |
| `GET /share/<id>/api/room` | Who is in the room, and what each of them holds |
| `POST /share/<id>/api/room` | A guest says who it is, what it has open, whether it holds it, whether it is writing |
| `POST /share/<id>/api/edit` | A guest puts its text into a file — refused when the file moved on |
| `POST /share/<id>/api/collab` | The collaborative document of a file: open it, change it, move the cursors |

### The guest page is the app, scoped

The page is the Harness conversation seen from the outside: the rail, the
shared conversation beside it, the **Chat / Trajectory / Context** tabs of the
host's own conversation, and — beside them — the files of the task's project
folder. A phone gets the same page without the side column.

What it does **not** have is the app behind it: the guest's browser never
receives the host's session cookie, so there is no session list, no workspace
switcher, no tool approvals and no other conversation to reach. The host's
`/api` is never exposed to a guest.

The transcript comes from the session's **durable log**
(`ctx.sessionPersistence.open(id, 'read')`), not from the live session view: a
live session's own view carries only its latest state, while the log holds the
whole conversation the owner shared. The title comes from the same log, in its
`session/title` event.

A tool result is a step of the agent's work, not a message of the
conversation: in the transcript it collapses into one line, and the Trajectory
tab carries the steps themselves.

### The visitor chooses the theme: the page follows their system until they
say otherwise, and the choice stays where they left it. The dark palette
is written once and serves both the system and the button, so the two
never drift apart.

The panel that holds a file takes the whole page and gives it back: a
button in its header, and the escape key.

The page wears the app's colours and the app's type: the values of the
transcript - a body of 13px on a 23px line in a column of 742px - and the
shape of the composer - a card with a ring around it, an input that grows
with the text and a send button that is a circle of the accent colour -
are the ones measured from the running host, not chosen by eye.

The page wears the app's colours

The guest page stands outside the app, so it carries the palette itself — but
the values are the app's, measured from the running host: the accent is
`#4176e6` in light and `#7aaaff` in dark, the text and the surfaces are the
app's, and the page follows the **visitor's** system theme, since the guest's
browser is not the owner's. The surfaces are a ramp of their own: the app's
light surfaces are all `#ffffff`, so a card that used them would be white on
white.

The scrollbars of the page are thin and out of the way: they appear when
the area they belong to is under the pointer.

A diagram of a document is drawn when it comes into view, not before: the
library is five megabytes and it comes in the background while the guest
reads. The diagram wears the palette of the page — the accent of the page
is the border of the nodes — so it reads as part of the document rather
than as a picture of another one.

The document follows the width of the panel it is shown in. A reader who
drags the panel open — or takes the whole page with it — is asking for a
wider document, and the tables, the code and the diagrams take the width
that is there. The lines of the prose keep a measure of their own, about
forty Chinese characters, so that a wide panel does not make them hard to
read; a table inside a quotation is not squeezed into the measure of a
paragraph.

A diagram follows the width of the panel it is shown in. The library draws a
diagram at the size it needs and freezes that size when it draws it, so a
panel that is widened afterwards — or a panel that takes the whole page — used
to leave the diagram at the width it was drawn at. The viewer takes the size
into its own hands: the drawing keeps its natural size, and the viewer scales
it to the width it is given. A drawing that is narrower than its place keeps
its own size, because blowing it up would make its letters larger than the
letters around it.

A diagram that is wider than its place is scaled down a long way, and a
reader has to be able to read it. The viewer therefore carries three
controls — zoom out, zoom in, and fit to the width — and the scale it is at.
The step of the zoom doubles while the drawing is smaller than its own size,
so three clicks take the reader from "the whole of it at once" to "as large
as it is"; past that size it grows gently. The drawing may also be dragged
with the pointer, and the wheel zooms when the keyboard is held down. The
keyboard reaches it as well: `+`, `-` and `0`.

The controls use the tokens of the page and no colour of their own, and they
say what they are: every one of them carries a name for the screen reader.

The conversation reads as the app's own transcript: what was asked and
what the agent answered. A question is a question - the owner's, a
guest's, a teammate's closing message - and it is rendered like the
answer: the guest reads the message as it was written, not as its
source. The host clips a message only far beyond what a reply holds,
and the cut falls on a line, so a paragraph never ends in the middle of
a word. The steps of the agent's work are plumbing, so
they gather into one folded group - "5 tool calls" - that opens when the
guest wants to see them; a step carries its name ("Read
remote-control/client.js", "Run a command") on a line of its own, and
its detail folds away under it. The tool result names the call it belongs to, so the live stream
lends the call's title to the result that follows. The agent
writes Markdown, so the guest sees Markdown - headings, lists, tables,
code - and never the source of it. A message that is a whole HTML document opens in the sandbox
of the file panel instead. A relative path in a message names a file of
the project, and the guest opens it in the panel.

The panel is the guest's own width: they drag its edge, and the width
stays where they left it. The conversation steps aside for it, and on a
phone the panel takes the whole screen. The files column beside the
conversation folds away and opens again, and it takes a width of its own
the same way.

An HTML document opens in a sandbox that lets the document run its own
scripts and answer a click, but gives it no same origin: it cannot reach
the guest's session, its storage or the page around it.

A document that carries a mermaid diagram is drawn as one. The library is
five megabytes, so it arrives only when a document asks for a diagram:
the host serves it through `GET /share/<id>/api/asset?name=mermaid`,
behind the same passcode gate as the other guest routes, cached for a
day. A host without the library keeps the code as code.

The files the guest reads are coloured, by the language their extension names:
`src/share-highlight.js` holds the highlighter, and it is a plain function
without a closure — the page injects its own source into the browser and the
tests run it here. It escapes the text before it colours it, so a file can
never write markup into the page.

The guest cookie is `dsh-share-<id>`, and its value is
`<issuedAt>.<HMAC-SHA256(device secret, "share:<id>:<issuedAt>")>` in base64url.
The timestamp travels with the HMAC because the HMAC covers it: a guest cannot
move it, and the server needs it to know how old the cookie is. The cookie is
`HttpOnly`, `SameSite=Lax`, `Path=/share/<id>` and lives for a day.

Five wrong passcodes lock the caller out for ten minutes. The lock belongs to
the caller — the relay forwards the phone's address in `x-forwarded-for`, so a
stranger cannot lock the owner out of their own link.

### The room of a share

A share is a room. The Host serves the event stream of every guest, so it is
already the one place where the guests of a share meet: each of them says
what it has open, and the Host hands every change to all of them.

Three things keep the guests out of each other's way:

- **A file belongs to one guest at a time.** A guest that takes a file for
  editing holds it, and the others are told who holds it.
- **A save is guarded.** The file travels with its version, and the Host
  writes with that version in hand: when the file moved on — the agent's
  work, most of the time — the save is refused, the guest keeps its text and
  is shown what the file holds now.
- **A file that changes is read again.** The Host watches the files the
  guests have open, and a guest that looks at a file sees it change under
  them instead of working on a text that is no longer there.

### The owner sees the room

The owner of a shared conversation is not a guest of it: it holds the
conversation and does not write in it. It still has to see who is in the room
and who is writing, because that is the one thing that says whether somebody
is there at all.

So the owner gets the room of every share of its conversation, in the right
corner of the conversation header. The widget is **folded away by default**:
the header of a conversation is the app's own, and a sentence about the
guests does not belong in it while the owner is working. What stays in the
header is a small pill of faces — and the sign of a guest that is writing,
because that is the one thing that must not wait for a click. A click opens
the panel: every guest, its name, and the file it has open.

- **Who is there.** Every guest of every share of the conversation, with the
  face it has everywhere else: the colour of a guest follows its id, so the
  dot of the guest in the room, the cursor of the guest in a document and the
  face of the guest in the header are one and the same colour.
- **Who is writing.** A guest says that it is writing while it types, and says
  that it stopped when it stops. The words of a guest expire on their own
  after six seconds: a guest that closes its tab in the middle never says
  that it stopped, and the sign of a guest that is gone must not stay behind.
- **A name, not an id.** The guest names itself in the header of its own
  page, and the name is what the owner sees. It is kept in the storage of the
  browser of the guest, so it is still there the next time.

The room of the owner is a **stream**, not a poll: `GET
/api/remote-control/presence?sessionId=…` is one answer that never ends, and
every change of the room is one frame of it. The route is behind the browser
session of the owner, like every other route of the owner. The Host says that
it is alive every twenty seconds, because a stream that says nothing for a
while is cut by the proxies between the browser and the Host.

The guest sees the same room on its own page: the panel of the side column
lists the other guests and marks the one that is writing.

### The queue of a conversation

The Host digests the messages of a conversation one at a time: the agent works
on one message, and the messages that arrive while it works wait behind it.
The plugin keeps that queue itself — the Host does not tell a plugin what is
waiting, and the Host cuts a message when several of them wait at the same
time (see `docs/bugs/2026-11-02-queued-user-prompts-are-truncated.md`).

So the message of a guest is **queued**, not delivered:

- `POST /share/<id>/api/message` puts the message in the queue and answers
  `{ ok: true, queued: true, id, position }`. The composer of the guest clears
  at once, and the message appears in the transcript when the Host records it.
- The queue hands the Host **one message at a time**: the next message waits
  until the turn of the agent has ended, so the Host never holds more than one
  message waiting and a message is never cut on its way in.
- The queue is told to every guest of the share at the same moment. The bar
  above the composer says what the agent works on, what waits behind it, and
  whose words those are — a guest sees their own message waiting.

The queue reads the turn boundaries of the shared session (`turn/start` and
`turn/end`) out of the event stream it already follows, so it knows when the
agent is free without asking the agent anything. A message the agent does not
take within a minute is let go, and the queue moves on: a guest waits for the
agent, never forever.

### The guests edit one document together

A file the guests edit together is a **document**: every guest holds the same
one, every change of one guest reaches the others, and the cursors travel
with it. The document is a CRDT (Yjs), so two guests may write the same
place at the same moment without either of them losing the other's text.

The Host keeps the document, because the Host is where the guests of a share
meet. The library travels to the browser as one file the Host serves
(`GET /share/<id>/api/asset?name=yjs`), the same way the diagram library does.

The document is written to the file when the guests stop typing, and the
write is guarded by the version the text was based on: when the agent wrote
the file in the meantime, the write is refused, the document starts again
from the file as it is now, and the guests are told that what they had was
set aside. The agent never joins the document — it is not a CRDT — so the
guard, not a merge, is what keeps the two apart.

### The history of a conversation

Every share is a record of its own, and the records stay: the Settings page
lists the shares of **every** conversation, with the state of each link
(active or revoked), and the Share dialog carries a **History** button that
shows the shares of the conversation at hand — every link, every passcode,
every permission, and whether the link still works.

### A guest annotates a document

The guest of a shared conversation picks a passage of a document, writes
what has to change there, and the model is asked for the wording of the
annotation. The guest reads the draft and sends it into the conversation
when the wording is right — with the file, the passage and the
annotation, so the agent knows what is being talked about.

The drafting is the one of the Markdown preview plugin, moved here so
that a guest may use it too: the Host owns the model, the page only
speaks HTTP to it.

Picking a passage offers a small pill next to it — and only the pill. The
panel waits for the guest to ask for it: a panel that opens over a document
nobody asked about is an interruption, and it takes the focus away from the
passage that was picked. The pill goes when the passage goes, and the panel
stays while the guest writes in it — the writing is worth more than the
offer.

The panel carries the passage it is about, so the guest sees what is being
talked about, and it says what it is for. Nothing of it is louder than the
document it belongs to: the colours are the page's own, the controls are
24 pixels wide, and every one of them carries a name for the screen reader.

### A write that is refused does not take the writing with it

The file of a project moves on while a guest is writing in it — the agent
rewrote it, or another guest saved it. The write is refused, and the text
of the guest is **not** thrown away: the document keeps it, the guest is
told that it did not reach the file, and one button puts it there.

A text that vanishes without a word is a text that is lost, and the writing
of a guest is worth more than the tidiness of the file.

### A guest may send a picture or a file

The composer of the guest carries a paperclip. A picture goes into the
message as it is, and the Host keeps it; any other file is uploaded first
and the receipt of that upload goes into the message. A file the Host
will not take does not take the message with it: the words still arrive.

### The project boundary is the plugin's job

The host does **not** confine a plugin's file reads: `ctx.workspaceFiles` reads
whatever the filesystem can reach, and the sandbox policy governs the agent's
tool calls, not the plugin's own code. The share therefore resolves every guest
path itself:

1. a guest path is always **relative** to the project root — an absolute path
   is refused outright;
2. `ctx.fs.lstat(path, {cwd: root})` looks at the path *before* the resolution
   follows its last component, so a symlink is seen as a symlink;
3. `ctx.fs.resolve(path, {cwd: root})` turns the path into the filesystem's own
   identity, resolving the ancestors as well;
4. `ctx.fs.contains(root, target)` compares that identity with the root's, by
   path segment — so a directory that merely starts with the root's name is
   outside it;
5. the size is capped.

Every failure answers `403` and says nothing about whether the path exists. The
root is the session's own `cwd`, snapshotted when the share was created; a
session's directory never moves afterwards.

### The relay hears about the shares

The management channel carries two new frames:

```
{ type: 'share_publish', share_id, device_id, revoked }
{ type: 'share_revoke',  share_id, device_id }
```

and the `register` frame carries `shares: [{id, revoked}]`, so a relay that
restarted learns the guest links again.

A guest request never receives the launch token, and a refused guest session is
never retried with one: the token is the owner's credential, and a guest that
could trade it in would be the owner.

### The relay serves the link

The relay routes `/s/<id>` to the device and forwards it to the host as
`/share/<id>`.

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
* A share is **not** an owner: the guest cookie is signed with the device
  secret and carries no host credential. The guest sees one session, and the
  files it may read are confined to that session's project directory by the
  plugin.
* The share records carry the passcodes in the clear, so the file is `0600`
  and lives beside the device secret.
* A relay deployment should sit behind TLS. Plain HTTP leaks the session
  cookie to anyone on the path.
