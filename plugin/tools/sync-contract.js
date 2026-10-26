#!/usr/bin/env node
/**
 * Write the wire contract of the browser half into `client.js`.
 *
 * The browser half cannot import `src/relay-protocol.js` — it runs in the
 * page, not in Node — so the two values it needs (the marker that opens a
 * compressed payload and the query parameter that announces the support)
 * have to exist on both sides. Hand-copied constants drift; generated ones
 * cannot.
 *
 * Usage:
 *   node tools/sync-contract.js           write the block into client.js
 *   node tools/sync-contract.js --check   fail when client.js is out of date
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { COMPRESSED_WS_PREFIX, COMPRESSION_QUERY } from '../src/relay-protocol.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'client.js')

const BEGIN =
  '  /* contract:begin — written by tools/sync-contract.js from src/relay-protocol.js */'
const END = '  /* contract:end */'

/**
 * One string literal, in the style of the file it is written into.
 *
 * @param {string} value
 * @returns {string}
 */
function literal(value) {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/**
 * The block the browser half carries.
 *
 * @returns {string}
 */
function renderBlock() {
  return [
    BEGIN,
    '  /**',
    '   * The marker that opens a compressed WebSocket payload.',
    '   *',
    '   * A copy of `COMPRESSED_WS_PREFIX` from `src/relay-protocol.js`: the',
    '   * browser half cannot import the Node-side protocol module, so the copy is',
    '   * generated from it (`node tools/sync-contract.js`) and checked by',
    '   * `tests/protocol-contract.test.js`.',
    '   */',
    `  const COMPRESSED_WS_PREFIX = ${literal(COMPRESSED_WS_PREFIX)}`,
    '',
    '  /**',
    '   * The query parameter a phone adds to its stream URL to announce that it',
    '   * can inflate a compressed payload.',
    '   *',
    '   * A copy of `COMPRESSION_QUERY` from `src/relay-protocol.js`.',
    '   */',
    `  const COMPRESSION_QUERY = ${literal(COMPRESSION_QUERY)}`,
    END,
  ].join('\n')
}

/**
 * Replace the marked block in the client file.
 *
 * @param {string} source the current client.js
 * @returns {string} the client.js with the current contract
 */
export function applyContract(source) {
  // The markers are matched loosely, so the text between them may change
  // without the tool losing the block.
  const start = source.indexOf('/* contract:begin')
  const end = source.indexOf('/* contract:end */')
  if (start === -1 || end === -1 || end < start) {
    throw new Error('sync-contract: client.js has no contract block')
  }
  // The block owns its own indentation, so the text before it ends at the
  // start of its line: otherwise every run indents it once more.
  const lineStart = source.lastIndexOf('\n', start) + 1
  const before = source.slice(0, lineStart)
  const after = source.slice(end + '/* contract:end */'.length)
  return `${before}${renderBlock()}${after}`
}

const check = process.argv.includes('--check')
const source = await readFile(clientPath, 'utf8')
const next = applyContract(source)

if (check) {
  if (next !== source) {
    console.error('sync-contract: client.js is out of date; run `node tools/sync-contract.js`')
    process.exit(1)
  }
  console.log('sync-contract: client.js carries the current contract')
} else {
  await writeFile(clientPath, next)
  console.log('sync-contract: client.js updated')
}
