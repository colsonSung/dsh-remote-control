/**
 * Regression tests for the WebSocket compression of the remote-control tunnel.
 *
 * The Harness app carries its session data over one WebSocket ("the mux",
 * `/api/remote.mux`). A session snapshot is megabytes of JSON, and a remote
 * relay is exactly where the bytes are scarce: the same payload crosses the
 * link twice (host to relay, relay to phone). Sending it uncompressed cost
 * seconds per session switch.
 *
 * The fix has three halves, and every half has a test here:
 *
 *   1. the phone announces that it can inflate a compressed payload
 *      (`rcz=1` in the query of its stream URL) and the host takes that
 *      parameter out of the path before it dials the local DSH server,
 *   2. a payload of at least 8 KiB is gzipped, marked with `DSHRC1` and sent
 *      as one binary frame, everything smaller travels as it is,
 *   3. the frames of one stream keep their order, and the relay forwards the
 *      compressed bytes byte for byte (`body_encoding: 'base64'`).
 *
 * Run with: `node --test tests/ws-compression.test.js`
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { test } from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'

import { WebSocket as NodeWebSocket, WebSocketServer } from 'ws'

import { createRelayClient } from '../src/relay-client.js'
import { createRelayServer } from '../src/relay-server.js'
import {
  COMPRESSED_WS_PREFIX,
  COMPRESSION_QUERY,
  decodeFrame,
  encodeFrame,
  isCompressedWsPayload,
  registerAckFrame,
  upgradeFrame,
} from '../src/relay-protocol.js'

const DEVICE_ID = 'device-1234'
const TOKEN = 'test-token'
const RELAY_SECRET = 'relay-secret-value'
const PUBLIC_URL = `https://relay.example/d/${DEVICE_ID}`
const MUX_PATH = '/api/remote.mux'

/** The threshold of the host: a payload of at least 8 KiB is compressed. */
const COMPRESSION_THRESHOLD = 8 * 1024

/* --------------------------------------------------------------- utilities */

/**
 * A session snapshot: JSON that compresses well.
 *
 * The function is deterministic, so the harness and the assertion can compare
 * the inflated payload with the original.
 *
 * @param {number} [minimumBytes]
 * @returns {string}
 */
function snapshotPayload(minimumBytes = COMPRESSION_THRESHOLD) {
  const unit = JSON.stringify({
    type: 'session.snapshot',
    messages: Array.from({ length: 20 }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: 'the quick brown fox jumps over the lazy dog '.repeat(4),
    })),
  })
  return unit.repeat(Math.ceil(minimumBytes / unit.length) + 1)
}

/**
 * Reserve a free TCP port.
 * @returns {Promise<number>}
 */
