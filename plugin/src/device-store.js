/**
 * Durable identity for one remote-control device.
 *
 * The store keeps three facts on disk: a stable device id, the alias the user
 * sees in "Remote device management", and the shared secret this device
 * presents to a relay. The secret never leaves the host: the relay only ever
 * sees it as a bearer credential, and the phone never sees it at all.
 */

import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The directory this profile keeps plugin state in.
 *
 * `DSH_PROFILE_DIR` is set by a profile-launched Harness; a profile-less
 * process falls back to the DSH home, and that falls back to `~/.dsh`.
 * @returns {string}
 */
export function stateDirectory() {
  const profile = process.env.DSH_PROFILE_DIR
  if (typeof profile === 'string' && profile.length > 0) return join(profile, 'plugins')
  // The desktop app does not export DSH_PROFILE_DIR to its own process, but it
  // passes the profile directory on its command line; without this the plugin
  // would fall back to the shared home and a second identity would appear.
  const fromArgv = profileFromArgv()
  if (fromArgv !== undefined) return join(fromArgv, 'plugins')
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home.length > 0 ? home : join(homedir(), '.dsh')
  const name = process.env.DSH_PROFILE
  if (typeof name === 'string' && name.length > 0) return join(base, 'profiles', name, 'plugins')
  return join(base, 'plugins')
}

/**
 * The profile directory named on this process's command line.
 *
 * `dsh-desktop-host` is started as `… index.js <resources> <profileDir> …`, so
 * the profile is visible there even when the environment does not carry it.
 * @returns {string | undefined}
 */
export function profileFromArgv() {
  for (const arg of process.argv) {
    if (typeof arg !== 'string') continue
    const match = /^(.*[\\/]profiles[\\/][^\\/]+)$/.exec(arg)
    if (match !== null && match[1].length > 0) return match[1]
  }
  return undefined
}

/**
 * The file this plugin's state lives in.
 * @returns {string}
 */
export function statePath() {
  return join(stateDirectory(), 'remote-control.json')
}

/**
 * Read the stored state, or `undefined` when there is none yet.
 * @returns {{ deviceId?: string, alias?: string, secret?: string, relayUrl?: string } | undefined}
 */
export function readState() {
  const path = statePath()
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Write the stored state, creating the directory when needed.
 * @param {Record<string, unknown>} state
 */
export function writeState(state) {
  const path = statePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

/**
 * The stable identity of this computer, created on first use.
 *
 * @param {{ alias?: string }} [options]
 * @returns {{ deviceId: string, alias: string, secret: string }}
 */
export function ensureIdentity(options = {}) {
  const stored = readState() ?? {}
  const deviceId = typeof stored.deviceId === 'string' && stored.deviceId.length > 0
    ? stored.deviceId
    : randomUUID()
  const alias = typeof options.alias === 'string' && options.alias.length > 0
    ? options.alias
    : (typeof stored.alias === 'string' && stored.alias.length > 0 ? stored.alias : hostname())
  const secret = typeof stored.secret === 'string' && stored.secret.length > 0
    ? stored.secret
    : randomBytes(32).toString('base64url')
  writeState({ ...stored, deviceId, alias, secret })
  return { deviceId, alias, secret }
}

/**
 * Remember whether Remote Control is switched on.
 *
 * The switch is a user decision that should survive a restart: the plugin
 * reads it back on load and brings the tunnel up again.
 *
 * @param {boolean} enabled
 */
export function rememberEnabled(enabled) {
  const stored = readState() ?? {}
  writeState({ ...stored, enabled: enabled === true })
}

/**
 * Whether Remote Control was switched on the last time it ran.
 *
 * @returns {boolean}
 */
export function wasEnabled() {
  const stored = readState() ?? {}
  return stored.enabled === true
}

/**
 * The per-device access key a relay demands from a phone.
 *
 * The key travels in the access link and is the credential that opens a public
 * relay: the relay hands the phone its own session cookie afterwards, so the
 * app's absolute asset and API URLs keep working without the key.
 *
 * @param {boolean} [force] replace an existing key
 * @returns {string}
 */
export function ensureAccessKey(force = false) {
  const stored = readState() ?? {}
  if (!force && typeof stored.accessKey === 'string' && stored.accessKey.length > 0) return stored.accessKey
  const accessKey = randomBytes(32).toString('base64url')
  writeState({ ...stored, accessKey })
  return accessKey
}

/**
 * The device's passcode: what a phone must type before it may control the agent.
 *
 * The access key in the link only proves that the holder has the link; the
 * passcode is the second factor, and it never travels in a URL, so a photo of
 * the QR code is not enough.
 *
 * @param {boolean} [force] replace an existing passcode
 * @returns {string}
 */
export function ensurePasscode(force = false) {
  const stored = readState() ?? {}
  if (!force && typeof stored.passcode === 'string' && /^[0-9]{8}$/.test(stored.passcode)) {
    return stored.passcode
  }
  // Eight digits: short enough to type on a phone, long enough that the
  // relay's lockout makes guessing impractical.
  const passcode = String(randomInt(0, 100_000_000)).padStart(8, '0')
  writeState({ ...stored, passcode })
  return passcode
}

/**
 * Replace the shared secret, which revokes every relay that holds the old one.
 * @returns {{ deviceId: string, alias: string, secret: string }}
 */
export function rotateSecret() {
  const stored = readState() ?? {}
  const secret = randomBytes(32).toString('base64url')
  writeState({ ...stored, secret })
  return {
    deviceId: typeof stored.deviceId === 'string' ? stored.deviceId : randomUUID(),
    alias: typeof stored.alias === 'string' ? stored.alias : hostname(),
    secret,
  }
}

/**
 * Remember the relay this device talks to, so the next start reconnects.
 * @param {string | undefined} url
 */
export function rememberRelayUrl(url) {
  const stored = readState() ?? {}
  writeState({ ...stored, relayUrl: url })
}

/**
 * Remember the public origin a phone should open.
 *
 * The bundled relay advertises the machine's LAN address by default. A tunnel
 * or a reverse proxy in front of it changes that origin, and the access link
 * has to carry the origin the phone can actually reach.
 *
 * @param {string | undefined} url
 */
export function rememberPublicAddress(url) {
  const stored = readState() ?? {}
  writeState({ ...stored, publicAddress: url })
}

/**
 * A short, non-reversible fingerprint of the shared secret.
 *
 * The Settings page shows it so a user can confirm two devices hold the same
 * credential without either side printing the secret.
 * @param {string} secret
 * @returns {string}
 */
export function secretFingerprint(secret) {
  return createHash('sha256').update(secret).digest('hex').slice(0, 12)
}
