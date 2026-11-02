/**
 * Durable records for the shared sessions of this device.
 *
 * A share record is the whole truth about one guest link: which session it
 * opens, what the guest may do with it, the passcode that opens it, and the
 * project directory the guest may read inside. The records live next to the
 * device identity — same directory, same owner-only mode — because a passcode
 * is a credential: anyone who can read this file can open every share.
 *
 * The file is rewritten as a whole. A share list is small, and a whole-file
 * write keeps the records consistent with each other: a half-written list
 * would be a share whose passcode exists but whose session does not.
 */

import { randomBytes, randomInt } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { stateDirectory } from './device-store.js'

/** The version of the persisted shape. */
export const SHARE_STATE_VERSION = 1

/** The prefix every share id carries. */
export const SHARE_ID_PREFIX = 's_'

/** How many hexadecimal characters the random part of a share id has. */
export const SHARE_ID_LENGTH = 12

/** The permissions a share may grant. */
export const SHARE_PERMISSIONS = Object.freeze(['read', 'write'])

/** The mode the share file keeps: owner read and write, nothing else. */
const SHARE_FILE_MODE = 0o600

/**
 * The file the share records live in.
 *
 * It sits beside `remote-control.json`, so the two files share one owner and
 * one directory.
 *
 * @returns {string}
 */
export function shareStatePath() {
  return join(stateDirectory(), 'remote-control-shares.json')
}

/**
 * Is this a well-formed share record?
 *
 * A record that lost a field in an older version is dropped rather than
 * repaired: a share without a passcode or without a session cannot be opened,
 * and pretending otherwise would hand the guest a broken link.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isShareRecord(value) {
  if (typeof value !== 'object' || value === null) return false
  const record = /** @type {Record<string, unknown>} */ (value)
  if (typeof record.id !== 'string' || !isShareId(record.id)) return false
  if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) return false
  if (typeof record.passcode !== 'string' || !/^[0-9]{8}$/.test(record.passcode)) return false
  if (record.permission !== 'read' && record.permission !== 'write') return false
  if (typeof record.projectRoot !== 'string' || record.projectRoot.length === 0) return false
  if (typeof record.title !== 'string') return false
  if (typeof record.createdAt !== 'number') return false
  if (record.lastUsedAt !== null && typeof record.lastUsedAt !== 'number') return false
  if (record.revokedAt !== null && typeof record.revokedAt !== 'number') return false
  return true
}

/**
 * Is this the shape of a share id?
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isShareId(value) {
  return typeof value === 'string' && new RegExp(`^${SHARE_ID_PREFIX}[0-9a-f]{${SHARE_ID_LENGTH}}$`).test(value)
}

/**
 * Read the persisted records, or an empty state when there are none.
 *
 * A file that cannot be read is treated as an empty state: the guest links
 * stop working, but the plugin still starts.
 *
 * @returns {{ version: number, shares: any[] }}
 */
export function readShareState() {
  const path = shareStatePath()
  if (!existsSync(path)) return { version: SHARE_STATE_VERSION, shares: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return { version: SHARE_STATE_VERSION, shares: [] }
    const shares = Array.isArray(parsed.shares) ? parsed.shares.filter(isShareRecord) : []
    return { version: SHARE_STATE_VERSION, shares }
  } catch {
    return { version: SHARE_STATE_VERSION, shares: [] }
  }
}

/**
 * Write the records, creating the directory when needed.
 *
 * The owner-only mode is set on every write, not only on creation: the file
 * keeps its mode when it is replaced, and a file that was copied from another
 * profile would otherwise keep that copy's mode.
 *
 * @param {{ shares?: any[] }} state
 */
