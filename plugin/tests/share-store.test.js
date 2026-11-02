/**
 * Share store tests.
 *
 * The store writes to the profile the environment points at, so a test points
 * it at a scratch directory.
 *
 * Run with: `node --test tests/share-store.test.js`
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * A scratch profile for one test.
 *
 * @returns {string}
 */
function scratchProfile() {
  const dir = mkdtempSync(join(tmpdir(), 'remote-control-shares-'))
  process.env.DSH_PROFILE_DIR = dir
  return dir
}

/**
 * A store module bound to the current scratch profile.
 *
 * @returns {Promise<any>}
 */
async function freshStore() {
  return import(`../src/share-store.js?profile=${Date.now()}-${Math.random()}`)
}

test('a share is written next to the device state and stays owner-only', async () => {
  const profile = scratchProfile()
  const store = await freshStore()

  const record = store.createShare({
    sessionId: 'session-1',
    title: 'A shared session',
    permission: 'read',
    projectRoot: '/tmp/project',
  })

  const path = join(profile, 'plugins', 'remote-control-shares.json')
  assert.equal(store.shareStatePath(), path, 'the records live beside the device state')

  const raw = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(raw.version, 1, 'the file carries its version')
  assert.equal(raw.shares.length, 1)
  assert.deepEqual(Object.keys(raw.shares[0]).sort(), [
    'createdAt',
    'id',
    'lastUsedAt',
    'passcode',
    'permission',
    'projectRoot',
    'revokedAt',
    'sessionId',
    'title',
  ])
  assert.equal(raw.shares[0].id, record.id)
  assert.equal(raw.shares[0].lastUsedAt, null)
  assert.equal(raw.shares[0].revokedAt, null)

  const mode = statSync(path).mode & 0o777
  assert.equal(mode, 0o600, 'the passcodes are readable by the owner only')
})

test('a share id is a prefix and twelve hexadecimal characters', async () => {
  scratchProfile()
  const store = await freshStore()

  const record = store.createShare({
    sessionId: 'session-1',
    title: 'A shared session',
    permission: 'read',
    projectRoot: '/tmp/project',
  })
  assert.match(record.id, /^s_[0-9a-f]{12}$/)
  assert.equal(store.isShareId(record.id), true)
  assert.equal(store.isShareId('s_short'), false)
  assert.equal(store.isShareId('../etc/passwd'), false)
})

test('a passcode is eight digits', async () => {
  scratchProfile()
  const store = await freshStore()

  const record = store.createShare({
    sessionId: 'session-1',
    title: 'A shared session',
    permission: 'write',
    projectRoot: '/tmp/project',
  })
  assert.match(record.passcode, /^[0-9]{8}$/)
})

test('the records survive a restart', async () => {
  scratchProfile()
  const store = await freshStore()
  const created = store.createShare({
    sessionId: 'session-1',
    title: 'A shared session',
    permission: 'read',
    projectRoot: '/tmp/project',
  })

  // A "restart" is a fresh module instance reading the same file.
  const reloaded = await freshStore()
  const found = reloaded.getShare(created.id)
  assert.ok(found, 'the record comes back')
  assert.equal(found.passcode, created.passcode)
  assert.equal(found.sessionId, 'session-1')
  assert.equal(reloaded.listShares().length, 1)
})

test('a record is changed, revoked and removed', async () => {
  scratchProfile()
  const store = await freshStore()
  const created = store.createShare({
    sessionId: 'session-1',
    title: 'A shared session',
    permission: 'read',
    projectRoot: '/tmp/project',
  })

  const touched = store.updateShare(created.id, { lastUsedAt: 1_700_000_000_000 })
  assert.equal(touched.lastUsedAt, 1_700_000_000_000)

  const revoked = store.updateShare(created.id, { revokedAt: 1_700_000_001_000 })
  assert.equal(revoked.revokedAt, 1_700_000_001_000)

  assert.equal(store.deleteShare(created.id), true, 'the record is gone')
  assert.equal(store.getShare(created.id), undefined)
  assert.equal(store.deleteShare(created.id), false, 'a second removal finds nothing')
  assert.equal(store.listShares().length, 0)
})

test('a broken record is dropped instead of repaired', async () => {
  const profile = scratchProfile()
  const store = await freshStore()
  const path = join(profile, 'plugins', 'remote-control-shares.json')
  store.createShare({
    sessionId: 'session-1',
    title: 'A shared session',
    permission: 'read',
    projectRoot: '/tmp/project',
  })

  // A record without a passcode cannot be opened: it is dropped.
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  raw.shares[0].passcode = 'nope'
  const { writeFileSync } = await import('node:fs')
  writeFileSync(path, JSON.stringify(raw))

  assert.equal(store.listShares().length, 0, 'the broken record is not served')
})

test('the owner view carries the link and the status', async () => {
  scratchProfile()
  const store = await freshStore()
  const created = store.createShare({
    sessionId: 'session-1',
    title: 'A shared session',
    permission: 'write',
    projectRoot: '/tmp/project',
  })

  const view = store.shareView(created, { link: 'https://relay.example/s/s_0123456789ab' })
  assert.equal(view.id, created.id)
  assert.equal(view.permission, 'write')
  assert.equal(view.passcode, created.passcode)
  assert.equal(view.link, 'https://relay.example/s/s_0123456789ab')
  assert.equal(view.status, 'active')
  assert.equal(view.revokedAt, null)

  const revoked = store.updateShare(created.id, { revokedAt: 42 })
  assert.equal(store.shareView(revoked, { link: null }).status, 'revoked')
})
