/**
 * The web app preloads its client-module bundles with `rel="preload" as="script"`,
 * but the browser loads those bundles as ES modules. WebKit (Safari) does not
 * reuse a classic script preload for a module import: it cancels the preload and
 * the import fails with it, so the page never finishes booting and the phone
 * shows an empty screen.
 *
 * The tunnel rewrites those preloads into `rel="modulepreload"`, which is the
 * preload a module import can actually use — and only the tunnel rewrites them,
 * so the desktop app keeps its own behaviour.
 *
 * The same rewrite asks the browser for a maximum scale of one, so a focused
 * field cannot zoom the page and stretch the composer across the screen.
 *
 * Run with: `node --test tests/phone-document.test.js`
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { rewritePhoneDocument } from '../src/relay-client.js'

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' }

/** A module bundle preload as the web app emits it. */
const PRELOAD = '<link rel="preload" as="script" href="plugins/??@deepseek-ai/dsh-api-gateway/client.js,@deepseek-ai/dsh-client-ui-chat/client.js&rev=00966cca3a81">'

test('a module bundle preload becomes a modulepreload', () => {
  const body = Buffer.from(`<!doctype html><html><head>${PRELOAD}</head><body></body></html>`, 'utf8')
  const result = rewritePhoneDocument(body, { ...HTML_HEADERS, 'content-length': String(body.length) })
  const html = result.body.toString('utf8')
  assert.match(html, /<link rel="modulepreload" href="plugins\/\?\?@deepseek-ai\/dsh-api-gateway\/client\.js/)
  assert.doesNotMatch(html, /as="script"/)
  assert.doesNotMatch(html, /rel="preload"/)
})

test('the rewritten document keeps a correct content length', () => {
  const body = Buffer.from(`<html><head>${PRELOAD}</head></html>`, 'utf8')
  const result = rewritePhoneDocument(body, { ...HTML_HEADERS, 'content-length': String(body.length) })
  assert.equal(result.headers['content-length'], String(result.body.length))
  assert.notEqual(result.headers['content-length'], String(body.length))
})

test('other preloads are left alone', () => {
  const style = '<link rel="preload" as="style" href="./assets/index.css">'
  const other = '<link rel="preload" as="script" href="./assets/index.js">'
  const body = Buffer.from(`<html><head>${style}${other}</head></html>`, 'utf8')
  const result = rewritePhoneDocument(body, { ...HTML_HEADERS, 'content-length': String(body.length) })
  const html = result.body.toString('utf8')
  assert.match(html, /<link rel="preload" as="style" href="\.\/assets\/index\.css">/)
  assert.match(html, /<link rel="preload" as="script" href="\.\/assets\/index\.js">/)
  assert.equal(result.headers['content-length'], String(result.body.length))
})

test('a body that is not html is never rewritten', () => {
  const body = Buffer.from(`/* ${PRELOAD} */`, 'utf8')
  const result = rewritePhoneDocument(body, { 'content-type': 'text/javascript; charset=utf-8' })
  assert.equal(result.body.toString('utf8'), body.toString('utf8'))
})

test('the attribute order of the emitted tag does not matter', () => {
  const body = Buffer.from('<link as="script" rel="preload" href="plugins/??a/client.js&amp;rev=1">', 'utf8')
  const result = rewritePhoneDocument(body, HTML_HEADERS)
  const html = result.body.toString('utf8')
  assert.match(html, /rel="modulepreload"/)
  assert.doesNotMatch(html, /as="script"/)
})

test('the viewport of a phone document cannot zoom the page', () => {
  const html = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
  const body = Buffer.from(`<!doctype html><html><head>${html}</head></html>`, 'utf8')
  const result = rewritePhoneDocument(body, { ...HTML_HEADERS, 'content-length': String(body.length) })
  const out = result.body.toString('utf8')
  assert.match(out, /name="viewport" content="[^"]*maximum-scale=1/)
  assert.match(out, /name="viewport" content="[^"]*user-scalable=no/)
  assert.match(out, /name="viewport" content="[^"]*viewport-fit=cover/)
  assert.doesNotMatch(out, /content="[^"]*initial-scale=1, initial-scale/)
})

test('a document without a viewport meta gets one that cannot zoom', () => {
  const body = Buffer.from('<!doctype html><html><head><title>x</title></head></html>', 'utf8')
  const result = rewritePhoneDocument(body, HTML_HEADERS)
  const out = result.body.toString('utf8')
  assert.match(out, /name="viewport" content="[^"]*maximum-scale=1/)
})

test('a document that is not html is never rewritten', () => {
  const body = Buffer.from('<meta name="viewport" content="width=device-width">', 'utf8')
  const result = rewritePhoneDocument(body, { 'content-type': 'text/javascript' })
  assert.equal(result.body.toString('utf8'), body.toString('utf8'))
})
