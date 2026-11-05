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
  // The remote marker is written on the document element, before the shell
  // renders anything, so the fake document has to carry one.
  const rootAttributes = {}
  const documentElement = {
    setAttribute: (name, value) => { rootAttributes[name] = String(value) },
    getAttribute: (name) => rootAttributes[name] ?? null,
    removeAttribute: (name) => { delete rootAttributes[name] },
    hasAttribute: (name) => name in rootAttributes,
  }
  const document = {
    head,
    documentElement,
    getElementById(id) {
      return styles.find((style) => style.id === id) ?? null
    },
    createElement(tagName) {
      return { tagName: String(tagName).toUpperCase(), id: '', textContent: '' }
    },
  }
  return { document, styles, documentElement }
}

/**
 * Load the browser half with a fake window and return the styles it injected.
 *
 * @returns {Promise<{styles: any[], window: any}>}
 */
async function loadClient(options = {}) {
  const { document, styles, documentElement } = fakeDocument()
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  globalThis.window = {
    __ModuleLoader__: { load() {} },
    location: {
      hostname: options.hostname ?? '127.0.0.1',
      protocol: options.protocol ?? 'http:',
      search: '',
    },
  }
  globalThis.document = document
  try {
    // The file registers a factory and runs its bundle-level installers.
    const source = await readFile(clientPath, 'utf8')
    const run = new Function('window', 'document', `${source}\n//# sourceURL=client.js`)
    run(globalThis.window, document)
    return { styles, window: globalThis.window, document, documentElement }
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
  globalThis.window = {
    __ModuleLoader__: { load() {} },
    location: { hostname: '127.0.0.1', search: '' },
  }
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

/** Return the single mobile stylesheet's CSS, not its implementation. */
async function mobileCss() {
  const { styles } = await loadClient()
  const style = styles.find((entry) => entry.id === 'dsh-remote-control-mobile-layout')
  assert.ok(style, 'the mobile layout stylesheet must be injected')
  return style.textContent
}

test('the conversation header stays the host\'s own and loses desktop-only controls', async () => {
  const css = await mobileCss()
  // The host folds the views it cannot show into a More menu, so the phone
  // must not take the header over: no height, padding or layout override.
  assert.doesNotMatch(css, /header\[data-window-drag\]\s*\{[^}]*min-height/s)
  assert.doesNotMatch(css, /header\[data-window-drag\]\s*\{[^}]*padding/s)
  assert.match(css, /header\[data-window-drag\] button[^{]*\{[^}]*min-height: 44px !important/s)
  assert.match(css, /\[data-conversation-tabs\][^{]*\{[^}]*overflow-x: auto !important/s)
  assert.match(css, /\[data-conversation-tabs\] \[role="tab"\][^{]*\{[^}]*min-height: 44px !important/s)
  assert.match(css, /\[data-width-handle\][^{]*\{[^}]*display: none !important/s)
})

test('the desktop-only "open locally" control is gone on a phone', async () => {
  const css = await mobileCss()
  // The host opens a file or a folder in an application on the Host desktop:
  // Finder, VS Code, Xcode, a terminal. A phone is not holding that machine,
  // so the split button the host marks with `data-open-target` must not be
  // offered there.
  assert.match(css, /\[data-open-target\][^{]*\{[^}]*display: none !important/s)
})

test('the phone chrome stays pinned while the page scrolls', async () => {
  const css = await mobileCss()
  // The rail and the conversation header are ordinary flow content: a focused
  // field that makes the browser scroll the page would take them away.
  assert.match(css, /\.sa-sidebar[^{]*\{[^}]*position: sticky !important/s)
  assert.match(css, /\.sa-sidebar[^{]*\{[^}]*height: 100dvh !important/s)
  assert.match(css, /header\[data-window-drag\][^{]*\{[^}]*position: sticky !important/s)
  assert.match(css, /header\[data-window-drag\][^{]*\{[^}]*top: 0 !important/s)
})

test('no editable control on a phone can trigger the focus zoom', async () => {
  const css = await mobileCss()
  assert.match(css, /input,\s*textarea,\s*select,\s*\[contenteditable\][^{]*\{[^}]*font-size: 16px !important/s)
})

test('a phone menu keeps a readable surface', async () => {
  const css = await mobileCss()
  const narrow = css.slice(css.indexOf('@media'))
  // The host's menu surface is painted by a CSS anchor-positioned element that
  // iOS Safari does not implement yet, so the menu would show the page through
  // it. A phone needs a surface that does not depend on that feature.
  assert.match(narrow, /\[data-menu-material\][^{]*\{[^}]*background: var\(--dsw-alias-bg-layer-2\) !important/s)
  assert.match(narrow, /\[data-menu-material\][^{]*\{[^}]*box-shadow: var\(--dsw-elevation-prominent\) !important/s)
  assert.match(narrow, /\[data-menu-material\][^{]*\{[^}]*max-width: calc\(100vw - 24px\) !important/s)
  assert.match(narrow, /\[data-menu-material\][^{]*\{[^}]*overflow-y: auto !important/s)
  // The host measures the room a menu has above its anchor and writes it down
  // as an inline max-height. A fixed share of the screen ignores that
  // measurement, and the menu then reaches over the top of the display: the
  // first entries, the file picker among them, are out of reach.
  assert.doesNotMatch(narrow, /\[data-menu-material\][^{]*\{[^}]*max-height:/s)
})

test('the shell follows the visible area of the phone', async () => {
  const css = await mobileCss()
  const narrow = css.slice(css.indexOf('@media'))
  // The composer is sticky at the bottom of the shell's own scroller, so a
  // shell sized to the visible area puts the composer on the top edge of the
  // keyboard without measuring or moving it.
  assert.match(narrow, /#root[^{]*\{[^}]*height: var\(--dsh-vv-height, 100%\) !important/s)
  assert.match(narrow, /#root[^{]*\{[^}]*margin-top: var\(--dsh-vv-offset, 0px\) !important/s)
  // The page itself must not scroll: Safari scrolls it to reveal a focused
  // field, and a scrolled page moves the shell out of the visible area.
  assert.match(narrow, /html, body[^{]*\{[^}]*overflow: hidden !important/s)
  // The composer is never moved with a transform: a transformed element is
  // measured after the transform, so the measurement of the keyboard would
  // read the lift of the previous round and feed it back.
  assert.doesNotMatch(narrow, /\[data-composer-seat\][^{]*\{[^}]*transform:/s)
  assert.doesNotMatch(narrow, /\[data-composer-seat\][^{]*\{[^}]*will-change: transform/s)
})

test('a dropdown of the composer takes the room of the text field', async () => {
  const css = await mobileCss()
  assert.match(css, /\[data-composer-seat\]:has\(\[data-trigger-menu\]\) \[data-input-scroll\][^{]*\{[^}]*display: none !important/s)
})

test('the composer is thumb-sized, readable and safe-area aware', async () => {
  const css = await mobileCss()
  assert.match(css, /\[data-composer-input\][^{]*\{[^}]*font-size: 16px !important/s)
  assert.match(css, /\[data-composer-card\] button[^{]*\{[^}]*min-height: 44px !important/s)
  // An attachment icon that may shrink turns into an ellipse once the file
  // name is long; the name is the part that may give way.
  assert.match(css, /\[data-composer-seat\] :is\(svg, img\)[^{]*\{[^}]*flex: 0 0 auto !important/s)
  assert.match(css, /\[data-dsh-composer-primary\][^{]*\{[^}]*min-width: 44px !important/s)
  assert.doesNotMatch(css, /\[data-composer-card\] button\[aria-label\][^{]*\{[^}]*min-width: 44px !important/s)
  assert.doesNotMatch(css, /\[data-composer-dock\][^{]*\{[^}]*flex-wrap: wrap !important/s)
  assert.doesNotMatch(css, /\[data-composer-card\] > div:last-child/)
  assert.match(css, /\[data-composer-seat\][^{]*\{[^}]*padding-bottom: calc\(4px \+ env\(safe-area-inset-bottom, 0px\)\) !important/s)
})

test('message content cannot create a second horizontal page', async () => {
  const css = await mobileCss()
  assert.match(css, /\[data-conversation-content\][^{]*\{[^}]*--dsh-chat-user-width: 100% !important/s)
  assert.match(css, /\[data-conversation-content\][^{]*\{[^}]*--dsh-composer-side-clearance: 12px !important/s)
  assert.match(css, /\[data-conversation-scroll\][^{]*\{[^}]*overflow-x: hidden !important/s)
  assert.match(css, /\[data-conversation-scroll\] pre[^{]*\{[^}]*max-width: 100% !important/s)
  assert.match(css, /\[data-conversation-scroll\] table[^{]*\{[^}]*overflow-x: auto !important/s)
  assert.match(css, /\[data-conversation-scroll\] :is\(p, li, h1, h2, h3, h4, h5, h6\)[^{]*\{[^}]*overflow-wrap: anywhere !important/s)
  assert.match(css, /\[data-conversation-scroll\] :is\(p, li\) code[^{]*\{[^}]*white-space: normal !important/s)
  assert.match(css, /\[data-conversation-scroll\] :is\(video, canvas, svg\)[^{]*\{[^}]*max-width: 100% !important/s)
  assert.match(css, /\[data-changes-review\] \[data-review-view\][^{]*\{[^}]*overflow-x: auto !important/s)
  assert.doesNotMatch(css, /\[data-conversation-scroll\] \[data-review-view\]/)
})

test('delivery and change cards collapse to one phone column', async () => {
  const css = await mobileCss()
  assert.match(css, /\[data-presented-files-row\][^{]*\{[^}]*grid-template-columns: minmax\(0, 1fr\) !important/s)
  assert.match(css, /\[data-presented-file\][^{]*\{[^}]*min-height: 64px !important/s)
  assert.match(css, /\[data-changed-files\][^{]*\{[^}]*max-width: 100% !important/s)
  assert.match(css, /\[data-changed-files\] li[^{]*\{[^}]*min-width: 0 !important/s)
  assert.match(css, /\[data-changed-files\] li button[^{]*\{[^}]*grid-template-columns: minmax\(0, 1fr\) auto !important/s)
  assert.match(css, /\[data-changed-files\] li button > span[^{]*\{[^}]*text-overflow: ellipsis !important/s)
  assert.doesNotMatch(css, /\[data-changed-files\] li button > span:(?:first|last)-child/)
  assert.match(css, /\[data-changes-review\][^{]*\{[^}]*max-width: 100% !important/s)
  assert.doesNotMatch(css, /\[data-changes-review\][^{]*\{[^}]*overflow: hidden !important/s)
  assert.match(css, /\[data-review-file\][^{]*\{[^}]*text-overflow: ellipsis !important/s)
  assert.match(css, /\[data-review-tool\][^{]*\{[^}]*min-width: 44px !important/s)
  assert.match(css, /\[data-review-tool\][^{]*\{[^}]*min-height: 44px !important/s)
})

test('mobile surfaces use theme tokens rather than hard-coded colors', async () => {
  const css = await mobileCss()
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i)
  assert.match(css, /var\(--dsw-alias-bg-base\)/)
})

test('only the composer send and stop actions receive the primary marker', async () => {
  const { document, window } = await loadClient()
  const mark = window[Symbol.for('dsh.remote-control.mark-composer-controls')]
  assert.equal(typeof mark, 'function', 'the composer marker helper must be published')
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
  const send = button('Send message')
  const stop = button('Stop generating')
  const queue = button('Queue message')
  const steer = button('Steer message')
  const commands = button('Add files or run commands')
  const buttons = [send, stop, queue, steer, commands]
  document.querySelectorAll = (selector) => {
    if (selector === '[data-composer-card] button[aria-label]') return buttons
    if (selector === '[data-dsh-composer-primary]') return buttons.filter((b) => b.hasAttribute('data-dsh-composer-primary'))
    return []
  }
  window.matchMedia = () => ({ matches: true })

  mark(['Send message', 'Stop generating', 'Queue message', 'Steer message'])

  for (const primary of [send, stop, queue, steer]) {
    assert.equal(primary.getAttribute('data-dsh-composer-primary'), '')
  }
  assert.equal(commands.getAttribute('data-dsh-composer-primary'), null)

  window.matchMedia = () => ({ matches: false })
  mark(['Send message', 'Stop generating', 'Queue message', 'Steer message'])
  for (const candidate of buttons) {
    assert.equal(candidate.getAttribute('data-dsh-composer-primary'), null)
  }
})

test('a remote page is marked, and its desktop-only controls are hidden', async () => {
  const { documentElement, styles } = await loadClient({ hostname: 'rc.example.com' })
  assert.equal(documentElement.getAttribute('data-dsh-remote'), 'true', 'a remote origin must mark the document')
  const css = styles.find((entry) => entry.id === 'dsh-remote-control-mobile-layout').textContent
  // The editor hand-off opens an application on the desktop; the Moments float
  // is a window of the desktop app; the live recorder captures the desktop
  // microphone. None of them can act on the machine holding the phone.
  assert.match(css, /html\[data-dsh-remote\] :is\(/s)
  for (const selector of ['[data-open-target]', '.mm-quick', '.mvm-quick', '.mm-quick-button', '.mvm-quick-button', '[aria-label="Open the Moments float"]', '[aria-label="Start live"]']) {
    assert.ok(css.includes(selector), `the remote rule must hide ${selector}`)
  }
  // The split button's anchor keeps its halves together; hiding only the
  // halves would leave a gap.
  assert.match(css, /html\[data-dsh-remote\] :has\(> \[data-open-target\]\)[^{]*\{[^}]*display: none !important/s)
})

test('the desktop app keeps its desktop-only controls', async () => {
  const { documentElement } = await loadClient({ hostname: '127.0.0.1' })
  assert.equal(documentElement.getAttribute('data-dsh-remote'), null, 'a loopback page must not be marked remote')
})

test('the desktop app is not remote just because it uses its own scheme', async () => {
  // The app registers `dsh-app:` and can load its own document through it; a
  // scheme is not a device, so the desktop keeps its desktop-only controls.
  const { documentElement } = await loadClient({ hostname: 'app', protocol: 'dsh-app:' })
  assert.equal(documentElement.getAttribute('data-dsh-remote'), null)
})
