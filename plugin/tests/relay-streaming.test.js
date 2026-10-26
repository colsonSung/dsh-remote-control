/**
 * @file Streaming and binary-tunnel tests for the remote-control relay.
 *
 * Two transport optimisations are covered here:
 *
 *   1. a response that streams (an event stream) is forwarded to the phone
 *      chunk by chunk instead of being waited for until it ends, and its
 *      deadline turns into an idle window so a live stream is never killed,
 *   2. a WebSocket payload that arrives as one binary tunnel message reaches
 *      the phone as the same kind of message, without the base64 inflation.
 *
 * The test plays the role of the DSH host: it opens the management and the
 * tunnel WebSocket against a real relay and answers the phone traffic.
 *
 * Run with: `node --test tests/relay-streaming.test.js`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'

import { createRelayServer } from '../src/relay-server.js'
import {
  MANAGEMENT_PATH,
  TUNNEL_PATH,
  CAPABILITY_BINARY_BODY,
  CAPABILITY_WS_BINARY_BODY,
  chunkedResponseFrame,
  decodeFrame,
  encodeBinaryBody,
  encodeBinaryWsPayload,
  encodeFrame,
  registerFrame,
  responseChunkFrame,
  responseFrame,
  upgradedFrame,
  wsFrame,
} from '../src/relay-protocol.js'

const TOKEN = 'test-token'

/**
 * Wait for a condition.
 *
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

/**
 * Sleep for a while.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait for the next frame on a socket.
 *
 * @param {WebSocket} socket
 * @param {number} [timeout]
 * @returns {Promise<Record<string, any>>}
 */
function nextFrame(socket, timeout = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('timed out waiting for a frame'))
    }, timeout)
    function cleanup() {
      clearTimeout(timer)
      socket.off('message', onMessage)
      socket.off('error', onError)
    }
    function onMessage(data) {
      cleanup()
      try {
        resolve(decodeFrame(String(data)))
      } catch (error) {
        reject(error)
      }
    }
    function onError(error) {
      cleanup()
      reject(error)
    }
    socket.on('message', onMessage)
    socket.on('error', onError)
  })
}

/**
 * The fake DSH host: management channel + tunnel channel.
 *
 * The test decides how a request is answered, so the host can behave like a
 * server that streams and like one that answers in one piece.
 */
class FakeHost {
  /**
   * @param {{relayUrl: string, deviceId: string, localBaseUrl?: string}} options
   */
  constructor(options) {
    this.options = options
    /** @type {WebSocket} */
    this.management = null
    /** @type {WebSocket} */
    this.tunnel = null
    /** @type {Record<string, any>[]} */
    this.requests = []
    /** @type {Record<string, any>[]} */
    this.upgrades = []
    /** @type {Record<string, any>[]} */
    this.aborts = []
    /** @type {Record<string, any> | null} */
    this.ack = null
    /** Answers one request frame. */
    this.answer = null
  }

  /**
   * Open both channels and register the device.
   *
   * @returns {Promise<FakeHost>}
   */
  async connect() {
    const { relayUrl, deviceId } = this.options
    const localBaseUrl = this.options.localBaseUrl ?? 'http://127.0.0.1:1'
    const headers = { Authorization: `Bearer ${TOKEN}` }

    this.management = new WebSocket(`${relayUrl}${MANAGEMENT_PATH}`, { headers })
    await once(this.management, 'open')
    this.management.send(
      encodeFrame(
        registerFrame({
          deviceId,
          alias: 'Fake Host',
          platform: 'darwin',
          clientVersion: '1.2.3',
          localBaseUrl,
        }),
      ),
    )
    const frame = await nextFrame(this.management)
    if (frame.type === 'register_ack') this.ack = frame

    const tunnelUrl = new URL(TUNNEL_PATH, relayUrl)
    tunnelUrl.searchParams.set('device_id', deviceId)
    tunnelUrl.searchParams.set('capabilities', 'request_chunk,response_chunk,abort')
    this.tunnel = new WebSocket(tunnelUrl.href, { headers })
    await once(this.tunnel, 'open')
    this.tunnel.on('message', (data) => this.onTunnelFrame(data))
    return this
  }

