/**
 * End-to-end test of the remote-control tunnel.
 *
 * A fake Harness server stands in for the real one: it mints a session cookie
 * only for `GET /?token=…`, serves an asset at an absolute path, answers a
 * JSON `POST /api/…`, and speaks WebSocket at `/api/remote.mux`. The relay and
 * the host-side tunnel client are the real implementations; the test plays the
 * part of the phone.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WebSocketServer } from 'ws'

import { createRelayClient } from '../src/relay-client.js'
import { createRelayServer } from '../src/relay-server.js'

const RELAY_SECRET = 'relay-secret-value'
const LAUNCH_TOKEN = 'launch-token-value'
const ACCESS_KEY = 'phone-access-key-value'
const DEVICE_ID = '11111111-2222-3333-4444-555555555555'

/**
 * A stand-in for the Harness web server.
 * @returns {Promise<{ server: import('node:http').Server, baseUrl: string, close: () => Promise<void> }>}
 */
async function startFakeHarness(seen = {}) {
  const sockets = new Set()
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    if (url.pathname === '/') {
      if (url.searchParams.get('token') !== LAUNCH_TOKEN) {
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end('unauthorized')
        return
      }
      res.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': 'dsh-auth=fake-session; Path=/; HttpOnly',
      })
      res.end('<html><body>harness index</body></html>')
      return
    }
    if (url.pathname === '/assets/app.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' })
      res.end('export const ready = true')
      return
    }
    if (url.pathname === '/api/session/list') {
      if (!String(req.headers.cookie ?? '').includes('dsh-auth=fake-session')) {
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end('unauthorized')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, sessions: [{ id: 'session-1' }] }))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/api/remote.mux')) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      client.on('message', (data, isBinary) => {
        if (isBinary) seen.binary = (seen.binary ?? 0) + 1
        else seen.text = (seen.text ?? 0) + 1
        client.send(`echo:${data.toString()}`)
      })
      client.on('ping', () => {
        seen.pings = (seen.pings ?? 0) + 1
      })
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      wss.close()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * Reserve a free TCP port.
 * @returns {Promise<number>}
 */
async function freePort() {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

test('a phone reaches the harness through the relay tunnel', async (t) => {
  const harness = await startFakeHarness()
  const relayPort = await freePort()
  const relay = createRelayServer({
    token: RELAY_SECRET,
    publicBaseUrl: `http://127.0.0.1:${relayPort}`,
    log: () => {},
  })
  const address = await relay.listen({ host: '127.0.0.1', port: relayPort })
  if (typeof relay.setPublicBaseUrl === 'function') {
    relay.setPublicBaseUrl(`http://127.0.0.1:${address.port}`)
  }

  const client = createRelayClient({
    relayUrl: `ws://127.0.0.1:${address.port}`,
    token: RELAY_SECRET,
    deviceId: DEVICE_ID,
    alias: 'test-machine',
    platform: 'darwin',
    clientVersion: '1.0.0',
    localBaseUrl: harness.baseUrl,
    launchToken: LAUNCH_TOKEN,
    log: () => {},
  })

  t.after(async () => {
    await client.stop().catch(() => {})
    await relay.close().catch(() => {})
    await harness.close()
  })

  await client.start()
  const status = client.status()
  assert.equal(status.state, 'online', 'the host registered with the relay')

  const publicUrl = status.publicUrl
  assert.ok(typeof publicUrl === 'string' && publicUrl.includes(DEVICE_ID), `public url ${publicUrl}`)
  assert.match(publicUrl, /rc=1/, 'the public url carries the Kimi-style parameters')

  // 1. The phone opens the access URL: the relay strips the device mount, the
  //    host injects its launch token, and the harness mints a session cookie.
  const index = await fetch(publicUrl, { redirect: 'manual' })
  assert.equal(index.status, 200, 'the phone receives the harness index')
  assert.match(await index.text(), /harness index/)
  const cookie = index.headers.getSetCookie?.()[0] ?? ''
  assert.match(cookie, /dsh-auth=fake-session/, 'the harness minted a session cookie for the phone')

  // 2. The harness app loads its assets by absolute path: the root-level
  //    request must still reach the device.
  const asset = await fetch(new URL('/assets/app.js', publicUrl).href)
  assert.equal(asset.status, 200)
  assert.match(await asset.text(), /export const ready/)

  // 3. The phone calls the API with the cookie it received.
  const api = await fetch(new URL('/api/session/list', publicUrl).href, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'dsh-auth=fake-session' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'list', payload: {} }),
  })
  assert.equal(api.status, 200)
  const payload = await api.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.sessions[0].id, 'session-1')

  // 4. The live stream carrier: a WebSocket through the relay.
  const { WebSocket } = await import('ws')
  const wsUrl = new URL('/api/remote.mux', publicUrl)
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(wsUrl.href, { headers: { cookie: 'dsh-auth=fake-session' } })
  const echoed = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no echo within 5s')), 5000)
    socket.on('open', () => socket.send('ping'))
    socket.on('message', (data) => {
      clearTimeout(timer)
      resolve(data.toString())
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  assert.equal(echoed, 'echo:ping')
  socket.close()
})

