/**
 * Host-side transport tests: the event stream and the binary WebSocket
 * payload.
 *
 * Two transport problems are covered here:
 *
 *   1. **The event stream dies after 30 seconds.** `/plugins/events` is a
 *      Server-Sent Events endpoint: its body never ends. The host used to
 *      buffer the whole body before answering the relay, so the relay timed
 *      the request out and the phone got a 504 instead of the events. The
 *      host now answers with the head first and the body in chunks.
 *   2. **The biggest WebSocket payload pays for base64.** A session snapshot
 *      is megabytes of JSON; travelling as a JSON frame it costs a third
 *      more bytes on the link that is the bottleneck. A relay that
 *      advertises `ws_binary_body` takes the payload as one binary tunnel
 *      message instead.
 *
 * A fake relay plays the cloud side, a fake upstream plays the local DSH
 * server and the `WebSocketImpl` seam fakes the local socket.
 *
 * Run with: `node --test tests/host-streaming.test.js`
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { test } from 'node:test'
import { gunzipSync } from 'node:zlib'

import { WebSocket as NodeWebSocket, WebSocketServer } from 'ws'

import { createRelayClient } from '../src/relay-client.js'
import {
  abortFrame,
  CAPABILITY_WS_BINARY_BODY,
  decodeBinaryWsPayload,
  decodeFrame,
  encodeFrame,
  registerAckFrame,
  requestFrame,
  upgradeFrame,
} from '../src/relay-protocol.js'

const DEVICE_ID = 'device-1234'
const TOKEN = 'test-token'
const LAUNCH_TOKEN = 'launch-secret'
const PUBLIC_URL = `https://relay.example/d/${DEVICE_ID}`
const EVENTS_PATH = '/plugins/events'

/* --------------------------------------------------------------- utilities */

/**
 * Collects the frames a socket sends and lets a test await a specific one.
 */
