/**
 * The shared conversation UI of the browser half.
 *
 * The owner shares the conversation that is open: a button in the
 * conversation header opens a dialog, the dialog creates a record with its
 * own link, its own 8-digit passcode and its own permission, and the
 * settings page lists every record.
 *
 * The test drives the real browser half: the file is loaded with a fake
 * window and a fake document, its plugin factory runs against a React
 * stand-in, and the Host route `/api/remote-control` is answered by a
 * recorder.
 *
 * Run with: `node --test tests/share-client.test.js`
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'client.js')

const NAMESPACE = 'remote-control'
const ROUTE = '/api/remote-control'

/** Let the promises of the page settle. */
const tick = () => new Promise((resolve) => setImmediate(resolve))

/* ------------------------------------------------------------- react stand-in */

/**
 * A React stand-in with the hooks the browser half uses.
 *
 * The hooks are real enough for the plugin: the state survives a render,
 * a state change renders the tree again, and the effects run once per
 * change of their dependencies.
 *
 * @returns {any}
 */
function fakeReact() {
  const cells = new Map()
  let context = null

  /** Whether two dependency lists are the same. */
  const sameDeps = (left, right) => {
    if (left === undefined || right === undefined) return false
    if (left.length !== right.length) return false
    return left.every((value, index) => Object.is(value, right[index]))
  }

  const host = {
    begin(path) {
      const list = cells.get(path) ?? []
      cells.set(path, list)
      context = { path, index: 0, cells: list }
    },
    end() {
      context = null
    },
    useState(initial) {
      const index = context.index++
      const cell = context.cells[index] ?? (context.cells[index] = { ready: false, value: undefined })
      if (cell.ready !== true) {
        cell.value = typeof initial === 'function' ? initial() : initial
        cell.ready = true
      }
      const setValue = (next) => {
        const value = typeof next === 'function' ? next(cell.value) : next
        if (Object.is(value, cell.value)) return
        cell.value = value
        host.renderer?.scheduleRender()
      }
      return [cell.value, setValue]
    },
    useEffect(effect, deps) {
      const index = context.index++
      const cell = context.cells[index] ?? (context.cells[index] = { ready: false, deps: undefined, cleanup: undefined })
      if (cell.ready !== true || sameDeps(cell.deps, deps) !== true) {
        cell.deps = deps
        cell.ready = true
        if (typeof cell.cleanup === 'function') cell.cleanup()
        cell.cleanup = effect()
      }
    },
    useCallback(callback, deps) {
      const index = context.index++
      const cell = context.cells[index] ?? (context.cells[index] = { ready: false, deps: undefined, value: undefined })
      if (cell.ready !== true || sameDeps(cell.deps, deps) !== true) {
        cell.deps = deps
        cell.value = callback
        cell.ready = true
      }
      return cell.value
    },
    useMemo(factory, deps) {
      return host.useCallback(factory, deps)()
    },
    useRef(initial) {
      const index = context.index++
      const cell = context.cells[index] ?? (context.cells[index] = { current: initial })
      return cell
    },
  }

  const react = {
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { type, props: merged }
    },
    useState: (initial) => host.useState(initial),
    useEffect: (effect, deps) => host.useEffect(effect, deps),
    useCallback: (callback, deps) => host.useCallback(callback, deps),
    useMemo: (factory, deps) => host.useMemo(factory, deps),
    useRef: (initial) => host.useRef(initial),
  }

  return { react, host }
}

/**
 * Render a tree of elements and keep it in step with its state.
 */
class TestRenderer {
  /**
   * @param {any} react the React stand-in
   */
  constructor(react) {
    this.react = react
    this.element = null
    this.root = null
    this.rendering = false
    this.dirty = false
  }

  /**
   * Render one element.
   *
   * @param {any} element
   * @returns {any} the rendered tree
   */
  render(element) {
    this.element = element
    this.run()
    return this.root
  }

  /**
   * Render the tree until it settles.
   *
   * @returns {void}
   */
  run() {
    let rounds = 0
    while (true) {
      this.dirty = false
      this.rendering = true
      this.root = this.renderNode(this.element, 'root')
      this.rendering = false
      if (this.dirty !== true) return
      rounds++
      if (rounds > 25) throw new Error('the render does not settle')
    }
  }

  /**
   * Render the tree again after a state change.
   *
   * @returns {void}
   */
  scheduleRender() {
    if (this.rendering === true) {
      this.dirty = true
      return
    }
    this.run()
  }

  /**
   * Render one node.
   *
   * @param {any} node
   * @param {string} path
   * @returns {any}
   */
  renderNode(node, path) {
    if (node === null || node === undefined || node === false || node === true) return null
    if (typeof node === 'string' || typeof node === 'number') {
      return { type: '#text', text: String(node), props: {}, children: [] }
    }
    if (Array.isArray(node)) {
      const rendered = []
      node.forEach((child, index) => {
        const child_ = this.renderNode(child, `${path}.${index}`)
        if (Array.isArray(child_)) rendered.push(...child_)
        else if (child_ !== null) rendered.push(child_)
      })
      return rendered
    }
    if (typeof node.type === 'function') {
      const key = `${path}@${node.type.name || 'fn'}`
      this.react.__host.begin(key)
      let result
      try {
        result = node.type(node.props)
      } finally {
        this.react.__host.end()
      }
      return this.renderNode(result, `${key}>`)
    }
    const children = this.renderNode(node.props.children, `${path}/`)
    const list = Array.isArray(children) ? children : (children === null ? [] : [children])
    return { type: node.type, props: node.props, children: list }
  }
}