async function freePort() {
  const probe = http.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/**
 * Wait for a condition.
 * @param {() => boolean} predicate
 * @param {string} what the condition describes (for the error message)
 * @param {number} [timeoutMs]
 */
async function waitFor(predicate, what, timeoutMs = 5_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/* ------------------------------------------------------------- fake relay */

/** Collects the frames a socket sends and lets a test await a specific one. */
class FrameInbox {
  /** @param {import('ws').WebSocket} socket */
  constructor(socket) {
    this.socket = socket
    /** @type {Record<string, unknown>[]} */
    this.frames = []
    /** @type {{ predicate: Function, resolve: Function, timer: NodeJS.Timeout }[]} */
    this.waiters = []

    socket.on('message', (data, isBinary) => {
      // The flag tells a binary message apart from a text frame; a text frame
      // that arrives in one piece is handed over as a Buffer, too.
      if (isBinary === true) return
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
    this.wss = new WebSocketServer({
      noServer: true,
      // Echo the bearer subprotocol the host offers.
      handleProtocols: (protocols) => protocols.values().next().value ?? false,
    })
    /** @type {any} */
    this.management = null
    /** @type {any} */
    this.tunnel = null
    /** @type {FrameInbox|null} */
    this.managementInbox = null
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
        this.management = ws
        this.managementInbox = new FrameInbox(ws)
        this.managementInbox
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
        this.tunnel = ws
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
        const inbox = kind === 'management' ? this.managementInbox : this.tunnelInbox
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

/* ------------------------------------------------- the fake local server */

/**
 * A stand-in for the WebSocket of the local DSH server.
 *
 * The host dials the local server through its `WebSocketImpl` seam, so a fake
 * socket lets a test decide exactly what the local server says and when.
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
    /** @type {{ payload: Buffer, binary: boolean }[]} what the host wrote */
    this.written = []
  }

  /** The handshake finished. */
  open() {
    this.readyState = FakeLocalSocket.OPEN
    this.emit('open')
  }

  /**
   * The local server sends one payload to the phone.
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
    this.written.push({
      payload: Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)),
      binary: options?.binary === true,
    })
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
 * A `WebSocketImpl` that fakes the local server and keeps the real WebSocket
 * for the two relay channels.
 *
 * @param {string} localBaseUrl the base URL of the local DSH server
 */
function makeWebSocketImpl(localBaseUrl) {
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

  return { impl: HybridWebSocket, localSockets }
}

/**
 * Wait for the host to open the local WebSocket.
 * @param {FakeLocalSocket[]} localSockets
 * @returns {Promise<FakeLocalSocket>}
 */
async function waitForLocalSocket(localSockets) {
  await waitFor(() => localSockets.length > 0, 'the host to open the local websocket')
  return localSockets[localSockets.length - 1]
}

/**
 * Build a host that talks to a fake relay and a fake local server.
 *
 * @param {string} relayUrl the URL of the fake relay
 * @param {string} localBaseUrl the base URL of the local DSH server
 * @returns {{ client: any, localSockets: FakeLocalSocket[] }}
 */
function makeHost(relayUrl, localBaseUrl) {
  const { impl, localSockets } = makeWebSocketImpl(localBaseUrl)
  const client = createRelayClient({
    relayUrl,
    token: TOKEN,
    deviceId: DEVICE_ID,
    alias: 'Test-Mac.local',
    platform: 'darwin',
    clientVersion: '1.0.0',
    localBaseUrl,
    log: () => {},
    WebSocketImpl: impl,
  })
  return { client, localSockets }
}

/* ---------------------------------------------------- the real relay (e2e) */

/**
 * A stand-in for the Harness web server: it speaks WebSocket at the mux path
 * and sends the session snapshot when the test asks for it.
 */
async function startFakeHarness() {
  /** @type {Set<any>} */
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    if (req.url === '/emit') {
      for (const socket of sockets) socket.send(snapshotPayload())
      res.writeHead(204)
      res.end()
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith(MUX_PATH)) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      sockets.add(client)
      client.on('close', () => sockets.delete(client))
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const socket of sockets) {
        try {
          socket.terminate()
        } catch {
          /* ignore */
        }
      }
      await new Promise((resolve) => wss.close(() => resolve(undefined)))
      await new Promise((resolve) => server.close(() => resolve(undefined)))
    },
  }
}

/**
 * Open a phone WebSocket against the relay.
 * @param {string} url
 */
function openPhone(url) {
  const socket = new NodeWebSocket(url)
  /** @type {{ data: Buffer, isBinary: boolean }[]} */
  const messages = []
  socket.on('message', (data, isBinary) => {
    messages.push({
      data: Buffer.isBuffer(data) ? data : Buffer.from(data),
      isBinary: isBinary === true,
    })
  })
  const opened = new Promise((resolve, reject) => {
    socket.on('open', () => resolve(socket))
    socket.on('error', reject)
  })
  return { socket, opened, messages }
}

/**
 * Wait for the first message the phone received.
 * @param {{ data: Buffer, isBinary: boolean }[]} messages
 * @param {number} [timeoutMs]
 */
async function waitForMessage(messages, timeoutMs = 5_000) {
  await waitFor(() => messages.length > 0, 'the phone to receive a message', timeoutMs)
  return messages[0]
}

/* ------------------------------------------------------------------ tests */

test('the compression announcement never reaches the local server', async (t) => {
  const relay = new FakeRelay()
  await relay.listen()
  t.after(() => relay.close())

  const localBaseUrl = `http://127.0.0.1:${await freePort()}`
  const { client, localSockets } = makeHost(relay.url, localBaseUrl)
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(
      upgradeFrame({
        id: 'ws-1',
        path: `${MUX_PATH}?${COMPRESSION_QUERY}=1`,
        headers: { host: 'relay.example' },
      }),
    ),
  )

  const local = await waitForLocalSocket(localSockets)

  // The parameter is ours: the local DSH server must never see it.
  assert.ok(
    !local.url.includes(COMPRESSION_QUERY),
    `the local url must not carry ${COMPRESSION_QUERY}: ${local.url}`,
  )
  assert.equal(new URL(local.url).pathname, MUX_PATH)

  // The bridge still compresses.
  local.open()
  await tunnel.next((frame) => frame.type === 'upgraded')

  const payload = snapshotPayload()
  local.deliver(payload, false)

  const frame = await tunnel.next((entry) => entry.type === 'ws_frame' && entry.id === 'ws-1')
  assert.equal(frame.binary, true, 'the negotiated bridge compresses')
  const bytes = Buffer.from(frame.data, 'base64')
  assert.ok(isCompressedWsPayload(bytes), 'the payload carries the compression marker')
  assert.equal(
    gunzipSync(bytes.subarray(COMPRESSED_WS_PREFIX.length)).toString('utf8'),
    payload,
  )
})

test('a phone that did not ask for compression gets the payload unchanged', async (t) => {
  const relay = new FakeRelay()
  await relay.listen()
  t.after(() => relay.close())

  const localBaseUrl = `http://127.0.0.1:${await freePort()}`
  const { client, localSockets } = makeHost(relay.url, localBaseUrl)
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(upgradeFrame({ id: 'ws-1', path: MUX_PATH, headers: { host: 'relay.example' } })),
  )

  const local = await waitForLocalSocket(localSockets)
  local.open()
  await tunnel.next((frame) => frame.type === 'upgraded')

  // The payload is big enough to be compressed when it is negotiated.
  const payload = snapshotPayload()
  local.deliver(payload, false)

  const frame = await tunnel.next((entry) => entry.type === 'ws_frame' && entry.id === 'ws-1')
  assert.equal(frame.binary, false, 'a text payload stays a text frame')
  const bytes = Buffer.from(frame.data, 'base64')
  assert.equal(isCompressedWsPayload(bytes), false, 'the payload was not compressed')
  assert.equal(bytes.toString('utf8'), payload, 'the payload travels unchanged')
})