class FrameInbox {
  /** @param {import('ws').WebSocket} socket */
  constructor(socket) {
    this.socket = socket
    /** @type {Record<string, unknown>[]} */
    this.frames = []
    /** @type {Buffer[]} the binary messages the socket sent */
    this.binaries = []
    /** @type {{ predicate: Function, resolve: Function, timer: NodeJS.Timeout }[]} */
    this.waiters = []

    socket.on('message', (data, isBinary) => {
      // The flag is what tells a binary message apart from a text frame: a
      // text frame that arrives in one piece is handed over as a Buffer, too.
      if (isBinary === true) {
        this.binaries.push(Buffer.isBuffer(data) ? data : Buffer.from(data))
        return
      }
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

  /**
   * Wait for the next binary message the socket sent.
   *
   * A binary message arrives as its own WebSocket message, so it may land
   * after the text frame that announced it.
   *
   * @param {number} [timeoutMs]
   * @returns {Promise<Buffer>}
   */
  async nextBinary(timeoutMs = 4_000) {
    const started = Date.now()
    while (this.binaries.length === 0) {
      if (Date.now() - started > timeoutMs) {
        throw new Error('timed out waiting for a binary message')
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return this.binaries.shift()
  }
}

/** The fake relay: management + tunnel channels over one HTTP server. */
class FakeRelay extends EventEmitter {
  /** @param {{ capabilities?: string[] }} [options] */
  constructor(options = {}) {
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
    /** @type {string[]} the capabilities the relay advertises */
    this.capabilities = options.capabilities ?? []

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
                  capabilities: this.capabilities,
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

/** The fake local DSH server. */
class FakeUpstream {
  /**
   * @param {(req: any, res: any, index: number) => void} [handler]
   */
  constructor(handler) {
    this.requests = []
    /** @type {number[]} the requests that were aborted */
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
  const started = Date.now()
  while (localSockets.length === 0) {
    if (Date.now() - started > 5_000) {
      throw new Error('timed out waiting for the host to open the local websocket')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
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
    launchToken: LAUNCH_TOKEN,
    log: () => {},
    WebSocketImpl: impl,
  })
  return { client, localSockets }
}

/**
 * Write to a response that may already be gone.
 *
 * @param {any} res
 * @param {string} payload
 */
function safeWrite(res, payload) {
  try {
    res.write(payload)
  } catch {
    /* the request was aborted */
  }
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

/* ------------------------------------------------------------------ tests */

test('an event stream is answered with a head and a chunked body', async (t) => {
  const relay = new FakeRelay()
  const upstream = new FakeUpstream((req, res) => {
    if (req.url !== EVENTS_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    safeWrite(res, 'data: first\n\n')
    // The stream stays open: an event stream ends when the server says so.
  })
  await relay.listen()
  await upstream.listen()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const { client } = makeHost(relay.url, upstream.url)
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(
      requestFrame({
        id: 'req-events',
        method: 'GET',
        path: EVENTS_PATH,
        headers: { accept: 'text/event-stream' },
        body: null,
      }),
    ),
  )

  // The head arrives while the stream is still running: the relay must not
  // wait for a body that never ends.
  const head = await tunnel.next((frame) => frame.type === 'response')
  assert.equal(head.id, 'req-events')
  assert.equal(head.chunked, true)
  assert.equal(head.status, 200)
  assert.equal(head.body, null)
  assert.equal(head.body_encoding, null)
  assert.equal(head.headers['content-type'], 'text/event-stream; charset=utf-8')
  // The length of a streamed body is unknown, and the host does not compress
  // it: the head must not claim either.
  assert.equal(head.headers['content-length'], undefined)
  assert.equal(head.headers['content-encoding'], undefined)

  // The body follows in chunks.
  const chunk = await tunnel.next((frame) => frame.type === 'response_chunk')
  assert.equal(chunk.id, 'req-events')
  assert.equal(chunk.last, false)
  assert.equal(chunk.body_encoding, 'base64')
  assert.equal(Buffer.from(chunk.chunk, 'base64').toString('utf8'), 'data: first\n\n')

  // Nothing else: the stream is still open, so there is no last chunk yet.
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(tunnel.find((frame) => frame.type === 'response_chunk' && frame.last === true), undefined)
})

test('a streamed response ends with one last chunk', async (t) => {
  const events = 'data: first\n\ndata: second\n\n'
  const relay = new FakeRelay()
  const upstream = new FakeUpstream((req, res) => {
    if (req.url !== EVENTS_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: first\n\n')
    setTimeout(() => {
      safeWrite(res, 'data: second\n\n')
      res.end()
    }, 30)
  })
  await relay.listen()
  await upstream.listen()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const { client } = makeHost(relay.url, upstream.url)
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(
      requestFrame({
        id: 'req-events',
        method: 'GET',
        path: EVENTS_PATH,
        headers: {},
        body: null,
      }),
    ),
  )

  await tunnel.next((frame) => frame.type === 'response')

  // Every chunk of the body, in order.
  /** @type {Record<string, unknown>[]} */
  const chunks = []
  /** @type {Record<string, unknown>|null} */
  let last = null
  const started = Date.now()
  while (last === null && Date.now() - started < 8_000) {
    const frame = await tunnel.next((candidate) => candidate.type === 'response_chunk', 8_000)
    if (frame.last === true) last = frame
    else chunks.push(frame)
  }

  assert.ok(last !== null, 'the stream ends with a last chunk')
  assert.equal(last.id, 'req-events')
  assert.equal(last.chunk, '')
  assert.equal(last.body_encoding, 'base64')

  // The chunks carry the upstream bytes, base64 encoded, in order.
  const decoded = chunks.map((chunk) => Buffer.from(String(chunk.chunk), 'base64'))
  assert.deepEqual(
    Buffer.concat(decoded).toString('utf8'),
    events,
    'the chunks decode back to the upstream bytes',
  )
  assert.ok(
    chunks.every((chunk) => chunk.last === false),
    'only the last chunk is flagged',
  )
})

test('a normal response still takes the buffered and compressed path', async (t) => {
  const payload = 'const answer = 42; // '.repeat(4096)
  const relay = new FakeRelay()
  const upstream = new FakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/javascript' })
    res.end(payload)
  })
  await relay.listen()
  await upstream.listen()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const { client } = makeHost(relay.url, upstream.url)
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(
      requestFrame({
        id: 'req-bundle',
        method: 'GET',
        path: '/app.js',
        headers: {},
        body: null,
      }),
    ),
  )

  const response = await tunnel.next((frame) => frame.type === 'response')
  assert.equal(response.id, 'req-bundle')
  // Not a stream: the old path is untouched.
  assert.equal(response.chunked, undefined)
  assert.equal(response.body_encoding, 'base64')
  // The 9 MB app bundle relies on this compression.
  assert.equal(response.headers['content-encoding'], 'gzip')
  const raw = Buffer.from(String(response.body), 'base64')
  assert.equal(Number(response.headers['content-length']), raw.length)
  assert.ok(raw.length < payload.length / 2, `expected a smaller body, got ${raw.length}`)
  assert.equal(gunzipSync(raw).toString('utf8'), payload)

  // Exactly one response frame, no chunks at all.
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(tunnel.find((frame) => frame.type === 'response'), undefined)
  assert.equal(tunnel.find((frame) => frame.type === 'response_chunk'), undefined)
})

test('a websocket payload travels as one binary tunnel message', async (t) => {
  const relay = new FakeRelay({ capabilities: [CAPABILITY_WS_BINARY_BODY] })
  await relay.listen()
  t.after(() => relay.close())

  const localBaseUrl = `http://127.0.0.1:${await freePort()}`
  const { client, localSockets } = makeHost(relay.url, localBaseUrl)
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(upgradeFrame({ id: 'ws-1', path: '/api/remote.mux', headers: {} })),
  )

  const local = await waitForLocalSocket(localSockets)
  local.open()
  await tunnel.next((frame) => frame.type === 'upgraded')

  // A payload that is not valid UTF-8: a relay that guesses the encoding
  // would hand the base64 text to the phone instead of the bytes.
  const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x7f, 0x80, 0xc3])
  local.deliver(bytes, true)

  const message = await tunnel.nextBinary()
  const decoded = decodeBinaryWsPayload(message)
  assert.ok(decoded !== undefined, 'the binary message is a websocket payload')
  assert.equal(decoded.id, 'ws-1')
  assert.deepEqual(decoded.payload, bytes)
  assert.equal(decoded.binary, true, 'the kind of the payload travels with it')

  // The JSON frame is gone: the payload paid for no base64.
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(tunnel.find((frame) => frame.type === 'ws_frame'), undefined)
})

test('a text websocket payload keeps its kind in the binary message', async (t) => {
  const relay = new FakeRelay({ capabilities: [CAPABILITY_WS_BINARY_BODY] })
  await relay.listen()
  t.after(() => relay.close())

  const localBaseUrl = `http://127.0.0.1:${await freePort()}`
  const { client, localSockets } = makeHost(relay.url, localBaseUrl)
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(upgradeFrame({ id: 'ws-1', path: '/api/remote.mux', headers: {} })),
  )

  const local = await waitForLocalSocket(localSockets)
  local.open()
  await tunnel.next((frame) => frame.type === 'upgraded')

  local.deliver('a plain text payload', false)

  const decoded = decodeBinaryWsPayload(await tunnel.nextBinary())
  assert.ok(decoded !== undefined)
  assert.equal(decoded.id, 'ws-1')
  assert.equal(decoded.payload.toString('utf8'), 'a plain text payload')
  assert.equal(decoded.binary, false, 'a text payload stays text')
})

test('a websocket payload stays a JSON frame when the relay does not allow it', async (t) => {
  const relay = new FakeRelay()
  await relay.listen()
  t.after(() => relay.close())

  const localBaseUrl = `http://127.0.0.1:${await freePort()}`
  const { client, localSockets } = makeHost(relay.url, localBaseUrl)
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(upgradeFrame({ id: 'ws-1', path: '/api/remote.mux', headers: {} })),
  )

  const local = await waitForLocalSocket(localSockets)
  local.open()
  await tunnel.next((frame) => frame.type === 'upgraded')

  const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x7f])
  local.deliver(bytes, true)

