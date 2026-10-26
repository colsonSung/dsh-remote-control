/**
 * The wire contract has to exist on both sides of the tunnel.
 *
 * The browser half runs in the page and cannot import the Node-side protocol
 * module, so the two values it needs are copied into `client.js`. The copy is
 * generated from `src/relay-protocol.js` and these tests make sure it stays
 * that way: a hand-copied constant that drifts is a phone that cannot read a
 * compressed payload and silently waits for the full megabytes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { COMPRESSED_WS_PREFIX, COMPRESSION_QUERY } from '../src/relay-protocol.js'

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const clientPath = path.join(pluginRoot, 'client.js')

/**
 * The client file as text.
 * @returns {Promise<string>}
 */
async function clientSource() {
  return readFile(clientPath, 'utf8')
}

test('the browser half carries the current contract', async () => {
  const { stdout } = await run(process.execPath, [path.join(pluginRoot, 'tools', 'sync-contract.js'), '--check'], {
    cwd: pluginRoot,
  })
  assert.match(stdout, /current contract/)
})

test('the marker and the query parameter match the protocol module', async () => {
  const source = await clientSource()
  assert.ok(
    source.includes(`const COMPRESSED_WS_PREFIX = '${COMPRESSED_WS_PREFIX}'`),
    `client.js must declare COMPRESSED_WS_PREFIX = '${COMPRESSED_WS_PREFIX}'`,
  )
  assert.ok(
    source.includes(`const COMPRESSION_QUERY = '${COMPRESSION_QUERY}'`),
    `client.js must declare COMPRESSION_QUERY = '${COMPRESSION_QUERY}'`,
  )
})

test('the marker is written down once in the browser half', async () => {
  const source = await clientSource()
  // The ASCII bytes of the marker are derived from the prefix, so the prefix
  // must not be spelled a second time as a byte array.
  const literals = source.match(/'DSHRC1'|0x44/g) ?? []
  assert.equal(literals.length, 1, `the marker must appear once, found ${literals.length} times`)
  assert.ok(
    source.includes('Array.from(COMPRESSED_WS_PREFIX'),
    'the marker bytes must be derived from the prefix',
  )
})

test('the protocol module and the client file agree on the query parameter', async () => {
  const source = await clientSource()
  const query = source.match(/const COMPRESSION_QUERY = '([^']*)'/)?.[1]
  assert.equal(query, COMPRESSION_QUERY)
})
