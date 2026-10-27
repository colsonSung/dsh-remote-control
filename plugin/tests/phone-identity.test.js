/**
 * @file One phone is one record, whatever the browser does.
 *
 * The owner's device list used to fill up with the same handset: every visit
 * that arrived without the phone's cookie created a new record, and the
 * phone had to type the access code again. Two things caused that, and both
 * are fixed here:
 *
 * - the cookie was `SameSite=Strict`, so it was not sent on the top level
 *   navigation that follows a link opened in another app (a chat, a QR
 *   scanner). It is `Lax` now, which still keeps it away from cross site
 *   POSTs.
 * - a phone that arrives without its cookie now continues the record of the
 *   same caller (address and User-Agent), instead of starting a new one. A
 *   trusted record is never continued that way: the trust belongs to the
 *   phone that proved itself, not to whoever shares its address.
 *
 * Run with: `node --test tests/phone-identity.test.js`
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { createRelayClient } from '../src/relay-client.js'
import { createRelayServer } from '../src/relay-server.js'

const RELAY_SECRET = 'relay-secret-value'
const LAUNCH_TOKEN = 'launch-token-value'
const ACCESS_KEY = 'phone-access-key-value'
const DEVICE_ID = '11111111-2222-3333-4444-555555555555'
const PASSCODE = '24681357'
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'
const OTHER_UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36'

/**
 * A stand-in for the Harness web server: the relay only needs it to answer the
 * phone's requests once the tunnel is up.
 * @returns {Promise<{ baseUrl: string, close: () => Promise<void> }>}
 */
async function startFakeHarness() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><body>harness index</body></html>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
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

/**
 * Boot a relay and a host against it.
 *
 * @param {import('node:test').TestContext} t - the test's cleanup hook.
 * @returns {Promise<{ relayPort: number, publicUrl: string, listPhones: () => Promise<any[]> }>}
 */
async function startRelay(t) {
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
    passcode: PASSCODE,
    log: () => {},
  })

  t.after(async () => {
    await client.stop().catch(() => {})
    await relay.close().catch(() => {})
    await harness.close()
  })
  await client.start()

  return {
    relayPort,
    publicUrl: client.status().publicUrl,
    /**
     * @returns {Promise<any[]>} the phones the owner sees.
     */
    listPhones: async () => {
      const response = await fetch(`http://127.0.0.1:${relayPort}/v1/remote/devices/${DEVICE_ID}/phones`, {
        headers: { authorization: `Bearer ${RELAY_SECRET}` },
      })
      assert.equal(response.status, 200)
      return response.json()
    },
  }
}

/**
 * Unlock the device, the way a phone types the access code.
 *
 * @param {string} publicUrl - the phone's url.
 * @param {{userAgent?: string, cookie?: string}} [options] - the caller.
 * @returns {Promise<{ status: number, cookies: string[], deviceCookie: string | undefined }>}
 */
async function unlock(publicUrl, options = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' }
  if (options.userAgent !== undefined) headers['user-agent'] = options.userAgent
  if (options.cookie !== undefined) headers.cookie = options.cookie
  const response = await fetch(publicUrl, {
    method: 'POST',
    headers,
    body: `p=${PASSCODE}`,
    redirect: 'manual',
  })
  const cookies = response.headers.getSetCookie?.() ?? []
  return {
    status: response.status,
    cookies,
    deviceCookie: cookies
      .map((value) => value.split(';')[0])
      .find((value) => value.startsWith('dsh-device=')),
  }
}

test('the phone cookie survives a link opened in another app', async (t) => {
  const { publicUrl } = await startRelay(t)

  const unlocked = await unlock(publicUrl, { userAgent: PHONE_UA })

  assert.equal(unlocked.status, 303)
  const device = unlocked.cookies.find((value) => value.startsWith('dsh-device='))
  assert.ok(device, 'the relay issues the phone credential')
  assert.match(device, /SameSite=Lax/, 'the credential travels with a link opened elsewhere')
  const session = unlocked.cookies.find((value) => value.startsWith('dsh-rc='))
  assert.ok(session, 'the relay issues a session cookie')
  assert.match(session, /SameSite=Lax/, 'the session travels with a link opened elsewhere')
})

test('a phone that lost its cookie continues its own record', async (t) => {
  const { publicUrl, listPhones } = await startRelay(t)

  const first = await unlock(publicUrl, { userAgent: PHONE_UA })
  assert.equal(first.status, 303)
  const before = await listPhones()
  assert.equal(before.length, 1)

  // The browser comes back without its credential: the same handset, the same
  // address, the same browser.
  const second = await unlock(publicUrl, { userAgent: PHONE_UA })
  assert.equal(second.status, 303)

  const after = await listPhones()
  assert.equal(after.length, 1, 'the same phone is still one record')
  assert.equal(after[0].id, before[0].id, 'the record is the same one')
  assert.equal(after[0].unlocks, 2, 'the record counts both unlocks')
  assert.equal(second.deviceCookie, first.deviceCookie, 'the phone keeps its credential')
})

test('a different browser is a different device', async (t) => {
  const { publicUrl, listPhones } = await startRelay(t)

  await unlock(publicUrl, { userAgent: PHONE_UA })
  await unlock(publicUrl, { userAgent: OTHER_UA })

  const phones = await listPhones()
  assert.equal(phones.length, 2, 'another browser is not the same device')
})

test('a trusted phone is never handed to a caller without its credential', async (t) => {
  const { relayPort, publicUrl, listPhones } = await startRelay(t)

  const unlocked = await unlock(publicUrl, { userAgent: PHONE_UA })
  const phones = await listPhones()
  assert.equal(phones.length, 1)

  // The owner trusts the phone.
  const trusted = await fetch(
    `http://127.0.0.1:${relayPort}/v1/remote/devices/${DEVICE_ID}/phones/${phones[0].id}/trust`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${RELAY_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ trusted: true }),
    },
  )
  assert.equal(trusted.status, 200)

  // A caller without the credential does not inherit that trust: it gets a
  // record of its own.
  await unlock(publicUrl, { userAgent: PHONE_UA })

  const after = await listPhones()
  assert.equal(after.length, 2, 'the caller without a credential gets its own record')
  const trustedRecord = after.find((phone) => phone.id === phones[0].id)
  assert.equal(trustedRecord.trusted, true, 'the trusted phone keeps its trust')
  const newcomer = after.find((phone) => phone.id !== phones[0].id)
  assert.equal(newcomer.trusted, false, 'the trust was not handed over')
  assert.ok(unlocked.deviceCookie, 'the first unlock issued a credential')
})
