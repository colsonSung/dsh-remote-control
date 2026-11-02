/**
 * The composer must stay above the phone keyboard.
 *
 * iOS Safari shrinks the visual viewport when the keyboard opens but keeps
 * the layout viewport, so a composer stuck to the bottom of its scroller ends
 * up behind the keyboard. The plugin measures how much of the composer is
 * actually hidden and lifts it by exactly that amount.
 *
 * Run with: `node --test tests/mobile-keyboard.test.js`
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'client.js')

/**
 * Load the browser half with a fake viewport and document.
 *
 * @param {{innerHeight?: number, viewportHeight?: number, viewportOffsetTop?: number, composerBottom?: number}} options
 * @returns {Promise<any>} the fake window, document and the recorded calls.
 */
async function loadClient(options = {}) {
  const innerHeight = options.innerHeight ?? 800
  const viewportHeight = options.viewportHeight ?? 500
  const viewportOffsetTop = options.viewportOffsetTop ?? 0
  const composerBottom = options.composerBottom ?? 900
  const properties = []
  const removed = []
  const listeners = new Map()
  const documentListeners = new Map()
  const viewport = {
    height: viewportHeight,
    offsetTop: viewportOffsetTop,
    addEventListener(type, handler) {
      listeners.set(type, handler)
    },
    removeEventListener(type) {
      listeners.delete(type)
    },
  }
  const target = { name: 'the-focused-field' }
  const seat = {
    getBoundingClientRect: () => ({ bottom: composerBottom, top: composerBottom - 60 }),
    contains: (node) => node === target,
  }
  const document = {
    documentElement: {
      style: {
        setProperty: (name, value) => properties.push([name, value]),
        removeProperty: (name) => removed.push(name),
      },
    },
    querySelector: (selector) => (selector === '[data-composer-seat]' ? seat : null),
    head: { appendChild: () => {} },
    getElementById: () => null,
    createElement: (tagName) => ({ tagName: String(tagName).toUpperCase(), id: '', textContent: '' }),
    querySelectorAll: () => [],
    addEventListener(type, handler) {
      documentListeners.set(type, handler)
    },
    removeEventListener(type) {
      documentListeners.delete(type)
    },
  }
  const window = {
    innerHeight,
    navigator: {
      userAgent: options.userAgent ?? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      platform: options.platform ?? 'MacIntel',
      maxTouchPoints: options.maxTouchPoints ?? 0,
    },
    visualViewport: viewport,
    requestAnimationFrame: (callback) => {
      callback()
      return 1
    },
    cancelAnimationFrame() {},
    matchMedia: () => ({ matches: true }),
    __ModuleLoader__: { load() {} },
  }
  const source = await readFile(clientPath, 'utf8')
  new Function('window', 'document', `${source}\n//# sourceURL=client.js`)(window, document)
  const focus = (target) => {
    const handler = documentListeners.get('focusin')
    if (handler) handler({ target })
  }
  return { document, documentListeners, focus, properties, removed, listeners, target, viewport, window }
}

test('the composer is lifted by exactly the hidden keyboard height', async () => {
  const { properties, removed, window } = await loadClient()
  const install = window[Symbol.for('dsh.remote-control.install-keyboard-inset')]
  assert.equal(typeof install, 'function')
  const dispose = install()
  // The composer ends 900px down the layout viewport while the visible area
  // ends at 500px, so 400px of it are behind the keyboard.
  assert.deepEqual(properties.at(-1), ['--dsh-rc-keyboard-inset', '400px'])
  dispose()
  assert.ok(removed.includes('--dsh-rc-keyboard-inset'))
})

test('a visible composer is not lifted at all', async () => {
  const { properties, window } = await loadClient({ composerBottom: 400 })
  const install = window[Symbol.for('dsh.remote-control.install-keyboard-inset')]
  install()
  assert.deepEqual(properties.at(-1), ['--dsh-rc-keyboard-inset', '0px'])
})

test('the keyboard inset follows the visual viewport', async () => {
  const { listeners, properties, viewport, window } = await loadClient()
  const install = window[Symbol.for('dsh.remote-control.install-keyboard-inset')]
  const dispose = install()
  assert.equal(typeof listeners.get('resize'), 'function')
  assert.equal(typeof listeners.get('scroll'), 'function')
  viewport.height = 700
  listeners.get('resize')()
  assert.deepEqual(properties.at(-1), ['--dsh-rc-keyboard-inset', '200px'])
  dispose()
  assert.equal(listeners.size, 0)
})

test('the composer seat is moved up by the measured inset', async () => {
  const styles = []
  const document = {
    head: {
      appendChild(node) {
        if (node.tagName === 'STYLE') styles.push(node)
        return node
      },
    },
    getElementById: () => null,
    createElement: (tagName) => ({ tagName: String(tagName).toUpperCase(), id: '', textContent: '' }),
    querySelectorAll: () => [],
  }
  const window = { __ModuleLoader__: { load() {} } }
  const source = await readFile(clientPath, 'utf8')
  new Function('window', 'document', `${source}\n//# sourceURL=client.js`)(window, document)
  const style = styles.find((entry) => entry.id === 'dsh-remote-control-mobile-layout')
  assert.ok(style)
  assert.match(style.textContent, /\[data-composer-seat\][^{]*\{[^}]*translateY\(calc\(-1 \* var\(--dsh-rc-keyboard-inset, 0px\)\)\) !important/s)
})

test('an iPhone also clears the input method toolbar above the keyboard', async () => {
  const { properties, window } = await loadClient({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    platform: 'iPhone',
    maxTouchPoints: 5,
  })
  const install = window[Symbol.for('dsh.remote-control.install-keyboard-inset')]
  install()
  // 400px of keyboard, plus the room the Chinese input method's own toolbar
  // takes above it — that toolbar is drawn over the page and never shows up in
  // the visual viewport.
  const value = Number(String(properties.at(-1)[1]).replace('px', ''))
  assert.ok(value > 400, `expected room for the input method toolbar, got ${value}px`)
})

test('another platform keeps the plain keyboard height', async () => {
  const { properties, window } = await loadClient()
  const install = window[Symbol.for('dsh.remote-control.install-keyboard-inset')]
  install()
  assert.deepEqual(properties.at(-1), ['--dsh-rc-keyboard-inset', '400px'])
})

test('the composer clears the input method toolbar while it has the focus', async () => {
  const { focus, properties, target, window } = await loadClient({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    platform: 'iPhone',
    maxTouchPoints: 5,
    // Safari scrolls the page to reveal the field, so nothing of the composer
    // is below the visible area any more - and the measurement alone would
    // report "nothing is covered".
    viewportHeight: 900,
    innerHeight: 900,
    composerBottom: 800,
  })
  const install = window[Symbol.for('dsh.remote-control.install-keyboard-inset')]
  install()
  focus(target)
  const value = Number(String(properties.at(-1)[1]).replace('px', ''))
  assert.ok(value > 0, `expected room for the input method toolbar, got ${value}px`)
})
