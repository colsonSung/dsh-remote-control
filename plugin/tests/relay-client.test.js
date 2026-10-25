/**
 * Relay client tests.
 *
 * A fake relay (a `ws` WebSocketServer) plays the cloud side of the protocol:
 * it accepts the management + tunnel channels, acknowledges the registration
 * and replays the phone's traffic. A fake upstream HTTP server plays the local
 * DSH server.
 *
 * Run with: `node --test tests/relay-client.test.js`
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { test } from 'node:test'

import { WebSocketServer } from 'ws'

import { createRelayClient } from '../src/relay-client.js'
import {
  abortFrame,
  decodeFrame,
  encodeFrame,
  registerAckFrame,
  registerNakFrame,
  requestFrame,
  revokeFrame,
  upgradeFrame,
  wsFrame,
} from '../src/relay-protocol.js'

const DEVICE_ID = 'device-1234'
const TOKEN = 'test-token'
const LAUNCH_TOKEN = 'launch-secret'
const PUBLIC_URL = `https://relay.example/d/${DEVICE_ID}`

/* --------------------------------------------------------------- utilities */

/** Collects the frames a socket sends and lets a test await a specific one. */
class FrameInbox {
  /** @param {import('ws').WebSocket} socket */
  constructor(socket) {
    this.socket = socket
    /** @type {Record<string, unknown>[]} */
    this.frames = []
    /** @type {{ predicate: Function, resolve: Function, timer: NodeJS.Timeout }[]} */
    this.waiters = []

    socket.on('message', (data) => {
      let frame
      try {
        frame = decodeFrame(data.toString())
      } catch {
        return
      }
      const index = this.waiters.findIndex((waiter) => waiter.predicate(frame))
      if (index !== -1) {
        const [waiter] = this.waiters.splice(index, 1)
        clearTimeout(waiter.timer)
        waiter.resolve(frame)
      } else {
        this.frames.push(frame)
      }
    })
  }

  /**
   * @param {(frame: Record<string, unknown>) => boolean} [predicate]
   * @param {number} [timeoutMs]
   * @returns {Promise<Record<string, unknown>>}
   */
  next(predicate = () => true, timeoutMs = 8_000) {
    const index = this.frames.findIndex(predicate)
    if (index !== -1) return Promise.resolve(this.frames.splice(index, 1)[0])
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null }
      waiter.timer = setTimeout(() => {
        const at = this.waiters.indexOf(waiter)
        if (at !== -1) this.waiters.splice(at, 1)
        reject(new Error('timed out waiting for a frame'))
      }, timeoutMs)
      this.waiters.push(waiter)
    })
  }

  /**
   * @param {(frame: Record<string, unknown>) => boolean} predicate
   * @returns {Record<string, unknown>|undefined}
   */
  find(predicate) {
    return this.frames.find(predicate)
  }
}

/** The fake relay: management + tunnel channels over one HTTP server. */
class FakeRelay extends EventEmitter {
  constructor() {
    super()
    this.server = http.createServer((req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not a websocket')
    })
    this.wss = new WebSocketServer({ noServer: true })
    /** @type {any} */
    this.management = null
    /** @type {any} */
    this.tunnel = null
    /** @type {FrameInbox|null} */
    this.managementInbox = null
    /** @type {FrameInbox|null} */
    this.tunnelInbox = null
    /** @type {any} */
    this.managementRequest = null
    /** @type {any} */
    this.tunnelRequest = null
    /** @type {Record<string, unknown>[]} */
    this.registrations = []
    /** @type {string[]} */
    this.urls = []
    /** @type {string|null} when set, the relay refuses the registration */
    this.nakReason = null

    this.server.on('upgrade', (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req)
      })
    })

    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url, 'http://relay.local')
      this.urls.push(url.pathname)
      if (url.pathname === '/v1/remote/create') {
        this.management = ws
        this.managementRequest = req
        this.managementInbox = new FrameInbox(ws)
        this.managementInbox
          .next((frame) => frame.type === 'register')
          .then((frame) => {
            this.registrations.push(frame)
            if (this.nakReason) {
              ws.send(encodeFrame(registerNakFrame(this.nakReason)))
              return
            }
            ws.send(
              encodeFrame(
                registerAckFrame({
                  deviceId: /** @type {string} */ (frame.device_id),
                  publicUrl: PUBLIC_URL,
                }),
              ),
            )
          })
          .catch(() => {})
        this.emit('management', ws, this.managementInbox)
      } else if (url.pathname === '/v1/remote/http') {
        this.tunnel = ws
        this.tunnelRequest = req
        this.tunnelInbox = new FrameInbox(ws)
        this.emit('tunnel', ws, this.tunnelInbox)
      }
    })
  }

  async listen() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    this.port = typeof address === 'object' && address ? address.port : 0
    this.url = `ws://127.0.0.1:${this.port}`
    return this.url
  }

  /**
   * @param {'management'|'tunnel'} kind
   * @returns {Promise<FrameInbox>}
   */
  waitFor(kind) {
    return new Promise((resolve) => {
      const onReady = (ws, inbox) => {
        if (kind === 'management' && this.management !== ws) return
        if (kind === 'tunnel' && this.tunnel !== ws) return
        resolve(inbox)
      }
      if (kind === 'management' && this.managementInbox) {
        resolve(this.managementInbox)
        return
      }
      if (kind === 'tunnel' && this.tunnelInbox) {
        resolve(this.tunnelInbox)
        return
      }
      this.on(kind, onReady)
    })
  }

  async close() {
    for (const ws of this.wss.clients) {
      try {
        ws.terminate()
      } catch {
        /* ignore */
      }
    }
    await new Promise((resolve) => this.wss.close(() => resolve(undefined)))
    this.server.closeAllConnections?.()
    await new Promise((resolve) => this.server.close(() => resolve(undefined)))
  }
}