/* ------------------------------------------------------------------- helpers */

/**
 * The markup of a rendered tree.
 *
 * @param {any} node
 * @returns {string}
 */
function toMarkup(node) {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(toMarkup).join('')
  if (typeof node === 'string') return node
  if (node.type === '#text') return node.text
  if (node.type === 'style') return ''
  const attributes = Object.entries(node.props ?? {})
    .filter(([name, value]) => name !== 'children' && name !== 'dangerouslySetInnerHTML' && typeof value !== 'function')
    .map(([name, value]) => ` ${name}="${String(value)}"`)
    .join('')
  const inner = `${node.props?.dangerouslySetInnerHTML?.__html ?? ''}${node.children.map(toMarkup).join('')}`
  return `<${node.type}${attributes}>${inner}</${node.type}>`
}

/**
 * Every node of a tree that carries an attribute.
 *
 * @param {any} node
 * @param {string} name
 * @returns {any[]}
 */
function findAll(node, name) {
  const found = []
  const walk = (current) => {
    if (current === null || current === undefined) return
    if (Array.isArray(current)) {
      current.forEach(walk)
      return
    }
    if (current.type === '#text') return
    if (current.props?.[name] !== undefined) found.push(current)
    current.children.forEach(walk)
  }
  walk(node)
  return found
}

/**
 * The first node of a tree that carries an attribute.
 *
 * @param {any} node
 * @param {string} name
 * @returns {any}
 */
function findByAttr(node, name) {
  const found = findAll(node, name)
  return found.length > 0 ? found[0] : null
}

/**
 * The CSS the tree carries in its style elements.
 *
 * @param {any} node
 * @returns {string}
 */
function styleOf(node) {
  const parts = []
  const walk = (current) => {
    if (current === null || current === undefined) return
    if (Array.isArray(current)) {
      current.forEach(walk)
      return
    }
    if (current.type === '#text') return
    const css = current.props?.dangerouslySetInnerHTML?.__html
    if (typeof css === 'string') parts.push(css)
    current.children.forEach(walk)
  }
  walk(node)
  return parts.join('\n')
}

/**
 * A window that answers what the browser half asks of it.
 *
 * The timers it hands out never keep the process alive: the page owns them,
 * not the test.
 *
 * @returns {any}
 */
function fakeWindow() {
  const timers = new Set()
  const window = {
    __ModuleLoader__: { load() {} },
    innerWidth: 1440,
    innerHeight: 900,
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      timers.add(timer)
      return timer
    },
    clearTimeout: (timer) => {
      timers.delete(timer)
      clearTimeout(timer)
    },
    setInterval: (fn, ms) => {
      const timer = setInterval(fn, ms)
      timer.unref?.()
      timers.add(timer)
      return timer
    },
    clearInterval: (timer) => {
      timers.delete(timer)
      clearInterval(timer)
    },
    requestAnimationFrame: (fn) => {
      const timer = setTimeout(fn, 0)
      timer.unref?.()
      timers.add(timer)
      return timer
    },
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false }),
    open() {},
    confirm: () => true,
  }
  window.timers = timers
  return window
}

/**
 * A document that records the styles the browser half injects.
 *
 * @returns {any}
 */
