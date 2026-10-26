/**
 * The mobile layout of the sidebar.
 *
 * Below 1024px the app keeps the expanded sidebar as a column beside the
 * conversation, which leaves the conversation a sliver (113px on a 393px
 * phone). The plugin's browser half therefore gives the sidebar the whole
 * screen while it is expanded.
 *
 * The rule is written against the shell's own attributes, not against the
 * build's hashed class names: a hashed name would break with the next
 * release, and a rule that stops matching must leave the app's own layout
 * alone rather than break it.
 *
 * Run with: `node --test tests/mobile-layout.test.js`
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'client.js')

/**
 * A document that records what the plugin injects into it.
 *
 * @returns {{document: any, styles: any[]}}
 */
function fakeDocument() {
  /** @type {any[]} */
  const styles = []
  const head = {
    appendChild(node) {
      if (node.tagName === 'STYLE') styles.push(node)
      return node
    },
  }
  const document = {
    head,
    getElementById(id) {
      return styles.find((style) => style.id === id) ?? null
    },
    createElement(tagName) {
      return { tagName: String(tagName).toUpperCase(), id: '', textContent: '' }
    },
  }
  return { document, styles }
}

/**
 * Load the browser half with a fake window and return the styles it injected.
 *
 * @returns {Promise<{styles: any[], window: any}>}
 */
async function loadClient() {
  const { document, styles } = fakeDocument()
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  globalThis.window = { __ModuleLoader__: { load() {} } }
  globalThis.document = document
  try {
    // The file registers a factory and runs its bundle-level installers.
    const source = await readFile(clientPath, 'utf8')
    const run = new Function('window', 'document', `${source}\n//# sourceURL=client.js`)
    run(globalThis.window, document)
    return { styles, window: globalThis.window, document }
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
  }
}

test('the browser half injects the mobile layout rule', async () => {
  const { styles } = await loadClient()
  const style = styles.find((entry) => entry.id === 'dsh-remote-control-mobile-layout')
  assert.ok(style, 'the mobile layout stylesheet must be injected')
  assert.match(style.textContent, /@media \(max-width: 1023px\)/)
  assert.match(style.textContent, /grid-template-columns: 100% 0 0 !important/)
})

test('the rule only uses the shell attributes, never a hashed class', async () => {
  const { styles } = await loadClient()
  const style = styles.find((entry) => entry.id === 'dsh-remote-control-mobile-layout')
  assert.ok(style)
  // The shell marks the frame's overlay seat and the collapsed state with
  // attributes whose names do not change between builds.
  assert.match(style.textContent, /\[data-shell-overlay\]/)
  assert.match(style.textContent, /:not\(\[data-sidebar-collapsed\]\)/)
  // The resize handle carries its own side marker.
  assert.match(style.textContent, /\[data-side="sidebar"\]/)
  // A class selector would be tied to one build.
  assert.doesNotMatch(style.textContent, /\.[A-Za-z_][A-Za-z0-9_-]*_/)
})

test('the stylesheet is injected once', async () => {
  const { document, styles } = fakeDocument()
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  globalThis.window = { __ModuleLoader__: { load() {} } }
  globalThis.document = document
  try {
    const source = await readFile(clientPath, 'utf8')
    const run = new Function('window', 'document', source)
    run(globalThis.window, document)
    run(globalThis.window, document)
    const layout = styles.filter((entry) => entry.id === 'dsh-remote-control-mobile-layout')
    assert.equal(layout.length, 1, 'the layout stylesheet must be injected once')
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
  }
})

test('the shell\'s own open and collapse controls are marked on a phone', async () => {
  const { document, styles, window } = await loadClient()
  assert.ok(styles.length > 0)
  const mark = window[Symbol.for('dsh.remote-control.mark-sidebar-controls')]
  assert.equal(typeof mark, 'function', 'the marker helper must be published')

  // A document with the shell's two controls and one that only looks like
  // them.
  const made = []
  const button = (label) => {
    const attributes = { 'aria-label': label }
    return {
      attributes,
      getAttribute: (name) => attributes[name] ?? null,
      setAttribute: (name, value) => { attributes[name] = value },
      removeAttribute: (name) => { delete attributes[name] },
      hasAttribute: (name) => name in attributes,
    }
  }
  const collapse = button('Collapse sidebar')
  const open = button('Open sidebar')
  const right = button('Open right sidebar')
  made.push(collapse, open, right)
  document.querySelectorAll = (selector) => (selector === 'button[aria-label]' ? made : [])
  document.querySelectorAll = (selector) => {
    if (selector === 'button[aria-label]') return made
    if (selector === '[data-dsh-sidebar-toggle]') return made.filter((b) => b.hasAttribute('data-dsh-sidebar-toggle'))
    return []
  }
  window.matchMedia = () => ({ matches: true })

  mark('Collapse sidebar', 'Open sidebar')

  assert.equal(collapse.getAttribute('data-dsh-sidebar-toggle'), 'collapse')
  assert.equal(open.getAttribute('data-dsh-sidebar-toggle'), 'open')
  // The right sidebar's own button must not be taken for the sidebar's.
  assert.equal(right.getAttribute('data-dsh-sidebar-toggle'), null)
})
