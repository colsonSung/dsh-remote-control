/**
 * Share protocol tests.
 *
 * The relay and the host have to agree on the frames that carry a shared
 * session, and the host has to recognise a guest request before it reaches
 * the local server.
 *
 * Run with: `node --test tests/protocol-share.test.js`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createRelayClient, isGuestPath } from '../src/relay-client.js'
import {
  decodeFrame,
  encodeFrame,
  registerFrame,
  sharePublishFrame,
  shareRevokeFrame,
} from '../src/relay-protocol.js'

const DEVICE_ID = 'device-1234'
const SHARE_ID = 's_0123456789ab'

test('the registration carries the shared sessions', () => {
  const frame = registerFrame({
    deviceId: DEVICE_ID,
    alias: 'A computer',
    platform: 'darwin',
    clientVersion: '1.0.0',
    localBaseUrl: 'http://127.0.0.1:3000',
    shares: [
      { id: SHARE_ID, revoked: false },
      { id: 's_abcdef012345', revoked: true },
    ],
  })

  assert.equal(frame.type, 'register')
  assert.deepEqual(frame.shares, [
    { id: SHARE_ID, revoked: false },
    { id: 's_abcdef012345', revoked: true },
  ])
})

test('a registration without shares carries an empty list', () => {
  const frame = registerFrame({
    deviceId: DEVICE_ID,
    alias: 'A computer',
    platform: 'darwin',
    clientVersion: '1.0.0',
    localBaseUrl: 'http://127.0.0.1:3000',
  })
  assert.deepEqual(frame.shares, [], 'the list is never missing')
})

test('a publish frame names the share and the device', () => {
  const frame = sharePublishFrame({ shareId: SHARE_ID, deviceId: DEVICE_ID })
  assert.equal(frame.type, 'share_publish')
  assert.equal(frame.share_id, SHARE_ID)
  assert.equal(frame.device_id, DEVICE_ID)
  assert.equal(frame.revoked, false)

  const revoked = sharePublishFrame({ shareId: SHARE_ID, deviceId: DEVICE_ID, revoked: true })
  assert.equal(revoked.revoked, true)
})

test('a revoke frame names the share and the device', () => {
  const frame = shareRevokeFrame({ shareId: SHARE_ID, deviceId: DEVICE_ID })
  assert.equal(frame.type, 'share_revoke')
  assert.equal(frame.share_id, SHARE_ID)
  assert.equal(frame.device_id, DEVICE_ID)
})

test('the frames survive the wire', () => {
  const publish = decodeFrame(encodeFrame(sharePublishFrame({ shareId: SHARE_ID, deviceId: DEVICE_ID })))
  assert.deepEqual(publish, {
    type: 'share_publish',
    share_id: SHARE_ID,
    device_id: DEVICE_ID,
    revoked: false,
    revoked_at: null,
  })
  const revoke = decodeFrame(encodeFrame(shareRevokeFrame({ shareId: SHARE_ID, deviceId: DEVICE_ID, revokedAt: 1700000000000 })))
  assert.deepEqual(revoke, {
    type: 'share_revoke',
    share_id: SHARE_ID,
    device_id: DEVICE_ID,
    revoked_at: 1700000000000,
  })
})

test('the relay client keeps the share list for the next registration', () => {
  const client = createRelayClient({
    relayUrl: 'ws://127.0.0.1:56131',
    token: 'shared-secret',
    deviceId: DEVICE_ID,
    localBaseUrl: 'http://127.0.0.1:3000',
    launchToken: 'launch-secret',
  })

  assert.deepEqual(client.shares(), [], 'a fresh client shares nothing')

  client.publishShare(SHARE_ID)
  assert.deepEqual(client.shares(), [{ id: SHARE_ID, revoked: false, revokedAt: null }])

  client.revokeShare(SHARE_ID, 1700000000000)
  assert.deepEqual(
    client.shares(),
    [{ id: SHARE_ID, revoked: true, revokedAt: 1700000000000 }],
    'a revoked share stays in the list, marked as revoked and when',
  )

  client.setShares([{ id: 's_abcdef012345' }])
  assert.deepEqual(client.shares(), [{ id: 's_abcdef012345', revoked: false, revokedAt: null }])
})

test('a guest path is recognised', () => {
  assert.equal(isGuestPath('/share/s_0123456789ab'), true)
  assert.equal(isGuestPath('/share/s_0123456789ab/api/state'), true)
  assert.equal(isGuestPath('/s/s_0123456789ab'), true)
  assert.equal(isGuestPath('/'), false)
  assert.equal(isGuestPath('/api/remote-control'), false)
  assert.equal(isGuestPath('/plugins/events'), false)
  assert.equal(isGuestPath(''), false)
})

test('a guest request never receives the launch token', () => {
  const client = createRelayClient({
    relayUrl: 'ws://127.0.0.1:56131',
    token: 'shared-secret',
    deviceId: DEVICE_ID,
    localBaseUrl: 'http://127.0.0.1:3000',
    launchToken: 'launch-secret',
  })

  const guest = client._resolveUpstream(`/share/${SHARE_ID}/api/state`, {}, { method: 'GET' })
  assert.equal(guest.isGuest, true)
  assert.equal(guest.tokenInjected, false, 'the guest gets no token')
  assert.doesNotMatch(guest.url, /token=/, 'the token does not reach the local server')

  // The relay may scope the path to the device; the prefix is stripped and
  // the guest request is still a guest request.
  const scoped = client._resolveUpstream(`/${DEVICE_ID}/share/${SHARE_ID}`, {}, { method: 'GET' })
  assert.equal(scoped.isGuest, true)
  assert.equal(scoped.tokenInjected, false)

  // The owner route still gets its token on the device root.
  const owner = client._resolveUpstream(`/${DEVICE_ID}/`, {}, { method: 'GET' })
  assert.equal(owner.isGuest, false)
  assert.equal(owner.tokenInjected, true, 'the owner still gets the token')
  assert.match(owner.url, /token=launch-secret/)

  // A refused session is recovered with the token — but never for a guest.
  const forced = client._resolveUpstream(`/share/${SHARE_ID}`, {}, { method: 'GET', forceToken: true })
  assert.equal(forced.tokenInjected, false, 'even a forced retry leaves the guest alone')
})
