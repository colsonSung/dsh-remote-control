/**
 * The guest page: the highlighter it colours the files with, the language
 * reader it reads the file's kind from, and the queue bar it shows the
 * waiting messages of the conversation in.
 *
 * The page is one big script that runs in the browser, so the tests read its
 * markup and run its script in a small document of their own.
 *
 * Run with: `node --test tests/share-page.test.js`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { highlightCode, languageOf } from '../src/share-highlight.js'
import { renderGuestPage } from '../src/share-page.js'

/**
 * The page of a write share, as the host renders it.
 *
 * @returns {string}
 */
function pageHtml() {
  return renderGuestPage({
    share: { id: 's_0123456789ab', title: 'A share', permission: 'write' },
    unlocked: true,
  })
}

/**
 * The script of the page.
 *
 * @param {string} html
 * @returns {string}
 */
function scriptOf(html) {
  const match = /<script>([\s\S]*)<\/script>/.exec(html)
  assert.ok(match !== null, 'the page carries a script')
  return match[1]
}

/* The document the page runs in -------------------------------------------- */

/** The tags that never carry anything below them. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'line',
  'polyline', 'polygon', 'ellipse', 'stop', 'use',
])

/**
 * One element of the small document.
 *
 * @param {string} tag
 * @returns {any}
 */
function element(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 0,
    attributes: {},
    children: [],
    listeners: {},
    style: { setProperty() {} },
    setAttribute(name, value) { this.attributes[name] = String(value) },
    getAttribute(name) { return this.attributes[name] ?? null },
    removeAttribute(name) { delete this.attributes[name] },
    appendChild(child) { this.children.push(child); return child },
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler) },
    set innerHTML(value) { if (value === '') this.children = [] },
    get innerHTML() { return '' },
    querySelector(selector) { return findIn(this, selector) },
    querySelectorAll() { return [] },
  }
}

/**
 * The first element of a class below a node.
 *
 * @param {any} node
 * @param {string} selector
 * @returns {any}
 */
function findIn(node, selector) {
  const wanted = String(selector).replace(/^\./, '')
  for (const child of node.children) {
    if (String(child.className).split(/\s+/).includes(wanted)) return child
    const found = findIn(child, selector)
    if (found !== null) return found
  }
  return null
}

/**
 * The text an element shows: its own, and the text of everything below it.
 *
 * @param {any} node
 * @returns {string}
 */
function textOf(node) {
  if (node.children.length === 0) return String(node.textContent ?? '')
  return node.children.map((child) => textOf(child)).join('')
}

/**
 * Read a markup into a tree of elements.
 *
 * The page is a document, so the test reads the very markup the host sends
 * and hands it to the script: a change of the markup changes the document
 * the script runs in.
 *
 * @param {string} source
 * @returns {any}
 */
function parseMarkup(source) {
  const root = element('div')
  const stack = [root]
  const pattern = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*)>|<\/([a-zA-Z][a-zA-Z0-9-]*)>|([^<]+)/g
  let match = pattern.exec(source)
  while (match !== null) {
    if (match[4] !== undefined) {
      const text = match[4].trim()
      if (text.length > 0) stack[stack.length - 1].textContent += text
    } else if (match[3] !== undefined) {
      if (stack.length > 1) stack.pop()
    } else {
      const tag = match[1].toLowerCase()
      const attributes = match[2] ?? ''
      const node = element(tag)
      const id = /\bid="([^"]*)"/.exec(attributes)
      if (id !== null) node.id = id[1]
      const cls = /\bclass="([^"]*)"/.exec(attributes)
      if (cls !== null) node.className = cls[1]
      if (/\bhidden\b/.test(attributes)) node.hidden = true
      stack[stack.length - 1].appendChild(node)
      const closed = attributes.trimEnd().endsWith('/')
      if (!closed && !VOID_TAGS.has(tag)) stack.push(node)
    }
    match = pattern.exec(source)
  }
  return root
}

/**
 * The document the page runs in, read out of the markup of the page.
 *
 * @param {string} html
 * @returns {any}
 */