test('a public relay only opens to a phone that presents the access key', async (t) => {
  const harness = await startFakeHarness()
  const relayPort = await freePort()
  const relay = createRelayServer({
    token: RELAY_SECRET,
    publicBaseUrl: `http://127.0.0.1:${relayPort}`,
    log: () => {},
  })
  await relay.listen({ host: '127.0.0.1', port: relayPort })

  const client = createRelayClient({
    relayUrl: `ws://127.0.0.1:${relayPort}`,
    token: RELAY_SECRET,
    deviceId: DEVICE_ID,
    alias: 'test-machine',
    platform: 'darwin',
    clientVersion: '1.0.0',
    localBaseUrl: harness.baseUrl,
    launchToken: LAUNCH_TOKEN,
    accessKey: ACCESS_KEY,
    log: () => {},
  })

  t.after(async () => {
    await client.stop().catch(() => {})
    await relay.close().catch(() => {})
    await harness.close()
  })

  await client.start()
  const publicUrl = client.status().publicUrl
  assert.ok(publicUrl.includes(`k=${ACCESS_KEY}`), 'the published url carries the access key')

  // Without the key the relay refuses to serve the device.
  const refused = await fetch(publicUrl.replace(`&k=${ACCESS_KEY}`, ''))
  assert.equal(refused.status, 401)

  // With the key the phone gets the index and a relay session cookie.
  const index = await fetch(publicUrl)
  assert.equal(index.status, 200)
  const cookies = index.headers.getSetCookie?.() ?? []
  assert.ok(
    cookies.some((cookie) => cookie.startsWith('dsh-rc=')),
    'the relay hands the phone its own session cookie',
  )

  // The app's absolute URLs carry no key; the session cookie carries them.
  const asset = await fetch(new URL('/assets/app.js', publicUrl).href, {
    headers: { cookie: cookies.map((cookie) => cookie.split(';')[0]).join('; ') },
  })
  assert.equal(asset.status, 200)
  assert.match(await asset.text(), /export const ready/)
})

test('the tunnel keeps the WebSocket frame kind and never re-registers', async (t) => {
  const seen = { text: 0, binary: 0, pings: 0 }
  const harness = await startFakeHarness(seen)
  const relayPort = await freePort()
  let registrations = 0
  const relay = createRelayServer({
    token: RELAY_SECRET,
    publicBaseUrl: `http://127.0.0.1:${relayPort}`,
    log: (message) => {
      if (String(message).includes('device registered')) registrations += 1
    },
  })
  await relay.listen({ host: '127.0.0.1', port: relayPort })

  const client = createRelayClient({
    relayUrl: `ws://127.0.0.1:${relayPort}`,
    token: RELAY_SECRET,
    deviceId: DEVICE_ID,
    alias: 'test-machine',
    platform: 'darwin',
    clientVersion: '1.0.0',
    localBaseUrl: harness.baseUrl,
    launchToken: LAUNCH_TOKEN,
    // A short registration timeout: the relay answers immediately, so the
    // client must clear it instead of tearing the channel down later.
    registrationTimeoutMs: 300,
    pingIntervalMs: 300,
    log: () => {},
  })

  t.after(async () => {
    await client.stop().catch(() => {})
    await relay.close().catch(() => {})
    await harness.close()
  })

  await client.start()
  const { WebSocket } = await import('ws')
  const socket = new WebSocket(`ws://127.0.0.1:${relayPort}/${DEVICE_ID}/api/remote.mux`, {
    headers: { cookie: 'dsh-auth=fake-session' },
  })
  await new Promise((resolve, reject) => {
    socket.on('open', resolve)
    socket.on('error', reject)
  })
  socket.send('plain text frame')
  socket.ping()
  await new Promise((resolve) => setTimeout(resolve, 1500))

  assert.equal(seen.text, 1, 'a text frame stays a text frame')
  assert.ok(seen.pings >= 1, 'the ping reached the far side')
  socket.close()

  // The registration timeout must not fire after the relay acknowledged.
  await new Promise((resolve) => setTimeout(resolve, 1200))
  assert.equal(registrations, 1, 'the device registered once and stayed registered')
})

