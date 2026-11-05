/**
 * Share service tests.
 *
 * The guest surface is exercised over real HTTP: the service owns the routes,
 * the passcode, the cookie and the project boundary, and a guest only ever
 * speaks to it.
 *
 * Run with: `node --test tests/share-service.test.js`
 */

import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import { test } from 'node:test'

import {
  createShareService,
  SHARE_COOKIE_MAX_AGE_SECONDS,
  SHARE_MAX_FAILURES,
  verifyShareCookie,
} from '../src/share-service.js'

const SECRET = 'device-secret-for-the-share-tests'

/**
 * A scratch profile for the share records.
 *
 * @returns {string}
 */
function scratchProfile() {
  const dir = mkdtempSync(join(tmpdir(), 'remote-control-share-service-'))
  process.env.DSH_PROFILE_DIR = dir
  return dir
}

/**
 * A filesystem that behaves like the host's local backend.
 *
 * The host resolves a path to its real identity and compares that identity
 * with the root's by path segment, so a directory that merely starts with the
 * root's name is outside it. The fake keeps that behaviour, or the boundary
 * test would prove nothing.
 *
 * @param {string} root
 * @returns {any}
 */
function makeFs(root) {
  return {
    async resolve(path, opts = {}) {
      const cwd = opts.cwd ?? root
      const display = isAbsolute(path) ? path : resolvePath(cwd, path)
      let key
      try {
        key = realpathSync(display)
      } catch {
        key = resolvePath(display)
      }
      return { targetKey: key, displayPath: display }
    },
    contains(parent, child) {
      const rel = relative(parent.targetKey, child.targetKey)
      return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    },
    async lstat(path, opts = {}) {
      const cwd = opts.cwd ?? root
      const display = isAbsolute(path) ? path : resolvePath(cwd, path)
      try {
        const info = lstatSync(display)
        return {
          // The version of a file moves when the file moves: the guest saves
          // against it, and the Host refuses a save of a file that changed.
          version: `${info.size}:${info.mtimeMs}:${info.ino}`,
          type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file',
          size: info.size,
        }
      } catch {
        return undefined
      }
    },
    async writeText(target, content, expected) {
      const before = readFileSync(target.displayPath, 'utf8')
      if (expected !== undefined && expected !== null && expected.kind === 'replaceIfVersion') {
        const info = lstatSync(target.displayPath)
        const version = `${info.size}:${info.mtimeMs}:${info.ino}`
        if (version !== expected.version) {
          const error = new Error('stale version')
          error.code = 'FS_STALE_VERSION'
          throw error
        }
      }
      writeFileSync(target.displayPath, content)
      const info = lstatSync(target.displayPath)
      return { operation: 'update', version: `${info.size}:${info.mtimeMs}:${info.ino}`, before, after: content }
    },
    async watch() {
      // A backend that cannot watch is not a reason to fail the guest.
      return async () => {}
    },
    async readText(target) {
      return readFileSync(target.displayPath, 'utf8')
    },
    // The guest reads a file through a byte range, so a file larger than the
    // cap is cut instead of refused.
    async readByteRange(target, range) {
      const buffer = readFileSync(target.displayPath)
      const end = Math.min(buffer.length, range.offset + range.length)
      return buffer.subarray(range.offset, end)
    },
    async listDir(target) {
      return readdirSync(target.displayPath, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: entry.isDirectory() ? undefined : statSync(join(target.displayPath, entry.name)).size,
      }))
    },
  }
}

/**
 * A project directory with a file inside it and a few ways out of it.
 *
 * @returns {{ root: string, outside: string, sibling: string }}
 */
function makeProject() {
  const base = mkdtempSync(join(tmpdir(), 'remote-control-project-'))
  const root = join(base, 'proj')
  const sibling = join(base, 'proj-secret')
  const outside = join(base, 'outside.txt')
  mkdirSync(root, { recursive: true })
  mkdirSync(sibling, { recursive: true })
  writeFileSync(join(root, 'inside.txt'), 'inside the project')
  writeFileSync(outside, 'outside the project')
  writeFileSync(join(sibling, 'secret.txt'), 'the sibling directory')
  // A symlink inside the project that points out of it.
  symlinkSync(outside, join(root, 'link.txt'))
  // A symlinked directory that points at the sibling.
  symlinkSync(sibling, join(root, 'link-dir'))
  return { root, outside, sibling }
}

/**
 * A stand-in for the mermaid library.
 *
 * The real library is a megabyte of build output; the route only carries
 * the bytes, so a small file proves the same thing.
 *
 * @param {string} [content]
 * @returns {string} the path of the file
 */
function makeMermaidFile(content = 'globalThis.mermaid = { initialize() {} }') {
  const dir = mkdtempSync(join(tmpdir(), 'remote-control-mermaid-'))
  const path = join(dir, 'mermaid.min.js')
  writeFileSync(path, content)
  return path
}

/**
 * The host services the share reads and writes through.
 *
 * @param {{ root: string }} options
 * @returns {{ sessionQuery: any, sessionController: any, prompts: any[] }}
 */
function makeHost(options) {
  const prompts = []
  // A Host whose event stream is not a stream: the guest must not find the
  // answer sent twice when the head of the stream is already out.
  const brokenStream = options.brokenStream === true
  const shortMessage = options.shortMessage === true
  // A Host whose stream stays open: the turns of the agent come and go while
  // the guest waits.
  const live = options.live === true
  // A Host that is working when the guest sends: the turn of the agent is
  // open when the stream opens.
  const busy = options.busy === true
  const events = [
    {
      type: 'user/message',
      seq: 0,
      time: 1,
      data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
    },
    {
      type: 'assistant/message',
      seq: 1,
      time: 2,
      data: {
        message: {
          id: 'm2',
          role: 'assistant',
          content: [{ type: 'text', text: 'hi there' }],
          source: { kind: 'model' },
        },
      },
    },
  ]
  if (busy) {
    // The turn of the agent is open: the last turn that started has not
    // ended yet.
    events.push({ type: 'turn/start', seq: 2, time: 3, data: { turn: 1 } })
  }
  // The turn the Host stands at.
  let turn = busy ? 1 : 0
  // The events that come after the stream opened: the followers read them as
  // they arrive.
  const arriving = []
  const listeners = new Set()
  const push = (event) => {
    arriving.push(event)
    for (const listener of [...listeners]) listener()
  }
  // The turn of the agent ends: the queue may hand the next message over.
  const endTurn = () => {
    push({ type: 'turn/end', seq: 40 + turn, time: 40 + turn, data: { turn } })
  }
  const sessionQuery = {
    async observeSession(sessionId) {
      return {
        header: { id: sessionId, cwd: options.root, createdAt: 0, isSeeded: false },
        inheritedEventCount: 0,
        events,
      }
    },
    async readTitle() {
      return { title: 'The shared session', eventSeq: 0, updatedAt: 0 }
    },
  }
  const sessionController = {
    async page() {
      return {
        records: events.map((event) => ({ type: 'event', event })),
        hasMore: false,
      }
    },
    async prompt(request, signal) {
      // The host reads the signal before anything else, so an undefined one is
      // refused before the message is even looked at.
      if (signal === undefined || typeof signal.throwIfAborted !== 'function') {
        throw new Error('the host needs an abort signal')
      }
      prompts.push(request)
      // The Host takes the message: it writes the words into the log and opens
      // a turn for them.
      const words = request.content?.find((part) => part?.type === 'text')?.text
      if (typeof words === 'string') {
        push({
          type: 'user/message',
          seq: 20 + prompts.length,
          time: 20 + prompts.length,
          data: {
            id: `m${20 + prompts.length}`,
            role: 'user',
            content: [{ type: 'text', text: words }],
            source: { kind: 'user' },
          },
        })
      }
      turn += 1
      push({ type: 'turn/start', seq: 30 + turn, time: 30 + turn, data: { turn } })
      return { accepted: true }
    },
    follow() {
      if (brokenStream) return undefined
      return (async function* () {
        yield {
          type: 'snapshot',
          cursor: 1,
          records: events.map((event) => ({ type: 'event', event })),
          hasMore: false,
        }
        if (shortMessage) {
          // The Host records a message shorter than it was given.
          yield {
            type: 'event',
            event: {
              type: 'user/message',
              seq: 9,
              time: 9,
              data: {
                id: 'm9',
                role: 'user',
                content: [{ type: 'text', text: 'hello' }],
                source: { kind: 'user' },
              },
            },
          }
        }
        if (!live) return
        // The stream stays open: the turns of the agent arrive as they
        // happen.
        let index = 0
        while (true) {
          if (index < arriving.length) {
            yield { type: 'event', event: arriving[index] }
            index += 1
            continue
          }
          await new Promise((resolve) => {
            const listener = () => {
              listeners.delete(listener)
              resolve()
            }
            listeners.add(listener)
          })
        }
      })()
    },
  }
  return { sessionQuery, sessionController, prompts, push, endTurn }
}