function fakeDocument(html) {
  const markup = /<body>([\s\S]*?)<script>/.exec(html)
  const root = parseMarkup(markup === null ? '' : markup[1])
  const byId = new Map()
  const index = (node) => {
    if (node.id !== '') byId.set(node.id, node)
    for (const child of node.children) index(child)
  }
  index(root)
  return {
    body: element('body'),
    documentElement: element('html'),
    createElement(tag) { return element(tag) },
    getElementById(id) { return byId.get(id) ?? null },
    querySelectorAll() { return [] },
    addEventListener() {},
  }
}

/**
 * Run the script of the page against a small document.
 *
 * @param {{ storage?: Record<string, string> }} options
 * @returns {{ document: any, window: any, requests: any[], streams: any[] }}
 */
function runGuestPage(options = {}) {
  const html = pageHtml()
  const document = fakeDocument(html)
  const store = new Map(Object.entries(options.storage ?? {}))
  const window = {
    localStorage: {
      getItem(key) { return store.has(key) ? store.get(key) : null },
      setItem(key, value) { store.set(key, String(value)) },
    },
    setInterval() { return 0 },
    addEventListener() {},
  }
  const requests = []
  const fetch = (url, init) => {
    const target = String(url)
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
    requests.push({ url: target, body })
    const answer = target.endsWith('api/message')
      ? { ok: true, queued: true, id: 'q0a1b2c3', position: 1 }
      : {}
    return Promise.resolve({ ok: true, json: () => Promise.resolve(answer) })
  }
  const streams = []
  class EventSource {
    constructor(url) {
      this.url = url
      this.listeners = {}
      streams.push(this)
    }

    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler) }
  }
  const location = { pathname: '/s/s_0123456789ab' }
  new Function('window', 'document', 'location', 'fetch', 'EventSource', scriptOf(html))(
    window,
    document,
    location,
    fetch,
    EventSource,
  )
  return { html, document, window, requests, streams }
}

/**
 * Let the promises of the page settle.
 *
 * @returns {Promise<void>}
 */