function fakeDocument() {
  const styles = []
  return {
    styles,
    body: { style: { overflow: '' } },
    activeElement: null,
    head: {
      appendChild(node) {
        if (node.tagName === 'STYLE') styles.push(node)
        return node
      },
    },
    getElementById: (id) => styles.find((style) => style.id === id) ?? null,
    createElement: (tagName) => ({
      tagName: String(tagName).toUpperCase(),
      id: '',
      textContent: '',
      setAttribute() {},
      remove() {},
    }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  }
}

/**
 * A stream of frames, as the browser reads it.
 *
 * The room of the owner is a long answer that never ends: the test pushes
 * the frames into it and the widget reads them as they arrive.
 *
 * @returns {any}
 */
function fakeStream() {
  const encoder = new TextEncoder()
  /** @type {string[]} */
  const chunks = []
  /** @type {((chunk: any) => void)[]} */
  const waiters = []
  const wake = () => {
    for (const waiter of waiters.splice(0)) {
      if (chunks.length > 0) waiter({ done: false, value: encoder.encode(chunks.shift()) })
      else waiter({ done: true, value: undefined })
    }
  }
  return {
    /**
     * Hand one frame to the reader.
     *
     * @param {string} text
     */
    push(text) {
      chunks.push(text)
      wake()
    },
    getReader() {
      return {
        read() {
          if (chunks.length > 0) {
            return Promise.resolve({ done: false, value: encoder.encode(chunks.shift()) })
          }
          // The reader waits for the next frame. It does not poll: a poll
          // would keep the test running after it is done.
          return new Promise((resolve) => { waiters.push(resolve) })
        },
        async cancel() {},
      }
    },
  }
}

/**
 * A Host route that answers the methods of the shared conversation API.
 *
 * @param {Record<string, any>} routes the answer of every method
 * @returns {any}
 */
function fakeFetch(routes) {
  const calls = []
  /** @type {Map<string, any>} */
  const streams = new Map()
  const impl = async (url, init) => {
    const raw = init?.body
    if (raw === undefined) {
      // A request without a body: the room of the owner, as a stream.
      calls.push({ url, method: 'GET', payload: undefined })
      const key = String(url)
      let stream = streams.get(key)
      if (stream === undefined) {
        stream = fakeStream()
        streams.set(key, stream)
      }
      return { status: 200, ok: true, body: stream }
    }
    const body = JSON.parse(raw)
    calls.push({ url, method: body.method, payload: body.payload })
    const route = routes[body.method]
    if (route === undefined) {
      return {
        status: 200,
        json: async () => ({ ok: false, error: { code: 'unknown-method', message: `unknown method ${body.method}` } }),
      }
    }
    const answer = typeof route === 'function' ? await route(body.payload, calls.length) : route
    return { status: 200, json: async () => answer }
  }
  impl.calls = calls
  impl.streams = streams
  /**
   * Hand one frame of the room of the owner to the browser.
   *
   * @param {any} frame
   */
  impl.push = (frame) => {
    for (const [url, stream] of streams) {
      if (!url.includes('/presence')) continue
      stream.push(`data: ${JSON.stringify(frame)}\n\n`)
    }
  }
  return impl
}

/**
 * The session store of the page.
 *
 * @param {Record<string, any>} byId the sessions of the list
 * @returns {any}
 */
function fakeSessions(byId) {
  const ids = Object.keys(byId)
  return (selector) => selector({ ids, byId, phase: 'ready' })
}

/**
 * Load the browser half and run its plugin factory.
 *
 * @param {{routes?: Record<string, any>, language?: string, sessions?: Record<string, any>}} options
 * @returns {Promise<any>}
 */
async function loadPlugin(options = {}) {
  const language = options.language ?? 'en'
  const source = await readFile(clientPath, 'utf8')
  const window = fakeWindow()
  const document = fakeDocument()
  let factory = null
  window.__ModuleLoader__ = {
    load(spec) {
      factory = spec.factory
    },
  }
  const run = new Function('window', 'document', `${source}\n//# sourceURL=client.js`)
  run(window, document)
  assert.equal(typeof factory, 'function', 'the browser half must register a factory')

  const { react, host } = fakeReact()
  const portals = []
  const plugin = factory((specifier) => {
    if (specifier === 'react') return react
    if (specifier === 'react-dom') {
      return {
        createPortal(children, target) {
          portals.push({ children, target })
          return children
        },
      }
    }
    throw new Error(`the browser half asked for the module "${specifier}"`)
  })
  react.__host = host

  const dictionaries = {}
  const registrations = []
  const injected = []
  const ctx = {
    locale: {
      register(namespace, dictionary) {
        dictionaries[namespace] = dictionary
        return () => {}
      },
      bind(namespace) {
        // The real locale fills the words of a template: the count of the
        // guests and the name of the one that writes go into the sentence.
        return (key, params) => {
          const template = dictionaries[namespace]?.[language]?.[key] ?? key
          if (params === undefined) return template
          return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
        }
      },
    },
    slots: {
      inject(name, register) {
        injected.push(name)
        return register()
      },
      register(registration, component) {
        registrations.push({ registration, component })
        return () => {}
      },
    },
    effect(effect) {
      return effect()
    },
    get: () => undefined,
    provide: () => {},
    on: () => {},
  }
  // The browser half starts a timer of its own when it marks the controls of
  // a phone. The page owns that timer, so it must not keep the test alive.
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const intervals = new Set()
  globalThis.setInterval = (fn, ms, ...rest) => {
    const timer = originalSetInterval(fn, ms, ...rest)
    timer.unref?.()
    intervals.add(timer)
    return timer
  }
  globalThis.clearInterval = (timer) => {
    intervals.delete(timer)
    originalClearInterval(timer)
  }

  plugin.apply(ctx)

  const renderer = new TestRenderer(react)
  host.renderer = renderer

  const originalFetch = globalThis.fetch
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const fetcher = fakeFetch(options.routes ?? {})
  globalThis.fetch = fetcher
  setNavigator({ clipboard: { writeText: async () => {} } })
  try {
    const t = ctx.locale.bind(NAMESPACE)
    return {
      ctx,
      react,
      renderer,
      window,
      document,
      fetch: fetcher,
      t,
      registrations,
      injected,
      dictionaries,
      portals,
      sessions: options.sessions ?? { s1: { id: 's1', displayTitle: 'Planning the share' } },
      restore() {
        globalThis.fetch = originalFetch
        globalThis.setInterval = originalSetInterval
        globalThis.clearInterval = originalClearInterval
        for (const timer of intervals) originalClearInterval(timer)
        for (const timer of window.timers) clearInterval(timer)
        if (originalNavigator === undefined) delete globalThis.navigator
        else Object.defineProperty(globalThis, 'navigator', originalNavigator)
      },
    }
  } catch (error) {
    globalThis.fetch = originalFetch
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    for (const timer of intervals) originalClearInterval(timer)
    for (const timer of window.timers) clearInterval(timer)
    if (originalNavigator === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', originalNavigator)
    throw error
  }
}

/**
 * Replace the navigator of the page.
 *
 * Node owns a navigator of its own that only has a getter, so the property
 * is defined again instead of assigned.
 *
 * @param {any} value
 * @returns {void}
 */
function setNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true })
}