test('a public relay asks for the passcode before it lets a phone in', async (t) => {
  const harness = await startFakeHarness()
  const relayPort = await freePort()
  const relay = createRelayServer({
    token: RELAY_SECRET,
    publicBaseUrl: `http://127.0.0.1:${relayPort}`,
    log: () => {},
  })
  await relay.listen({ host: '127.0.0.1', port: relayPort })

  const client = createRelayClient({
    relayUrl: `ws://127.0.0.1:${relayPort}`,
    token: RELAY_SECRET,
    deviceId: DEVICE_ID,
    alias: 'test-machine',
    platform: 'darwin',
    clientVersion: '1.0.0',
    localBaseUrl: harness.baseUrl,
    launchToken: LAUNCH_TOKEN,
    accessKey: ACCESS_KEY,
    passcode: '24681357',
    log: () => {},
  })

  t.after(async () => {
    await client.stop().catch(() => {})
    await relay.close().catch(() => {})
    await harness.close()
  })

  await client.start()
  const publicUrl = client.status().publicUrl

  // The link alone is not enough: the relay asks for the passcode.
  const asked = await fetch(publicUrl)
  assert.equal(asked.status, 200)
  const page = await asked.text()
  assert.match(page, /需要访问码|passcode/i, 'the relay serves an unlock page')
  assert.ok(!page.includes('harness index'), 'the agent was not served yet')

  // A wrong code is refused.
  const wrong = await fetch(publicUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'p=00000000',
    redirect: 'manual',
  })
  assert.equal(wrong.status, 401)

  // The right code unlocks the device and leaves a session cookie.
  const right = await fetch(publicUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'p=24681357',
    redirect: 'manual',
  })
  assert.equal(right.status, 303)
  const cookie = (right.headers.getSetCookie?.() ?? []).find((value) => value.startsWith('dsh-rc='))
  assert.ok(cookie, 'the relay issues a session cookie')
  const session = cookie.split(';')[0]

  // With the cookie the phone reaches the agent.
  const index = await fetch(publicUrl, { headers: { cookie: session } })
  assert.equal(index.status, 200)
  assert.match(await index.text(), /harness index/)
})

test('a wrong passcode locks the caller out, not the device', async (t) => {
  const harness = await startFakeHarness()
  const relayPort = await freePort()
  const relay = createRelayServer({
    token: RELAY_SECRET,
    publicBaseUrl: `http://127.0.0.1:${relayPort}`,
    log: () => {},
  })
  await relay.listen({ host: '127.0.0.1', port: relayPort })
  const client = createRelayClient({
    relayUrl: `ws://127.0.0.1:${relayPort}`,
    token: RELAY_SECRET,
    deviceId: DEVICE_ID,
    alias: 'test-machine',
    platform: 'darwin',
    clientVersion: '1.0.0',
    localBaseUrl: harness.baseUrl,
    launchToken: LAUNCH_TOKEN,
    accessKey: ACCESS_KEY,
    passcode: '24681357',
    log: () => {},
  })
  t.after(async () => {
    await client.stop().catch(() => {})
    await relay.close().catch(() => {})
    await harness.close()
  })
  await client.start()
  const publicUrl = client.status().publicUrl

  // Five wrong attempts from one address lock that address out.
  const codes = []
  for (let i = 0; i < 6; i += 1) {
    codes.push(await fetch(publicUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '203.0.113.7' },
      body: 'p=00000000',
      redirect: 'manual',
    }).then((response) => response.status))
  }
  assert.deepEqual(codes.slice(0, 4), [401, 401, 401, 401])
  assert.equal(codes[4], 429, 'the caller is locked out')
  assert.equal(codes[5], 429)

  // Another address is unaffected and the right code still works.
  const other = await fetch(publicUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.9' },
    body: 'p=24681357',
    redirect: 'manual',
  })
  assert.equal(other.status, 303, 'a different caller unlocks normally')
})

