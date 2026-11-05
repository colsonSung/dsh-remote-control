/**
 * The composer must stay above the phone keyboard.
 *
 * iOS Safari shrinks the visual viewport when the keyboard opens but keeps
 * the layout viewport, so a shell sized to the layout viewport puts its
 * composer - sticky at the bottom of the shell's own scroller - behind the
 * keyboard. The plugin therefore sizes the shell to the visible area, and the
 * composer lands on the top edge of the keyboard by construction.
 *
 * The composer is never measured to find out how much of it is hidden: the
 * composer is an element of the very shell the plugin resizes, so a
 * measurement reads the result of the previous resize and feeds that value
 * back into the next one. The lift then alternates between the true keyboard
 * height and none at all, and the composer ends up half covered.
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
const INSTALL = Symbol.for('dsh.remote-control.install-keyboard-inset')

/**
 * Load the browser half with a fake viewport and document.
 *
 * @param {{layoutHeight?: number, viewportHeight?: number, viewportOffsetTop?: number, userAgent?: string, platform?: string, maxTouchPoints?: number, focused?: boolean, withShell?: boolean}} options
 * @returns {Promise<any>} the fake window, document and the recorded calls.
 */
async function loadClient(options = {}) {
  const layoutHeight = options.layoutHeight ?? 800
  const viewportHeight = options.viewportHeight ?? 500
  const viewportOffsetTop = options.viewportOffsetTop ?? 0
  const properties = []
  const removed = []
  const attributes = new Map()
  const listeners = new Map()
  const documentListeners = new Map()
  const windowListeners = new Map()
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
  // The seat must never be measured: a measurement of a transformed element
  // reads the lift it already carries and feeds it back into the next one.
  const seat = {
    style: {
      setProperty: (name, value) => properties.push([`seat:${name}`, value]),
      removeProperty: (name) => removed.push(`seat:${name}`),
    },
    getBoundingClientRect: () => {
      throw new Error('the composer must not be measured')
    },
    contains: () => true,
  }
  const shell = options.withShell === false ? null : { id: 'root' }
  const field = { tagName: 'TEXTAREA' }
  const document = {
    documentElement: {
      clientHeight: layoutHeight,
      style: {
        setProperty: (name, value) => properties.push([name, value]),
        removeProperty: (name) => removed.push(name),
      },
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: (name) => attributes.delete(name),
    },
    activeElement: options.focused === false ? null : field,
    querySelector: (selector) => (selector === '[data-composer-seat]' ? seat : null),
    getElementById: (id) => (id === 'root' ? shell : null),
    head: { appendChild: () => {} },
    createElement: (tagName) => ({ tagName: String(tagName).toUpperCase(), id: '', textContent: '' }),
    querySelectorAll: () => [],
    addEventListener(type, handler) {
      documentListeners.set(type, handler)
    },
    removeEventListener(type) {
      documentListeners.delete(type)
    },
  }
  const frames = []
  const window = {
    innerHeight: layoutHeight,
    navigator: {
      userAgent: options.userAgent ?? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      platform: options.platform ?? 'MacIntel',
      maxTouchPoints: options.maxTouchPoints ?? 0,
    },
    visualViewport: viewport,
    // The frame queue is flushed by hand: a fake that runs the callback
    // straight away leaves the guard set and every later event is dropped.
    requestAnimationFrame: (callback) => {
      frames.push(callback)
      return frames.length
    },
    cancelAnimationFrame() {},
    addEventListener(type, handler) {
      windowListeners.set(type, handler)
    },
    removeEventListener(type) {
      windowListeners.delete(type)
    },
    matchMedia: () => ({ matches: true }),
    __ModuleLoader__: { load() {} },
  }
  const source = await readFile(clientPath, 'utf8')
  new Function('window', 'document', `${source}\n//# sourceURL=client.js`)(window, document)
  const flush = () => {
    while (frames.length > 0) frames.shift()()
  }
  return {
    attributes, document, documentListeners, flush, properties, removed,
    listeners, seat, viewport, window, windowListeners,
  }
}