/**
 * The component the plugin registered in a slot.
 *
 * @param {any} plugin
 * @param {string} slot
 * @returns {any}
 */
function componentOf(plugin, slot) {
  const entry = plugin.registrations.find((row) => row.registration.name === slot)
  assert.ok(entry, `the plugin must register something in ${slot}`)
  return entry
}

/**
 * The widget that shows who is in the shared conversation.
 *
 * @param {any} plugin
 * @returns {any}
 */
function presenceOf(plugin) {
  const entry = plugin.registrations.find((row) => row.registration.id === 'remote-control-presence')
  assert.ok(entry, 'the plugin must show the presence of the guests')
  return entry
}

/**
 * Render the widget that shows who is in the shared conversation.
 *
 * @param {any} plugin
 * @returns {any}
 */
function renderPresence(plugin) {
  const entry = presenceOf(plugin)
  const useSessions = fakeSessions(plugin.sessions)
  return plugin.renderer.render(plugin.react.createElement(entry.component, {
    sessionId: 's1',
    useSessions,
    t: plugin.t,
  }))
}

/**
 * Render the share button of the conversation header.
 *
 * @param {any} plugin
 * @returns {any}
 */
function renderHeader(plugin) {
  const entry = componentOf(plugin, 'conversation.session.header.utilities')
  const useSessions = fakeSessions(plugin.sessions)
  return plugin.renderer.render(plugin.react.createElement(entry.component, {
    sessionId: 's1',
    useSessions,
    t: plugin.t,
  }))
}

/**
 * Render the settings page of the plugin.
 *
 * @param {any} plugin
 * @returns {any}
 */
function renderSettings(plugin) {
  const entry = componentOf(plugin, 'settings.section')
  return plugin.renderer.render(plugin.react.createElement(entry.component, { t: plugin.t }))
}

/* --------------------------------------------------------------------- tests */

test('the conversation header carries the share button', async () => {
  const plugin = await loadPlugin()
  try {
    assert.ok(
      plugin.injected.includes('conversation.session.header.utilities'),
      'the plugin must register in the utilities of the conversation header',
    )
    const entry = componentOf(plugin, 'conversation.session.header.utilities')
    assert.equal(entry.registration.id, 'remote-control-share')
    const markup = toMarkup(renderHeader(plugin))
    assert.match(markup, /data-rc-share-open="true"/)
    assert.match(markup, /Share this conversation/)
  } finally {
    plugin.restore()
  }
})

test('the shared conversation works on a phone', async () => {
  const plugin = await loadPlugin()
  try {
    const css = plugin.document.getElementById('dsh-remote-control-share-styles')?.textContent ?? ''
    assert.ok(css.length > 0, 'the share styles must be installed in the document head')
    // The narrow layout of the plugin: one column and thumb sized targets.
    assert.match(css, /@media \(max-width: 1023px\)/)
    assert.match(css, /\.rc-share-row\{[^}]*flex-direction:column/s)
    assert.match(css, /\.rc-share-action\{[^}]*min-height:44px/s)
    assert.match(css, /\.rc-share-input\{[^}]*min-height:44px/s)
    assert.match(css, /\.rc-share-choice\{[^}]*min-height:44px/s)
    // The button of the narrow header keeps its glyph and its name, the way
    // the app's own share action does.
    assert.match(css, /\.rc-share-button \.rc-share-label\{[^}]*display:inline/s)
    assert.match(css, /\.rc-share-button\{[^}]*min-height:44px/s)
  } finally {
    plugin.restore()
  }
})

test('the share dialog asks for a title and a permission', async () => {
  const plugin = await loadPlugin()
  try {
    const root = renderHeader(plugin)
    const open = findByAttr(root, 'data-rc-share-open')
    assert.ok(open, 'the header must carry the share button')
    open.props.onClick()
    const dialog = findByAttr(plugin.renderer.root, 'data-rc-share-overlay')
    assert.ok(dialog, 'the button must open the share dialog')

    const title = findByAttr(plugin.renderer.root, 'data-rc-share-title')
    assert.ok(title, 'the dialog must ask for a title')
    // The title of the conversation is the default.
    assert.equal(title.props.value, 'Planning the share')

    const choices = findAll(plugin.renderer.root, 'data-rc-share-permission-choice')
    assert.equal(choices.length, 2, 'the dialog must offer the two permissions')
    assert.deepEqual(choices.map((choice) => choice.props.value), ['read', 'write'])
    assert.equal(choices[0].props.checked, true, 'read-only is the default')

    assert.ok(findByAttr(plugin.renderer.root, 'data-rc-share-generate'), 'the dialog must have a generate button')
  } finally {
    plugin.restore()
  }
})

test('the share dialog is a viewport modal mounted outside the header', async () => {
  const plugin = await loadPlugin()
  try {
    const root = renderHeader(plugin)
    findByAttr(root, 'data-rc-share-open').props.onClick()

    assert.ok(
      plugin.portals.some((portal) => portal.target === plugin.document.body),
      'the dialog must portal to document.body, not remain inside the header',
    )
    const overlay = findByAttr(plugin.renderer.root, 'data-rc-share-overlay')
    assert.ok(overlay, 'the overlay must cover the viewport')
    assert.equal(overlay.props.className, 'rc-share-overlay')
    const modal = overlay.children[0]
    assert.equal(modal.props.className, 'rc-share-modal')
    assert.equal(modal.props.role, 'dialog')
    assert.equal(modal.props['aria-modal'], 'true')
    assert.equal(plugin.document.body.style.overflow, 'hidden', 'the page behind the modal is locked')
    assert.equal(
      plugin.document.styles.filter((style) => style.id === 'dsh-remote-control-share-styles').length,
      1,
      'the share stylesheet is installed once in the document head',
    )
  } finally {
    plugin.restore()
  }
})

