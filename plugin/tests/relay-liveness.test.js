/**
 * @file A device that stopped answering must not keep its registration.
 *
 * A socket that goes quiet without closing — a dropped network, a sleeping
 * laptop, a NAT that forgets the flow — stays `OPEN` on the relay. The relay
 * would then keep the device registered and refuse every new registration of
 * the same device ("device already registered"), so the computer could never
 * come back: the owner sees the device as offline and the tunnel stays dead.
 *
 * The relay therefore remembers when it last heard from a device and drops the
 * channels of the ones that went quiet. A device that is really there keeps
 * its place: the duplicate is still refused.
 *
 * Run with: `node --test tests/relay-liveness.test.js`
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'

import { WebSocket } from 'ws'

import { createRelayServer } from '../src/relay-server.js'
import { MANAGEMENT_PATH, decodeFrame, encodeFrame, registerFrame } from '../src/relay-protocol.js'

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
 * Register a device on a relay and wait for the relay's answer.
 *
 * @param {number} port - the relay's port.
 * @returns {Promise<{ socket: WebSocket, frame: any }>} the socket and the answer.
 */
async function register(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${MANAGEMENT_PATH}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  await once(socket, 'open')
  const answer = new Promise((resolve) => {
    socket.on('message', (data) => {
      const frame = decodeFrame(String(data))
      if (frame.type === 'register_ack' || frame.type === 'register_nak') resolve(frame)
    })
  })
  socket.send(
    encodeFrame(
      registerFrame({
        deviceId: DEVICE_ID,
        alias: 'Fake Host',
        platform: 'darwin',
        clientVersion: '1.0.0',
        localBaseUrl: 'http://127.0.0.1:1',
      }),
    ),
  )
  return { socket, frame: await answer }
}

/**
 * Wait for a moment.
 *
 * @param {number} ms - how long to wait.
 * @returns {Promise<void>}
 */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('a device that stopped answering may register again', async (t) => {
  const port = await freePort()
  // A short window: the test does not wait a minute for the relay to notice.
  const relay = createRelayServer({
    token: TOKEN,
    log: () => {},
    livenessTimeoutMs: 200,
    livenessIntervalMs: 50,
  })
  await relay.listen({ host: '127.0.0.1', port })
  t.after(async () => {
    await relay.close()
  })

  const first = await register(port)
  // The socket is paused below and would wait for a close handshake that never
  // comes: it is torn down instead.
  t.after(() => {
    first.socket._socket?.destroy?.()
    first.socket.close()
  })
  assert.equal(first.frame.type, 'register_ack', 'the device registers')

  // The device goes quiet: it stops reading, so it does not answer the
  // relay's pings any more. The relay still sees an open socket — the way a
  // dropped network leaves it.
  first.socket.pause?.()

  // While the relay still believes the device is there, the registration is
  // refused — this is the state that keeps a computer from coming back.
  const blocked = await register(port)
  t.after(() => blocked.socket.close())
  assert.equal(blocked.frame.type, 'register_nak', 'the quiet device still holds the registration')
  assert.match(String(blocked.frame.reason ?? ''), /already registered/)

  // The relay notices that nobody answers, and lets the device back in.
  await wait(500)
  const again = await register(port)
  t.after(() => again.socket.close())
  assert.equal(again.frame.type, 'register_ack', 'the device may register again')
})

test('a device that keeps answering keeps its place', async (t) => {
  const port = await freePort()
  const relay = createRelayServer({
    token: TOKEN,
    log: () => {},
    livenessTimeoutMs: 200,
    livenessIntervalMs: 50,
  })
  await relay.listen({ host: '127.0.0.1', port })
  t.after(async () => {
    await relay.close()
  })

  const first = await register(port)
  t.after(() => first.socket.close())
  assert.equal(first.frame.type, 'register_ack')

  // The device is there and answers: a second registration of the same id is
  // still refused, so a second copy of the host cannot take the place.
  await wait(400)
  const second = await register(port)
  t.after(() => second.socket.close())
  assert.equal(second.frame.type, 'register_nak', 'a live device keeps its registration')
  assert.match(String(second.frame.reason ?? ''), /already registered/)
})
