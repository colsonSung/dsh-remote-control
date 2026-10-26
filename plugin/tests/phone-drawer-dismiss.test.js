/**
 * The phone drawer must not steal the tap from the control under the finger.
 *
 * On a narrow frame the plugin keeps the expanded sidebar as a drawer over the
 * conversation and closes it when something inside it is used. The dismissal
 * used to run on `pointerdown`: the press closed the drawer, the drawer took
 * the pressed control out from under the finger, and the browser then
 * dispatched the click to whatever had moved into that place — the
 * conversation behind the drawer. The control never ran, so a session row had
 * to be tapped twice before it opened, and the first tap looked like it did
 * nothing at all.
 *
 * The dismissal now waits for the `click`, which the browser dispatches while
 * the drawer is still in place, so the control handles its own tap first and
 * the drawer closes afterwards.
 *
 * Run with: `node --test tests/phone-drawer-dismiss.test.js`
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'client.js')

/**
 * The stand-in for `Element`: the plugin tests `target instanceof Element` and
 * walks the tree with `closest` and `contains`.
 */
class FakeElement {
  /**
   * @param {string} tagName - the element's tag.
   * @param {{attributes?: Record<string, string>}} [options] - initial attributes.
   */
  constructor(tagName, options = {}) {
    this.tagName = String(tagName).toUpperCase()
    this.attributes = { ...(options.attributes ?? {}) }
    /** @type {FakeElement[]} */
    this.children = []
    /** @type {FakeElement | null} */
    this.parent = null
    /** @type {(() => void) | null} */
    this.onClick = null
  }

  /** @param {string} name - attribute name. @returns {string | null} */
  getAttribute(name) {
    return this.attributes[name] ?? null
  }

  /** @param {string} name - attribute name. @param {string} value - value. */
  setAttribute(name, value) {
    this.attributes[name] = value
  }

  /** @param {string} name - attribute name. @returns {boolean} */
  hasAttribute(name) {
    return name in this.attributes
  }

  /** @param {string} name - attribute name. */
  removeAttribute(name) {
    delete this.attributes[name]
  }

  /** The first child, the way the shell's frame exposes its columns. */
  get firstElementChild() {
    return this.children[0] ?? null
  }

  /** @param {FakeElement} child - the child to add. @returns {FakeElement} */
  appendChild(child) {
    child.parent = this
    this.children.push(child)
    return child
  }

  /** @param {FakeElement | null} node - the node to look for. @returns {boolean} */
  contains(node) {
    for (let current = node; current !== null && current !== undefined; current = current.parent) {
      if (current === this) return true
    }
    return false
  }

  /** @param {string} selector - the selector the plugin uses. @returns {FakeElement | null} */
  closest(selector) {
    const wanted = selector.split(',').map((part) => part.trim())
    for (let current = this; current !== null; current = current.parent) {
      for (const part of wanted) {
        if (part === 'button' && current.tagName === 'BUTTON') return current
        if (part === '[role="button"]' && current.getAttribute('role') === 'button') return current
      }
    }
    return null
  }
}

/**
 * A frame with the shell's own columns: the sidebar column holds a session
 * row and the sidebar's own collapse control.
 */
function buildFrame() {
  const frame = new FakeElement('div', { attributes: { style: 'grid-template-columns: 280px minmax(0px, 1fr) minmax(0px, 0px)' } })
  const column = new FakeElement('div')
  const row = new FakeElement('div', { attributes: { 'data-row-key': 'session:abc', role: 'treeitem' } })
  const toggle = new FakeElement('button', { attributes: { 'aria-label': 'Collapse sidebar' } })
  column.appendChild(row)
  column.appendChild(toggle)
  frame.appendChild(column)
  return { frame, column, row, toggle }
}

/**
 * Build the browser environment the plugin runs in.
 *
 * @param {{innerWidth?: number}} [options] - the viewport the phone reports.
 */
function createEnvironment(options = {}) {
  const { frame, column, row, toggle } = buildFrame()
  /** @type {Map<string, {capture: Function[], bubble: Function[]}>} */
  const listeners = new Map()
  /** @type {(() => void)[]} */
  const timers = []
  // The shell's own toggle: the frame carries the collapsed marker while the
  // sidebar is closed, and the plugin's second scheduled collapse sees that
  // marker and does nothing.
  const layout = {
    toggles: 0,
    collapses: 0,
    toggleSidebar() {
      layout.toggles += 1
      if (frame.hasAttribute('data-sidebar-collapsed')) {
        frame.removeAttribute('data-sidebar-collapsed')
        return
      }
      frame.setAttribute('data-sidebar-collapsed', '')
      layout.collapses += 1
    },
  }

  const document = {
    head: {
      appendChild(node) {
        return node
      },
    },
    getElementById() {
      return null
    },
    createElement(tagName) {
      return new FakeElement(tagName)
    },
    querySelector(selector) {
      if (selector === '[style*="grid-template-columns"]') return frame
      return null
    },
    querySelectorAll(selector) {
      if (selector === 'button[aria-label]') return [toggle]
      return []
    },
    addEventListener(type, handler, capture) {
      const entry = listeners.get(type) ?? { capture: [], bubble: [] }
      if (capture === true) entry.capture.push(handler)
      else entry.bubble.push(handler)
      listeners.set(type, entry)
    },
    removeEventListener(type, handler) {
      const entry = listeners.get(type)
      if (entry === undefined) return
      entry.capture = entry.capture.filter((candidate) => candidate !== handler)
      entry.bubble = entry.bubble.filter((candidate) => candidate !== handler)
    },
    /**
     * Deliver an event the way the browser does: the capture listeners of the
     * document run first, then the target's own handler, then the bubble
     * listeners.
     *
     * @param {string} type - the event type.
     * @param {{target: FakeElement}} event - the event.
     */
    dispatch(type, event) {
      const entry = listeners.get(type)
      if (entry === undefined) return
      for (const handler of [...entry.capture]) handler(event)
      if (event.target.onClick !== null) event.target.onClick(event)
      for (const handler of [...entry.bubble]) handler(event)
    },
  }

  const window = {
    innerWidth: options.innerWidth ?? 390,
    __ModuleLoader__: { load() {} },
    setTimeout(callback) {
      timers.push(callback)
      return timers.length
    },
    requestAnimationFrame(callback) {
      timers.push(callback)
      return timers.length
    },
    addEventListener() {},
    removeEventListener() {},
    matchMedia(query) {
      return { matches: (options.innerWidth ?? 390) <= 1023, media: query }
    },
  }

  const originalElement = globalThis.Element
  const originalMutationObserver = globalThis.MutationObserver
  globalThis.Element = FakeElement
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  }

  return {
    document,
    window,
    frame,
    column,
    row,
    toggle,
    layout,
    /** The event types the document currently listens for. */
    listenerTypes() {
      return [...listeners.keys()]
    },
    /** Run every timer that was scheduled, including the ones they schedule. */
    flushTimers() {
      let pending = timers.splice(0, timers.length)
      while (pending.length > 0) {
        for (const callback of pending) callback()
        pending = timers.splice(0, timers.length)
      }
    },
    /** Put the DOM globals back the way they were. */
    restoreGlobals() {
      if (originalElement === undefined) delete globalThis.Element
      else globalThis.Element = originalElement
      if (originalMutationObserver === undefined) delete globalThis.MutationObserver
      else globalThis.MutationObserver = originalMutationObserver
    },
  }
}