  // An older relay keeps working: the payload travels as it always did.
  const frame = await tunnel.next((entry) => entry.type === 'ws_frame' && entry.id === 'ws-1')
  assert.equal(frame.binary, true)
  assert.equal(frame.body_encoding, 'base64')
  assert.deepEqual(Buffer.from(String(frame.data), 'base64'), bytes)
  assert.equal(tunnel.binaries.length, 0, 'no binary message was sent')
})

test('the relay aborting a stream stops the chunks and closes the stream', async (t) => {
  const relay = new FakeRelay()
  const upstream = new FakeUpstream((req, res) => {
    if (req.url !== EVENTS_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    safeWrite(res, 'data: first\n\n')
    // The stream stays open until the relay aborts the request.
  })
  await relay.listen()
  await upstream.listen()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const { client } = makeHost(relay.url, upstream.url)
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(
      requestFrame({
        id: 'req-events',
        method: 'GET',
        path: EVENTS_PATH,
        headers: {},
        body: null,
      }),
    ),
  )

  await tunnel.next((frame) => frame.type === 'response')
  await tunnel.next((frame) => frame.type === 'response_chunk')

  // The relay gives up on the request.
  tunnel.socket.send(encodeFrame(abortFrame('req-events')))

  // The stream ends cleanly: the last chunk closes the phone's response.
  const last = await tunnel.next(
    (frame) => frame.type === 'response_chunk' && frame.last === true,
  )
  assert.equal(last.id, 'req-events')
  assert.equal(last.chunk, '')

  // The upstream request was aborted, and no further chunk was sent.
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(upstream.aborted.length, 1, 'the upstream request was aborted')
  assert.equal(
    tunnel.find((frame) => frame.type === 'response_chunk' && frame.last !== true),
    undefined,
    'no chunk was sent after the abort',
  )
})

test('a stream that dies ends cleanly instead of hanging the phone', async (t) => {
  const relay = new FakeRelay()
  const upstream = new FakeUpstream((req, res) => {
    if (req.url !== EVENTS_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    safeWrite(res, 'data: first\n\n')
    // The upstream socket dies in the middle of the stream.
    setTimeout(() => {
      try {
        req.socket.destroy()
      } catch {
        /* ignore */
      }
    }, 40)
  })
  await relay.listen()
  await upstream.listen()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const { client } = makeHost(relay.url, upstream.url)
  t.after(() => client.stop())

  await client.start()
  const tunnel = await relay.waitFor('tunnel')

  tunnel.socket.send(
    encodeFrame(
      requestFrame({
        id: 'req-events',
        method: 'GET',
        path: EVENTS_PATH,
        headers: {},
        body: null,
      }),
    ),
  )

  await tunnel.next((frame) => frame.type === 'response')

  // The stream ends with the last chunk, so the relay can close the phone's
  // response instead of leaving it hanging.
  const last = await tunnel.next(
    (frame) => frame.type === 'response_chunk' && frame.last === true,
  )
  assert.equal(last.id, 'req-events')
  assert.equal(last.chunk, '')

  // A dead stream is not a bad gateway: the head was already sent.
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(tunnel.find((frame) => frame.type === 'response' && frame.status === 502), undefined)
})