test('the frame kind mirrors what the local socket delivered', async (t) => {
  const relay = new FakeRelay()
  await relay.listen()
  t.after(() => relay.close())

  const localBaseUrl = `http://127.0.0.1:${await freePort()}`
  const { client, localSockets } = makeHost(relay.url, localBaseUrl)
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(upgradeFrame({ id: 'ws-1', path: MUX_PATH, headers: { host: 'relay.example' } })),
  )

  const local = await waitForLocalSocket(localSockets)
  local.open()
  await tunnel.next((frame) => frame.type === 'upgraded')

  const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x7f])
  local.deliver(bytes, true)

  const frame = await tunnel.next((entry) => entry.type === 'ws_frame' && entry.id === 'ws-1')
  assert.equal(frame.binary, true, 'a binary payload stays a binary frame')
  assert.deepEqual(Buffer.from(frame.data, 'base64'), bytes)
})

test('a large payload is compressed into one binary frame with the marker', async (t) => {
  const relay = new FakeRelay()
  await relay.listen()
  t.after(() => relay.close())

  const localBaseUrl = `http://127.0.0.1:${await freePort()}`
  const { client, localSockets } = makeHost(relay.url, localBaseUrl)
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(
      upgradeFrame({
        id: 'ws-1',
        path: `${MUX_PATH}?${COMPRESSION_QUERY}=1`,
        headers: { host: 'relay.example' },
      }),
    ),
  )

  const local = await waitForLocalSocket(localSockets)
  local.open()
  await tunnel.next((frame) => frame.type === 'upgraded')

  const payload = snapshotPayload()
  local.deliver(payload, false)

  const frame = await tunnel.next((entry) => entry.type === 'ws_frame' && entry.id === 'ws-1')
  assert.equal(frame.binary, true, 'a compressed payload travels as a binary frame')
  assert.equal(frame.body_encoding, 'base64', 'the frame says how it is encoded')

  const bytes = Buffer.from(frame.data, 'base64')
  assert.equal(
    bytes.subarray(0, COMPRESSED_WS_PREFIX.length).toString('latin1'),
    COMPRESSED_WS_PREFIX,
    'the payload opens with the compression marker',
  )
  assert.ok(isCompressedWsPayload(bytes))
  assert.equal(
    gunzipSync(bytes.subarray(COMPRESSED_WS_PREFIX.length)).toString('utf8'),
    payload,
    'the payload inflates back to the original text',
  )

  // One frame, not a stream of them.
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(tunnel.find((entry) => entry.type === 'ws_frame'), undefined)
})

