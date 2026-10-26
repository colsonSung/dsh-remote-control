/**
 * The phone's stream must survive a session the local server refuses.
 *
 * The Harness app binds its browser-session cookie to one authority, and the
 * desktop app moves that authority on every restart (the web server listens on
 * an ephemeral port). The cookie the phone kept is then worth nothing: the
 * HTTP path recovers by trading in the launch token, but the WebSocket
 * upgrade had no way back — the phone sat on an empty screen until it
 * reloaded the page.
 *
 * These tests drive the host with a local server that refuses the first
 * handshake and check that the host mints a fresh cookie and tries again.
 *
 * Run with: `node --test tests/upgrade-recovery.test.js`
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { test } from 'node:test'

import { WebSocket as NodeWebSocket, WebSocketServer } from 'ws'

import { createRelayClient } from '../src/relay-client.js'
import {
  decodeFrame,
  encodeFrame,
  registerAckFrame,
  upgradeFrame,
} from '../src/relay-protocol.js'

const DEVICE_ID = 'device-recovery'
const TOKEN = 'test-token'
const LAUNCH_TOKEN = 'launch-secret'
const PUBLIC_URL = `https://relay.example/d/${DEVICE_ID}`
const FRESH_COOKIE = 'dsh-auth-test=fresh-session'

/**
 * Collects the frames a socket sends and lets a test await a specific one.
 */
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
}

/**
 * A fake relay: it plays the cloud side of the tunnel.
 */
