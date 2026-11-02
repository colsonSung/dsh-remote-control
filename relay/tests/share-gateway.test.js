/**
 * @file Self-test for the relay's guest (share) gateway.
 *
 * The guest namespace is the public door of a shared conversation: a visitor
 * with a link and a passcode reaches one conversation and nothing else.
 *
 * The test plays the role of the DSH host: it opens the management and the
 * tunnel WebSocket against the relay, registers a device, publishes a share
 * and answers the `request` frames the relay produces for guest traffic.
 *
 * The suite runs against **both** copies of the relay — the standalone one in
 * `src/` and the one the plugin embeds — because the two must behave the
 * same way.
 *
 * Run with: `node --test tests/share-gateway.test.js`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

import { createRelayServer as createStandaloneRelay } from '../src/relay-server.js'
import {
  MANAGEMENT_PATH,
  TUNNEL_PATH,
  decodeFrame,
  encodeFrame,
  registerFrame,
  responseFrame,
} from '../src/relay-protocol.js'

// The plugin embeds its own copy of the relay, and the two must behave the
// same way. The plugin sits next to the relay in the working copy and under
// 'plugin/' in the published one, so both places are tried.
const { createRelayServer: createBundledRelay } = await import('../../remote-control/src/relay-server.js')
  .catch(() => import('../../plugin/src/relay-server.js'))

const TOKEN = 'test-token'
const DEVICE_ID = 'host-device'
const SHARE_ID = 'share-1'

/**
 * The two relay copies under test.
 *
 * The bundled one lives in the plugin package; it is a newer copy of the same
 * relay, and a guest must not tell them apart.
 */
const IMPLEMENTATIONS = [
  { name: 'standalone relay', create: createStandaloneRelay },
  { name: 'bundled relay', create: createBundledRelay },
]

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
   * @param {{relayUrl: string, localBaseUrl: string, deviceId?: string, shares?: {id: string, revoked?: boolean}[]}} options
   */
  constructor(options) {
    this.options = options
    this.deviceId = options.deviceId ?? DEVICE_ID
    /** @type {WebSocket | null} */
    this.management = null
    /** @type {WebSocket | null} */
    this.tunnel = null
    /** @type {Record<string, any>[]} */
    this.requests = []
    /** @type {Record<string, any> | null} */
    this.ack = null
  }

  /**
   * Open both channels and register the device.
   *
   * @returns {Promise<FakeHost>}
   */
  async connect() {
    const headers = { Authorization: `Bearer ${TOKEN}` }
    this.management = new WebSocket(`${this.options.relayUrl}${MANAGEMENT_PATH}`, { headers })
    await once(this.management, 'open')
    this.management.send(
      encodeFrame(
        registerFrame({
          deviceId: this.deviceId,
          alias: 'Fake Host',
          platform: 'darwin',
          clientVersion: '1.2.3',
          localBaseUrl: this.options.localBaseUrl,
          accessKey: 'access-key',
          passcode: this.options.passcode ?? '12345678',
          shares: this.options.shares ?? [],
        }),
      ),
    )
    const frame = await nextFrame(this.management)
    this.ack = frame.type === 'register_ack' ? frame : null
    assert.ok(this.ack, 'the device registered')

    const tunnelUrl = new URL(TUNNEL_PATH, this.options.relayUrl)
    tunnelUrl.searchParams.set('device_id', this.deviceId)
    this.tunnel = new WebSocket(tunnelUrl.href, { headers })
    await once(this.tunnel, 'open')
    this.tunnel.on('message', (data) => this.onTunnelFrame(data))
    return this
  }

  /**
   * Send one frame on the management channel.
   *
   * @param {Record<string, any>} frame
   */
  sendManagement(frame) {
    this.management.send(encodeFrame(frame))
  }

  /**
   * @param {Buffer | string} data
   */
  onTunnelFrame(data) {
    const frame = decodeFrame(String(data))
    if (frame.type !== 'request') return
    this.requests.push(frame)
    void this.answerRequest(frame)
  }

  /**
   * Answer one request frame the way the host does.
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
   * Close the tunnel channel, as a computer that went to sleep would.
   */
  async closeTunnel() {
    const tunnel = this.tunnel
    this.tunnel = null
    if (!tunnel) return
    const closed = once(tunnel, 'close')
    tunnel.close()
    await closed
  }

  /**
   * Close the management channel, so the device may register again.
   */
  async closeManagement() {
    const management = this.management
    this.management = null
    if (!management) return
    const closed = once(management, 'close')
    management.close()
    await closed
    // The relay needs a moment to notice that the channel is gone.
    await delay(50)
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
 * @param {(options: any) => any} create
 * @param {{statePath?: string, log?: (message: string) => void}} [options]
 */
async function startRelay(create, options = {}) {
  const relay = create({
    token: TOKEN,
    publicBaseUrl: 'http://127.0.0.1:0',
    statePath: options.statePath,
    log: options.log ?? (() => {}),
  })
  const { port } = await relay.listen({ host: '127.0.0.1', port: 0 })
  return { relay, url: `http://127.0.0.1:${port}` }
}

/**
 * Start the fake upstream server the host serves.
 *
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
async function startUpstream() {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      )
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/**
 * One request against the relay.
 *
 * @param {string} url
 * @param {{method?: string, headers?: Record<string, string>, body?: string}} [options]
 */
async function request(url, options = {}) {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
    body: options.body,
    redirect: 'manual',
  })
  const body = await response.text()
  return { status: response.status, headers: response.headers, body }
}