test('creating a share calls shareCreate with the session, the permission and the title', async () => {
  const plugin = await loadPlugin({
    routes: {
      shareCreate: { ok: true, value: { id: 'sh1', link: 'https://relay.example.com/s/sh1', passcode: '48213577', permission: 'write', createdAt: '2026-11-01T08:00:00.000Z' } },
    },
  })
  try {
    const root = renderHeader(plugin)
    findByAttr(root, 'data-rc-share-open').props.onClick()

    const write = findAll(plugin.renderer.root, 'data-rc-share-permission-choice')
      .find((choice) => choice.props.value === 'write')
    write.props.onChange()
    const title = findByAttr(plugin.renderer.root, 'data-rc-share-title')
    title.props.onChange({ target: { value: '  The share dialog  ' } })
    findByAttr(plugin.renderer.root, 'data-rc-share-generate').props.onClick()
    await tick()

    const call = plugin.fetch.calls.find((row) => row.method === 'shareCreate')
    assert.ok(call, 'the dialog must call shareCreate')
    assert.equal(call.url, ROUTE)
    assert.deepEqual(call.payload, {
      sessionId: 's1',
      permission: 'write',
      title: 'The share dialog',
    })
  } finally {
    plugin.restore()
  }
})

test('the created share shows its link, its passcode, its permission and a QR code', async () => {
  const plugin = await loadPlugin({
    routes: {
      shareCreate: { ok: true, value: { id: 'sh1', link: 'https://relay.example.com/s/sh1', passcode: '48213577', permission: 'read', createdAt: 1793520000000 } },
    },
  })
  try {
    const root = renderHeader(plugin)
    findByAttr(root, 'data-rc-share-open').props.onClick()
    findByAttr(plugin.renderer.root, 'data-rc-share-generate').props.onClick()
    await tick()

    const markup = toMarkup(plugin.renderer.root)
    assert.match(markup, /https:\/\/relay\.example\.com\/s\/sh1/)
    assert.match(markup, /48213577/)
    assert.match(markup, /data-rc-share-permission="read"/)
    assert.doesNotMatch(markup, /Created: —/, 'an epoch-millisecond creation time is formatted too')
    assert.match(markup, /<svg/)
    // The QR code is a real one: it has the three finder patterns.
    assert.match(markup, /M0 0h1v1h-1z/)
  } finally {
    plugin.restore()
  }
})

test('without a relay the dialog says that there is no public link', async () => {
  const plugin = await loadPlugin({
    routes: {
      shareCreate: { ok: true, value: { id: 'sh1', link: null, passcode: '48213577', permission: 'read', createdAt: '2026-11-01T08:00:00.000Z' } },
    },
  })
  try {
    const root = renderHeader(plugin)
    findByAttr(root, 'data-rc-share-open').props.onClick()
    findByAttr(plugin.renderer.root, 'data-rc-share-generate').props.onClick()
    await tick()

    const markup = toMarkup(plugin.renderer.root)
    assert.match(markup, /data-rc-share-no-relay="true"/)
    assert.match(markup, /No relay is configured/)
    // The passcode is still shown: the record exists.
    assert.match(markup, /48213577/)
    assert.equal(findByAttr(plugin.renderer.root, 'data-rc-share-link'), null)
  } finally {
    plugin.restore()
  }
})

test('the settings page lists the shared conversations', async () => {
  const plugin = await loadPlugin({
    routes: {
      status: { ok: true, value: { enabled: false, devices: [], phones: [] } },
      shareList: {
        ok: true,
        value: {
          shares: [
            {
              id: 'sh1',
              sessionId: 's1',
              title: 'The first share',
              permission: 'read',
              passcode: '48213577',
              createdAt: '2026-11-01T08:00:00.000Z',
              lastUsedAt: null,
              revokedAt: null,
              link: 'https://relay.example.com/s/sh1',
              status: 'active',
            },
            {
              id: 'sh2',
              sessionId: 's1',
              title: 'The second share',
              permission: 'write',
              passcode: '11223344',
              createdAt: '2026-11-02T08:00:00.000Z',
              lastUsedAt: null,
              revokedAt: null,
              link: 'https://relay.example.com/s/sh2',
              status: 'disabled',
            },
          ],
        },
      },
    },
  })
  try {
    renderSettings(plugin)
    await tick()

    const rows = findAll(plugin.renderer.root, 'data-rc-share-row')
    assert.equal(rows.length, 2, 'the list must show every share')
    const markup = toMarkup(plugin.renderer.root)
    assert.match(markup, /The first share/)
    assert.match(markup, /The second share/)
    assert.match(markup, /https:\/\/relay\.example\.com\/s\/sh1/)
    assert.match(markup, /48213577/)
    assert.match(markup, /11223344/)
    assert.match(markup, /data-rc-share-permission="write"/)
    // The disabled share shows its status.
    assert.match(markup, /data-rc-share-status="disabled"/)
    assert.match(markup, /Disabled/)
    // Only the active share can be disabled again.
    assert.equal(findAll(plugin.renderer.root, 'data-rc-share-disable').length, 1)
  } finally {
    plugin.restore()
  }
})