test('a trusted phone skips the access code, and the list survives a relay restart', async (t) => {
  const harness = await startFakeHarness()
  const statePath = join(tmpdir(), `dsh-relay-state-${Date.now()}.json`)
  const relayPort = await freePort()
  const relay = createRelayServer({
    token: RELAY_SECRET,
    publicBaseUrl: `http://127.0.0.1:${relayPort}`,
    statePath,
    log: () => {},
  })
  await relay.listen({ host: '127.0.0.1', port: relayPort })

  const client = createRelayClient({
    relayUrl: `ws://127.0.0.1:${relayPort}`,
    token: RELAY_SECRET,
    deviceId: DEVICE_ID,
    alias: 'test-machine',
    platform: 'darwin',
    clientVersion: '1.0.0',
    localBaseUrl: harness.baseUrl,
    launchToken: LAUNCH_TOKEN,
    accessKey: ACCESS_KEY,
    passcode: '24681357',
    log: () => {},
  })
  t.after(async () => {
    await client.stop().catch(() => {})
    await relay.close().catch(() => {})
    await harness.close()
  })
  await client.start()
  const publicUrl = client.status().publicUrl

  // The phone unlocks once and keeps its own credential.
  const unlocked = await fetch(publicUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'p=24681357',
    redirect: 'manual',
  })
  assert.equal(unlocked.status, 303)
  const deviceCookie = (unlocked.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(';')[0])
    .find((value) => value.startsWith('dsh-device='))
  assert.ok(deviceCookie, 'the phone keeps a device credential')

  // The owner sees the phone in the list, not yet trusted.
  const listed = await fetch(`http://127.0.0.1:${relayPort}/v1/remote/devices/${DEVICE_ID}/phones`, {
    headers: { authorization: `Bearer ${RELAY_SECRET}` },
  })
  assert.equal(listed.status, 200)
  const phones = await listed.json()
  assert.equal(phones.length, 1)
  assert.equal(phones[0].trusted, false)
  assert.ok(phones[0].label, 'the phone gets a readable name')

  // Without trust, the phone still has to type the code.
  const stillLocked = await fetch(publicUrl, { headers: { cookie: deviceCookie } })
  assert.equal(stillLocked.status, 200)
  assert.match(await stillLocked.text(), /需要访问码|passcode/i, 'an untrusted phone still asks')

  // The owner marks it as trusted.
  const trusted = await fetch(
    `http://127.0.0.1:${relayPort}/v1/remote/devices/${DEVICE_ID}/phones/${phones[0].id}/trust`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${RELAY_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ trusted: true }),
    },
  )
  assert.equal(trusted.status, 200)

  // Now the phone walks straight in.
  const opened = await fetch(publicUrl, { headers: { cookie: deviceCookie } })
  assert.equal(opened.status, 200)
  assert.match(await opened.text(), /harness index/, 'a trusted phone reaches the agent')

  // The trust decision outlives the relay process.
  await relay.close()
  const restartedPort = await freePort()
  const restarted = createRelayServer({
    token: RELAY_SECRET,
    publicBaseUrl: `http://127.0.0.1:${restartedPort}`,
    statePath,
    log: () => {},
  })
  await restarted.listen({ host: '127.0.0.1', port: restartedPort })
  t.after(() => restarted.close().catch(() => {}))

  // The host comes back and registers again, the way it does in production.
  const returning = createRelayClient({
    relayUrl: `ws://127.0.0.1:${restartedPort}`,
    token: RELAY_SECRET,
    deviceId: DEVICE_ID,
    alias: 'test-machine',
    platform: 'darwin',
    clientVersion: '1.0.0',
    localBaseUrl: harness.baseUrl,
    launchToken: LAUNCH_TOKEN,
    accessKey: ACCESS_KEY,
    passcode: '24681357',
    log: () => {},
  })
  t.after(() => returning.stop().catch(() => {}))
  await returning.start()

  const relisted = await fetch(`http://127.0.0.1:${restartedPort}/v1/remote/devices/${DEVICE_ID}/phones`, {
    headers: { authorization: `Bearer ${RELAY_SECRET}` },
  })
  const afterRestart = await relisted.json()
  assert.equal(afterRestart.length, 1, 'the phone list is persisted')
  assert.equal(afterRestart[0].trusted, true, 'the trust flag is persisted')
})