export function writeShareState(state) {
  const path = shareStatePath()
  mkdirSync(dirname(path), { recursive: true })
  const shares = Array.isArray(state?.shares) ? state.shares.filter(isShareRecord) : []
  writeFileSync(path, `${JSON.stringify({ version: SHARE_STATE_VERSION, shares }, null, 2)}\n`, {
    mode: SHARE_FILE_MODE,
  })
  try {
    chmodSync(path, SHARE_FILE_MODE)
  } catch {
    /* a filesystem that refuses the mode change is not worth failing over */
  }
}

/**
 * A fresh share id: a prefix and twelve hexadecimal characters.
 *
 * @returns {string}
 */
export function newShareId() {
  return SHARE_ID_PREFIX + randomBytes(6).toString('hex')
}

/**
 * A fresh passcode: eight digits, like the device access code.
 *
 * @returns {string}
 */
export function newSharePasscode() {
  return String(randomInt(0, 100_000_000)).padStart(8, '0')
}

/**
 * Every persisted share record.
 *
 * @returns {any[]}
 */
export function listShares() {
  return readShareState().shares
}

/**
 * One persisted share record.
 *
 * @param {string} id
 * @returns {any | undefined}
 */
export function getShare(id) {
  if (typeof id !== 'string' || id.length === 0) return undefined
  return listShares().find((share) => share.id === id)
}

/**
 * Add one share record.
 *
 * The id is drawn until it is free: two records with one id would leave the
 * owner unable to tell which one the guest opens.
 *
 * @param {{ sessionId: string, title: string, permission: 'read'|'write', projectRoot: string, passcode?: string, createdAt?: number }} input
 * @returns {any} the stored record
 */
export function createShare(input) {
  const shares = listShares()
  const createdAt = typeof input.createdAt === 'number' ? input.createdAt : Date.now()
  const passcode = typeof input.passcode === 'string' && /^[0-9]{8}$/.test(input.passcode)
    ? input.passcode
    : newSharePasscode()
  /** @type {any} */
  let record
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = newShareId()
    if (shares.some((share) => share.id === id)) continue
    record = {
      id,
      sessionId: input.sessionId,
      title: input.title,
      permission: input.permission,
      passcode,
      createdAt,
      lastUsedAt: null,
      revokedAt: null,
      projectRoot: input.projectRoot,
    }
    break
  }
  if (record === undefined) throw new Error('share-store: could not draw a free share id')
  shares.push(record)
  writeShareState({ shares })
  return record
}

/**
 * Change the fields of one share record.
 *
 * @param {string} id
 * @param {Record<string, unknown>} patch
 * @returns {any | undefined} the stored record, or undefined when there is none
 */
export function updateShare(id, patch) {
  const shares = listShares()
  const index = shares.findIndex((share) => share.id === id)
  if (index === -1) return undefined
  const next = { ...shares[index], ...patch }
  if (!isShareRecord(next)) return undefined
  shares[index] = next
  writeShareState({ shares })
  return next
}

/**
 * Remove one share record.
 *
 * @param {string} id
 * @returns {boolean} whether a record was removed
 */
export function deleteShare(id) {
  const shares = listShares()
  const kept = shares.filter((share) => share.id !== id)
  if (kept.length === shares.length) return false
  writeShareState({ shares: kept })
  return true
}

/**
 * The view of one share the owner API returns.
 *
 * The passcode travels with it: the owner has to be able to read the code out
 * of the Settings page, and the relay never sees it.
 *
 * @param {any} share
 * @param {{ link: string | null }} options
 * @returns {{ id: string, sessionId: string, title: string, permission: string, passcode: string, createdAt: number, lastUsedAt: number | null, revokedAt: number | null, link: string | null, status: string }}
 */
export function shareView(share, options = {}) {
  return {
    id: share.id,
    sessionId: share.sessionId,
    title: share.title,
    permission: share.permission,
    passcode: share.passcode,
    createdAt: share.createdAt,
    lastUsedAt: share.lastUsedAt ?? null,
    revokedAt: share.revokedAt ?? null,
    link: options.link ?? null,
    status: share.revokedAt === null || share.revokedAt === undefined ? 'active' : 'revoked',
  }
}