test('the list disables and deletes a share', async () => {
  const plugin = await loadPlugin({
    routes: {
      status: { ok: true, value: { enabled: false, devices: [], phones: [] } },
      shareList: {
        ok: true,
        value: {
          shares: [{
            id: 'sh1',
            sessionId: 's1',
            title: 'The first share',
            permission: 'read',
            passcode: '48213577',
            createdAt: '2026-11-01T08:00:00.000Z',
            link: 'https://relay.example.com/s/sh1',
            status: 'active',
          }],
        },
      },
      shareDisable: { ok: true, value: { ok: true } },
      shareDelete: { ok: true, value: { ok: true } },
    },
  })
  try {
    renderSettings(plugin)
    await tick()

    findByAttr(plugin.renderer.root, 'data-rc-share-disable').props.onClick()
    await tick()
    const disable = plugin.fetch.calls.find((row) => row.method === 'shareDisable')
    assert.ok(disable, 'the list must disable a share')
    assert.deepEqual(disable.payload, { id: 'sh1' })

    findByAttr(plugin.renderer.root, 'data-rc-share-delete').props.onClick()
    await tick()
    const remove = plugin.fetch.calls.find((row) => row.method === 'shareDelete')
    assert.ok(remove, 'the list must delete a share')
    assert.deepEqual(remove.payload, { id: 'sh1' })
  } finally {
    plugin.restore()
  }
})

test('the list copies the link and the passcode of a share', async () => {
  const written = []
  const plugin = await loadPlugin({
    routes: {
      status: { ok: true, value: { enabled: false, devices: [], phones: [] } },
      shareList: {
        ok: true,
        value: {
          shares: [{
            id: 'sh1',
            sessionId: 's1',
            title: 'The first share',
            permission: 'read',
            passcode: '48213577',
            createdAt: '2026-11-01T08:00:00.000Z',
            link: 'https://relay.example.com/s/sh1',
            status: 'active',
          }],
        },
      },
    },
  })
  try {
    setNavigator({ clipboard: { writeText: async (text) => { written.push(text) } } })
    renderSettings(plugin)
    await tick()

    findByAttr(plugin.renderer.root, 'data-rc-share-copy-link').props.onClick()
    await tick()
    findByAttr(plugin.renderer.root, 'data-rc-share-copy-passcode').props.onClick()
    await tick()

    assert.deepEqual(written, ['https://relay.example.com/s/sh1', '48213577'])
  } finally {
    plugin.restore()
  }
})

test('sharing again adds another record and leaves the earlier one alone', async () => {
  const shares = []
  const plugin = await loadPlugin({
    routes: {
      status: { ok: true, value: { enabled: false, devices: [], phones: [] } },
      shareList: { ok: true, value: { shares } },
      shareCreate: (payload) => {
        const record = {
          id: `sh${shares.length + 1}`,
          sessionId: payload.sessionId,
          title: payload.title ?? 'Planning the share',
          permission: payload.permission,
          passcode: `4821357${shares.length}`,
          createdAt: '2026-11-01T08:00:00.000Z',
          link: `https://relay.example.com/s/sh${shares.length + 1}`,
          status: 'active',
        }
        shares.push(record)
        return { ok: true, value: record }
      },
    },
  })
  try {
    renderSettings(plugin)
    await tick()

    // The same conversation is shared twice: the second share is another
    // record with its own link and its own permission.
    for (const permission of ['read', 'write']) {
      const root = renderHeader(plugin)
      findByAttr(root, 'data-rc-share-open').props.onClick()
      // After a result the next share's settings are folded away; open them
      // before choosing a different permission for the next link.
      findByAttr(plugin.renderer.root, 'data-rc-share-edit-next')?.props.onClick()
      const choice = findAll(plugin.renderer.root, 'data-rc-share-permission-choice')
        .find((row) => row.props.value === permission)
      choice.props.onChange()
      findByAttr(plugin.renderer.root, 'data-rc-share-generate').props.onClick()
      await tick()
    }

    const created = plugin.fetch.calls.filter((row) => row.method === 'shareCreate')
    assert.equal(created.length, 2, 'every share is a record of its own')
    assert.equal(created[0].payload.permission, 'read')
    assert.equal(created[1].payload.permission, 'write')
    assert.equal(shares.length, 2)
    assert.notEqual(shares[0].link, shares[1].link)
    assert.notEqual(shares[0].passcode, shares[1].passcode)

    // The dialog shows both records, each with its own link.
    const records = findAll(plugin.renderer.root, 'data-rc-share-record')
    assert.equal(records.length, 2, 'the dialog keeps both records')
    const dialog = toMarkup(plugin.renderer.root)
    assert.match(dialog, /https:\/\/relay\.example\.com\/s\/sh1/)
    assert.match(dialog, /https:\/\/relay\.example\.com\/s\/sh2/)

    // The list shows both records.
    renderSettings(plugin)
    await tick()
    assert.equal(findAll(plugin.renderer.root, 'data-rc-share-row').length, 2)
  } finally {
    plugin.restore()
  }
})