test('a revoked device is refused until the owner restores it', async (t) => {
  const harness = await startFakeHarness()
  const relayPort = await freePort()
  const relay = createRelayServer({
    token: RELAY_SECRET,
    publicBaseUrl: `http://127.0.0.1:${relayPort}`,
    log: () => {},
  })
  await relay.listen({ host: '127.0.0.1', port: relayPort })

  const client = createRelayClient({
    relayUrl: `ws://127.0.0.1:${relayPort}`,
    token: RELAY_SECRET,
    deviceId: DEVICE_ID,
    alias: 'test-machine',
    platform: 'darwin',
    clientVersion: '1.0.0',
    localBaseUrl: harness.baseUrl,
    launchToken: LAUNCH_TOKEN,
    accessKey: ACCESS_KEY,
    passcode: '24681357',
    log: () => {},
  })
  t.after(async () => {
    await client.stop().catch(() => {})
    await relay.close().catch(() => {})
    await harness.close()
  })
  await client.start()
  assert.equal(client.status().state, 'online')

  // The owner revokes the device.
  const revoked = await fetch(`http://127.0.0.1:${relayPort}/v1/remote/devices/${DEVICE_ID}/revoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${RELAY_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify({ revoked: true }),
  })
  assert.equal(revoked.status, 200)

  // The device is refused, reconnects included.
  const refused = await fetch(`http://127.0.0.1:${relayPort}/v1/remote/devices`, {
    headers: { authorization: `Bearer ${RELAY_SECRET}` },
  })
  const devices = await refused.json()
  assert.equal(devices[0].status, 'offline', 'a revoked device reads as offline')

  // The phone-facing path refuses the device...
  const blocked = await fetch(`http://127.0.0.1:${relayPort}/${DEVICE_ID}/?rc=1&k=${ACCESS_KEY}`)
  assert.equal(blocked.status, 403, 'a revoked device serves no phone')

  // ...while the owner still sees it, so it can be restored.
  const phones = await fetch(`http://127.0.0.1:${relayPort}/v1/remote/devices/${DEVICE_ID}/phones`, {
    headers: { authorization: `Bearer ${RELAY_SECRET}` },
  })
  assert.equal(phones.status, 200, 'the owner can still see the device')

  // Restoring lets it back in.
  const restored = await fetch(`http://127.0.0.1:${relayPort}/v1/remote/devices/${DEVICE_ID}/revoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${RELAY_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify({ revoked: false }),
  })
  assert.equal(restored.status, 200)
  await new Promise((resolve) => setTimeout(resolve, 1500))
  assert.equal(client.status().state, 'online', 'the device registers again')
})

test('a device keeps the name the owner gave it', async (t) => {
  const harness = await startFakeHarness()
  const statePath = join(tmpdir(), `dsh-relay-alias-${Date.now()}.json`)
  const relayPort = await freePort()
  const relay = createRelayServer({
    token: RELAY_SECRET,
    publicBaseUrl: `http://127.0.0.1:${relayPort}`,
    statePath,
    log: () => {},
  })
  await relay.listen({ host: '127.0.0.1', port: relayPort })

  const client = createRelayClient({
    relayUrl: `ws://127.0.0.1:${relayPort}`,
    token: RELAY_SECRET,
    deviceId: DEVICE_ID,
    alias: 'the-original-name',
    platform: 'darwin',
    clientVersion: '1.0.0',
    localBaseUrl: harness.baseUrl,
    launchToken: LAUNCH_TOKEN,
    accessKey: ACCESS_KEY,
    passcode: '24681357',
    log: () => {},
  })
  t.after(async () => {
    await client.stop().catch(() => {})
    await relay.close().catch(() => {})
    await harness.close()
  })
  await client.start()

  const listDevices = async () => {
    const response = await fetch(`http://127.0.0.1:${relayPort}/v1/remote/devices`, {
      headers: { authorization: `Bearer ${RELAY_SECRET}` },
    })
    const list = await response.json()
    return list.find((device) => device.deviceId === DEVICE_ID)
  }

  // The owner renames the device.
  const renamed = await fetch(`http://127.0.0.1:${relayPort}/v1/remote/devices/${DEVICE_ID}/alias`, {
    method: 'POST',
    headers: { authorization: `Bearer ${RELAY_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify({ alias: 'the-name-i-chose' }),
  })
  assert.equal(renamed.status, 200)
  assert.equal((await listDevices()).alias, 'the-name-i-chose')

  // The device registers again with its own name: the owner's name wins.
  await client.stop().catch(() => {})
  await client.start()
  await new Promise((resolve) => setTimeout(resolve, 400))
  let afterRestart
  try {
    afterRestart = await listDevices()
  } catch (error) {
    throw new Error('listDevices after the re-registration failed: ' + String(error))
  }
  assert.equal(afterRestart.alias, 'the-name-i-chose', 'the owner name survives a re-registration')

  // And it survives a relay restart.
  await relay.close()
  const restartedPort = await freePort()
  const restarted = createRelayServer({
    token: RELAY_SECRET,
    publicBaseUrl: `http://127.0.0.1:${restartedPort}`,
    statePath,
    log: () => {},
  })
  await restarted.listen({ host: '127.0.0.1', port: restartedPort })
  t.after(() => restarted.close().catch(() => {}))
  const response = await fetch(`http://127.0.0.1:${restartedPort}/v1/remote/devices`, {
    headers: { authorization: `Bearer ${RELAY_SECRET}` },
  })
  const list = await response.json()
  assert.equal(list.find((device) => device.deviceId === DEVICE_ID).alias, 'the-name-i-chose')
})
