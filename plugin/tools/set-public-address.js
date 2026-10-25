#!/usr/bin/env node
/**
 * Set the public origin a phone opens, without touching the settings page.
 *
 *   node tools/set-public-address.js https://rc.example.com
 *   node tools/set-public-address.js            # clears it (back to the LAN address)
 *
 * The running plugin re-reads this file, so the tunnel re-registers and the
 * QR code follows within a few seconds — no application restart needed.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where this profile keeps the plugin's state.
 * @returns {string}
 */
function statePath() {
  const profile = process.env.DSH_PROFILE_DIR
  if (typeof profile === 'string' && profile.length > 0) return join(profile, 'plugins', 'remote-control.json')
  const fromArgv = profileFromArgv()
  if (fromArgv !== undefined) return join(fromArgv, 'plugins', 'remote-control.json')
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home.length > 0 ? home : join(homedir(), '.dsh')
  const name = process.env.DSH_PROFILE
  if (typeof name === 'string' && name.length > 0) return join(base, 'profiles', name, 'plugins', 'remote-control.json')
  // A plain shell has neither: use whichever state file the Harness touched last.
  return mostRecentProfileState(base) ?? join(base, 'plugins', 'remote-control.json')
}

/**
 * The profile directory named on a process command line.
 * @returns {string | undefined}
 */
function profileFromArgv() {
  for (const arg of process.argv) {
    if (typeof arg !== 'string') continue
    const match = /^(.*[\\/]profiles[\\/][^\\/]+)$/.exec(arg)
    if (match !== null) return match[1]
  }
  return undefined
}

/**
 * The most recently written profile state file under one Harness home.
 * @param {string} base
 * @returns {string | undefined}
 */
function mostRecentProfileState(base) {
  let best
  let bestTime = -1
  let profiles
  try {
    profiles = readdirSync(join(base, 'profiles'), { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of profiles) {
    if (!entry.isDirectory()) continue
    const candidate = join(base, 'profiles', entry.name, 'plugins', 'remote-control.json')
    try {
      const time = statSync(candidate).mtimeMs
      if (time > bestTime) {
        bestTime = time
        best = candidate
      }
    } catch {
      /* no state in this profile */
    }
  }
  return best
}

const raw = process.argv[2] ?? ''
const address = raw.trim().replace(/\/+$/, '')

if (address.length > 0 && !/^https?:\/\//.test(address)) {
  console.error(`not an http(s) origin: ${address}`)
  process.exit(1)
}

const path = statePath()
let state = {}
try {
  state = JSON.parse(readFileSync(path, 'utf8'))
} catch {
  console.error(`no plugin state at ${path} — start the Harness with the plugin once first`)
  process.exit(1)
}

state.publicAddress = address
writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`)

console.log(address.length > 0 ? `public address set to ${address}` : 'public address cleared')
console.log('the access link now uses this origin; the QR code follows on the next poll')