/**
 * One HTTP request.
 *
 * The client keeps no connection alive, so the test server can close right
 * after the last answer.
 *
 * @param {string} target the absolute URL
 * @param {{ method?: string, headers?: Record<string, string>, body?: unknown }} [options]
 * @returns {Promise<{ status: number, headers: any, body: string, json: () => any }>}
 */
function request(target, options = {}) {
  const url = new URL(target)
  const payload =
    options.body === undefined
      ? undefined
      : typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? 'GET',
        headers:
          payload === undefined
            ? options.headers ?? {}
            : { 'content-type': 'application/json', ...(options.headers ?? {}) },
        agent: false,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: () => JSON.parse(body),
          })
        })
      },
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/**
 * Wait for a thing to become true.
 *
 * The queue of a conversation hands a message to the Host a moment after the
 * guest sent it, so a test that watches the Host has to wait for the queue
 * rather than look at it once.
 *
 * @param {() => boolean} predicate
 * @param {string} what the thing that is waited for
 * @param {number} [timeout] how long the wait may last, in milliseconds
 * @returns {Promise<void>}
 */
async function waitFor(predicate, what, timeout = 2000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`the wait ran out: ${what}`)
}

/**
 * Open the event stream of a share and read its frames as they come.
 *
 * The stream of a guest does not end when the Host stops talking: the guest
 * keeps it open, so the frames are read while they arrive.
 *
 * @param {string} target the absolute URL
 * @param {{ headers?: Record<string, string> }} [options]
 * @returns {{ frames: () => Promise<any[]>, close: () => void }}
 */
function openStream(target, options = {}) {
  const url = new URL(target)
  /** @type {any[]} */
  const frames = []
  /** @type {(() => void)[]} */
  const waiters = []
  const wake = () => {
    for (const waiter of waiters.splice(0)) waiter()
  }
  const req = http.request(
    {
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: options.headers ?? {},
      agent: false,
    },
    (res) => {
      let buffer = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buffer += chunk
        let index = buffer.indexOf('\n\n')
        while (index >= 0) {
          const block = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          for (const line of block.split('\n')) {
            if (!line.startsWith('data: ')) continue
            frames.push(JSON.parse(line.slice(6)))
          }
          wake()
          index = buffer.indexOf('\n\n')
        }
      })
    },
  )
  req.on('error', () => {})
  req.end()
  return {
    /**
     * The frames that have arrived so far.
     *
     * @returns {any[]}
     */
    frames: () => frames,

    /**
     * Wait until the stream has carried that many frames.
     *
     * @param {number} count
     * @returns {Promise<void>}
     */
    async wait(count) {
      const deadline = Date.now() + 2000
      while (frames.length < count && Date.now() < deadline) {
        await new Promise((resolve) => {
          waiters.push(resolve)
          setTimeout(resolve, 20)
        })
      }
    },

    close: () => {
      req.destroy()
    },
  }
}

/**
 * Start the guest routes on a real HTTP server.
 *
 * @param {any} service
 * @returns {Promise<{ origin: string, close: () => Promise<void> }>}
 */