/** The fake local DSH server. */
class FakeUpstream {
  /**
   * @param {(req: any, res: any, index: number) => void} [handler]
   */
  constructor(handler) {
    this.requests = []
    /** @type {any[]} */
    this.aborted = []
    this.server = http.createServer((req, res) => {
      const index = this.requests.length
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('aborted', () => this.aborted.push(index))
      // The response is closed without being finished when the caller aborts
      // the in-flight request.
      res.on('close', () => {
        if (!res.writableFinished) this.aborted.push(index)
      })
      req.on('end', () => {
        this.requests.push({
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
        if (handler) handler(req, res, index)
        else {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, path: req.url }))
        }
      })
    })
  }

  async listen() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    this.port = typeof address === 'object' && address ? address.port : 0
    this.url = `http://127.0.0.1:${this.port}`
    return this.url
  }

  async close() {
    this.server.closeAllConnections?.()
    await new Promise((resolve) => this.server.close(() => resolve(undefined)))
  }
}

/** Create a client wired to the fake relay and the fake upstream. */
function makeClient(overrides = {}) {
  return createRelayClient({
    relayUrl: overrides.relayUrl,
    token: TOKEN,
    deviceId: DEVICE_ID,
    alias: 'Test-Mac.local',
    platform: 'darwin',
    clientVersion: '1.0.0',
    localBaseUrl: overrides.localBaseUrl,
    launchToken: LAUNCH_TOKEN,
    log: overrides.log,
    ...(overrides.tuning || {}),
  })
}

/* ------------------------------------------------------------------ tests */

test('registers with the relay and publishes the public URL', async (t) => {
  const relay = new FakeRelay()
  const upstream = new FakeUpstream()
  await relay.listen()
  await upstream.listen()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const client = makeClient({ relayUrl: relay.url, localBaseUrl: upstream.url })
  t.after(() => client.stop())

  const states = []
  const unsubscribe = client.on('status', (status) => states.push(status.state))

  await client.start()

  assert.equal(client.status().state, 'online')
  assert.equal(client.status().publicUrl, PUBLIC_URL)
  assert.equal(client.status().error, null)

  // The management channel carried the credential and the bearer subprotocol.
  assert.equal(relay.managementRequest.headers.authorization, `Bearer ${TOKEN}`)
  assert.equal(
    relay.managementRequest.headers['sec-websocket-protocol'],
    `kimi-code.bearer.${TOKEN}`,
  )

  // The registration frame describes this device.
  assert.equal(relay.registrations.length, 1)
  const registration = relay.registrations[0]
  assert.equal(registration.device_id, DEVICE_ID)
  assert.equal(registration.alias, 'Test-Mac.local')
  assert.equal(registration.platform, 'darwin')
  assert.equal(registration.client_version, '1.0.0')
  assert.equal(registration.local_base_url, upstream.url)

  // Both channels are open on the relay.
  await relay.waitFor('tunnel')
  assert.ok(relay.urls.includes('/v1/remote/create'))
  assert.ok(relay.urls.includes('/v1/remote/http'))

  assert.ok(states.includes('connecting'))
  assert.ok(states.includes('online'))

  unsubscribe()
  await client.stop()
  assert.equal(client.status().state, 'offline')
})