class FakeRelay extends EventEmitter {
  constructor() {
    super()
    this.server = http.createServer((req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not a websocket')
    })
    this.wss = new WebSocketServer({ noServer: true })
    /** @type {FrameInbox|null} */
    this.tunnelInbox = null

    this.server.on('upgrade', (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req)
      })
    })

    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url, 'http://relay.local')
      if (url.pathname === '/v1/remote/create') {
        const inbox = new FrameInbox(ws)
        inbox
          .next((frame) => frame.type === 'register')
          .then((frame) => {
            ws.send(
              encodeFrame(
                registerAckFrame({
                  deviceId: /** @type {string} */ (frame.device_id),
                  publicUrl: PUBLIC_URL,
                  capabilities: [],
                }),
              ),
            )
          })
          .catch(() => {})
        this.emit('management', ws)
      } else if (url.pathname === '/v1/remote/http') {
        this.tunnelInbox = new FrameInbox(ws)
        this.emit('tunnel', ws)
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
      const onReady = () => {
        const inbox = kind === 'management' ? null : this.tunnelInbox
        if (inbox) resolve(inbox)
        else this.on(kind, onReady)
      }
      onReady()
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

/**
 * A stand-in for the WebSocket of the local DSH server.
 */
class FakeLocalSocket extends EventEmitter {
  /**
   * @param {string} url the URL the host dialed
   * @param {string[]} [protocols]
   * @param {Record<string, unknown>} [options]
   */
  constructor(url, protocols, options) {
    super()
    this.url = url
    this.protocols = protocols ?? []
    this.options = options ?? {}
    this.readyState = FakeLocalSocket.CONNECTING
  }

  open() {
    this.readyState = FakeLocalSocket.OPEN
    this.emit('open')
  }

  /**
   * The local server refuses the handshake with a status.
   *
   * @param {number} statusCode
   */
  refuse(statusCode) {
    this.readyState = FakeLocalSocket.CLOSED
    this.emit('unexpected-response', { headers: {} }, { statusCode })
  }

  /**
   * @param {string | Buffer} payload
   * @param {boolean} [isBinary]
   */
  deliver(payload, isBinary = false) {
    this.emit('message', payload, isBinary)
  }

  /**
   * @param {string | Buffer} payload
   * @param {{ binary?: boolean }} [options]
   */
  send(payload, options) {
    void payload
    void options
  }

  /** @param {number} [code] */
  close(code = 1000) {
    this.readyState = FakeLocalSocket.CLOSED
    this.emit('close', code, Buffer.alloc(0))
  }

  terminate() {
    this.close(1006)
  }

  ping() {}

  pong() {}
}

FakeLocalSocket.CONNECTING = 0
FakeLocalSocket.OPEN = 1
FakeLocalSocket.CLOSING = 2
FakeLocalSocket.CLOSED = 3

/**
 * The local DSH server: it mints a cookie when it is asked with the launch
 * token, and refuses every other request.
 */
class FakeUpstream {
  constructor() {
    /** @type {string[]} the paths the host asked for */
    this.requested = []
    this.server = http.createServer((req, res) => {
      this.requested.push(String(req.url))
      if (String(req.url).includes('token=')) {
        res.writeHead(303, {
          'set-cookie': `${FRESH_COOKIE}; Path=/; HttpOnly`,
          location: './',
        })
        res.end()
        return
      }
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized')
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

/**
 * Build the host with a fake local socket.
 *
 * @param {string} relayUrl
 * @param {string} localBaseUrl
 * @returns {{ client: any, localSockets: FakeLocalSocket[] }}
 */
function makeHost(relayUrl, localBaseUrl) {
  const authority = new URL(localBaseUrl).host
  const prefix = `ws://${authority}/`
  /** @type {FakeLocalSocket[]} */
  const localSockets = []

  class HybridWebSocket {
    /**
     * @param {string} url
     * @param {string[]} [protocols]
     * @param {Record<string, unknown>} [options]
     */
    constructor(url, protocols, options) {
      if (typeof url === 'string' && url.startsWith(prefix)) {
        const socket = new FakeLocalSocket(url, protocols, options)
        localSockets.push(socket)
        return socket
      }
      return new NodeWebSocket(url, protocols, options)
    }
  }

  HybridWebSocket.OPEN = NodeWebSocket.OPEN
  HybridWebSocket.CONNECTING = NodeWebSocket.CONNECTING
  HybridWebSocket.CLOSING = NodeWebSocket.CLOSING
  HybridWebSocket.CLOSED = NodeWebSocket.CLOSED

  const client = createRelayClient({
    relayUrl,
    token: TOKEN,
    deviceId: DEVICE_ID,
    alias: 'Test-Mac.local',
    platform: 'darwin',
    clientVersion: '1.0.0',
    localBaseUrl,
    launchToken: LAUNCH_TOKEN,
    log: () => {},
    WebSocketImpl: HybridWebSocket,
  })
  return { client, localSockets }
}

/**
 * Wait for the host to open the local WebSocket.
 *
 * @param {FakeLocalSocket[]} localSockets
 * @param {number} [count] how many sockets to wait for
 * @returns {Promise<FakeLocalSocket>}
 */
async function waitForLocalSocket(localSockets, count = 1) {
  const started = Date.now()
  while (localSockets.length < count) {
    if (Date.now() - started > 5_000) {
      throw new Error('timed out waiting for the host to open the local websocket')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return localSockets[localSockets.length - 1]
}

test('a refused session is recovered with a fresh cookie', async (t) => {
  const relay = new FakeRelay()
  const upstream = new FakeUpstream()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const relayUrl = await relay.listen()
  const localBaseUrl = await upstream.listen()
  const { client, localSockets } = makeHost(relayUrl, localBaseUrl)
  t.after(() => client.stop())
  await client.start()

  const tunnel = await relay.waitFor('tunnel')

  // The phone holds a cookie the local server no longer accepts.
  tunnel.socket.send(
    encodeFrame(
      upgradeFrame({
        id: 'ws-recovery',
        path: '/api/remote.mux',
        headers: { cookie: 'dsh-auth-old=stale-session' },
      }),
    ),
  )

  const first = await waitForLocalSocket(localSockets)
  assert.equal(localSockets.length, 1)

  // The server refuses the handshake.
  first.refuse(401)

  // The host trades the launch token in and tries again.
  const second = await waitForLocalSocket(localSockets, 2)
  assert.notEqual(second, first)
  assert.ok(
    upstream.requested.some((url) => url.includes('token=')),
    `the host must ask for a fresh cookie, asked for ${upstream.requested.join(', ')}`,
  )
  assert.equal(
    second.options?.headers?.cookie,
    FRESH_COOKIE,
    'the retry must carry the fresh cookie',
  )

  second.open()
  const upgraded = await tunnel.next((frame) => frame.type === 'upgraded')
  assert.equal(upgraded.id, 'ws-recovery')
})

test('a handshake that is accepted is not tried twice', async (t) => {
  const relay = new FakeRelay()
  const upstream = new FakeUpstream()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const relayUrl = await relay.listen()
  const localBaseUrl = await upstream.listen()
  const { client, localSockets } = makeHost(relayUrl, localBaseUrl)
  t.after(() => client.stop())
  await client.start()

  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(
      upgradeFrame({
        id: 'ws-plain',
        path: '/api/remote.mux',
        headers: { cookie: 'dsh-auth-old=good-session' },
      }),
    ),
  )

  const socket = await waitForLocalSocket(localSockets)
  socket.open()
  const upgraded = await tunnel.next((frame) => frame.type === 'upgraded')
  assert.equal(upgraded.id, 'ws-plain')

  // Nothing was refused, so nothing is retried and no cookie is minted.
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(localSockets.length, 1)
  assert.deepEqual(upstream.requested, [])
})
