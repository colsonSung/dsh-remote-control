/**
 * @file Self-test for the remote-control relay server.
 *
 * The test plays the role of the DSH host: it opens the management and the
 * tunnel WebSocket against the relay, registers a device, and answers the
 * `request` frames the relay produces for phone traffic. A small fake upstream
 * (`node:http`) stands in for the host's local server.
 *
 * Run with: `node --test tests/relay-server.test.js`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'

import { createRelayServer } from '../src/relay-server.js'
import {
  MANAGEMENT_PATH,
  TUNNEL_PATH,
  CAPABILITY_BINARY_BODY,
  decodeFrame,
  encodeBinaryBody,
  encodeFrame,
  registerFrame,
  responseFrame,
  upgradedFrame,
  wsFrame,
} from '../src/relay-protocol.js'

const TOKEN = 'test-token'

/**
 * Start the fake upstream server (the host's local server).
 *
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>, wss: WebSocketServer}>}
 */
async function startUpstream() {
  const wss = new WebSocketServer({ noServer: true })
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      if (req.url && req.url.startsWith('/set-cookie')) {
        res.writeHead(200, {
          'content-type': 'text/plain',
          'set-cookie': ['a=1; Path=/', 'b=2; Path=/'],
        })
        res.end('cookies')
        return
      }
      if (req.url && req.url.startsWith('/gzip')) {
        // A body that is not valid UTF-8: a relay that guesses the encoding
        // would hand the phone the base64 text instead of these bytes.
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' })
        res.end(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0xfd]))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'fake' })
      res.end(JSON.stringify({ method: req.method, url: req.url, body }))
    })
  })
  server.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/api/remote.mux')) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      client.on('message', (data) => client.send(`echo:${data}`))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    wss,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/**
 * Wait for the next frame on a socket.
 *
 * @param {WebSocket} socket
 * @param {number} [timeout]
 * @returns {Promise<Record<string, any>>}
 */
