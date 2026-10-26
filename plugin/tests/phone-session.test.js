/**
 * A phone's session must outlive the relay process.
 *
 * The relay hands a phone a session cookie after it types the access code.
 * The token used to be random and lived in memory, so every restart of the
 * relay — a deploy, a crash, a reboot — threw it away and locked every phone
 * out: the app then answered every request with `401` and the phone showed a
 * blank screen until the access code was typed again.
 *
 * The token is derived from the phone's own credential and the relay's secret
 * now, so the relay can recompute it after a restart.
 *
 * Run with: `node --test tests/phone-session.test.js`
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { WebSocket as NodeWebSocket, WebSocketServer } from 'ws'

import { createRelayServer } from '../src/relay-server.js'
import { decodeFrame, encodeFrame, registerFrame, responseFrame } from '../src/relay-protocol.js'

const TOKEN = 'test-token'
const DEVICE_ID = 'device-session'
const ACCESS_KEY = 'access-key-of-the-device'
const PASSCODE = '12345678'

/**
 * A fake host: it registers the device and keeps both channels open.
 */
class FakeHost extends EventEmitter {
  /**
   * @param {{relayUrl: string, deviceId: string, localBaseUrl: string}} options
   */
  constructor(options) {
    super()
    this.options = options
    /** @type {any} */
    this.management = null
  }

  /**
   * Open the channels and register.
   *
   * @returns {Promise<FakeHost>}
   */
  async connect() {
    const { relayUrl, deviceId, localBaseUrl } = this.options
    const url = new URL(relayUrl)
    url.pathname = '/v1/remote/create'
    const headers = { Authorization: `Bearer ${TOKEN}` }
    this.management = new NodeWebSocket(url, { headers })
    await new Promise((resolve, reject) => {
      this.management.once('open', resolve)
      this.management.once('error', reject)
    })
    this.management.send(
      encodeFrame(
        registerFrame({
          deviceId,
          alias: 'Fake Host',
          platform: 'darwin',
          clientVersion: '1.0.0',
          localBaseUrl,
          accessKey: ACCESS_KEY,
          passcode: PASSCODE,
        }),
      ),
    )
    const frame = await this.nextFrame()
    if (frame.type !== 'register_ack') throw new Error(`the relay refused the device: ${frame.type}`)

    // The relay only serves a phone when the device has a live tunnel.
    const tunnelUrl = new URL('/v1/remote/http', relayUrl)
    tunnelUrl.searchParams.set('device_id', deviceId)
    tunnelUrl.searchParams.set('capabilities', 'request_chunk,response_chunk,abort')
    this.tunnel = new NodeWebSocket(tunnelUrl.href, { headers })
    await new Promise((resolve, reject) => {
      this.tunnel.once('open', resolve)
      this.tunnel.once('error', reject)
    })
    this.tunnel.on('message', (data) => {
      const frame = decodeFrame(String(data))
      if (frame.type === 'request') {
        // The phone asked the upstream for something: answer it.
        void fetch(this.options.localBaseUrl + frame.path, { method: 'POST' })
          .then((response) => response.arrayBuffer())
          .then((body) => {
            this.tunnel.send(
              encodeFrame(
                responseFrame({
                  id: frame.id,
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                  body: Buffer.from(body).toString('base64'),
                }),
              ),
            )
          })
          .catch(() => {
            this.tunnel.send(
              encodeFrame(
                responseFrame({ id: frame.id, status: 502, headers: {}, body: null }),
              ),
            )
          })
      }
    })
    return this
  }

  /**
   * @returns {Promise<Record<string, any>>}
   */
  nextFrame() {
    return new Promise((resolve) => {
      const onMessage = (data) => {
        this.management.off('message', onMessage)
        resolve(decodeFrame(data.toString()))
      }
      this.management.on('message', onMessage)
    })
  }