function tick() {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

/**
 * Hand a frame to the page, the way the stream of the host does.
 *
 * @param {{ streams: any[] }} page
 * @param {any} frame
 */
function emit(page, frame) {
  const stream = page.streams[0]
  assert.ok(stream !== undefined, 'the page follows the stream of the host')
  for (const handler of stream.listeners.message ?? []) handler({ data: JSON.stringify(frame) })
}

/* The page --------------------------------------------------------------- */

test('the language of a file follows its extension', () => {
  assert.equal(languageOf('src/main.js'), 'clike')
  assert.equal(languageOf('src/app.tsx'), 'clike')
  assert.equal(languageOf('tool.sh'), 'hash')
  assert.equal(languageOf('package.json'), 'json')
  assert.equal(languageOf('docs/readme.md'), 'md')
  assert.equal(languageOf('page.html'), 'markup')
  assert.equal(languageOf('style.css'), 'css')
  assert.equal(languageOf('main.go'), 'clike')
  assert.equal(languageOf('Makefile'), 'plain')
  assert.equal(languageOf(''), 'plain')
})

test('the highlighter colours the parts of a source file', () => {
  const html = highlightCode('const answer = 42 // the answer\n', 'clike')
  assert.match(html, /<span class="tok-key">const<\/span>/, 'a keyword is coloured')
  assert.match(html, /<span class="tok-num">42<\/span>/, 'a number is coloured')
  assert.match(html, /<span class="tok-com">\/\/ the answer<\/span>/, 'a comment is coloured')
})

test('the highlighter keeps the numbers of the code', () => {
  const html = highlightCode('const port = 8080\nconst again = 8080\n', 'clike')
  assert.match(html, /<span class="tok-num">8080<\/span>/)
  assert.equal((html.match(/<span class="tok-num">8080<\/span>/g) ?? []).length, 2, 'both numbers are coloured')
})

test('the highlighter never lets a file write markup into the page', () => {
  const html = highlightCode('<script>alert(1)</script>\n', 'js')
  assert.doesNotMatch(html, /<script>/, 'the tag is escaped')
  assert.match(html, /&lt;script&gt;/, 'the tag shows as text')
})

test('the highlighter leaves an unknown language alone', () => {
  const html = highlightCode('plain <b>text</b>', 'plain')
  assert.equal(html, 'plain &lt;b&gt;text&lt;/b&gt;')
})

test('the highlighter colours markdown', () => {
  const html = highlightCode('# Title\n\n**bold** and `code`\n', 'md')
  assert.match(html, /tok-head/)
  assert.match(html, /tok-key/)
  assert.match(html, /tok-str/)
})

test('the guest page carries the highlighter and the palette of the app', () => {
  const html = renderGuestPage({
    share: { id: 's_0123456789ab', title: 'A share', permission: 'read' },
    unlocked: true,
  })
  // The page colours the files in the browser, so it carries the highlighter.
  assert.match(html, /var highlight = \(function highlightCode/, 'the highlighter travels with the page')
  assert.match(html, /var languageOf = \(function languageOf/, 'the language reader travels with the page')
  // The palette is the app's own, measured from the running host.
  assert.match(html, /--accent: #4176e6/, 'the light accent is the app\'s')
  assert.match(html, /--accent: #7aaaff/, 'the dark accent is the app\'s')
  assert.match(html, /prefers-color-scheme: dark/, 'the page follows the visitor\'s theme')
})

test('the script of the guest page parses', () => {
  // A page whose script does not parse shows the shell and nothing else: the
  // file tree stays empty and nothing says why.
  const html = renderGuestPage({
    share: { id: 's_0123456789ab', title: 'A share', permission: 'read' },
    unlocked: true,
  })
  const match = /<script>([\s\S]*)<\/script>/.exec(html)
  assert.ok(match !== null, 'the page carries a script')
  assert.doesNotThrow(() => new Function(match[1]), 'the script of the page parses')
})

/* The queue bar ---------------------------------------------------------- */

test('the page carries the queue bar above the composer', () => {
  const html = pageHtml()
  assert.match(html, /<div class="queue" id="queue" hidden>/, 'the bar is there, and it starts hidden')
  assert.match(html, /<div class="queue-body">/, 'the bar carries a body')
  assert.match(html, /<div class="queue-working"><\/div>/, 'the bar carries the line of what is worked on')
  assert.match(html, /<ol class="queue-waiting"><\/ol>/, 'the bar carries the list of what waits')
})

test('the bar wraps on a phone instead of running past the edge', () => {
  const html = pageHtml()
  // The strip is a column of lines that may shrink, and every line of it
  // wraps: the bar grows downwards on a narrow screen.
  assert.match(html, /\.queue-body \{[^}]*min-width: 0/, 'the body of the bar may shrink')
  assert.match(html, /\.queue-body \{[^}]*flex-direction: column/, 'the bar is a column of lines')
  assert.match(html, /\.queue-working \{[^}]*overflow-wrap: anywhere/, 'the line of the work wraps')
  assert.match(html, /\.queue-item \{[^}]*overflow-wrap: anywhere/, 'a waiting message wraps')
})

test('the bar reads the queue of the host', () => {
  const script = scriptOf(pageHtml())
  assert.match(script, /frame\?\.working/, 'the bar reads what is worked on')
  assert.match(script, /frame\?\.waiting/, 'the bar reads what waits behind it')
  assert.match(script, /item\.from/, 'the bar reads the sender of a message')
  assert.match(script, /item\.id/, 'the bar reads the id of a message')
  assert.match(script, /'Working on: '/, 'the bar says what the agent works on')
  assert.match(script, /'Waiting for the agent\.'/, 'the bar says that it waits for the agent')
  assert.match(script, /'yours'/, 'the bar marks the message of the guest')
})

test('the guest says who it is with the message', () => {
  const script = scriptOf(pageHtml())
  assert.match(script, /guest: guestId/, 'the message carries the id of the guest')
  assert.match(script, /from: guestName/, 'the message carries the name of the guest')
  assert.match(script, /myMessageId = String\(answer\.id\)/, 'the guest keeps the id the host answered with')
})

test('the bar is hidden when the queue is empty', () => {
  const page = runGuestPage()
  const bar = page.document.getElementById('queue')
  emit(page, { kind: 'queue', working: null, waiting: [] })
  assert.equal(bar.hidden, true, 'the bar is hidden')
})

test('the bar says what the agent works on', () => {
  const page = runGuestPage()
  const bar = page.document.getElementById('queue')
  emit(page, {
    kind: 'queue',
    working: { id: 'q11111111', text: 'read the parser', from: 'Ada', at: 1 },
    waiting: [],
  })
  assert.equal(bar.hidden, false, 'the bar is shown')
  assert.equal(
    textOf(bar.querySelector('.queue-working')),
    'Working on: read the parser — Ada',
    'the bar says the work and who asked for it',
  )
})

test('the bar says that it waits for the agent', () => {
  const page = runGuestPage()
  const bar = page.document.getElementById('queue')
  emit(page, {
    kind: 'queue',
    working: null,
    waiting: [{ id: 'q11111111', text: 'read the parser', from: 'Ada', at: 1 }],
  })
  assert.equal(
    textOf(bar.querySelector('.queue-working')),
    'Waiting for the agent.',
    'nothing is worked on, so the bar waits with the agent',
  )
})

test('the bar lists the messages that wait, in order', () => {
  const page = runGuestPage()
  const bar = page.document.getElementById('queue')
  emit(page, {
    kind: 'queue',
    working: null,
    waiting: [
      { id: 'q11111111', text: 'read the parser', from: 'Ada', at: 1 },
      { id: 'q22222222', text: 'run the tests', from: 'Bob', at: 2 },
      { id: 'q33333333', text: 'and the docs', from: '', at: 3 },
    ],
  })
  const items = bar.querySelector('.queue-waiting').children
  assert.equal(items.length, 3, 'every waiting message is in the bar')
  assert.equal(textOf(items[0]), 'Ada: read the parser', 'the first message carries its sender')
  assert.equal(textOf(items[1]), 'Bob: run the tests', 'the second message carries its sender')
  assert.equal(textOf(items[2]), 'a guest: and the docs', 'a message of an unknown guest still has a sender')
})

test('the guest sees its own message as its own', async () => {
  const page = runGuestPage({
    storage: { 'dsh-share-guest-id': 'g_ada', 'dsh-share-guest-name': 'Ada' },
  })
  const form = page.document.getElementById('composer')
  const input = page.document.getElementById('composerInput')
  input.value = 'read the parser'
  await form.listeners.submit[0]({ preventDefault() {} })
  await tick()

  const request = page.requests.find((entry) => entry.url.endsWith('api/message'))
  assert.ok(request !== undefined, 'the message went to the host')
  assert.equal(request.body.text, 'read the parser', 'the message carries the words')
  assert.equal(request.body.guest, 'g_ada', 'the message carries the id of the guest')
  assert.equal(request.body.from, 'Ada', 'the message carries the name of the guest')

  // The host answered with the id the message has in the queue: the guest
  // finds its own message in the bar, even when the host does not know who
  // sent it.
  const bar = page.document.getElementById('queue')
  emit(page, {
    kind: 'queue',
    working: null,
    waiting: [
      { id: 'q44444444', text: 'run the tests', from: 'Bob', at: 2 },
      { id: 'q0a1b2c3', text: 'read the parser', from: '', at: 3 },
    ],
  })
  const items = bar.querySelector('.queue-waiting').children
  assert.equal(textOf(items[0]), 'Bob: run the tests', 'the message of another guest keeps its sender')
  assert.equal(textOf(items[1]), 'yours: read the parser', 'the message of the guest is its own')
  assert.equal(items[1].getAttribute('data-mine'), 'true', 'the message of the guest is marked')

  // The message of the guest is worked on: the bar says so as well.
  emit(page, {
    kind: 'queue',
    working: { id: 'q0a1b2c3', text: 'read the parser', from: '', at: 3 },
    waiting: [],
  })
  const head = bar.querySelector('.queue-working')
  assert.equal(textOf(head), 'Working on: read the parser — yours', 'the work is the work of the guest')
  assert.equal(head.getAttribute('data-mine'), 'true', 'the work of the guest is marked')
})