function nextFrame(socket, timeout = 5000) {
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
 */
class FakeHost {
  /**
   * @param {{relayUrl: string, deviceId: string, localBaseUrl: string, alias?: string, protocol?: string}} options
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
    this.wsFrames = []
    /** @type {Record<string, any>[]} */
    this.upgrades = []
    /** @type {Record<string, any> | null} */
    this.ack = null
    /** @type {Record<string, any> | null} */
    this.nak = null
  }

  /**
   * Open both channels and register the device.
   *
   * @returns {Promise<FakeHost>}
   */
  async connect() {
    const { relayUrl, deviceId, localBaseUrl, alias, protocol } = this.options
    const headers = { Authorization: `Bearer ${TOKEN}` }
    const managementOptions = protocol
      ? { headers, protocols: [protocol] }
      : { headers }

    this.management = new WebSocket(`${relayUrl}${MANAGEMENT_PATH}`, managementOptions)
    await once(this.management, 'open')
    this.management.send(
      encodeFrame(
        registerFrame({
          deviceId,
          alias: alias || 'Fake Host',
          platform: 'darwin',
          clientVersion: '1.2.3',
          localBaseUrl,
        }),
      ),
    )
    const frame = await nextFrame(this.management)
    if (frame.type === 'register_ack') this.ack = frame
    else this.nak = frame

    const tunnelUrl = new URL(TUNNEL_PATH, relayUrl)
    tunnelUrl.searchParams.set('device_id', deviceId)
    tunnelUrl.searchParams.set('capabilities', 'request_chunk,response_chunk,abort')
    this.tunnel = new WebSocket(tunnelUrl.href, managementOptions)
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
      void this.answerRequest(frame)
      return
    }
    if (frame.type === 'upgrade') {
      this.upgrades.push(frame)
      if (this.options.refuseUpgrades) {
        // The host could not open the local WebSocket and reports it with a
        // `response` frame, exactly like the plugin's relay client does.
        this.tunnel.send(
          encodeFrame(responseFrame({ id: frame.id, status: 502, headers: {}, body: null })),
        )
        return
      }
      this.tunnel.send(encodeFrame(upgradedFrame(frame.id)))
      return
    }
    if (frame.type === 'ws_frame') {
      this.wsFrames.push(frame)
    }
  }

  /**
   * Execute the request against the fake upstream and answer the relay.
   *
   * @param {Record<string, any>} frame
   */
  async answerRequest(frame) {
    const body = frame.body ? Buffer.from(frame.body, 'base64') : null
    const target = new URL(frame.path, this.options.localBaseUrl)
    const result = await new Promise((resolve, reject) => {
      const request = http.request(
        target,
        { method: frame.method, headers: frame.headers },
        (response) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () =>
            resolve({
              status: response.statusCode || 200,
              headers: response.headers,
              body: Buffer.concat(chunks),
            }),
          )
        },
      )
      request.on('error', reject)
      if (body) request.write(body)
      request.end()
    })
    const binary = Array.isArray(this.ack?.capabilities)
      && this.ack.capabilities.includes(CAPABILITY_BINARY_BODY)
      && result.body.length > 0
    if (binary) {
      // The way a host answers a relay that accepts a binary body: the text
      // frame carries the status and the headers, the message the bytes.
      this.tunnel.send(
        encodeFrame(
          responseFrame({
            id: frame.id,
            status: result.status,
            headers: result.headers,
            body: null,
            body_encoding: 'binary',
            body_length: result.body.length,
          }),
        ),
      )
      this.tunnel.send(encodeBinaryBody(String(frame.id), result.body))
      return
    }
    this.tunnel.send(
      encodeFrame(
        responseFrame({
          id: frame.id,
          status: result.status,
          headers: result.headers,
          body: result.body.length ? result.body.toString('base64') : null,
        }),
      ),
    )
  }

  /**
   * Refuse the pending upgrade, the way the host does when the local
   * WebSocket cannot be opened.
   */
  refuseUpgrade() {
    const frame = this.upgrades[this.upgrades.length - 1]
    this.tunnel.send(
      encodeFrame(responseFrame({ id: frame.id, status: 502, headers: {}, body: null })),
    )
  }

  /**
   * Send one payload to the bridged phone WebSocket.
   *
   * @param {string} payload
   */
  sendWsPayload(payload) {
    const frame = this.wsFrames[this.wsFrames.length - 1]
    this.tunnel.send(
      encodeFrame(wsFrame({ id: frame.id, data: Buffer.from(payload, 'utf8').toString('base64') })),
    )
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
 * @param {{publicBaseUrl?: string, devicePath?: string}} [options]
 */
async function startRelay(options = {}) {
  const relay = createRelayServer({
    token: TOKEN,
    publicBaseUrl: options.publicBaseUrl,
    devicePath: options.devicePath,
    log: () => {},
  })
  const { port } = await relay.listen({ host: '127.0.0.1', port: 0 })
  return { relay, url: `http://127.0.0.1:${port}` }
}

test('createRelayServer requires a token', () => {
  assert.throws(() => createRelayServer({}), /token/)
  assert.throws(() => createRelayServer({ token: '' }), /token/)
  assert.doesNotThrow(() => createRelayServer({ token: 'x' }))
})

test('registers a device and publishes the phone url', async (t) => {
  const upstream = await startUpstream()
  const { relay, url } = await startRelay({ publicBaseUrl: 'http://192.168.1.20:56131' })
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const host = await new FakeHost({
    relayUrl: url,
    deviceId: 'device-1',
    localBaseUrl: upstream.url,
  }).connect()
  t.after(() => host.close())

  assert.ok(host.ack, 'expected a register_ack frame')
  assert.equal(host.ack.device_id, 'device-1')
  assert.equal(
    host.ack.public_url,
    'http://192.168.1.20:56131/device-1/?rc=1&from=dsh_desktop',
  )

  const devices = relay.devices()
  assert.equal(devices.length, 1)
  assert.equal(devices[0].deviceId, 'device-1')
  assert.equal(devices[0].status, 'online')
  assert.equal(devices[0].localBaseUrl, upstream.url)
  assert.ok(devices[0].connectedAt)
  assert.ok(devices[0].lastSeenAt)
})

test('setPublicBaseUrl changes the published phone url', async (t) => {
  const upstream = await startUpstream()
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  relay.setPublicBaseUrl(`http://127.0.0.1:9999/`)
  const host = await new FakeHost({
    relayUrl: url,
    deviceId: 'device-late',
    localBaseUrl: upstream.url,
  }).connect()
  t.after(() => host.close())

  assert.equal(
    host.ack.public_url,
    'http://127.0.0.1:9999/device-late/?rc=1&from=dsh_desktop',
  )
})

test('authenticates the management channel with the bearer subprotocol', async (t) => {
  const upstream = await startUpstream()
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const host = await new FakeHost({
    relayUrl: url,
    deviceId: 'device-sub',
    localBaseUrl: upstream.url,
    protocol: `kimi-code.bearer.${TOKEN}`,
  }).connect()
  t.after(() => host.close())

  assert.ok(host.ack, 'expected a register_ack frame')
  assert.equal(host.ack.device_id, 'device-sub')
})

test('mounts the device under a configured path prefix', async (t) => {
  const upstream = await startUpstream()
  const relay = createRelayServer({
    token: TOKEN,
    devicePath: '/rc/',
    publicBaseUrl: 'http://relay.local',
    log: () => {},
  })
  const { port } = await relay.listen({ host: '127.0.0.1', port: 0 })
  const url = `http://127.0.0.1:${port}`
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const host = await new FakeHost({
    relayUrl: url,
    deviceId: 'device-prefixed',
    localBaseUrl: upstream.url,
  }).connect()
  t.after(() => host.close())

  assert.equal(
    host.ack.public_url,
    'http://relay.local/rc/device-prefixed/?rc=1&from=dsh_desktop',
  )

  const scoped = await fetch(`${url}/rc/device-prefixed/app.js`)
  assert.equal(scoped.status, 200)
  assert.equal((await scoped.json()).url, '/app.js')

  const absolute = await fetch(`${url}/assets/app.js`)
  assert.equal(absolute.status, 200)
  assert.equal((await absolute.json()).url, '/assets/app.js')
})

test('survives a malformed frame and keeps serving', async (t) => {
  const upstream = await startUpstream()
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const host = await new FakeHost({
    relayUrl: url,
    deviceId: 'device-robust',
    localBaseUrl: upstream.url,
  }).connect()
  t.after(() => host.close())

  host.management.send('this is not json')
  host.management.send(JSON.stringify({ no_type: true }))
  host.management.send(JSON.stringify({ type: 'unknown-frame' }))
  host.tunnel.send(JSON.stringify({ type: 'unknown-frame' }))
  await new Promise((resolve) => setTimeout(resolve, 100))

  // The relay is still alive and still proxies traffic.
  const response = await fetch(`${url}/device-robust/after-garbage`)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).url, '/after-garbage')
})