test('the copy of the shared conversation exists in both languages', async () => {
  const english = await loadPlugin({ language: 'en' })
  const chinese = await loadPlugin({ language: 'zh' })
  try {
    const en = toMarkup(renderHeader(english))
    assert.match(en, /Share this conversation/)
    const zh = toMarkup(renderHeader(chinese))
    assert.match(zh, /分享此会话/)

    // Every key of the English dictionary has a Chinese counterpart, and the
    // other way around.
    const dictionary = english.dictionaries[NAMESPACE]
    assert.ok(dictionary, 'the plugin must register its dictionary')
    assert.deepEqual(
      Object.keys(dictionary.en).sort(),
      Object.keys(dictionary.zh).sort(),
      'both languages must carry the same keys',
    )
    for (const key of ['shareButton', 'shareGenerate', 'sharePermissionRead', 'sharePermissionWrite', 'shareNoRelay', 'shareListTitle', 'shareDisable', 'shareDelete']) {
      assert.ok(dictionary.en[key], `the English copy must carry ${key}`)
      assert.ok(dictionary.zh[key], `the Chinese copy must carry ${key}`)
    }
  } finally {
    english.restore()
    chinese.restore()
  }
})

test('the locale files carry the copy of the shared conversation', async () => {
  const en = JSON.parse(await readFile(path.join(here, '..', 'locale', 'en.json'), 'utf8'))
  const zh = JSON.parse(await readFile(path.join(here, '..', 'locale', 'zh.json'), 'utf8'))
  assert.ok(en.share, 'the English locale must describe the sharing')
  assert.ok(zh.share, 'the Chinese locale must describe the sharing')
  assert.deepEqual(Object.keys(en.share).sort(), Object.keys(zh.share).sort())
  assert.ok(en.share.title.length > 0)
  assert.ok(zh.share.title.length > 0)
})

test('the QR code of a share link is a real QR code', async () => {
  const plugin = await loadPlugin()
  try {
    const qrMatrix = plugin.window[Symbol.for('dsh.remote-control.qr-matrix')]
    assert.equal(typeof qrMatrix, 'function', 'the QR encoder must be published')
    const code = qrMatrix('https://relay.example.com/s/sh1')
    assert.ok(code, 'the link must fit into a QR code')
    assert.equal(code.size, 17 + 4 * code.version)
    assert.ok(code.version >= 1 && code.version <= 10)
    // The finder patterns are dark in their corners.
    assert.equal(code.modules[0][0], true)
    assert.equal(code.modules[0][6], true)
    assert.equal(code.modules[6][0], true)
    assert.equal(code.modules[3][3], true)
    // The separator around the top left finder is light.
    assert.equal(code.modules[0][7], false)
    assert.equal(code.modules[7][0], false)
  } finally {
    plugin.restore()
  }
})

test('the bundle survives being executed twice in one page', async () => {
  const source = await readFile(clientPath, 'utf8')

  // A hot reload runs the bundle again. The module system refuses the second
  // factory under the same id, and the plugin is alive: the factory from the
  // first run is still the live one. The bundle must not turn that refusal
  // into a broken plugin.
  const duplicate = new Error('client-modules: duplicate factory registration for "@local/remote-control" (bundle executed twice without invalidate?)')
  const window = fakeWindow()
  window.__ModuleLoader__ = {
    load() {
      throw duplicate
    },
  }
  const run = new Function('window', 'document', `${source}\n//# sourceURL=client.js`)
  assert.doesNotThrow(() => run(window, fakeDocument()), 'a duplicate registration is not a failure')

  // Every other refusal is a real failure and must surface.
  const window2 = fakeWindow()
  window2.__ModuleLoader__ = {
    load() {
      throw new Error('the module system is broken')
    },
  }
  const run2 = new Function('window', 'document', `${source}\n//# sourceURL=client.js`)
  assert.throws(() => run2(window2, fakeDocument()), /the module system is broken/)
})

test('the bundle can be executed twice in the same page scope', async () => {
  // The host loads a plugin bundle as a classic script, and a hot reload runs
  // it again in the same page. Top-level `const` and `let` of a classic script
  // live in the page's global lexical scope, so a second execution would stop
  // at "Identifier ... has already been declared" — before the bundle ever
  // registers itself, and the host then reports the plugin as loaded but not
  // registered.
  const source = await readFile(clientPath, 'utf8')
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  globalThis.window = fakeWindow()
  globalThis.document = fakeDocument()
  try {
    assert.doesNotThrow(() => vm.runInThisContext(source), 'the first execution registers the bundle')
    assert.doesNotThrow(() => vm.runInThisContext(source), 'a second execution in the same page must not throw')
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
  }
})