test('serves a tunnel request, injects the launch token on the root path', async (t) => {
  const relay = new FakeRelay()
  const upstream = new FakeUpstream()
  await relay.listen()
  await upstream.listen()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const client = makeClient({ relayUrl: relay.url, localBaseUrl: upstream.url })
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(
      requestFrame({
        id: 'req-root',
        method: 'GET',
        path: '/',
        headers: {
          host: 'relay.example',
          origin: 'https://relay.example',
          cookie: 'dsh_hint=1',
          'sec-fetch-site': 'same-origin',
          accept: 'text/html',
          connection: 'upgrade',
          'accept-encoding': 'gzip, deflate',
        },
        body: null,
      }),
    ),
  )

  const response = await tunnel.next((frame) => frame.type === 'response')
  assert.equal(response.id, 'req-root')
  assert.equal(response.status, 200)
  assert.equal(response.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(Buffer.from(response.body, 'base64').toString('utf8')), {
    ok: true,
    path: '/?token=launch-secret',
  })

  // The upstream request was rewritten for the local server.
  assert.equal(upstream.requests.length, 1)
  const upstreamRequest = upstream.requests[0]
  assert.equal(upstreamRequest.method, 'GET')
  assert.equal(upstreamRequest.url, '/?token=launch-secret')
  assert.equal(upstreamRequest.headers.host, `127.0.0.1:${upstream.port}`)
  assert.equal(upstreamRequest.headers.origin, `http://127.0.0.1:${upstream.port}`)
  assert.equal(upstreamRequest.headers['accept-encoding'], 'identity')
  assert.equal(upstreamRequest.headers.cookie, 'dsh_hint=1')
  assert.equal(upstreamRequest.headers['sec-fetch-site'], 'same-origin')
  assert.equal(upstreamRequest.headers.accept, 'text/html')
  // The hop-by-hop headers of the phone are dropped, not forwarded.
  assert.notEqual(upstreamRequest.headers.connection, 'upgrade')
  assert.equal(upstreamRequest.headers['accept-encoding'], 'identity')
})

test('never injects the launch token on a non-root path', async (t) => {
  const relay = new FakeRelay()
  const upstream = new FakeUpstream()
  await relay.listen()
  await upstream.listen()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const client = makeClient({ relayUrl: relay.url, localBaseUrl: upstream.url })
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(
      requestFrame({
        id: 'req-api',
        method: 'POST',
        path: '/api/rpc?x=1',
        headers: { origin: 'https://relay.example', 'content-type': 'application/json' },
        body: Buffer.from('{"method":"ping"}', 'utf8').toString('base64'),
      }),
    ),
  )

  const response = await tunnel.next((frame) => frame.type === 'response')
  assert.equal(response.id, 'req-api')
  assert.equal(response.status, 200)

  assert.equal(upstream.requests.length, 1)
  const upstreamRequest = upstream.requests[0]
  assert.equal(upstreamRequest.url, '/api/rpc?x=1')
  assert.equal(upstreamRequest.headers.origin, `http://127.0.0.1:${upstream.port}`)
  assert.equal(upstreamRequest.headers['content-type'], 'application/json')
  assert.equal(upstreamRequest.body, '{"method":"ping"}')
})

test('treats /<deviceId>/ as the device root and forwards it as /', async (t) => {
  const relay = new FakeRelay()
  const upstream = new FakeUpstream()
  await relay.listen()
  await upstream.listen()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const client = makeClient({ relayUrl: relay.url, localBaseUrl: upstream.url })
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(
      requestFrame({
        id: 'req-device-root',
        method: 'GET',
        path: `/${DEVICE_ID}/`,
        headers: {},
        body: null,
      }),
    ),
  )

  await tunnel.next((frame) => frame.type === 'response')
  assert.equal(upstream.requests.length, 1)
  assert.equal(upstream.requests[0].url, '/?token=launch-secret')
})