test('rejects an unauthorized management upgrade with 401', async (t) => {
  const upstream = await startUpstream()
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const socket = new WebSocket(`${url}${MANAGEMENT_PATH}`)
  const [error] = await once(socket, 'error')
  assert.match(String(error && error.message), /401/)
})

test('rejects a duplicate device registration', async (t) => {
  const upstream = await startUpstream()
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const host = await new FakeHost({
    relayUrl: url,
    deviceId: 'device-dup',
    localBaseUrl: upstream.url,
  }).connect()
  t.after(() => host.close())

  const second = new WebSocket(`${url}${MANAGEMENT_PATH}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  await once(second, 'open')
  second.send(
    encodeFrame(
      registerFrame({
        deviceId: 'device-dup',
        alias: 'Other',
        platform: 'darwin',
        clientVersion: '1.2.3',
        localBaseUrl: upstream.url,
      }),
    ),
  )
  const frame = await nextFrame(second)
  assert.equal(frame.type, 'register_nak')
  assert.ok(frame.reason)
})

test('proxies phone traffic through the tunnel and strips the device prefix', async (t) => {
  const upstream = await startUpstream()
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const host = await new FakeHost({
    relayUrl: url,
    deviceId: 'device-proxy',
    localBaseUrl: upstream.url,
  }).connect()
  t.after(() => host.close())

  const response = await fetch(`${url}/device-proxy/hello?x=1`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-upstream'), 'fake')
  const payload = await response.json()
  assert.equal(payload.method, 'GET')
  assert.equal(payload.url, '/hello?x=1')

  assert.equal(host.requests.length, 1)
  assert.equal(host.requests[0].type, 'request')
  assert.equal(host.requests[0].method, 'GET')
  assert.equal(host.requests[0].path, '/hello?x=1')
  assert.equal(host.requests[0].headers['accept-encoding'], 'identity')
  assert.equal(host.requests[0].headers.host, undefined)
})

test('routes root level paths to the default device', async (t) => {
  const upstream = await startUpstream()
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const host = await new FakeHost({
    relayUrl: url,
    deviceId: 'device-root',
    localBaseUrl: upstream.url,
  }).connect()
  t.after(() => host.close())

  const response = await fetch(`${url}/assets/index-abc.js`)
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.url, '/assets/index-abc.js')
  assert.equal(host.requests[0].path, '/assets/index-abc.js')
})

test('preserves the query string on the device root', async (t) => {
  const upstream = await startUpstream()
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const host = await new FakeHost({
    relayUrl: url,
    deviceId: 'device-query',
    localBaseUrl: upstream.url,
  }).connect()
  t.after(() => host.close())

  const response = await fetch(`${url}/device-query/?rc=1&from=dsh_desktop&token=abc`)
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.url, '/?rc=1&from=dsh_desktop&token=abc')
  assert.equal(host.requests[0].path, '/?rc=1&from=dsh_desktop&token=abc')
})

test('forwards POST bodies unchanged', async (t) => {
  const upstream = await startUpstream()
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const host = await new FakeHost({
    relayUrl: url,
    deviceId: 'device-post',
    localBaseUrl: upstream.url,
  }).connect()
  t.after(() => host.close())

  const body = JSON.stringify({ jsonrpc: '2.0', method: 'session.list', params: [] })
  const response = await fetch(`${url}/api/session/list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.method, 'POST')
  assert.equal(payload.url, '/api/session/list')
  assert.equal(payload.body, body)
  assert.equal(host.requests[0].body_encoding, 'base64')
  assert.equal(
    Buffer.from(host.requests[0].body, 'base64').toString('utf8'),
    body,
  )
})