test('the history of a conversation can delete a share', async () => {
  const plugin = await loadPlugin()
  try {
    const source = await readFile(path.join(here, '..', 'client.js'), 'utf8')
    // The panel of the history carries a delete for every share, and the
    // delete asks first: it takes the link and the passcode away for good.
    assert.match(source, /data-rc-share-history-delete/, 'the history carries a delete')
    assert.match(source, /call\('shareDelete'/, 'the delete removes the record')
    assert.match(source, /shareDeleteConfirm/, 'the delete asks first')
    assert.match(source, /setHistory\(\(current\) => current\.filter/, 'the row leaves the panel')
  } finally {
    plugin.restore()
  }
})

/* The room of the owner --------------------------------------------------- */

test('the conversation header carries the people who are in the shared conversation', async () => {
  const plugin = await loadPlugin()
  try {
    const entry = presenceOf(plugin)
    assert.equal(entry.registration.name, 'conversation.session.header.utilities')
    // The widget sits past the button that shares the conversation: it is in
    // the far right corner of the conversation.
    const share = componentOf(plugin, 'conversation.session.header.utilities')
    assert.ok(entry.registration.order > share.registration.order, 'the presence is right of the share button')

    renderPresence(plugin)
    await tick()

    const asked = plugin.fetch.calls.find((call) => String(call.url).includes('/presence'))
    assert.ok(asked, 'the owner asks the host for the room of the conversation')
    assert.match(String(asked.url), /sessionId=s1/, 'the owner asks for the room of its own conversation')
  } finally {
    plugin.restore()
  }
})

test('the owner sees who is in the shared conversation', async () => {
  const plugin = await loadPlugin()
  try {
    renderPresence(plugin)
    await tick()

    // The room is empty: the widget has nothing to say.
    assert.equal(findByAttr(plugin.renderer.root, 'data-rc-presence'), null, 'nobody is in the room yet')

    plugin.fetch.push({
      kind: 'presence',
      sessionId: 's1',
      guests: [{ id: 'g_ada', name: 'Ada', color: '#4176e6', typing: false }],
      locks: [],
    })
    await tick()
    await tick()

    const widget = findByAttr(plugin.renderer.root, 'data-rc-presence')
    assert.ok(widget, 'the widget shows that somebody is there')
    const markup = toMarkup(plugin.renderer.root)
    assert.match(markup, /Ada/, 'the owner sees the name of the guest')
    assert.match(markup, /rc-presence-face/, 'the guest has a face')
    assert.match(markup, /1 guest here/, 'the owner sees how many are there')
  } finally {
    plugin.restore()
  }
})

test('the owner sees who is writing', async () => {
  const plugin = await loadPlugin()
  try {
    renderPresence(plugin)
    await tick()

    plugin.fetch.push({
      kind: 'presence',
      sessionId: 's1',
      guests: [{ id: 'g_ada', name: 'Ada', color: '#4176e6', typing: true, typingAt: Date.now() }],
      locks: [],
    })
    await tick()
    await tick()

    const widget = findByAttr(plugin.renderer.root, 'data-rc-presence')
    assert.ok(widget, 'the widget is there')
    assert.equal(widget.props['data-rc-presence-typing'], 'true', 'the widget says that somebody is writing')
    const markup = toMarkup(plugin.renderer.root)
    assert.match(markup, /Ada is typing/, 'the owner sees who is writing')
    assert.match(markup, /rc-presence-dots/, 'the sign of a guest that writes is drawn')
  } finally {
    plugin.restore()
  }
})

test('the widget of the room is folded away, and a click opens it', async () => {
  const plugin = await loadPlugin()
  try {
    renderPresence(plugin)
    await tick()

    plugin.fetch.push({
      kind: 'presence',
      sessionId: 's1',
      guests: [
        { id: 'g_ada', name: 'Ada', color: '#4176e6', typing: false, file: 'docs/plan.md', editing: false },
        { id: 'g_bob', name: 'Bob', color: '#0f8a8a', typing: true, typingAt: Date.now(), file: '', editing: false },
      ],
      locks: [],
    })
    await tick()
    await tick()

    // The header of a conversation is the app's own: the widget is a small
    // pill of faces until the owner asks for the names.
    const pill = findByAttr(plugin.renderer.root, 'data-rc-presence')
    assert.ok(pill, 'the pill of the guests is in the header')
    assert.equal(pill.props['data-rc-presence-open'], 'false', 'the widget is folded away')
    assert.equal(pill.props['aria-expanded'], 'false', 'the pill says that it is closed')
    assert.equal(findByAttr(plugin.renderer.root, 'data-rc-presence-panel'), null, 'the panel is not there yet')

    pill.props.onClick()

    const panel = findByAttr(plugin.renderer.root, 'data-rc-presence-panel')
    assert.ok(panel, 'the click opens the panel')
    const markup = toMarkup(plugin.renderer.root)
    assert.match(markup, /Ada/, 'the panel names the guests')
    assert.match(markup, /Bob/, 'the panel names every guest')
    assert.match(markup, /docs\/plan\.md/, 'the panel says what a guest has open')
    assert.equal(
      findByAttr(plugin.renderer.root, 'data-rc-presence').props['aria-expanded'],
      'true',
      'the pill says that it is open',
    )

    // A second click folds the panel away again.
    findByAttr(plugin.renderer.root, 'data-rc-presence').props.onClick()
    assert.equal(findByAttr(plugin.renderer.root, 'data-rc-presence-panel'), null, 'the panel folds away again')
  } finally {
    plugin.restore()
  }
})

test('the widget of the room is drawn in the style of the app', async () => {
  const plugin = await loadPlugin()
  try {
    const css = plugin.document.getElementById('dsh-remote-control-share-styles')?.textContent ?? ''
    assert.match(css, /\.rc-presence\{/, 'the widget has a style of its own')
    assert.match(css, /\.rc-presence-panel\{/, 'the panel has a style of its own')
    assert.match(css, /@keyframes rc-presence-blink/, 'the sign of a guest that writes travels')
    assert.match(css, /prefers-reduced-motion/, 'the travel of the dots may be stopped')
  } finally {
    plugin.restore()
  }
})