test('does not inject the launch token once the phone has a session cookie', async (t) => {
  const relay = new FakeRelay()
  const upstream = new FakeUpstream()
  await relay.listen()
  await upstream.listen()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const client = makeClient({ relayUrl: relay.url, localBaseUrl: upstream.url })
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  // The phone already holds the signed session cookie: the host must not
  // trade the launch token in again, or the server would answer a fresh
  // redirect on every load and the phone would loop forever.
  tunnel.socket.send(
    encodeFrame(
      requestFrame({
        id: 'req-with-cookie',
        method: 'GET',
        path: '/',
        headers: { cookie: 'dsh-auth-abc123=signed-session; Path=/' },
        body: null,
      }),
    ),
  )

  await tunnel.next((frame) => frame.type === 'response')
  assert.equal(upstream.requests.length, 1)
  assert.equal(upstream.requests[0].url, '/')
  assert.equal(upstream.requests[0].headers.cookie, 'dsh-auth-abc123=signed-session; Path=/')
})

test('injects the launch token when the cookie is not a session cookie', async (t) => {
  const relay = new FakeRelay()
  const upstream = new FakeUpstream()
  await relay.listen()
  await upstream.listen()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const client = makeClient({ relayUrl: relay.url, localBaseUrl: upstream.url })
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(
      requestFrame({
        id: 'req-other-cookie',
        method: 'GET',
        path: '/',
        headers: { cookie: 'theme=dark; dsh-hint=1' },
        body: null,
      }),
    ),
  )

  await tunnel.next((frame) => frame.type === 'response')
  assert.equal(upstream.requests.length, 1)
  assert.equal(upstream.requests[0].url, '/?token=launch-secret')
})

test('keeps an existing token query parameter untouched', async (t) => {
  const relay = new FakeRelay()
  const upstream = new FakeUpstream()
  await relay.listen()
  await upstream.listen()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const client = makeClient({ relayUrl: relay.url, localBaseUrl: upstream.url })
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(
      requestFrame({
        id: 'req-token',
        method: 'GET',
        path: '/?token=phone-token&x=2',
        headers: {},
        body: null,
      }),
    ),
  )

  await tunnel.next((frame) => frame.type === 'response')
  assert.equal(upstream.requests.length, 1)
  assert.equal(upstream.requests[0].url, '/?token=phone-token&x=2')
})

test('aborts the in-flight upstream request on an abort frame', async (t) => {
  const relay = new FakeRelay()
  const upstream = new FakeUpstream((req, res) => {
    if (req.url.startsWith('/slow')) return // never answers
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await relay.listen()
  await upstream.listen()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const client = makeClient({ relayUrl: relay.url, localBaseUrl: upstream.url })
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(
      requestFrame({
        id: 'req-slow',
        method: 'GET',
        path: '/slow',
        headers: {},
        body: null,
      }),
    ),
  )

  // Wait until the upstream request actually reached the server.
  await new Promise((resolve) => setTimeout(resolve, 150))
  tunnel.socket.send(encodeFrame(abortFrame('req-slow')))

  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(upstream.aborted.length, 1)
  assert.equal(tunnel.find((frame) => frame.type === 'response'), undefined)
})

test('bridges a websocket upgrade to the local server', async (t) => {
  const relay = new FakeRelay()
  const upstream = new FakeUpstream()
  await relay.listen()
  await upstream.listen()

  // A websocket endpoint on the local DSH server.
  const localWss = new WebSocketServer({ server: upstream.server, path: '/ws' })
  /** @type {any[]} */
  const localHandshakes = []
  localWss.on('connection', (ws, req) => {
    localHandshakes.push(req.headers)
    ws.on('message', (data) => ws.send(`echo:${data.toString()}`))
  })
  t.after(async () => {
    for (const ws of localWss.clients) {
      try {
        ws.terminate()
      } catch {
        /* ignore */
      }
    }
    await new Promise((resolve) => localWss.close(() => resolve(undefined)))
    await relay.close()
    await upstream.close()
  })

  const client = makeClient({ relayUrl: relay.url, localBaseUrl: upstream.url })
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(
      upgradeFrame({
        id: 'ws-1',
        path: '/ws',
        headers: {
          host: 'relay.example',
          origin: 'https://relay.example',
          cookie: 'dsh_session=abc',
          'sec-websocket-protocol': 'kimi-code.bearer.phone',
        },
      }),
    ),
  )

  const upgraded = await tunnel.next((frame) => frame.type === 'upgraded')
  assert.equal(upgraded.id, 'ws-1')

  // The local handshake carried the rewritten headers.
  assert.equal(localHandshakes.length, 1)
  assert.equal(localHandshakes[0].host, `127.0.0.1:${upstream.port}`)
  assert.equal(localHandshakes[0].origin, `http://127.0.0.1:${upstream.port}`)
  assert.equal(localHandshakes[0].cookie, 'dsh_session=abc')

  // Phone -> host -> local server.
  tunnel.socket.send(
    encodeFrame(wsFrame({ id: 'ws-1', data: Buffer.from('ping', 'utf8').toString('base64') })),
  )
  const echoed = await tunnel.next(
    (frame) => frame.type === 'ws_frame' && frame.id === 'ws-1',
  )
  assert.equal(Buffer.from(echoed.data, 'base64').toString('utf8'), 'echo:ping')
})