  /**
   * @param {Buffer | string} data
   */
  onTunnelFrame(data) {
    const frame = decodeFrame(String(data))
    if (frame.type === 'request') {
      this.requests.push(frame)
      if (typeof this.answer === 'function') this.answer(frame)
      return
    }
    if (frame.type === 'upgrade') {
      this.upgrades.push(frame)
      this.tunnel.send(encodeFrame(upgradedFrame(frame.id)))
      return
    }
    if (frame.type === 'abort') {
      this.aborts.push(frame)
    }
  }

  /**
   * Answer one request with the head of a streamed response.
   *
   * @param {string} id
   * @param {{status?: number, headers?: Record<string, string>}} [options]
   */
  sendStreamHead(id, options = {}) {
    this.tunnel.send(
      encodeFrame(
        chunkedResponseFrame({
          id,
          status: options.status ?? 200,
          headers: options.headers ?? { 'content-type': 'text/event-stream' },
        }),
      ),
    )
  }

  /**
   * Send one chunk of a streamed response.
   *
   * @param {string} id
   * @param {string} chunk
   * @param {boolean} [last]
   */
  sendStreamChunk(id, chunk, last = false) {
    this.tunnel.send(
      encodeFrame(
        responseChunkFrame({
          id,
          chunk: Buffer.from(chunk, 'utf8').toString('base64'),
          last,
        }),
      ),
    )
  }

  /**
   * Answer one request with a plain response frame.
   *
   * @param {string} id
   * @param {{status?: number, headers?: Record<string, string>, body?: string | null}} [options]
   */
  sendResponse(id, options = {}) {
    const body = options.body ?? null
    this.tunnel.send(
      encodeFrame(
        responseFrame({
          id,
          status: options.status ?? 200,
          headers: options.headers ?? { 'content-type': 'text/plain' },
          body: body === null ? null : Buffer.from(body, 'utf8').toString('base64'),
        }),
      ),
    )
  }

  /**
   * Answer one request with a body that travels as one binary message.
   *
   * @param {string} id
   * @param {Buffer} body
   */
  sendBinaryBody(id, body) {
    this.tunnel.send(
      encodeFrame(
        responseFrame({
          id,
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
          body: null,
          body_encoding: 'binary',
          body_length: body.length,
        }),
      ),
    )
    this.tunnel.send(encodeBinaryBody(id, body))
  }

  /**
   * Send one WebSocket payload as one binary tunnel message.
   *
   * @param {string} id the bridge the payload belongs to
   * @param {Buffer} payload
   * @param {boolean} binary
   */
  sendBinaryWsPayload(id, payload, binary) {
    this.tunnel.send(encodeBinaryWsPayload(id, payload, binary))
  }