async function startGuestServer(service) {
  const server = http.createServer((req, res) => {
    void service.handle(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

/**
 * One share, a service and a running guest server.
 *
 * @param {{ permission?: 'read'|'write', now?: () => number, mermaidPath?: string | (() => string | undefined), live?: boolean, busy?: boolean }} [options]
 * @returns {Promise<any>}
 */
async function setup(options = {}) {
  scratchProfile()
  const project = makeProject()
  const host = makeHost({
    root: project.root,
    brokenStream: options.brokenStream === true,
    shortMessage: options.shortMessage === true,
    live: options.live === true,
    busy: options.busy === true,
  })
  const store = await import('../src/share-store.js')
  const service = createShareService({
    secret: SECRET,
    sessionQuery: host.sessionQuery,
    sessionController: host.sessionController,
    fs: makeFs(project.root),
    now: options.now,
    mermaidPath: options.mermaidPath,
  })
  const record = store.createShare({
    sessionId: 'session-1',
    title: 'The shared session',
    permission: options.permission ?? 'read',
    projectRoot: project.root,
  })
  const server = await startGuestServer(service)
  return { service, store, record, project, host, server, origin: server.origin }
}

/**
 * The guest cookie of one answer.
 *
 * @param {any} headers
 * @returns {string | undefined}
 */
function cookieOf(headers) {
  const raw = headers?.['set-cookie']
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
  const entry = list.find((value) => value.startsWith('dsh-share-'))
  return entry?.split(';')[0]
}

/**
 * The attributes of the guest cookie.
 *
 * @param {any} headers
 * @returns {string | undefined}
 */
function cookieAttributesOf(headers) {
  const raw = headers?.['set-cookie']
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
  return list.find((value) => value.startsWith('dsh-share-'))
}

/**
 * Unlock a share and return its cookie.
 *
 * @param {any} fixture
 * @returns {Promise<string>}
 */
async function unlock(fixture) {
  const answer = await request(`${fixture.origin}/share/${fixture.record.id}/unlock`, {
    method: 'POST',
    body: { passcode: fixture.record.passcode },
  })
  assert.equal(answer.status, 200, 'the passcode opens the share')
  const cookie = cookieOf(answer.headers)
  assert.ok(cookie, 'the answer sets a cookie')
  return cookie
}

test('a guest needs the passcode before the session opens', async () => {
  const fixture = await setup()
  const { origin, record, server, store } = fixture

  const page = await request(`${origin}/share/${record.id}`)
  assert.equal(page.status, 200)
  assert.match(page.body, /id="gateForm"/, 'the page asks for the passcode')
  assert.match(page.body, /id="gateInput"/, 'the page asks for the passcode')
  assert.doesNotMatch(page.body, /hello/, 'the conversation is not shown yet')

  const locked = await request(`${origin}/share/${record.id}/api/state`)
  assert.equal(locked.status, 401, 'the state needs the passcode')

  const wrong = await request(`${origin}/share/${record.id}/unlock`, {
    method: 'POST',
    body: { passcode: '00000000' },
  })
  assert.equal(wrong.status, 401, 'a wrong passcode is refused')

  const right = await request(`${origin}/share/${record.id}/unlock`, {
    method: 'POST',
    body: { passcode: record.passcode },
  })
  assert.equal(right.status, 200, 'the right passcode opens the share')

  const cookie = cookieOf(right.headers)
  assert.ok(cookie, 'the answer sets a cookie')
  assert.match(cookie, /^dsh-share-s_[0-9a-f]{12}=/)

  const attributes = cookieAttributesOf(right.headers)
  // The cookie is bound to the share id and signed, so it is scoped to that
  // share rather than to a path: behind a relay the guest's page lives under
  // '/s/<id>' while the host answers '/share/<id>', and a path-scoped cookie
  // would never travel back to the host.
  assert.match(attributes, /Path=\//, 'the cookie is not tied to one path prefix')
  assert.match(attributes, /HttpOnly/, 'the cookie is not readable by a script')
  assert.match(attributes, /SameSite=Lax/, 'the cookie does not travel with a cross-site post')
  assert.match(attributes, /Max-Age=86400/, 'the cookie lives for a day')

  const unlocked = await request(`${origin}/share/${record.id}/api/state`, { headers: { cookie } })
  assert.equal(unlocked.status, 200)
  const state = unlocked.json()
  assert.equal(state.share.id, record.id)
  assert.equal(state.share.title, 'The shared session')
  assert.equal(state.share.permission, 'read')
  assert.equal(state.session.title, 'The shared session')
  assert.equal(state.session.cwd, store.getShare(record.id).projectRoot)
  // The guest reads the steps the app's transcript shows.
  assert.equal(state.messages.length, 2)
  assert.equal(state.messages[0].kind, 'prompt')
  assert.equal(state.messages[0].role, 'user')
  assert.equal(state.messages[0].detail, 'hello')
  assert.equal(state.messages[1].kind, 'answer')
  assert.equal(state.messages[1].role, 'assistant')
  assert.equal(state.messages[1].detail, 'hi there')

  await server.close()
})

test('the guest page addresses its siblings through the path it was opened at', async () => {
  const fixture = await setup()
  const { origin, record, server } = fixture

  const page = await request(`${origin}/share/${record.id}`)
  assert.equal(page.status, 200)

  // A relative 'unlock' resolves against '/s/<id>' to '/s/unlock' — the share
  // id is dropped and the call never reaches the share. Every call has to
  // carry the base the page was opened at.
  assert.match(page.body, /var base = location\.pathname/, 'the page derives its base from the path')
  assert.doesNotMatch(page.body, /fetch\('unlock'/, 'the unlock call carries the base')
  assert.match(page.body, /fetch\(base \+ 'unlock'/, 'the unlock call carries the base')

  // The calls of the opened page carry it too.
  const cookie = await unlock(fixture)
  const opened = await request(`${origin}/share/${record.id}`, { headers: { cookie } })
  assert.doesNotMatch(opened.body, /fetch\('api\/[^']*'/, 'the api calls carry the base')
  assert.match(opened.body, /fetch\(base \+ 'api\/message'/, 'the message call carries the base')
  assert.match(opened.body, /get\('api\/state'\)/, 'the state call carries the base')
  assert.match(opened.body, /new EventSource\(base \+ 'api\/stream'/, 'the stream carries the base')
  // The guest browses the task's project folder, so the tree is read through
  // the same base and stays inside the share's namespace.
  assert.match(opened.body, /get\('api\/tree'/, 'the tree call carries the base')

  await server.close()
})

test('the guest cookie is signed and cannot be forged', async () => {
  const fixture = await setup()
  const { origin, record, server } = fixture

  const right = await request(`${origin}/share/${record.id}/unlock`, {
    method: 'POST',
    body: { passcode: record.passcode },
  })
  const cookie = cookieOf(right.headers)
  const value = cookie.slice(cookie.indexOf('=') + 1)

  assert.equal(verifyShareCookie(SECRET, record.id, value), true, 'the cookie verifies')
  assert.equal(verifyShareCookie('another-secret', record.id, value), false, 'another secret does not verify')
  assert.equal(verifyShareCookie(SECRET, 's_000000000000', value), false, 'another share does not verify')
  assert.equal(verifyShareCookie(SECRET, record.id, `${value}x`), false, 'a tampered cookie does not verify')
  assert.equal(verifyShareCookie(SECRET, record.id, 'nonsense'), false)

  const issuedAt = Number(value.slice(0, value.indexOf('.')))
  const expired = verifyShareCookie(SECRET, record.id, value, {
    now: issuedAt + (SHARE_COOKIE_MAX_AGE_SECONDS + 60) * 1000,
  })
  assert.equal(expired, false, 'an old cookie is refused')

  const refused = await request(`${origin}/share/${record.id}/api/state`, {
    headers: { cookie: `dsh-share-${record.id}=${value}x` },
  })
  assert.equal(refused.status, 401, 'a forged cookie does not open the share')

  await server.close()
})

test('five wrong passcodes lock the caller out for ten minutes', async () => {
  let clock = Date.UTC(2026, 0, 1)
  const fixture = await setup({ now: () => clock })
  const { origin, record, server } = fixture

  for (let attempt = 0; attempt < SHARE_MAX_FAILURES; attempt += 1) {
    const answer = await request(`${origin}/share/${record.id}/unlock`, {
      method: 'POST',
      body: { passcode: '11111111' },
    })
    assert.equal(answer.status, 401, `attempt ${attempt + 1} is refused`)
  }

  const locked = await request(`${origin}/share/${record.id}/unlock`, {
    method: 'POST',
    body: { passcode: '11111111' },
  })
  assert.equal(locked.status, 429, 'the caller is locked out')

  const correct = await request(`${origin}/share/${record.id}/unlock`, {
    method: 'POST',
    body: { passcode: record.passcode },
  })
  assert.equal(correct.status, 429, 'the right passcode does not open a locked share')

  // The lock runs out after ten minutes.
  clock += 10 * 60 * 1000 + 1
  const later = await request(`${origin}/share/${record.id}/unlock`, {
    method: 'POST',
    body: { passcode: record.passcode },
  })
  assert.equal(later.status, 200, 'the lock runs out')

  await server.close()
})

test('the guest may only read files inside the project root', async () => {
  const fixture = await setup()
  const { origin, record, server } = fixture
  const cookie = await unlock(fixture)

  const inside = await request(`${origin}/share/${record.id}/api/file?path=inside.txt`, {
    headers: { cookie },
  })
  assert.equal(inside.status, 200, 'a file inside the project opens')
  assert.equal(inside.body, 'inside the project')

  const escapes = [
    ['a parent traversal', '../outside.txt'],
    ['an absolute path', '/etc/passwd'],
    ['a symlinked file', 'link.txt'],
    ['a symlinked directory', 'link-dir/secret.txt'],
    ['a directory that only shares the root name', '../proj-secret/secret.txt'],
    ['a nested traversal', 'sub/../../outside.txt'],
  ]
  for (const [what, path] of escapes) {
    const answer = await request(`${origin}/share/${record.id}/api/file?path=${encodeURIComponent(path)}`, {
      headers: { cookie },
    })
    assert.equal(answer.status, 403, `${what} is refused`)
    assert.doesNotMatch(answer.body, /outside the project/, 'the answer says nothing about the file')
  }

  await server.close()
})

test('a read-only share cannot put a message into the session', async () => {
  const fixture = await setup({ permission: 'read' })
  const { origin, record, server, host } = fixture
  const cookie = await unlock(fixture)

  const answer = await request(`${origin}/share/${record.id}/api/message`, {
    method: 'POST',
    headers: { cookie },
    body: { text: 'may I?' },
  })
  assert.equal(answer.status, 403, 'a read-only share may not write')
  assert.equal(host.prompts.length, 0, 'the host was never asked')

  await server.close()
})

test('a write share puts a message into the queue of the conversation', async () => {
  const fixture = await setup({ permission: 'write' })
  const { origin, record, server, host } = fixture
  const cookie = await unlock(fixture)

  const answer = await request(`${origin}/share/${record.id}/api/message`, {
    method: 'POST',
    headers: { cookie },
    body: { text: 'please continue' },
  })
  assert.equal(answer.status, 200)
  // The message waits in the queue of the conversation: the Host is told about
  // it there, and it is handed over one message at a time.
  assert.equal(answer.json().queued, true, 'the message is queued')
  assert.match(String(answer.json().id), /^q[0-9a-f]{8}$/, 'the message has an id of its own')
  assert.equal(answer.json().position, 1, 'the message is first in the queue')

  await waitFor(() => host.prompts.length === 1, 'the host was asked once')
  assert.equal(host.prompts[0].sessionId, 'session-1')
  assert.equal(host.prompts[0].mode, 'queue')
  assert.equal(host.prompts[0].content[0].type, 'text')
  assert.equal(host.prompts[0].content[0].text, 'please continue')

  const empty = await request(`${origin}/share/${record.id}/api/message`, {
    method: 'POST',
    headers: { cookie },
    body: { text: '   ' },
  })
  assert.equal(empty.status, 400, 'an empty message is refused')
  assert.equal(host.prompts.length, 1, 'the host was not asked again')

  await server.close()
})

test('a message of a guest waits while the agent is working', async () => {
  const fixture = await setup({ permission: 'write', live: true, busy: true })
  const { origin, record, server, host } = fixture
  const cookie = await unlock(fixture)

  const answer = await request(`${origin}/share/${record.id}/api/message`, {
    method: 'POST',
    headers: { cookie },
    body: { text: 'wait for me' },
  })
  assert.equal(answer.status, 200)
  assert.equal(answer.json().queued, true, 'the message is queued')

  // The agent is working: the message waits, and the Host is not asked.
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(host.prompts.length, 0, 'the host was not asked while the agent was working')

  // The turn of the agent ends: the message goes out.
  host.endTurn()
  await waitFor(() => host.prompts.length === 1, 'the message went out when the turn ended')
  assert.equal(host.prompts[0].content[0].text, 'wait for me')

  await fixture.service.dispose()
  await server.close()
})

test('two messages of the guests are handed to the Host one after the other', async () => {
  const fixture = await setup({ permission: 'write', live: true })
  const { origin, record, server, host } = fixture
  const cookie = await unlock(fixture)

  await request(`${origin}/share/${record.id}/api/message`, {
    method: 'POST',
    headers: { cookie },
    body: { text: 'first' },
  })
  await request(`${origin}/share/${record.id}/api/message`, {
    method: 'POST',
    headers: { cookie },
    body: { text: 'second' },
  })

  // The first message is delivered; the second one waits for the turn of the
  // first to end.
  await waitFor(() => host.prompts.length === 1, 'the first message went out')
  assert.equal(host.prompts[0].content[0].text, 'first')
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(host.prompts.length, 1, 'the second message is still waiting')

  host.endTurn()
  await waitFor(() => host.prompts.length === 2, 'the second message went out after the turn ended')
  assert.equal(host.prompts[1].content[0].text, 'second')

  await fixture.service.dispose()
  await server.close()
})

test('a revoked share answers like one that never existed', async () => {
  const fixture = await setup()
  const { origin, record, server, service } = fixture

  assert.equal(service.disable(record.id), true)
  const page = await request(`${origin}/share/${record.id}`)
  assert.equal(page.status, 404, 'a revoked share is gone')
  const state = await request(`${origin}/share/${record.id}/api/state`)
  assert.equal(state.status, 404)

  await server.close()
})

test('an unknown share answers like a revoked one', async () => {
  const fixture = await setup()
  const { origin, server } = fixture
  const answer = await request(`${origin}/share/s_000000000000`)
  assert.equal(answer.status, 404)
  await server.close()
})

test('the guest page asks for the passcode and shows the session once it is open', async () => {
  const fixture = await setup()
  const { origin, record, server } = fixture

  const locked = await request(`${origin}/share/${record.id}`)
  assert.equal(locked.status, 200)
  assert.match(locked.body, /id="gateForm"/, 'the locked page asks for the passcode')
  assert.match(locked.body, /Passcode/, 'the locked page has a passcode field')
  assert.match(locked.body, /unlock/, 'the locked page posts to the unlock route')

  const cookie = await unlock(fixture)
  const opened = await request(`${origin}/share/${record.id}`, { headers: { cookie } })
  assert.equal(opened.status, 200)
  assert.match(opened.body, /The shared session/, 'the open page shows the title')
  assert.match(opened.body, /api\/stream/, 'the open page follows the stream')
  // The app shape the guest expects: the conversation, and the files of the
  // task's project folder beside it. The guest reads the conversation and the
  // files - no other tab of the host is on show.
  assert.match(opened.body, /data-tab="chat"/, 'the page carries the chat tab')
  assert.doesNotMatch(opened.body, /data-tab="trajectory"/, 'the guest sees no trajectory tab')
  assert.doesNotMatch(opened.body, /data-tab="context"/, 'the guest sees no context tab')
  assert.match(opened.body, /id="tree"/, 'the page lists the project files')
  assert.match(opened.body, /id="filePanel"/, 'the page opens a file in a panel')
  // A read share shows the conversation but no composer.
  assert.doesNotMatch(opened.body, /id="composer"/, 'a read share has no composer')
  assert.match(opened.body, /read-only/i, 'a read share says so')

  // A write share carries the composer.
  const writable = await setup({ permission: 'write' })
  const writeCookie = await unlock(writable)
  const writePage = await request(`${writable.origin}/share/${writable.record.id}`, { headers: { cookie: writeCookie } })
  assert.match(writePage.body, /id="composer"/, 'a write share has the composer')
  await writable.server.close()

  await server.close()
})

/**
 * A Cordis context that carries just what the plugin asks for.
 *
 * @param {Record<string, any>} services the host services the plugin reads
 * @returns {any}
 */
function fakeContext(services) {
  const registered = { fetch: [], web: [] }
  services.connection = {
    fetch: {
      register: (route) => {
        registered.fetch.push(route)
        return () => {}
      },
    },
  }
  services.webServer = {
    register: (route) => {
      registered.web.push(route)
      return () => {}
    },
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: (name) => services[name],
    effect: (fn) => {
      const dispose = fn()
      return () => (typeof dispose === 'function' ? dispose() : undefined)
    },
    inject: (_names, fn) => {
      fn(ctx)
    },
    registered,
    // Cordis hands a service to the plugin as a property of its context.
    ...services,
  }
  return ctx
}

test('the owner API creates, lists, revokes and deletes a share', async () => {
  scratchProfile()
  const project = makeProject()
  const host = makeHost({ root: project.root })
  const sessions = new Map([
    ['session-1', { header: { id: 'session-1', cwd: project.root } }],
  ])
  const services = {
    sessions: { get: (id) => sessions.get(id) },
    sessionQuery: host.sessionQuery,
    sessionController: host.sessionController,
    fs: makeFs(project.root),
  }
  const ctx = fakeContext(services)

  const { apply } = await import('../index.js')
  apply(ctx)

  // The plugin registers its owner route and its guest routes.
  const owner = ctx.registered.fetch.find((route) => route.path === '/api/remote-control')
  assert.ok(owner, 'the owner route is registered')
  assert.deepEqual(owner.methods, ['POST'])
  const guest = ctx.registered.web.find((route) => route.path === '/share')
  assert.ok(guest, 'the guest route is registered')
  assert.equal(guest.kind, 'prefix')
  // The host matches a prefix route as `pathname === prefix ||
  // pathname.startsWith(prefix + '/')`. A prefix with a trailing slash would
  // only ever match '/share//', and every guest link would answer 404.
  assert.ok('/share/s_abc123'.startsWith(`${guest.path}/`), 'a guest path matches under the host matcher')
  assert.ok(!guest.path.endsWith('/'), 'the prefix carries no trailing slash')

  const call = async (method, payload) => {
    const response = await owner.fetch({
      json: async () => ({ method, payload }),
    })
    return response.json()
  }

  const created = await call('shareCreate', { sessionId: 'session-1', permission: 'write', title: 'A title' })
  assert.equal(created.ok, true)
  assert.match(created.value.id, /^s_[0-9a-f]{12}$/)
  assert.match(created.value.passcode, /^[0-9]{8}$/)
  assert.equal(created.value.permission, 'write')
  assert.equal(created.value.link, null, 'there is no relay in a test')
  assert.equal(created.value.reason, 'no relay is configured')

  const listed = await call('shareList', {})
  assert.equal(listed.ok, true)
  assert.equal(listed.value.shares.length, 1)
  assert.equal(listed.value.shares[0].id, created.value.id)
  assert.equal(listed.value.shares[0].status, 'active')
  assert.equal(listed.value.shares[0].sessionId, 'session-1')

  const disabled = await call('shareDisable', { id: created.value.id })
  assert.equal(disabled.ok, true)
  assert.equal(disabled.value.ok, true)
  const afterDisable = await call('shareList', {})
  assert.equal(afterDisable.value.shares[0].status, 'revoked')

  const deleted = await call('shareDelete', { id: created.value.id })
  assert.equal(deleted.ok, true)
  const afterDelete = await call('shareList', {})
  assert.equal(afterDelete.value.shares.length, 0, 'the record is gone')

  const unknown = await call('shareDisable', { id: 's_000000000000' })
  assert.equal(unknown.ok, false, 'an unknown share is refused')
})

test('the owner API refuses a share without a session or a directory', async () => {
  scratchProfile()
  const services = {
    sessions: { get: () => undefined },
    sessionQuery: {
      async observeSession() {
        throw new Error('no such session')
      },
    },
  }
  const ctx = fakeContext(services)
  const { apply } = await import('../index.js')
  apply(ctx)

  const owner = ctx.registered.fetch.find((route) => route.path === '/api/remote-control')
  const call = async (method, payload) => {
    const response = await owner.fetch({ json: async () => ({ method, payload }) })
    return response.json()
  }

  const noSession = await call('shareCreate', { permission: 'read' })
  assert.equal(noSession.ok, false, 'a share needs a session')

  const noPermission = await call('shareCreate', { sessionId: 'session-1' })
  assert.equal(noPermission.ok, false, 'a share needs a permission')

  const noDirectory = await call('shareCreate', { sessionId: 'session-1', permission: 'read' })
  assert.equal(noDirectory.ok, false, 'a share needs a project directory')
})

test('the guest browses the project folder and may not leave it', async () => {
  const fixture = await setup()
  const { origin, record, server, project } = fixture
  const cookie = await unlock(fixture)

  const root = await request(`${origin}/share/${record.id}/api/tree`, { headers: { cookie } })
  assert.equal(root.status, 200)
  const listing = root.json()
  assert.equal(listing.path, '')
  const names = listing.entries.map((entry) => entry.name)
  assert.ok(names.includes('inside.txt'), 'the project folder lists its file')
  // A symlink out of the project is not listed at all.
  assert.ok(!names.includes('link.txt'), 'a symlink out of the project is not listed')
  assert.ok(!names.includes('link-dir'), 'a symlinked directory is not listed')

  const file = await request(`${origin}/share/${record.id}/api/file?path=inside.txt`, { headers: { cookie } })
  assert.equal(file.status, 200)
  assert.match(file.body, /inside the project/)

  // The paths that leave the project answer the same way as a path that does
  // not exist.
  for (const path of ['../outside.txt', 'link.txt', 'link-dir/secret.txt', '/etc/passwd']) {
    const answer = await request(`${origin}/share/${record.id}/api/file?path=${encodeURIComponent(path)}`, { headers: { cookie } })
    assert.equal(answer.status, 403, `the path ${path} is refused`)
  }
  const outside = await request(`${origin}/share/${record.id}/api/tree?path=${encodeURIComponent('../')}`, { headers: { cookie } })
  assert.equal(outside.status, 403, 'the tree does not leave the project')

  await server.close()
})

test('the guest reads the trajectory and the context of the shared session', async () => {
  const fixture = await setup()
  const { origin, record, server } = fixture
  const cookie = await unlock(fixture)

  const trajectory = await request(`${origin}/share/${record.id}/api/trajectory`, { headers: { cookie } })
  assert.equal(trajectory.status, 200)
  const steps = trajectory.json().steps
  assert.ok(Array.isArray(steps))
  // The conversation the owner shared is the trajectory the guest reads.
  assert.ok(steps.length > 0, 'the trajectory has steps')

  const context = await request(`${origin}/share/${record.id}/api/context`, { headers: { cookie } })
  assert.equal(context.status, 200)
  const summary = context.json()
  assert.ok(typeof summary.summary === 'string' && summary.summary.length > 0, 'the context says something')
  assert.ok(Array.isArray(summary.files))

  await server.close()
})

test('the tree and the projections need the passcode', async () => {
  const fixture = await setup()
  const { origin, record, server } = fixture

  for (const route of ['api/tree', 'api/trajectory', 'api/context']) {
    const answer = await request(`${origin}/share/${record.id}/${route}`)
    assert.equal(answer.status, 401, `${route} needs the passcode`)
  }

  await server.close()
})

test('a guest sees an image of the project as bytes', async () => {
  const fixture = await setup()
  const { origin, record, server, project } = fixture
  const cookie = await unlock(fixture)

  // A file that is not an image travels as text, not as bytes.
  const text = await request(`${origin}/share/${record.id}/api/blob?path=inside.txt`, { headers: { cookie } })
  assert.equal(text.status, 415, 'a text file is not an image')

  // A path that leaves the project answers like a path that does not exist.
  const outside = await request(`${origin}/share/${record.id}/api/blob?path=${encodeURIComponent('../outside.txt')}`, { headers: { cookie } })
  assert.equal(outside.status, 403, 'the image does not leave the project')

  await server.close()
})

test('the guest asset route needs the passcode', async () => {
  const fixture = await setup({ mermaidPath: makeMermaidFile() })
  const { origin, record, server } = fixture

  const locked = await request(`${origin}/share/${record.id}/api/asset?name=mermaid`)
  assert.equal(locked.status, 401, 'the library needs the passcode')

  const cookie = await unlock(fixture)
  const open = await request(`${origin}/share/${record.id}/api/asset?name=mermaid`, { headers: { cookie } })
  assert.equal(open.status, 200, 'the library opens once the passcode is proved')

  await server.close()
})

test('the guest asset route serves the mermaid library', async () => {
  const source = 'globalThis.mermaid = { initialize() {} }'
  const path = makeMermaidFile(source)
  let lookups = 0
  const fixture = await setup({
    mermaidPath: () => {
      lookups += 1
      return path
    },
  })
  const { origin, record, server } = fixture
  const cookie = await unlock(fixture)

  const answer = await request(`${origin}/share/${record.id}/api/asset?name=mermaid`, { headers: { cookie } })
  assert.equal(answer.status, 200)
  assert.equal(answer.headers['content-type'], 'application/javascript; charset=utf-8')
  assert.equal(answer.body, source, 'the library travels as it is on the disk')
  assert.equal(answer.headers['content-length'], String(Buffer.byteLength(source)))
  assert.equal(answer.headers['cache-control'], 'public, max-age=86400')
  assert.ok(answer.headers.etag, 'the answer carries an entity tag')

  // The bytes are kept in memory: the library is read once, not once per
  // request.
  const again = await request(`${origin}/share/${record.id}/api/asset?name=mermaid`, { headers: { cookie } })
  assert.equal(again.status, 200)
  assert.equal(again.body, source)
  assert.equal(lookups, 1, 'the library was looked up once')

  await server.close()
})

test('the guest asset route answers 404 when the library is not installed', async () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'remote-control-mermaid-')), 'mermaid.min.js')
  const fixture = await setup({ mermaidPath: missing })
  const { origin, record, server } = fixture
  const cookie = await unlock(fixture)

  const answer = await request(`${origin}/share/${record.id}/api/asset?name=mermaid`, { headers: { cookie } })
  assert.equal(answer.status, 404, 'there is no library to serve')
  assert.match(answer.body, /mermaid is unavailable/)

  await server.close()
})

test('the guest asset route serves nothing but the mermaid library', async () => {
  const fixture = await setup({ mermaidPath: makeMermaidFile() })
  const { origin, record, server } = fixture
  const cookie = await unlock(fixture)

  for (const name of ['', 'other', 'MERMAID', 'mermaid.min.js', '../../etc/passwd']) {
    const answer = await request(`${origin}/share/${record.id}/api/asset?name=${encodeURIComponent(name)}`, {
      headers: { cookie },
    })
    assert.equal(answer.status, 404, `the name "${name}" is refused`)
  }

  await server.close()
})

test('the room tells the guests who is here and what they hold', async () => {
  const fixture = await setup()
  const { origin, record } = fixture
  const cookie = await unlock(fixture)

  const empty = await request(`${origin}/share/${record.id}/api/room`, { headers: { cookie } })
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.json().guests, [], 'the room is empty at first')

  const joined = await request(`${origin}/share/${record.id}/api/room`, {
    method: 'POST',
    headers: { cookie },
    body: { id: 'guest-a', name: 'Ada', action: 'hello' },
  })
  assert.equal(joined.status, 200)
  assert.equal(joined.json().guests.length, 1, 'the guest is in the room')
  assert.equal(joined.json().guests[0].name, 'Ada')

  const focused = await request(`${origin}/share/${record.id}/api/room`, {
    method: 'POST',
    headers: { cookie },
    body: { id: 'guest-a', action: 'focus', file: 'inside.txt' },
  })
  assert.equal(focused.status, 200)
  assert.equal(focused.json().guests[0].file, 'inside.txt', 'the guest says what it has open')

  // A guest that wants to edit a file holds it.
  const held = await request(`${origin}/share/${record.id}/api/room`, {
    method: 'POST',
    headers: { cookie },
    body: { id: 'guest-a', action: 'editing', file: 'inside.txt', editing: true },
  })
  assert.equal(held.status, 200)
  assert.equal(held.json().locks.length, 1, 'the file is held')

  // The other guest is told who holds it.
  const other = await request(`${origin}/share/${record.id}/api/room`, {
    method: 'POST',
    headers: { cookie },
    body: { id: 'guest-b', name: 'Bob', action: 'editing', file: 'inside.txt', editing: true },
  })
  assert.equal(other.status, 423, 'a file belongs to one guest at a time')
  assert.equal(other.json().guest, 'Ada', 'the guest is told who holds it')

  await fixture.service.dispose()
  await fixture.server.close()
})

test('a guest saves a file, and the Host refuses a save of a file that moved on', async () => {
  const fixture = await setup({ permission: 'write' })
  const { origin, record, project } = fixture
  const cookie = await unlock(fixture)

  const read = await request(`${origin}/share/${record.id}/api/file?path=inside.txt`, { headers: { cookie } })
  assert.equal(read.status, 200)
  const version = read.headers['x-dsh-share-version']
  assert.ok(version, 'the file carries its version')

  const saved = await request(`${origin}/share/${record.id}/api/edit`, {
    method: 'POST',
    headers: { cookie },
    body: { path: 'inside.txt', content: 'the guest wrote this', version },
  })
  assert.equal(saved.status, 200, 'the guest writes the file')
  assert.equal(readFileSync(join(project.root, 'inside.txt'), 'utf8'), 'the guest wrote this')

  // The file moves on: the agent, or another guest.
  writeFileSync(join(project.root, 'inside.txt'), 'the agent wrote this')

  const stale = await request(`${origin}/share/${record.id}/api/edit`, {
    method: 'POST',
    headers: { cookie },
    body: { path: 'inside.txt', content: 'the guest writes again', version },
  })
  assert.equal(stale.status, 409, 'the save of a file that moved on is refused')
  assert.equal(stale.json().current, 'the agent wrote this', 'the guest is shown what the file holds now')
  assert.equal(readFileSync(join(project.root, 'inside.txt'), 'utf8'), 'the agent wrote this', 'the file was not overwritten')

  await fixture.service.dispose()
  await fixture.server.close()
})

test('a read-only share may not write a file', async () => {
  const fixture = await setup({ permission: 'read' })
  const { origin, record } = fixture
  const cookie = await unlock(fixture)

  const answer = await request(`${origin}/share/${record.id}/api/edit`, {
    method: 'POST',
    headers: { cookie },
    body: { path: 'inside.txt', content: 'no', version: '' },
  })
  assert.equal(answer.status, 403, 'a read-only share may not write')

  await fixture.service.dispose()
  await fixture.server.close()
})

test('a guest may not write a file outside the project', async () => {
  const fixture = await setup({ permission: 'write' })
  const { origin, record } = fixture
  const cookie = await unlock(fixture)

  const answer = await request(`${origin}/share/${record.id}/api/edit`, {
    method: 'POST',
    headers: { cookie },
    body: { path: '../outside.txt', content: 'no', version: '' },
  })
  assert.equal(answer.status, 403, 'the file does not leave the project')

  await fixture.service.dispose()
  await fixture.server.close()
})

test('a stream that cannot start does not answer twice', async () => {
  // The head of the event stream is already sent when the Host finds that it
  // has no stream to send. A second answer would take the Host down.
  const fixture = await setup({ brokenStream: true })
  const { origin, record } = fixture
  const cookie = await unlock(fixture)

  const answer = await request(`${origin}/share/${record.id}/api/stream`, { headers: { cookie } })
  assert.equal(answer.status, 200, 'the stream answers once')
  assert.match(answer.headers['content-type'] ?? '', /text\/event-stream/, 'the answer is a stream')

  await fixture.service.dispose()
  await fixture.server.close()
})

test('the guest that holds a file may save it, and the other one may not', async () => {
  const fixture = await setup({ permission: 'write' })
  const { origin, record } = fixture
  const cookie = await unlock(fixture)

  // Ada holds the file.
  const held = await request(`${origin}/share/${record.id}/api/room`, {
    method: 'POST',
    headers: { cookie },
    body: { id: 'ada', name: 'Ada', action: 'editing', file: 'inside.txt', editing: true },
  })
  assert.equal(held.status, 200, 'Ada holds the file')

  // She may save it.
  const read = await request(`${origin}/share/${record.id}/api/file?path=inside.txt`, { headers: { cookie } })
  const saved = await request(`${origin}/share/${record.id}/api/edit`, {
    method: 'POST',
    headers: { cookie },
    body: { path: 'inside.txt', content: 'Ada wrote this', version: read.headers['x-dsh-share-version'], guest: 'ada' },
  })
  assert.equal(saved.status, 200, 'the guest that holds the file may save it')

  // Bob may not.
  const refused = await request(`${origin}/share/${record.id}/api/edit`, {
    method: 'POST',
    headers: { cookie },
    body: { path: 'inside.txt', content: 'Bob wrote this', version: read.headers['x-dsh-share-version'], guest: 'bob' },
  })
  assert.equal(refused.status, 423, 'the other guest may not write the file')
  assert.equal(refused.json().guest, 'Ada', 'the guest is told who holds it')

  await fixture.service.dispose()
  await fixture.server.close()
})

test('the guests of a share edit one document, and it reaches the file', async () => {
  const fixture = await setup({ permission: 'write' })
  const { origin, record, project } = fixture
  const cookie = await unlock(fixture)

  // A guest opens the document of a file.
  const opened = await request(`${origin}/share/${record.id}/api/collab`, {
    method: 'POST',
    headers: { cookie },
    body: { action: 'open', path: 'inside.txt', client: 11 },
  })
  assert.equal(opened.status, 200, 'the guest opens the document')
  assert.ok(opened.json().state.length > 0, 'the document travels to the guest')

  // The other guest opens it too and finds the same text.
  const second = await request(`${origin}/share/${record.id}/api/collab`, {
    method: 'POST',
    headers: { cookie },
    body: { action: 'open', path: 'inside.txt', client: 22 },
  })
  assert.equal(second.status, 200, 'the other guest opens the document')
  assert.equal(second.json().state, opened.json().state, 'both guests hold the same document')

  // A change of one guest reaches the other. The change is a real one: the
  // guest that types hands out the bytes the document produced.
  const Y = await import('yjs')
  const guest = new Y.Doc()
  Y.applyUpdate(guest, Buffer.from(opened.json().state, 'base64'))
  let produced = null
  guest.on('update', (bytes) => { produced = bytes })
  guest.getText('content').insert(0, 'a change\n')

  const changed = await request(`${origin}/share/${record.id}/api/collab`, {
    method: 'POST',
    headers: { cookie },
    body: { action: 'update', path: 'inside.txt', client: 11, update: Buffer.from(produced ?? []).toString('base64') },
  })
  assert.equal(changed.status, 200, 'the change is taken')

  // A change that is not a change is refused.
  const rubbish = await request(`${origin}/share/${record.id}/api/collab`, {
    method: 'POST',
    headers: { cookie },
    body: { action: 'update', path: 'inside.txt', client: 11, update: Buffer.from('not a change').toString('base64') },
  })
  assert.equal(rubbish.status, 400, 'a change that is not one is refused')

  guest.destroy()
  await fixture.service.dispose()
  await fixture.service.dispose()
  await fixture.server.close()
})

test('a write that is refused keeps the text of the guest and tells them', async () => {
  // The session is alive: the stream of the room stays open, and the room
  // can tell the guest what happened.
  const fixture = await setup({ permission: 'write', live: true })
  const { origin, record, project } = fixture
  const cookie = await unlock(fixture)

  // The guest opens the document of a file.
  const opened = await request(`${origin}/share/${record.id}/api/collab`, {
    method: 'POST',
    headers: { cookie },
    body: { action: 'open', path: 'inside.txt', client: 11 },
  })
  assert.equal(opened.status, 200, 'the guest opens the document')

  // The guest is in the room, and the stream is open: the room can tell the
  // guest what happened.
  const joined = await request(`${origin}/share/${record.id}/api/room`, {
    method: 'POST',
    headers: { cookie },
    body: { id: 'guest-1', name: 'Ada', action: 'hello' },
  })
  assert.equal(joined.status, 200, 'the guest is in the room')
  const stream = openStream(`${origin}/share/${record.id}/api/stream`, { headers: { cookie } })

  // The guest types.
  const Y = await import('yjs')
  const guest = new Y.Doc()
  Y.applyUpdate(guest, Buffer.from(opened.json().state, 'base64'))
  let produced = null
  guest.on('update', (bytes) => { produced = bytes })
  guest.getText('content').insert(0, 'a change\n')
  const changed = await request(`${origin}/share/${record.id}/api/collab`, {
    method: 'POST',
    headers: { cookie },
    body: { action: 'update', path: 'inside.txt', client: 11, update: Buffer.from(produced ?? []).toString('base64') },
  })
  assert.equal(changed.status, 200, 'the change is taken')

  // The file moves on under the guest: the agent rewrote it.
  writeFileSync(join(project.root, 'inside.txt'), 'the agent rewrote this\n')

  // The write is refused, and the guests are told: a text that does not
  // reach the file without a word is a text that is lost.
  await waitFor(
    () => stream.frames().some((frame) => frame.kind === 'collab-save-failed'),
    'the guests are told that the write was refused',
  )

  // What the guest wrote is still there: it is not thrown away.
  const reopened = await request(`${origin}/share/${record.id}/api/collab`, {
    method: 'POST',
    headers: { cookie },
    body: { action: 'open', path: 'inside.txt', client: 11 },
  })
  const kept = new Y.Doc()
  Y.applyUpdate(kept, Buffer.from(reopened.json().state, 'base64'))
  assert.match(
    kept.getText('content').toString(),
    /a change/,
    'the text of the guest is not thrown away',
  )

  // And the file holds what the agent wrote: the refused write did not
  // overwrite the work of the agent.
  assert.equal(
    readFileSync(join(project.root, 'inside.txt'), 'utf8'),
    'the agent rewrote this\n',
    'the file holds the work of the agent',
  )

  stream.close()
  guest.destroy()
  kept.destroy()
  await fixture.service.dispose()
  await fixture.server.close()
})

test('the yjs bundle travels to the guest', async () => {
  const fixture = await setup()
  const { origin, record } = fixture
  const cookie = await unlock(fixture)

  const answer = await request(`${origin}/share/${record.id}/api/asset?name=yjs`, { headers: { cookie } })
  assert.equal(answer.status, 200, 'the bundle is served')
  assert.match(answer.headers['content-type'] ?? '', /javascript/, 'the bundle is a script')
  assert.ok(answer.body.length > 10_000, 'the bundle carries the library')

  const other = await request(`${origin}/share/${record.id}/api/asset?name=whatever`, { headers: { cookie } })
  assert.equal(other.status, 404, 'no other asset is served')

  await fixture.service.dispose()
  await fixture.server.close()
})

test('the stream tells the guests which message is worked on and what waits', async () => {
  const fixture = await setup({ permission: 'write', live: true })
  const { origin, record } = fixture
  const cookie = await unlock(fixture)

  // The guest sends a message: it waits in the queue of the conversation.
  await request(`${origin}/share/${record.id}/api/message`, {
    method: 'POST',
    headers: { cookie },
    body: { text: 'hello', guest: 'g1', from: 'Ada' },
  })

  // The stream of the session: the words of the people come as events, and
  // the queue comes with them.
  const stream = openStream(`${origin}/share/${record.id}/api/stream`, { headers: { cookie } })
  await waitFor(
    () => stream.frames().some((frame) => frame.kind === 'queue' && frame.working !== null),
    'the stream carries the queue',
  )
  const queue = stream.frames().filter((frame) => frame.kind === 'queue').pop()
  assert.equal(queue.working.text, 'hello', 'the word that is worked on is told')
  assert.equal(queue.working.from, 'Ada', 'the guest who sent it is told')
  assert.deepEqual(queue.waiting, [], 'nothing waits behind it')

  stream.close()
  await fixture.service.dispose()
  await fixture.server.close()
})

test('every guest of the share sees the same queue', async () => {
  const fixture = await setup({ permission: 'write', live: true })
  const { origin, record } = fixture
  const cookie = await unlock(fixture)

  const first = openStream(`${origin}/share/${record.id}/api/stream`, { headers: { cookie } })
  const second = openStream(`${origin}/share/${record.id}/api/stream`, { headers: { cookie } })
  await first.wait(1)
  await second.wait(1)

  // One guest sends a message: the other one is told about it too.
  await request(`${origin}/share/${record.id}/api/message`, {
    method: 'POST',
    headers: { cookie },
    body: { text: 'mine too', guest: 'g2', from: 'Bob' },
  })

  await waitFor(
    () => first.frames().some((frame) => frame.kind === 'queue'),
    'the first guest sees the queue',
  )
  await waitFor(
    () => second.frames().some((frame) => frame.kind === 'queue'),
    'the second guest sees the queue',
  )
  const mine = first.frames().filter((frame) => frame.kind === 'queue').pop()
  const theirs = second.frames().filter((frame) => frame.kind === 'queue').pop()
  assert.deepEqual(mine, theirs, 'both guests are told the same thing')
  assert.equal(mine.waiting.length + (mine.working === null ? 0 : 1), 1, 'the queue holds the message')

  first.close()
  second.close()
  await fixture.service.dispose()
  await fixture.server.close()
})

test('a message the Host records shorter is told to the guests', async () => {
  const fixture = await setup({ permission: 'write', shortMessage: true })
  const { origin, record } = fixture
  const cookie = await unlock(fixture)

  // The guest sends a message the Host will not record whole.
  const sent = await request(`${origin}/share/${record.id}/api/message`, {
    method: 'POST',
    headers: { cookie },
    body: { text: 'hello and the rest of it' },
  })
  assert.equal(sent.status, 200, 'the message is accepted')

  const stream = await request(`${origin}/share/${record.id}/api/stream`, { headers: { cookie } })
  const frames = stream.body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
  const shortened = frames.find((frame) => frame.kind === 'shortened')
  assert.ok(shortened !== undefined, 'the guests are told')
  assert.equal(shortened.recorded, 'hello', 'the words the Host recorded are told')
  assert.equal(shortened.sent, 'hello and the rest of it', 'the words the guest sent are told')

  // The words that are missing are said again, whole.
  await waitFor(
    () => fixture.host.prompts.some((prompt) => prompt.mode === 'steer'),
    'the whole message is said again',
  )
  const said = fixture.host.prompts.map((prompt) => prompt.content?.[0]?.text)
  assert.ok(
    said.includes('hello and the rest of it'),
    'the whole message is said again',
  )

  await fixture.service.dispose()
  await fixture.server.close()
})