test('a payload below the threshold is forwarded unchanged', async (t) => {
  const relay = new FakeRelay()
  await relay.listen()
  t.after(() => relay.close())

  const localBaseUrl = `http://127.0.0.1:${await freePort()}`
  const { client, localSockets } = makeHost(relay.url, localBaseUrl)
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(
      upgradeFrame({
        id: 'ws-1',
        path: `${MUX_PATH}?${COMPRESSION_QUERY}=1`,
        headers: { host: 'relay.example' },
      }),
    ),
  )

  const local = await waitForLocalSocket(localSockets)
  local.open()
  await tunnel.next((frame) => frame.type === 'upgraded')

  const payload = 'x'.repeat(COMPRESSION_THRESHOLD - 1)
  local.deliver(payload, false)

  const frame = await tunnel.next((entry) => entry.type === 'ws_frame' && entry.id === 'ws-1')
  assert.equal(frame.binary, false, 'a small payload is not worth compressing')
  const bytes = Buffer.from(frame.data, 'base64')
  assert.equal(isCompressedWsPayload(bytes), false)
  assert.equal(bytes.toString('utf8'), payload)
})

test('a payload of exactly 8 KiB is compressed', async (t) => {
  const relay = new FakeRelay()
  await relay.listen()
  t.after(() => relay.close())

  const localBaseUrl = `http://127.0.0.1:${await freePort()}`
  const { client, localSockets } = makeHost(relay.url, localBaseUrl)
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(
      upgradeFrame({
        id: 'ws-1',
        path: `${MUX_PATH}?${COMPRESSION_QUERY}=1`,
        headers: { host: 'relay.example' },
      }),
    ),
  )

  const local = await waitForLocalSocket(localSockets)
  local.open()
  await tunnel.next((frame) => frame.type === 'upgraded')

  const payload = 'x'.repeat(COMPRESSION_THRESHOLD)
  local.deliver(payload, false)

  const frame = await tunnel.next((entry) => entry.type === 'ws_frame' && entry.id === 'ws-1')
  assert.equal(frame.binary, true, 'the threshold itself is compressed')
  const bytes = Buffer.from(frame.data, 'base64')
  assert.ok(isCompressedWsPayload(bytes))
  assert.equal(gunzipSync(bytes.subarray(COMPRESSED_WS_PREFIX.length)).toString('utf8'), payload)
})

test('the frames of one stream keep their order', async (t) => {
  const relay = new FakeRelay()
  await relay.listen()
  t.after(() => relay.close())

  const localBaseUrl = `http://127.0.0.1:${await freePort()}`
  const { client, localSockets } = makeHost(relay.url, localBaseUrl)
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(
      upgradeFrame({
        id: 'ws-1',
        path: `${MUX_PATH}?${COMPRESSION_QUERY}=1`,
        headers: { host: 'relay.example' },
      }),
    ),
  )

  const local = await waitForLocalSocket(localSockets)
  local.open()
  await tunnel.next((frame) => frame.type === 'upgraded')

  const small = 'the first frame'
  const large = snapshotPayload()
  local.deliver(small, false)
  local.deliver(large, false)

  const first = await tunnel.next((entry) => entry.type === 'ws_frame')
  const second = await tunnel.next((entry) => entry.type === 'ws_frame')

  // The small frame is not delayed behind the compression of the big one.
  assert.equal(first.binary, false)
  assert.equal(Buffer.from(first.data, 'base64').toString('utf8'), small)
  assert.equal(second.binary, true)
  assert.equal(
    gunzipSync(
      Buffer.from(second.data, 'base64').subarray(COMPRESSED_WS_PREFIX.length),
    ).toString('utf8'),
    large,
  )
})

test('a compressed frame does not let the next frame overtake it', async (t) => {
  const relay = new FakeRelay()
  await relay.listen()
  t.after(() => relay.close())

  const localBaseUrl = `http://127.0.0.1:${await freePort()}`
  const { client, localSockets } = makeHost(relay.url, localBaseUrl)
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(
      upgradeFrame({
        id: 'ws-1',
        path: `${MUX_PATH}?${COMPRESSION_QUERY}=1`,
        headers: { host: 'relay.example' },
      }),
    ),
  )

  const local = await waitForLocalSocket(localSockets)
  local.open()
  await tunnel.next((frame) => frame.type === 'upgraded')

  // The first frame is the one that needs the compression: the second frame
  // must not overtake it while the gzip is still running.
  const large = snapshotPayload()
  const small = 'the second frame'
  local.deliver(large, false)
  local.deliver(small, false)

  const first = await tunnel.next((entry) => entry.type === 'ws_frame')
  const second = await tunnel.next((entry) => entry.type === 'ws_frame')

  assert.equal(first.binary, true)
  assert.equal(
    gunzipSync(Buffer.from(first.data, 'base64').subarray(COMPRESSED_WS_PREFIX.length)).toString(
      'utf8',
    ),
    large,
  )
  assert.equal(second.binary, false)
  assert.equal(Buffer.from(second.data, 'base64').toString('utf8'), small)
})