test('the shell is sized to the visible area while a keyboard is up', async () => {
  const { attributes, properties, window } = await loadClient()
  const install = window[INSTALL]
  assert.equal(typeof install, 'function')
  const dispose = install()
  // The layout viewport is 800px tall and the keyboard covers everything
  // below 500px, so the shell follows the 500px that are still visible.
  assert.deepEqual(properties.at(-2), ['--dsh-vv-height', '500px'])
  assert.deepEqual(properties.at(-1), ['--dsh-vv-offset', '0px'])
  assert.equal(attributes.get('data-dsh-keyboard'), 'open')
  dispose()
})

test('the composer is never measured', async () => {
  // The fake seat throws when it is measured, so the test fails if the
  // installer reads the composer's box again.
  const { window } = await loadClient()
  window[INSTALL]()
})

test('a page that merely scrolled keeps the shell as it is', async () => {
  const { attributes, properties, removed, window } = await loadClient({ focused: false })
  window[INSTALL]()
  // Nothing is being typed, so the browser bar is what shrank the visible
  // area; the shell must not follow it.
  assert.equal(properties.length, 0)
  assert.equal(removed.includes('--dsh-vv-height'), true)
  assert.equal(attributes.has('data-dsh-keyboard'), false)
})

test('the shell follows the visual viewport', async () => {
  const { flush, listeners, properties, viewport, window } = await loadClient()
  const dispose = window[INSTALL]()
  assert.equal(typeof listeners.get('resize'), 'function')
  assert.equal(typeof listeners.get('scroll'), 'function')
  viewport.height = 650
  listeners.get('resize')()
  flush()
  assert.deepEqual(properties.at(-2), ['--dsh-vv-height', '650px'])
  dispose()
  assert.equal(listeners.size, 0)
})

test('a browser bar that hides a little is not a keyboard', async () => {
  const { flush, listeners, removed, viewport, window } = await loadClient()
  const dispose = window[INSTALL]()
  // A hundred pixels is a browser bar, not a keyboard: the shell must stay.
  viewport.height = 700
  listeners.get('resize')()
  flush()
  assert.equal(removed.includes('--dsh-vv-height'), true)
  dispose()
})

test('the shell follows the pan of the visible area', async () => {
  const { flush, listeners, properties, viewport, window } = await loadClient({ viewportOffsetTop: 40 })
  window[INSTALL]()
  viewport.offsetTop = 120
  listeners.get('scroll')()
  flush()
  assert.deepEqual(properties.at(-1), ['--dsh-vv-offset', '120px'])
})

test('an iPhone keeps the whole visible area for the composer', async () => {
  const { properties, window } = await loadClient({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    platform: 'iPhone',
    maxTouchPoints: 5,
  })
  window[INSTALL]()
  // The Chinese candidate bar belongs to the keyboard, so the visible area
  // already ends where the keyboard begins. A reserve on top of that would
  // leave an empty band under the composer.
  assert.deepEqual(properties.at(-2), ['--dsh-vv-height', '500px'])
})

test('another platform keeps the whole visible area', async () => {
  const { properties, window } = await loadClient()
  window[INSTALL]()
  assert.deepEqual(properties.at(-2), ['--dsh-vv-height', '500px'])
})

test('the shell returns to its normal height when the keyboard closes', async () => {
  const { flush, listeners, removed, viewport, window } = await loadClient()
  const dispose = window[INSTALL]()
  viewport.height = 800
  listeners.get('resize')()
  flush()
  assert.equal(removed.includes('--dsh-vv-height'), true)
  dispose()
})

test('the disposer takes the listeners and the variables away', async () => {
  const { documentListeners, listeners, removed, window, windowListeners } = await loadClient()
  const dispose = window[INSTALL]()
  dispose()
  assert.equal(listeners.size, 0)
  assert.equal(windowListeners.size, 0)
  assert.equal(documentListeners.size, 0)
  assert.equal(removed.includes('--dsh-vv-height'), true)
  assert.equal(removed.includes('--dsh-vv-offset'), true)
})

test('without a shell the composer is raised by a margin', async () => {
  const { properties, window } = await loadClient({ withShell: false })
  window[INSTALL]()
  // A margin moves the box without changing what the box measures, so the
  // measurement cannot feed back into itself the way a transform does.
  assert.deepEqual(properties.at(-1), ['seat:margin-bottom', '300px'])
})
