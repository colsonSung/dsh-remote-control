/**
 * The log of the plugin, on disk.
 *
 * The Host keeps the words of the plugin in its console, and the desktop app
 * writes them into a crash report when it stops. The plugin therefore writes
 * them into a file of its own, so that a phone that fails while nobody is
 * looking still leaves a trace.
 *
 * Run with: `node --test tests/remote-log.test.js`
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  remoteLogPath,
  REMOTE_LOG_MAX_BYTES,
  writeRemoteLog,
} from '../src/remote-log.js'

/**
 * A scratch directory for the log.
 *
 * @returns {string}
 */
function scratch() {
  return mkdtempSync(join(tmpdir(), 'remote-control-log-'))
}

test('the plugin writes its words into a file of its own', () => {
  const dir = scratch()
  writeRemoteLog(dir, 'the tunnel came up', { port: 56131 })
  const text = readFileSync(remoteLogPath(dir), 'utf8')
  assert.match(text, /the tunnel came up/, 'the words are in the file')
  assert.match(text, /"port":56131/, 'the details are in the file')
  assert.match(text, /^\d{4}-\d{2}-\d{2}T/, 'the line carries the time it was written')
})

test('the file of the log is kept for the owner alone', () => {
  const dir = scratch()
  writeRemoteLog(dir, 'the tunnel came up')
  const mode = statSync(remoteLogPath(dir)).mode & 0o777
  assert.equal(mode, 0o600, 'only the owner reads the log')
})

test('the log is rotated when it grows past its bound', () => {
  const dir = scratch()
  const path = remoteLogPath(dir)
  // A file that is already at its bound is rotated on the next line.
  writeFileSync(path, 'x'.repeat(REMOTE_LOG_MAX_BYTES + 1))
  writeRemoteLog(dir, 'after the rotation')
  assert.ok(existsSync(`${path}.1`), 'the old log is kept beside the live one')
  assert.match(readFileSync(path, 'utf8'), /after the rotation/, 'the live log carries the new words')
  assert.ok(statSync(`${path}.1`).size > REMOTE_LOG_MAX_BYTES, 'the old log is the one that was rotated')

  // A second rotation moves every file one place along.
  writeFileSync(path, 'y'.repeat(REMOTE_LOG_MAX_BYTES + 1))
  writeRemoteLog(dir, 'after the second rotation')
  assert.ok(existsSync(`${path}.2`), 'the log before it is kept as well')
  assert.match(readFileSync(`${path}.1`, 'utf8'), /^y/, 'the live log of a moment ago took the first place')
  assert.match(readFileSync(`${path}.2`, 'utf8'), /^x/, 'the log before it took the second place')
})

test('a log that cannot be written does not stop the plugin', () => {
  // A directory that cannot be created: the words are lost, and the plugin
  // carries on.
  const dir = join(scratch(), 'file-in-the-way')
  writeFileSync(dir, 'not a directory')
  assert.doesNotThrow(() => writeRemoteLog(dir, 'the words are lost'))
})
