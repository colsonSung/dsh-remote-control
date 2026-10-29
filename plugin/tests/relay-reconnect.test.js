/**
 * @file The host comes back on its own after the relay let go of a stale
 * registration.
 *
 * A relay that still holds the registration of a connection that is already
 * gone refuses the device ("device already registered"). The refusal used to
 * stop the client for good: the computer stayed offline until it was
 * restarted. The client now keeps trying, so the device is back as soon as
 * the relay lets the stale registration go.
 *
 * Run with: `node --test tests/relay-reconnect.test.js`
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'

import { WebSocket } from 'ws'

import { createRelayClient } from '../src/relay-client.js'
import { createRelayServer } from '../src/relay-server.js'
import { MANAGEMENT_PATH, encodeFrame, registerFrame } from '../src/relay-protocol.js'

const TOKEN = 'test-token'
const DEVICE_ID = '11111111-2222-3333-4444-555555555555'

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
 * Hold a registration of the device, the way a stale connection does.
 *
 * @param {number} port - the relay's port.
 * @returns {Promise<WebSocket>} the socket holding the registration.
 */
async function holdRegistration(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${MANAGEMENT_PATH}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  await once(socket, 'open')
  socket.send(
    encodeFrame(
      registerFrame({
        deviceId: DEVICE_ID,
        alias: 'Stale Host',
        platform: 'darwin',
        clientVersion: '1.0.0',
        localBaseUrl: 'http://127.0.0.1:1',
      }),
    ),
  )
  await new Promise((resolve) => setTimeout(resolve, 150))
  return socket
}

test('the client comes back once the relay lets the stale registration go', async (t) => {
  const port = await freePort()
  const relay = createRelayServer({ token: TOKEN, log: () => {} })
  await relay.listen({ host: '127.0.0.1', port })
  t.after(async () => {
    await relay.close()
  })

  // A stale connection holds the registration.
  const stale = await holdRegistration(port)
  t.after(() => stale.close())

  const client = createRelayClient({
    relayUrl: `ws://127.0.0.1:${port}`,
    token: TOKEN,
    deviceId: DEVICE_ID,
    alias: 'test-machine',
    platform: 'darwin',
    clientVersion: '1.0.0',
    localBaseUrl: 'http://127.0.0.1:1',
    launchToken: 'launch-token',
    log: () => {},
    // A short backoff: the test does not wait a minute for the retry.
    reconnectBaseDelayMs: 100,
    reconnectMaxDelayMs: 300,
  })
  t.after(async () => {
    await client.stop().catch(() => {})
  })

  await client.start().catch(() => {})
  assert.equal(client.status().state, 'error', 'the relay refuses the device while the stale one holds it')

  // The stale connection goes away.
  stale._socket?.destroy?.()
  stale.close()

  // The client keeps trying and comes back.
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && client.status().state !== 'online') {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(client.status().state, 'online', 'the device is back on its own')
})