/**
 * Load the plugin's browser half and apply it to a fake plugin context.
 *
 * The plugin stays installed: its effects own the listeners the test drives.
 * The returned disposer takes them down again.
 *
 * @param {ReturnType<typeof createEnvironment>} env - the environment.
 * @returns {Promise<() => void>} the disposer for the installed effects.
 */
async function loadPlugin(env) {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  const originalElement = globalThis.Element
  const originalMutationObserver = globalThis.MutationObserver
  /** @type {any} */
  let definition = null
  globalThis.window = env.window
  globalThis.document = env.document
  env.window.__ModuleLoader__ = {
    load(value) {
      definition = value
    },
  }
  /** @type {(() => void)[]} */
  const disposers = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    get(name) {
      if (name === 'layout') return env.layout
      if (name === 'uiWorkspace') {
        return {
          openSession() {},
          startSession() {},
          openWorkspace() {},
        }
      }
      return undefined
    },
    locale: {
      register() {},
      bind(namespace) {
        return (key) => `${namespace}.${key}`
      },
    },
    slots: {
      inject(_name, fn) {
        return fn()
      },
      register() {
        return () => {}
      },
    },
  }
  try {
    const source = await readFile(clientPath, 'utf8')
    const run = new Function('window', 'document', `${source}\n//# sourceURL=client.js`)
    run(env.window, env.document)
    const plugin = definition.factory((id) => {
      if (id === 'react') return { createElement: () => ({}) }
      throw new Error(`unexpected require: ${id}`)
    })
    plugin.apply(ctx)
    return () => {
      for (const dispose of disposers) dispose()
    }
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
    if (originalElement === undefined) delete globalThis.Element
    else globalThis.Element = originalElement
    if (originalMutationObserver === undefined) delete globalThis.MutationObserver
    else globalThis.MutationObserver = originalMutationObserver
  }
}

test('the drawer waits for the click, never for the press', async (t) => {
  const env = createEnvironment()
  const dispose = await loadPlugin(env)
  t.after(() => dispose())

  assert.ok(
    env.listenerTypes().includes('click'),
    'the dismissal must listen for the click',
  )
  assert.ok(
    !env.listenerTypes().includes('pointerdown'),
    'the dismissal must not listen for the press: it closes the drawer under the finger',
  )
})

test('a press inside the drawer leaves the drawer open', async (t) => {
  const env = createEnvironment()
  const dispose = await loadPlugin(env)
  t.after(() => dispose())

  env.document.dispatch('pointerdown', { target: env.row })
  env.flushTimers()

  assert.equal(env.layout.toggles, 0, 'a press must not close the drawer')
})

test('the tapped control handles its own tap before the drawer closes', async (t) => {
  const env = createEnvironment()
  const dispose = await loadPlugin(env)
  t.after(() => dispose())

  let handled = 0
  env.row.onClick = () => {
    handled += 1
  }

  env.document.dispatch('click', { target: env.row })

  assert.equal(handled, 1, 'the tapped control must receive the click')
  assert.equal(
    env.layout.toggles,
    0,
    'the drawer must not close while the tap is still being handled',
  )

  env.flushTimers()
  assert.equal(env.layout.collapses, 1, 'the drawer closes once the tap is handled')
})

test('the sidebar\'s own collapse control is not mistaken for a dismissal', async (t) => {
  const env = createEnvironment()
  const dispose = await loadPlugin(env)
  t.after(() => dispose())

  env.document.dispatch('click', { target: env.toggle })
  env.flushTimers()

  assert.equal(env.layout.toggles, 0, 'the toggle must stay a toggle')
})

test('a wide frame keeps the sidebar as a column', async (t) => {
  const env = createEnvironment({ innerWidth: 1440 })
  const dispose = await loadPlugin(env)
  t.after(() => dispose())

  env.document.dispatch('click', { target: env.row })
  env.flushTimers()

  assert.equal(env.layout.toggles, 0, 'a desktop frame must not close the sidebar')
})