  /**
   * @returns {Promise<void>}
   */
  async close() {
    for (const socket of [this.tunnel, this.management]) {
      if (!socket) continue
      try {
        socket.close()
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Boot a relay for one test.
 *
 * @param {{publicBaseUrl?: string, requestTimeoutMs?: number, streamIdleTimeoutMs?: number}} [options]
 */
async function startRelay(options = {}) {
  const relay = createRelayServer({
    token: TOKEN,
    publicBaseUrl: options.publicBaseUrl,
    requestTimeoutMs: options.requestTimeoutMs,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
    log: () => {},
  })
  const { port } = await relay.listen({ host: '127.0.0.1', port: 0 })
  return { relay, url: `http://127.0.0.1:${port}` }
}

/**
 * Open a phone request and record what the relay delivers.
 *
 * The events tell the order in which the phone saw the response: the head,
 * every chunk and the end.
 *
 * @param {string} url
 * @returns {{events: string[], chunks: Buffer[], status: number, headers: Record<string, any>, request: http.ClientRequest}}
 */
function phoneRequest(url) {
  const events = []
  /** @type {Buffer[]} */
  const chunks = []
  /** @type {Record<string, any>} */
  let headers = {}
  let status = 0
  const request = http.get(url, (response) => {
    status = response.statusCode || 0
    headers = response.headers
    events.push(`head:${status}`)
    response.on('data', (chunk) => {
      chunks.push(chunk)
      events.push(`chunk:${chunk.toString('utf8')}`)
    })
    response.on('end', () => events.push('end'))
    response.on('aborted', () => events.push('aborted'))
    response.on('error', (error) => events.push(`error:${error.code || error.message}`))
  })
  request.on('error', (error) => events.push(`error:${error.code || error.message}`))
  return {
    events,
    chunks,
    get status() {
      return status
    },
    get headers() {
      return headers
    },
    request,
  }
}

/**
 * The body the phone received.
 *
 * @param {{chunks: Buffer[]}} phone
 * @returns {string}
 */
function phoneBody(phone) {
  return Buffer.concat(phone.chunks).toString('utf8')
}

test('a chunked response reaches the phone chunk by chunk', async (t) => {
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
  })

  const host = await new FakeHost({ relayUrl: url, deviceId: 'device-stream' }).connect()
  t.after(() => host.close())

  const phone = phoneRequest(`${url}/device-stream/plugins/events`)
  await waitFor(() => host.requests.length === 1, 'the request frame')
  const id = host.requests[0].id

  host.sendStreamHead(id, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  })

  // The head reaches the phone before any chunk: the phone knows the stream
  // is open even before the first event arrives.
  await waitFor(() => phone.events.length > 0, 'the response head')
  assert.equal(phone.status, 200)
  assert.equal(phone.headers['content-type'], 'text/event-stream')
  // The length of a stream is unknown, so no content-length is sent and Node
  // uses chunked transfer encoding instead.
  assert.equal(phone.headers['content-length'], undefined)
  assert.equal(phone.headers['transfer-encoding'], 'chunked')

  host.sendStreamChunk(id, 'data: one\n\n', false)
  await waitFor(() => phone.chunks.length === 1, 'the first chunk')
  assert.deepEqual(phone.events, ['head:200', 'chunk:data: one\n\n'])
  // The response is still open: the chunk did not arrive as one lump at the
  // end of the response.
  assert.equal(phone.events.includes('end'), false)

  host.sendStreamChunk(id, 'data: two\n\n', true)
  await waitFor(() => phone.events.includes('end'), 'the end of the stream')
  assert.deepEqual(phone.events, [
    'head:200',
    'chunk:data: one\n\n',
    'chunk:data: two\n\n',
    'end',
  ])
  assert.equal(phoneBody(phone), 'data: one\n\ndata: two\n\n')
})

test('the phone response ends when the last chunk arrives', async (t) => {
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
  })

  const host = await new FakeHost({ relayUrl: url, deviceId: 'device-last' }).connect()
  t.after(() => host.close())

  const phone = phoneRequest(`${url}/device-last/plugins/events`)
  await waitFor(() => host.requests.length === 1, 'the request frame')
  const id = host.requests[0].id

  host.sendStreamHead(id)
  host.sendStreamChunk(id, 'first', false)
  await waitFor(() => phone.chunks.length === 1, 'the first chunk')
  assert.equal(phone.events.includes('end'), false)

  host.sendStreamChunk(id, 'last', true)
  await waitFor(() => phone.events.includes('end'), 'the end of the stream')
  assert.equal(phoneBody(phone), 'firstlast')
  // A stream that ended on its own is not aborted.
  assert.equal(host.aborts.length, 0)
})

test('the request timeout does not fire while the stream keeps sending', async (t) => {
  // The idle window is short, so the test does not have to wait for the 30 s
  // deadline of a real relay.
  const { relay, url } = await startRelay({ requestTimeoutMs: 150 })
  t.after(async () => {
    await relay.close()
  })

  const host = await new FakeHost({ relayUrl: url, deviceId: 'device-idle' }).connect()
  t.after(() => host.close())

  const phone = phoneRequest(`${url}/device-idle/plugins/events`)
  await waitFor(() => host.requests.length === 1, 'the request frame')
  const id = host.requests[0].id

  host.sendStreamHead(id)
  // Every chunk arrives well inside the idle window: the deadline has to be
  // pushed out every time, or the stream would die on the first one.
  for (let index = 0; index < 6; index += 1) {
    await sleep(60)
    host.sendStreamChunk(id, `chunk-${index}\n`, false)
  }
  await waitFor(() => phone.chunks.length === 6, 'all chunks')
  assert.equal(host.aborts.length, 0)
  assert.equal(phone.events.includes('end'), false)

  host.sendStreamChunk(id, 'the end\n', true)
  await waitFor(() => phone.events.includes('end'), 'the end of the stream')
  assert.equal(phoneBody(phone).split('\n').length, 8)
})