/**
 * One request against the relay, with the path exactly as it is written.
 *
 * `fetch` normalises a path before it sends it, so a path that tries to walk
 * out of a share has to be sent raw to reach the relay at all.
 *
 * @param {string} baseUrl
 * @param {{path: string, method?: string, headers?: Record<string, string>, body?: string}} options
 */
function rawRequest(baseUrl, options) {
  const url = new URL(baseUrl)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

/**
 * Wait until the relay has written its state file.
 *
 * @param {number} ms
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

for (const implementation of IMPLEMENTATIONS) {
  test(`${implementation.name}: an unknown share answers 404`, async (t) => {
    const upstream = await startUpstream()
    const { relay, url } = await startRelay(implementation.create)
    const host = await new FakeHost({ relayUrl: url, localBaseUrl: upstream.url }).connect()
    t.after(async () => {
      await host.close()
      await relay.close()
      await upstream.close()
    })

    const response = await request(`${url}/s/${SHARE_ID}/conversation`)
    assert.equal(response.status, 404)
    assert.equal(host.requests.length, 0, 'the host is never asked')
  })

  test(`${implementation.name}: a closed share answers 403`, async (t) => {
    const upstream = await startUpstream()
    const { relay, url } = await startRelay(implementation.create)
    const host = await new FakeHost({ relayUrl: url, localBaseUrl: upstream.url }).connect()
    t.after(async () => {
      await host.close()
      await relay.close()
      await upstream.close()
    })

    host.sendManagement({
      type: 'share_publish',
      share_id: SHARE_ID,
      device_id: DEVICE_ID,
      revoked: true,
    })
    await delay(50)

    const response = await request(`${url}/s/${SHARE_ID}/conversation`)
    assert.equal(response.status, 403)
    assert.equal(host.requests.length, 0, 'the host is never asked')
  })

  test(`${implementation.name}: a share of an offline device answers 503`, async (t) => {
    const upstream = await startUpstream()
    const { relay, url } = await startRelay(implementation.create)
    const host = await new FakeHost({ relayUrl: url, localBaseUrl: upstream.url }).connect()
    t.after(async () => {
      await host.close()
      await relay.close()
      await upstream.close()
    })

    host.sendManagement({
      type: 'share_publish',
      share_id: SHARE_ID,
      device_id: DEVICE_ID,
      revoked: false,
    })
    await delay(50)
    await host.closeTunnel()

    const response = await request(`${url}/s/${SHARE_ID}/conversation`)
    assert.equal(response.status, 503)
  })

  test(`${implementation.name}: a guest request is rewritten to the host's share namespace`, async (t) => {
    const upstream = await startUpstream()
    const { relay, url } = await startRelay(implementation.create)
    const host = await new FakeHost({ relayUrl: url, localBaseUrl: upstream.url }).connect()
    t.after(async () => {
      await host.close()
      await relay.close()
      await upstream.close()
    })

    host.sendManagement({
      type: 'share_publish',
      share_id: SHARE_ID,
      device_id: DEVICE_ID,
      revoked: false,
    })
    await delay(50)

    const response = await request(`${url}/s/${SHARE_ID}/conversation/42?p=246810`)
    assert.equal(response.status, 200)
    assert.equal(host.requests.length, 1)
    const frame = host.requests[0]
    assert.equal(frame.method, 'GET')
    assert.equal(frame.path, `/share/${SHARE_ID}/conversation/42?p=246810`)
    assert.equal(frame.headers['x-dsh-share'], SHARE_ID)
    // The guest never reaches the device root, where the host would hand out
    // a launch token.
    assert.ok(!frame.path.startsWith('/share/') === false)
    assert.ok(!frame.path.includes('token='), 'no launch token travels with the guest')
  })

  test(`${implementation.name}: a guest may not forge the host's headers`, async (t) => {
    const upstream = await startUpstream()
    const { relay, url } = await startRelay(implementation.create)
    const host = await new FakeHost({ relayUrl: url, localBaseUrl: upstream.url }).connect()
    t.after(async () => {
      await host.close()
      await relay.close()
      await upstream.close()
    })

    host.sendManagement({
      type: 'share_publish',
      share_id: SHARE_ID,
      device_id: DEVICE_ID,
      revoked: false,
    })
    await delay(50)

    await request(`${url}/s/${SHARE_ID}/conversation`, {
      headers: {
        'x-dsh-share': 'somebody-elses-share',
        'x-dsh-role': 'owner',
        'x-dsh-internal': 'yes',
      },
    })

    assert.equal(host.requests.length, 1)
    const headers = host.requests[0].headers
    assert.equal(headers['x-dsh-share'], SHARE_ID)
    assert.equal(headers['x-dsh-role'], undefined)
    assert.equal(headers['x-dsh-internal'], undefined)
  })

  test(`${implementation.name}: a guest may not walk out of its share`, async (t) => {
    const upstream = await startUpstream()
    const { relay, url } = await startRelay(implementation.create)
    const host = await new FakeHost({ relayUrl: url, localBaseUrl: upstream.url }).connect()
    t.after(async () => {
      await host.close()
      await relay.close()
      await upstream.close()
    })

    host.sendManagement({
      type: 'share_publish',
      share_id: SHARE_ID,
      device_id: DEVICE_ID,
      revoked: false,
    })
    await delay(50)

    const escaped = await rawRequest(url, { path: `/s/${SHARE_ID}/../../api/secret` })
    assert.equal(escaped.status, 400)
    assert.equal(host.requests.length, 0, 'the host is never asked')

    const encoded = await rawRequest(url, { path: `/s/${SHARE_ID}/%2e%2e/%2e%2e/api/secret` })
    assert.equal(encoded.status, 400)
    assert.equal(host.requests.length, 0, 'the host is never asked')

    const deeper = await rawRequest(url, { path: `/s/${SHARE_ID}/a/../../b` })
    assert.equal(deeper.status, 400)
    assert.equal(host.requests.length, 0, 'the host is never asked')
  })

  test(`${implementation.name}: a guest gets no websocket`, async (t) => {
    const upstream = await startUpstream()
    const { relay, url } = await startRelay(implementation.create)
    const host = await new FakeHost({ relayUrl: url, localBaseUrl: upstream.url }).connect()
    t.after(async () => {
      await host.close()
      await relay.close()
      await upstream.close()
    })

    host.sendManagement({
      type: 'share_publish',
      share_id: SHARE_ID,
      device_id: DEVICE_ID,
      revoked: false,
    })
    await delay(50)

    const socket = new WebSocket(`${url.replace('http', 'ws')}/s/${SHARE_ID}/api/remote.mux`)
    const response = await new Promise((resolve, reject) => {
      socket.on('unexpected-response', (_request, res) => resolve(res))
      socket.on('open', () => reject(new Error('the guest got a websocket')))
      socket.on('error', () => resolve(null))
    })
    assert.ok(response, 'the upgrade was answered with a response')
    assert.equal(response.statusCode, 403)
    socket.terminate()
    assert.equal(host.requests.length, 0)
  })

  test(`${implementation.name}: a websocket bridge needs a phone credential`, async (t) => {
    const upstream = await startUpstream()
    const { relay, url } = await startRelay(implementation.create)
    const host = await new FakeHost({ relayUrl: url, localBaseUrl: upstream.url }).connect()
    t.after(async () => {
      await host.close()
      await relay.close()
      await upstream.close()
    })

    // A bridge is an owner peer on the host, so the device id in the path is
    // not a credential: without the session cookie the upgrade is refused.
    const socket = new WebSocket(`${url.replace('http', 'ws')}/${DEVICE_ID}/api/remote.mux`)
    const response = await new Promise((resolve, reject) => {
      socket.on('unexpected-response', (_request, res) => resolve(res))
      socket.on('open', () => reject(new Error('the bridge opened without a credential')))
      socket.on('error', () => resolve(null))
    })
    assert.ok(response, 'the upgrade was answered with a response')
    assert.equal(response.statusCode, 401)
    socket.terminate()
  })

  test(`${implementation.name}: the share_revoke frame closes a share`, async (t) => {
    const upstream = await startUpstream()
    const { relay, url } = await startRelay(implementation.create)
    const host = await new FakeHost({ relayUrl: url, localBaseUrl: upstream.url }).connect()
    t.after(async () => {
      await host.close()
      await relay.close()
      await upstream.close()
    })

    host.sendManagement({
      type: 'share_publish',
      share_id: SHARE_ID,
      device_id: DEVICE_ID,
      revoked: false,
    })
    await delay(50)
    const open = await request(`${url}/s/${SHARE_ID}/conversation`)
    assert.equal(open.status, 200)

    host.sendManagement({
      type: 'share_revoke',
      share_id: SHARE_ID,
      device_id: DEVICE_ID,
    })
    await delay(50)

    const closed = await request(`${url}/s/${SHARE_ID}/conversation`)
    assert.equal(closed.status, 403)
  })

  test(`${implementation.name}: a share survives a relay restart`, async (t) => {
    const upstream = await startUpstream()
    const statePath = join(mkdtempSync(join(tmpdir(), 'dsh-relay-share-')), 'state.json')

    const first = await startRelay(implementation.create, { statePath })
    const host = await new FakeHost({ relayUrl: first.url, localBaseUrl: upstream.url }).connect()
    host.sendManagement({
      type: 'share_publish',
      share_id: SHARE_ID,
      device_id: DEVICE_ID,
      revoked: false,
    })
    await delay(50)
    await host.close()
    await first.relay.close()

    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.deepEqual(state.shares?.[SHARE_ID], { device_id: DEVICE_ID, revoked: false })

    // The relay comes back with an empty state file: the route is restored by
    // the share list the device publishes with its registration.
    const second = await startRelay(implementation.create, { statePath })
    t.after(async () => {
      await second.relay.close()
      await upstream.close()
    })

    const restored = await new FakeHost({
      relayUrl: second.url,
      localBaseUrl: upstream.url,
      shares: [{ id: SHARE_ID, revoked: false }],
    }).connect()
    t.after(async () => {
      await restored.close()
    })

    const response = await request(`${second.url}/s/${SHARE_ID}/conversation`)
    assert.equal(response.status, 200)
    assert.equal(restored.requests.length, 1)
    assert.equal(restored.requests[0].path, `/share/${SHARE_ID}/conversation`)
  })

  test(`${implementation.name}: a share the host stops listing is closed`, async (t) => {
    const upstream = await startUpstream()
    const { relay, url } = await startRelay(implementation.create)
    const host = await new FakeHost({
      relayUrl: url,
      localBaseUrl: upstream.url,
      shares: [{ id: SHARE_ID, revoked: false }],
    }).connect()
    t.after(async () => {
      await host.close()
      await relay.close()
      await upstream.close()
    })

    const open = await request(`${url}/s/${SHARE_ID}/conversation`)
    assert.equal(open.status, 200)

    // The host registers again and no longer lists the share: the link is
    // closed, not forgotten, so it answers "forbidden".
    await host.closeManagement()
    const second = await new FakeHost({
      relayUrl: url,
      localBaseUrl: upstream.url,
      shares: [],
    }).connect()
    t.after(async () => {
      await second.close()
    })
    await delay(50)

    const closed = await request(`${url}/s/${SHARE_ID}/conversation`)
    assert.equal(closed.status, 403)
  })

  test(`${implementation.name}: the phone link keeps working`, async (t) => {
    const upstream = await startUpstream()
    const { relay, url } = await startRelay(implementation.create)
    // The device registers without a passcode, so the link alone is the
    // credential — the phone path must not change.
    const host = await new FakeHost({
      relayUrl: url,
      localBaseUrl: upstream.url,
      passcode: '',
    }).connect()
    t.after(async () => {
      await host.close()
      await relay.close()
      await upstream.close()
    })

    // The phone presents the access key of the device and gets the app.
    const response = await request(`${url}/${DEVICE_ID}/?rc=1&k=access-key`)
    assert.equal(response.status, 200)
    assert.equal(host.requests.length, 1)
    assert.equal(host.requests[0].path, '/?rc=1&k=access-key')
  })
}
