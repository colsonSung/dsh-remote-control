/**
 * The log of the plugin, on disk.
 *
 * The Host writes what the plugin says to its own console. The desktop app
 * keeps those words in memory and writes them into a crash report when it
 * stops — so a phone that fails in the middle of the night is not there when
 * the app stops, and the reason is gone.
 *
 * The plugin therefore writes its own words into a file of its own, next to
 * the state it keeps. The file is small, it is kept for the owner alone, and
 * it is rotated when it grows past its bound.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * How large the log may grow before it is rotated.
 */
export const REMOTE_LOG_MAX_BYTES = 1024 * 1024

/**
 * How many rotated files are kept beside the live one.
 */
export const REMOTE_LOG_KEEP = 2

/**
 * The file the words of the plugin are written into.
 *
 * @param {string} directory the directory of the plugin's state
 * @returns {string}
 */
export function remoteLogPath(directory) {
  return join(directory, 'remote-control.log')
}

/**
 * Rotate the log when it grew past its bound.
 *
 * The oldest file is let go: the log is a record of the recent past, and a
 * file that grows without end is a file nobody reads.
 *
 * @param {string} path the file of the log
 * @returns {void}
 */
function rotate(path) {
  try {
    const size = statSync(path).size
    if (size < REMOTE_LOG_MAX_BYTES) return
  } catch (error) {
    // A log that is not there yet has nothing to rotate.
    return
  }
  for (let index = REMOTE_LOG_KEEP; index >= 2; index -= 1) {
    const from = `${path}.${index - 1}`
    const to = `${path}.${index}`
    if (!existsSync(from)) continue
    try {
      renameSync(from, to)
    } catch (error) {
      // A file that cannot be moved is left where it is.
    }
  }
  try {
    renameSync(path, `${path}.1`)
  } catch (error) {
    // The live log stays where it is: it is still the log.
  }
}

/**
 * Write one line into the log of the plugin.
 *
 * A log that cannot be written must not stop the plugin: the words are a
 * record, not the work itself.
 *
 * @param {string} directory the directory of the plugin's state
 * @param {string} message what the plugin says
 * @param {unknown} [extra] the details of the words
 * @returns {void}
 */
export function writeRemoteLog(directory, message, extra) {
  try {
    mkdirSync(directory, { recursive: true })
    const path = remoteLogPath(directory)
    rotate(path)
    const stamp = new Date().toISOString()
    const detail = extra === undefined || extra === null ? '' : ` ${safeJson(extra)}`
    appendFileSync(path, `${stamp} ${message}${detail}\n`, { mode: 0o600 })
  } catch (error) {
    // The log is a convenience: a failure to write it is not a failure of the
    // plugin.
  }
}

/**
 * The details of one line, as text.
 *
 * A detail that cannot be written as JSON is written as its own text: the
 * line is worth keeping even when its details are not.
 *
 * @param {unknown} value
 * @returns {string}
 */
function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch (error) {
    return String(value)
  }
}