test('a quiet stream outlives the request deadline', async (t) => {
  // An event stream says nothing between its events, so the deadline that
  // guards a request would cut it while it is perfectly alive.
  const { relay, url } = await startRelay({ requestTimeoutMs: 120 })
  t.after(async () => {
    await relay.close()
  })

  const host = await new FakeHost({ relayUrl: url, deviceId: 'device-quiet' }).connect()
  t.after(() => host.close())

  const phone = phoneRequest(`${url}/device-quiet/plugins/events`)
  await waitFor(() => host.requests.length === 1, 'the request frame')
  const id = host.requests[0].id

  host.sendStreamHead(id)
  host.sendStreamChunk(id, 'hello\n', false)
  await waitFor(() => phone.chunks.length === 1, 'the first chunk')

  // The request deadline is long gone; the stream has its own window.
  await sleep(500)
  assert.equal(host.aborts.length, 0, 'a quiet stream must not be aborted')
  assert.equal(phone.events.includes('end'), false)

  // And it still carries events.
  host.sendStreamChunk(id, 'more\n', false)
  await waitFor(() => phone.chunks.length === 2, 'the second chunk')
  assert.equal(phoneBody(phone), 'hello\nmore\n')
})

test('a stream that stops sending is aborted', async (t) => {
  const { relay, url } = await startRelay({ requestTimeoutMs: 150, streamIdleTimeoutMs: 150 })
  t.after(async () => {
    await relay.close()
  })

  const host = await new FakeHost({ relayUrl: url, deviceId: 'device-stalled' }).connect()
  t.after(() => host.close())

  const phone = phoneRequest(`${url}/device-stalled/plugins/events`)
  await waitFor(() => host.requests.length === 1, 'the request frame')
  const id = host.requests[0].id

  host.sendStreamHead(id)
  host.sendStreamChunk(id, 'hello\n', false)
  await waitFor(() => phone.chunks.length === 1, 'the first chunk')

  // Nothing follows: the idle window runs out and the host is told to abort.
  await waitFor(() => host.aborts.length === 1, 'the abort frame')
  assert.equal(host.aborts[0].id, id)
  await waitFor(
    () => phone.events.some((event) => event.startsWith('error') || event === 'aborted'),
    'the cut stream',
  )
  assert.equal(phone.events.includes('end'), false)
})

test('a phone that walks away aborts the streamed request', async (t) => {
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
  })

  const host = await new FakeHost({ relayUrl: url, deviceId: 'device-walk' }).connect()
  t.after(() => host.close())

  const phone = phoneRequest(`${url}/device-walk/plugins/events`)
  await waitFor(() => host.requests.length === 1, 'the request frame')
  const id = host.requests[0].id

  host.sendStreamHead(id)
  host.sendStreamChunk(id, 'hello\n', false)
  await waitFor(() => phone.chunks.length === 1, 'the first chunk')

  phone.request.destroy()
  await waitFor(() => host.aborts.length === 1, 'the abort frame')
  assert.equal(host.aborts[0].id, id)
})

test('a plain response frame still answers the phone in one piece', async (t) => {
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
  })

  const host = await new FakeHost({ relayUrl: url, deviceId: 'device-plain' }).connect()
  t.after(() => host.close())

  const body = JSON.stringify({ ok: true })
  host.answer = (frame) => {
    host.sendResponse(frame.id, {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body,
    })
  }

  const phone = phoneRequest(`${url}/device-plain/api/session/list`)
  await waitFor(() => phone.events.includes('end'), 'the end of the response')
  assert.deepEqual(phone.events, ['head:200', `chunk:${body}`, 'end'])
  assert.equal(phoneBody(phone), body)
  // A response that arrives in one piece still knows its length.
  assert.equal(phone.headers['content-length'], String(Buffer.byteLength(body)))
  assert.equal(phone.headers['transfer-encoding'], undefined)
})

