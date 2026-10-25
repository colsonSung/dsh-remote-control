import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * The store resolves its directory from the environment, so a test points it at
 * a scratch profile.
 * @returns {string}
 */
function scratchProfile() {
  const dir = mkdtempSync(join(tmpdir(), 'remote-control-store-'))
  process.env.DSH_PROFILE_DIR = dir
  return dir
}

test('the switch state survives a restart', async () => {
  scratchProfile()
  const store = await import('../src/device-store.js')

  assert.equal(store.wasEnabled(), false, 'a fresh profile is off')
  store.rememberEnabled(true)
  assert.equal(store.wasEnabled(), true)

  // A "restart" is a fresh module instance reading the same file.
  const reloaded = await import(`../src/device-store.js?restart=${Date.now()}`)
  assert.equal(reloaded.wasEnabled(), true, 'the switch comes back on')

  reloaded.rememberEnabled(false)
  const again = await import(`../src/device-store.js?restart=${Date.now()}`)
  assert.equal(again.wasEnabled(), false, 'and it stays off once turned off')
})

test('the identity, access key and passcode are generated once', async () => {
  scratchProfile()
  const store = await import('../src/device-store.js')

  const first = store.ensureIdentity()
  const second = store.ensureIdentity()
  assert.equal(first.deviceId, second.deviceId, 'the device id is stable')
  assert.equal(first.secret, second.secret, 'the relay credential is stable')

  const key = store.ensureAccessKey()
  assert.equal(key, store.ensureAccessKey(), 'the access key is stable')
  assert.ok(store.ensureAccessKey().length >= 32)

  const code = store.ensurePasscode()
  assert.match(code, /^[0-9]{8}$/, 'the passcode is eight digits')
  assert.equal(code, store.ensurePasscode(), 'the passcode is stable')
  assert.notEqual(code, store.ensurePasscode(true), 'rotating changes it')
})