test('isCompressedWsPayload recognises the marker and rejects a plain payload', () => {
  const compressed = Buffer.concat([
    Buffer.from(COMPRESSED_WS_PREFIX, 'latin1'),
    gzipSync(Buffer.from('hello', 'utf8')),
  ])

  assert.equal(isCompressedWsPayload(compressed), true)
  assert.equal(isCompressedWsPayload(new Uint8Array(compressed)), true)
  assert.equal(isCompressedWsPayload(Buffer.from('hello', 'utf8')), false)
  // Shorter than the marker itself.
  assert.equal(isCompressedWsPayload(Buffer.from('DSH', 'utf8')), false)
  assert.equal(isCompressedWsPayload(Buffer.alloc(0)), false)
})

test('the phone receives the compressed payload through the real relay', async (t) => {
  const harness = await startFakeHarness()
  const relayPort = await freePort()
  const relay = createRelayServer({
    token: RELAY_SECRET,
    publicBaseUrl: `http://127.0.0.1:${relayPort}`,
    log: () => {},
  })
  const address = await relay.listen({ host: '127.0.0.1', port: relayPort })

  const client = createRelayClient({
    relayUrl: `ws://127.0.0.1:${address.port}`,
    token: RELAY_SECRET,
    deviceId: DEVICE_ID,
    alias: 'test-machine',
    platform: 'darwin',
    clientVersion: '1.0.0',
    localBaseUrl: harness.baseUrl,
    log: () => {},
  })

  t.after(async () => {
    await client.stop().catch(() => {})
    await relay.close().catch(() => {})
    await harness.close()
  })

  await client.start()
  assert.equal(client.status().state, 'online')

  // The phone announces that it can inflate a compressed payload.
  const phone = openPhone(
    `ws://127.0.0.1:${address.port}/${DEVICE_ID}${MUX_PATH}?${COMPRESSION_QUERY}=1`,
  )
  t.after(() => phone.socket.close())
  await phone.opened

  // The harness sends the session snapshot.
  await fetch(`${harness.baseUrl}/emit`)
  await new Promise((resolve) => setTimeout(resolve, 50))

  const message = await waitForMessage(phone.messages)
  assert.equal(message.isBinary, true, 'the compressed payload travels as a binary message')
  assert.ok(
    isCompressedWsPayload(message.data),
    'the relay did not mangle the compressed bytes',
  )
  assert.equal(
    gunzipSync(message.data.subarray(COMPRESSED_WS_PREFIX.length)).toString('utf8'),
    snapshotPayload(),
    'the payload inflates back to the original text',
  )
})

test('the relay forwards a binary ws frame byte for byte', async (t) => {
  const relayPort = await freePort()
  const relay = createRelayServer({
    token: RELAY_SECRET,
    publicBaseUrl: `http://127.0.0.1:${relayPort}`,
    log: () => {},
  })
  const address = await relay.listen({ host: '127.0.0.1', port: relayPort })

  const localBaseUrl = `http://127.0.0.1:${await freePort()}`
  const { impl, localSockets } = makeWebSocketImpl(localBaseUrl)
  const client = createRelayClient({
    relayUrl: `ws://127.0.0.1:${address.port}`,
    token: RELAY_SECRET,
    deviceId: DEVICE_ID,
    alias: 'test-machine',
    platform: 'darwin',
    clientVersion: '1.0.0',
    localBaseUrl,
    log: () => {},
    WebSocketImpl: impl,
  })

  t.after(async () => {
    await client.stop().catch(() => {})
    await relay.close().catch(() => {})
  })

  await client.start()
  assert.equal(client.status().state, 'online')

  const phone = openPhone(`ws://127.0.0.1:${address.port}/${DEVICE_ID}${MUX_PATH}`)
  t.after(() => phone.socket.close())

  const local = await waitForLocalSocket(localSockets)
  local.open()
  await phone.opened
  // The relay attaches the bridge to the phone when the handshake completes.
  await new Promise((resolve) => setTimeout(resolve, 50))

  // Bytes that are not valid UTF-8: a relay that guesses the encoding would
  // hand the base64 text to the phone instead of the bytes.
  const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x7f, 0x80, 0xc3])
  local.deliver(bytes, true)

  const message = await waitForMessage(phone.messages)
  assert.equal(message.isBinary, true, 'a binary frame stays a binary message')
  assert.deepEqual(message.data, bytes, 'the relay forwards the payload byte for byte')
})