test('a response body that arrives as a binary message still works', async (t) => {
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
  })

  const host = await new FakeHost({ relayUrl: url, deviceId: 'device-binary-body' }).connect()
  t.after(() => host.close())

  // Bytes that are not valid UTF-8: a relay that guesses the encoding would
  // hand the phone the base64 text instead.
  const bytes = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0xfd])
  host.answer = (frame) => host.sendBinaryBody(frame.id, bytes)

  const phone = phoneRequest(`${url}/device-binary-body/assets/app.js`)
  await waitFor(() => phone.events.includes('end'), 'the end of the response')
  assert.deepEqual([...Buffer.concat(phone.chunks)], [...bytes])
})

test('a websocket payload that arrives as a binary tunnel message keeps its kind', async (t) => {
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
  })

  const host = await new FakeHost({ relayUrl: url, deviceId: 'device-ws-binary' }).connect()
  t.after(() => host.close())

  const phone = new WebSocket(`${url}/device-ws-binary/api/remote.mux`)
  await once(phone, 'open')
  t.after(() => phone.close())
  /** @type {{data: Buffer, isBinary: boolean}[]} */
  const received = []
  phone.on('message', (data, isBinary) => {
    received.push({ data: Buffer.from(data), isBinary: isBinary === true })
  })

  await waitFor(() => host.upgrades.length === 1, 'the upgrade frame')
  const bridgeId = host.upgrades[0].id

  // A binary payload stays binary on the way to the phone.
  host.sendBinaryWsPayload(bridgeId, Buffer.from([0x00, 0x01, 0xfe, 0xff]), true)
  await waitFor(() => received.length === 1, 'the binary payload')
  assert.equal(received[0].isBinary, true)
  assert.deepEqual([...received[0].data], [0x00, 0x01, 0xfe, 0xff])

  // A text payload stays text: guessing it from the bytes breaks the peer
  // protocol on the phone.
  host.sendBinaryWsPayload(bridgeId, Buffer.from('hello', 'utf8'), false)
  await waitFor(() => received.length === 2, 'the text payload')
  assert.equal(received[1].isBinary, false)
  assert.equal(received[1].data.toString('utf8'), 'hello')
})

test('a host that does not know the capability keeps sending json frames', async (t) => {
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
  })

  const host = await new FakeHost({ relayUrl: url, deviceId: 'device-json' }).connect()
  t.after(() => host.close())

  const phone = new WebSocket(`${url}/device-json/api/remote.mux`)
  await once(phone, 'open')
  t.after(() => phone.close())
  /** @type {{data: Buffer, isBinary: boolean}[]} */
  const received = []
  phone.on('message', (data, isBinary) => {
    received.push({ data: Buffer.from(data), isBinary: isBinary === true })
  })

  await waitFor(() => host.upgrades.length === 1, 'the upgrade frame')
  const bridgeId = host.upgrades[0].id

  // The payload travels as a `ws_frame` frame, the way an older host sends it.
  host.tunnel.send(
    encodeFrame(wsFrame({ id: bridgeId, data: Buffer.from('legacy', 'utf8').toString('base64') })),
  )
  await waitFor(() => received.length === 1, 'the payload')
  assert.equal(received[0].data.toString('utf8'), 'legacy')
})

test('the relay advertises the binary websocket payload capability', async (t) => {
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
  })

  const host = await new FakeHost({ relayUrl: url, deviceId: 'device-caps' }).connect()
  t.after(() => host.close())

  assert.ok(host.ack, 'expected a register_ack frame')
  assert.ok(host.ack.capabilities.includes(CAPABILITY_WS_BINARY_BODY))
  // The capability of the binary body stays: a host that knows it sends the
  // body of a big response without the base64 inflation as well.
  assert.ok(host.ack.capabilities.includes(CAPABILITY_BINARY_BODY))
})