  close() {
    try {
      this.management?.terminate()
    } catch {
      /* ignore */
    }
    try {
      this.tunnel?.terminate()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Boot a relay that keeps its state in the given file.
 *
 * @param {{statePath: string, publicBaseUrl?: string}} options
 * @returns {Promise<{relay: any, url: string}>}
 */
async function startRelay(options) {
  const relay = createRelayServer({
    token: TOKEN,
    publicBaseUrl: options.publicBaseUrl,
    statePath: options.statePath,
    log: () => {},
  })
  const { port } = await relay.listen({ host: '127.0.0.1', port: 0 })
  return { relay, url: `http://127.0.0.1:${port}` }
}

/**
 * The upstream the relay proxies to.
 *
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
async function startUpstream() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  }
}

/**
 * Unlock a phone and return its cookies.
 *
 * @param {string} url the relay base URL
 * @returns {Promise<{session: string, device: string}>}
 */
async function unlock(url) {
  const link = `${url}/${DEVICE_ID}/?k=${ACCESS_KEY}`
  const response = await fetch(link, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `p=${PASSCODE}`,
    redirect: 'manual',
  })
  const cookies = response.headers.getSetCookie()
  const session = cookies.find((cookie) => cookie.startsWith('dsh-rc='))
  const device = cookies.find((cookie) => cookie.startsWith('dsh-device='))
  assert.ok(session, `expected a session cookie, got ${cookies.join(', ')}`)
  assert.ok(device, `expected a device cookie, got ${cookies.join(', ')}`)
  return {
    session: session.split(';')[0],
    device: device.split(';')[0],
  }
}

/**
 * Ask the relay something as an unlocked phone.
 *
 * @param {string} url the relay base URL
 * @param {string} cookie the cookies to send
 * @returns {Promise<number>} the status
 */
async function phoneGet(url, cookie) {
  const response = await fetch(`${url}/${DEVICE_ID}/api/ping`, { headers: { cookie } })
  return response.status
}

test('the session of a phone outlives a relay restart', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'dsh-relay-state-'))
  const statePath = path.join(directory, 'state.json')
  t.after(() => rmSync(directory, { recursive: true, force: true }))

  const upstream = await startUpstream()
  t.after(() => upstream.close())

  // The first relay: the phone unlocks here.
  const first = await startRelay({ statePath })
  const host = await new FakeHost({
    relayUrl: first.url,
    deviceId: DEVICE_ID,
    localBaseUrl: upstream.url,
  }).connect()
  t.after(() => host.close())

  const cookies = await unlock(first.url)
  assert.equal(await phoneGet(first.url, cookies.session), 200)

  // The relay restarts — a deploy, a crash, a reboot.
  host.close()
  await first.relay.close()

  const second = await startRelay({ statePath })
  t.after(async () => {
    await second.relay.close()
  })
  const host2 = await new FakeHost({
    relayUrl: second.url,
    deviceId: DEVICE_ID,
    localBaseUrl: upstream.url,
  }).connect()
  t.after(() => host2.close())

  // The phone keeps its cookie: it must not be asked for the access code again.
  assert.equal(
    await phoneGet(second.url, `${cookies.session}; ${cookies.device}`),
    200,
    'the session must survive the restart',
  )
})

test('a removed phone loses its session', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'dsh-relay-state-'))
  const statePath = path.join(directory, 'state.json')
  t.after(() => rmSync(directory, { recursive: true, force: true }))

  const upstream = await startUpstream()
  t.after(() => upstream.close())

  const { relay, url } = await startRelay({ statePath })
  t.after(async () => {
    await relay.close()
  })
  const host = await new FakeHost({
    relayUrl: url,
    deviceId: DEVICE_ID,
    localBaseUrl: upstream.url,
  }).connect()
  t.after(() => host.close())

  const cookies = await unlock(url)
  assert.equal(await phoneGet(url, `${cookies.session}; ${cookies.device}`), 200)

  // The owner forgets the phone.
  const list = await fetch(`${url}/v1/remote/devices/${DEVICE_ID}/phones`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  const phones = await list.json()
  assert.equal(phones.length, 1)
  const removed = await fetch(
    `${url}/v1/remote/devices/${DEVICE_ID}/phones/${phones[0].id}/remove`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } },
  )
  assert.equal(removed.status, 200)

  // Its session is worth nothing any more.
  assert.equal(
    await phoneGet(url, `${cookies.session}; ${cookies.device}`),
    401,
    'a forgotten phone must not keep its session',
  )
})