test('keeps every set-cookie of the upstream response', async (t) => {
  const upstream = await startUpstream()
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const host = await new FakeHost({
    relayUrl: url,
    deviceId: 'device-cookie',
    localBaseUrl: upstream.url,
  }).connect()
  t.after(() => host.close())

  const response = await fetch(`${url}/set-cookie`)
  assert.equal(response.status, 200)
  const cookies = response.headers.getSetCookie()
  assert.equal(cookies.length, 2)
  assert.match(cookies[0], /a=1/)
  assert.match(cookies[1], /b=2/)
})

test('delivers a binary body as bytes, not as its base64 text', async (t) => {
  const upstream = await startUpstream()
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const host = await new FakeHost({
    relayUrl: url,
    deviceId: 'device-binary',
    localBaseUrl: upstream.url,
  }).connect()
  t.after(() => host.close())

  const response = await new Promise((resolve, reject) => {
    // A raw request: `fetch` would decompress the body on its own and hide
    // what the relay actually delivered.
    const request = http.get(`${url}/gzip`, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
      )
    })
    request.on('error', reject)
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers['content-encoding'], 'gzip')
  // The bytes have to arrive unchanged: a relay that guessed the encoding
  // would deliver the base64 text of a body that is not valid UTF-8.
  assert.deepEqual([...response.body], [0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0xfd])
})

test('delivers a body that arrives as a binary message', async (t) => {
  const upstream = await startUpstream()
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const host = await new FakeHost({
    relayUrl: url,
    deviceId: 'device-binary-body',
    localBaseUrl: upstream.url,
  }).connect()
  t.after(() => host.close())

  // The relay advertises the capability, so the host answers with a binary
  // message and the phone has to receive the very same bytes.
  assert.ok(host.ack.capabilities.includes(CAPABILITY_BINARY_BODY))

  const response = await new Promise((resolve, reject) => {
    const request = http.get(`${url}/gzip`, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
      )
    })
    request.on('error', reject)
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers['content-encoding'], 'gzip')
  assert.deepEqual([...response.body], [0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0xfd])
})

test('answers 503 when the device has no live tunnel', async (t) => {
  const upstream = await startUpstream()
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const host = await new FakeHost({
    relayUrl: url,
    deviceId: 'device-notunnel',
    localBaseUrl: upstream.url,
  }).connect()
  t.after(() => host.close())

  host.tunnel.close()
  await once(host.tunnel, 'close')

  const response = await fetch(`${url}/device-notunnel/anything`)
  assert.equal(response.status, 503)
})

test('answers 403 once the host revoked the device', async (t) => {
  const upstream = await startUpstream()
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const host = await new FakeHost({
    relayUrl: url,
    deviceId: 'device-revoked',
    localBaseUrl: upstream.url,
  }).connect()
  t.after(() => host.close())

  host.management.send(encodeFrame({ type: 'revoke', reason: 'user asked for it' }))
  await new Promise((resolve) => setTimeout(resolve, 100))

  const response = await fetch(`${url}/device-revoked/anything`)
  assert.equal(response.status, 403)
})