test('answers a failed websocket upgrade with a 502 response frame', async (t) => {
  const relay = new FakeRelay()
  await relay.listen()
  t.after(async () => {
    await relay.close()
  })

  // Nothing listens on this port: the local connection must fail.
  const dead = new FakeUpstream()
  await dead.listen()
  const deadPort = dead.port
  await dead.close()

  const client = makeClient({
    relayUrl: relay.url,
    localBaseUrl: `http://127.0.0.1:${deadPort}`,
  })
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(upgradeFrame({ id: 'ws-dead', path: '/ws', headers: {} })),
  )

  const response = await tunnel.next(
    (frame) => frame.type === 'response' && frame.id === 'ws-dead',
  )
  assert.equal(response.status, 502)
})

test('answers an unreachable upstream with a 502 response frame', async (t) => {
  const relay = new FakeRelay()
  await relay.listen()
  t.after(async () => {
    await relay.close()
  })

  const dead = new FakeUpstream()
  await dead.listen()
  const deadPort = dead.port
  await dead.close()

  const client = makeClient({
    relayUrl: relay.url,
    localBaseUrl: `http://127.0.0.1:${deadPort}`,
  })
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(requestFrame({ id: 'req-dead', method: 'GET', path: '/', headers: {}, body: null })),
  )

  const response = await tunnel.next(
    (frame) => frame.type === 'response' && frame.id === 'req-dead',
  )
  assert.equal(response.status, 502)
})

test('reconnects and re-registers when the relay drops the management channel', async (t) => {
  const relay = new FakeRelay()
  const upstream = new FakeUpstream()
  await relay.listen()
  await upstream.listen()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const client = makeClient({
    relayUrl: relay.url,
    localBaseUrl: upstream.url,
    tuning: { reconnectBaseDelayMs: 30, reconnectMaxDelayMs: 100 },
  })
  t.after(() => client.stop())

  await client.start()
  await relay.waitFor('management')
  assert.equal(relay.registrations.length, 1)

  const states = []
  client.on('status', (status) => states.push(status.state))

  // The relay drops the management channel.
  relay.management.terminate()

  await new Promise((resolve) => setTimeout(resolve, 600))

  // The client came back on its own and registered again.
  assert.equal(relay.registrations.length, 2)
  assert.equal(client.status().state, 'online')
  assert.ok(states.includes('connecting'))
  assert.ok(states.includes('online'))
})

test('goes offline when the relay revokes the device', async (t) => {
  const relay = new FakeRelay()
  const upstream = new FakeUpstream()
  await relay.listen()
  await upstream.listen()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const client = makeClient({
    relayUrl: relay.url,
    localBaseUrl: upstream.url,
    tuning: { reconnectBaseDelayMs: 30, reconnectMaxDelayMs: 100 },
  })
  t.after(() => client.stop())

  await client.start()
  await relay.waitFor('management')

  const revocations = []
  client.on('revoke', (reason) => revocations.push(reason))

  relay.management.send(encodeFrame(revokeFrame('quota exceeded')))

  await new Promise((resolve) => setTimeout(resolve, 300))

  assert.equal(client.status().state, 'offline')
  assert.equal(client.status().error, 'quota exceeded')
  assert.deepEqual(revocations, ['quota exceeded'])

  // A revoked device does not come back on its own.
  const registrationsAfterRevoke = relay.registrations.length
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(relay.registrations.length, registrationsAfterRevoke)
})

test('fails start() when the relay refuses the device', async (t) => {
  const relay = new FakeRelay()
  const upstream = new FakeUpstream()
  await relay.listen()
  await upstream.listen()
  relay.nakReason = 'device limit reached'
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const client = makeClient({
    relayUrl: relay.url,
    localBaseUrl: upstream.url,
    tuning: { reconnectBaseDelayMs: 30, reconnectMaxDelayMs: 100 },
  })
  t.after(() => client.stop())

  await assert.rejects(() => client.start(), /device limit reached/)

  assert.equal(client.status().state, 'error')
  assert.equal(client.status().error, 'device limit reached')
  assert.equal(client.status().publicUrl, null)
})