test('exposes the management api', async (t) => {
  const upstream = await startUpstream()
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const host = await new FakeHost({
    relayUrl: url,
    deviceId: 'device-api',
    localBaseUrl: upstream.url,
  }).connect()
  t.after(() => host.close())

  const unauthorized = await fetch(`${url}/v1/remote/devices`)
  assert.equal(unauthorized.status, 401)

  const list = await fetch(`${url}/v1/remote/devices`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(list.status, 200)
  const devices = await list.json()
  assert.equal(devices.length, 1)
  assert.deepEqual(Object.keys(devices[0]).sort(), [
    'alias',
    'clientVersion',
    'connectedAt',
    'deviceId',
    'lastSeenAt',
    'platform',
    'status',
  ])
  assert.equal(devices[0].deviceId, 'device-api')
  assert.equal(devices[0].status, 'online')

  const renamed = await fetch(`${url}/v1/remote/devices/device-api/alias`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ alias: 'Living room' }),
  })
  assert.equal(renamed.status, 200)
  assert.deepEqual(await renamed.json(), { ok: true })
  assert.equal(relay.devices()[0].alias, 'Living room')

  const badAlias = await fetch(`${url}/v1/remote/devices/device-api/alias`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ alias: 42 }),
  })
  assert.equal(badAlias.status, 400)

  const unknown = await fetch(`${url}/v1/remote/devices/nope/alias`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ alias: 'x' }),
  })
  assert.equal(unknown.status, 404)

  const offline = await fetch(`${url}/v1/remote/devices/device-api/offline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(offline.status, 200)
  assert.deepEqual(await offline.json(), { ok: true })
  assert.equal(relay.devices()[0].status, 'offline')

  const afterOffline = await fetch(`${url}/device-api/anything`)
  assert.equal(afterOffline.status, 403)
})

test('bridges a phone websocket to the host', async (t) => {
  const upstream = await startUpstream()
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const host = await new FakeHost({
    relayUrl: url,
    deviceId: 'device-ws',
    localBaseUrl: upstream.url,
  }).connect()
  t.after(() => host.close())

  const phone = new WebSocket(`${url}/api/remote.mux`)
  await once(phone, 'open')
  const received = []
  phone.on('message', (data) => received.push(String(data)))
  t.after(() => phone.close())

  // The relay asks the host to upgrade; the host answers with `upgraded`.
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(host.upgrades.length, 1)
  assert.equal(host.upgrades[0].type, 'upgrade')
  assert.equal(host.upgrades[0].path, '/api/remote.mux')

  phone.send('ping')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(host.wsFrames.length, 1)
  assert.equal(Buffer.from(host.wsFrames[0].data, 'base64').toString('utf8'), 'ping')

  host.sendWsPayload('pong')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(received, ['pong'])
})

test('fails the phone websocket when the host cannot open it', async (t) => {
  const upstream = await startUpstream()
  const { relay, url } = await startRelay()
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  const host = await new FakeHost({
    relayUrl: url,
    deviceId: 'device-ws-fail',
    localBaseUrl: upstream.url,
    refuseUpgrades: true,
  }).connect()
  t.after(() => host.close())

  const phone = new WebSocket(`${url}/api/remote.mux`)
  const [error] = await once(phone, 'error')
  assert.match(String(error && error.message), /502/)

  assert.equal(host.upgrades.length, 1)
})

test('runs on a pre-built server', async (t) => {
  const upstream = await startUpstream()
  const relay = createRelayServer({ token: TOKEN, log: () => {} })
  const custom = http.createServer()
  const { port } = await relay.listen({ host: '127.0.0.1', port: 0, server: custom })
  t.after(async () => {
    await relay.close()
    await upstream.close()
  })

  assert.ok(port > 0)
  const info = relay.address()
  assert.equal(info.port, port)
  assert.ok(String(info.url).startsWith('http://127.0.0.1:'))

  const response = await fetch(`http://127.0.0.1:${port}/v1/remote/devices`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), [])
})

test('closes cleanly and releases every socket', async (t) => {
  const upstream = await startUpstream()
  const { relay, url } = await startRelay()
  const host = await new FakeHost({
    relayUrl: url,
    deviceId: 'device-close',
    localBaseUrl: upstream.url,
  }).connect()

  const closed = Promise.all([
    once(host.management, 'close'),
    once(host.tunnel, 'close'),
  ])
  await relay.close()
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))])
  await upstream.close()

  assert.equal(host.management.readyState, WebSocket.CLOSED)
  assert.equal(host.tunnel.readyState, WebSocket.CLOSED)
  assert.equal(relay.devices()[0].status, 'offline')
})
