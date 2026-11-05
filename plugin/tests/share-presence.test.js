/**
 * The presence of a shared conversation.
 *
 * A share is a room, and the owner of the conversation sees who is in it: the
 * room tells the owner who is there and who is writing, live, while the
 * guests of the share write in it.
 *
 * The tests run the real room and the real service: the room over its own
 * API, and the service over HTTP, the way a guest and the owner of the
 * conversation meet it.
 *
 * Run with: `node --test tests/share-presence.test.js`
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createShareService } from '../src/share-service.js'
import { createShareRooms, SHARE_TYPING_TTL_MS } from '../src/share-room.js'
import { guestColor, guestInitial } from '../src/share-identity.js'

const SECRET = 'device-secret-for-the-presence-tests'

/**
 * One HTTP request.
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
 * One share, a service and a running guest server.
 *
 * @param {{ now?: () => number }} [options]
 * @returns {Promise<any>}
 */
async function setup(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'remote-control-presence-'))
  process.env.DSH_PROFILE_DIR = dir
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  const service = createShareService({ secret: SECRET, now: options.now })
  const record = service.create({
    sessionId: 'session-1',
    title: 'The shared session',
    permission: 'write',
    projectRoot: root,
  })
  const server = http.createServer((req, res) => {
    void service.handle(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const origin = `http://127.0.0.1:${port}`
  const unlocked = await request(`${origin}/share/${record.id}/unlock`, {
    method: 'POST',
    body: { passcode: record.passcode },
  })
  const cookie = cookieOf(unlocked.headers)
  assert.ok(cookie, 'the passcode opens the share')
  return {
    service,
    record,
    origin,
    cookie,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

/**
 * Read the frames of a presence stream, one at a time.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {{ next: () => Promise<any> }}
 */
function readFrames(stream) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return {
    async next() {
      for (;;) {
        const cut = buffer.indexOf('\n\n')
        if (cut !== -1) {
          const block = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          const line = block.split('\n').find((entry) => entry.startsWith('data:'))
          if (line !== undefined) return JSON.parse(line.slice(5).trim())
          continue
        }
        const chunk = await reader.read()
        if (chunk.done === true) return undefined
        buffer += decoder.decode(chunk.value, { stream: true })
      }
    },
  }
}

/* ------------------------------------------------------------------- the room */

test('the room knows who is writing, and forgets it when it stops', () => {
  const rooms = createShareRooms()
  rooms.join('s_1', { id: 'guest-a', name: 'Ada' })
  assert.equal(rooms.view('s_1').guests[0].typing, false, 'a guest does not write at first')

  rooms.setTyping('s_1', 'guest-a', true)
  assert.equal(rooms.view('s_1').guests[0].typing, true, 'the guest is writing')

  rooms.setTyping('s_1', 'guest-a', false)
  assert.equal(rooms.view('s_1').guests[0].typing, false, 'the guest stopped writing')
})

test('the words of a guest expire on their own', () => {
  // The clock of the room is the clock of the Host, so the test can move it.
  let clock = 1_000
  const rooms = createShareRooms({ now: () => clock })
  rooms.join('s_1', { id: 'guest-a', name: 'Ada' })
  rooms.setTyping('s_1', 'guest-a', true)
  assert.equal(rooms.view('s_1').guests[0].typing, true, 'the guest is writing')

  clock += SHARE_TYPING_TTL_MS - 1
  assert.equal(rooms.view('s_1').guests[0].typing, true, 'the words are still there')

  // A guest that closes its tab in the middle never says that it stopped.
  clock += 2
  assert.equal(rooms.view('s_1').guests[0].typing, false, 'the words ran out')
})

test('the owner of the room hears who is in it', () => {
  const rooms = createShareRooms()
  /** @type {string[]} */
  const frames = []
  const stop = rooms.subscribeOwner('s_1', (line) => frames.push(line))
  rooms.join('s_1', { id: 'guest-a', name: 'Ada' })
  rooms.announce('s_1')
  assert.equal(frames.length, 1, 'the owner hears the room')
  const frame = JSON.parse(frames[0].slice('data: '.length))
  assert.equal(frame.kind, 'presence')
  assert.equal(frame.guests[0].name, 'Ada', 'the owner sees who is in the room')

  stop()
  rooms.announce('s_1')
  assert.equal(frames.length, 1, 'the owner that left hears nothing more')
})

test('the colour of a guest is the same everywhere it is shown', () => {
  const rooms = createShareRooms()
  rooms.join('s_1', { id: 'guest-a', name: 'Ada' })
  const guest = rooms.view('s_1').guests[0]
  assert.equal(guest.color, guestColor('guest-a'), 'the room carries the colour of the guest')
  assert.equal(guestInitial('Ada'), 'A', 'the guest has a face')
  assert.equal(guestInitial(''), '?', 'a guest without a name still has a face')
})

/* ----------------------------------------------------------------- the owner */

test('the owner of a conversation sees who is in its room', async () => {
  const fixture = await setup()
  const { origin, record, service, cookie } = fixture

  const empty = service.ownerRoom('session-1')
  assert.deepEqual(empty.guests, [], 'the room of the owner is empty at first')

  const joined = await request(`${origin}/share/${record.id}/api/room`, {
    method: 'POST',
    headers: { cookie },
    body: { id: 'guest-a', name: 'Ada', action: 'hello' },
  })
  assert.equal(joined.status, 200)

  const room = service.ownerRoom('session-1')
  assert.equal(room.guests.length, 1, 'the owner sees the guest')
  assert.equal(room.guests[0].name, 'Ada', 'the owner sees the name of the guest')
  assert.equal(room.guests[0].shareId, record.id, 'the owner knows the share the guest came through')

  await fixture.close()
})

test('a guest says that it is writing, and the owner hears it', async () => {
  const fixture = await setup()
  const { origin, record, service, cookie } = fixture

  await request(`${origin}/share/${record.id}/api/room`, {
    method: 'POST',
    headers: { cookie },
    body: { id: 'guest-a', name: 'Ada', action: 'hello' },
  })

  const writing = await request(`${origin}/share/${record.id}/api/room`, {
    method: 'POST',
    headers: { cookie },
    body: { id: 'guest-a', action: 'typing', typing: true },
  })
  assert.equal(writing.status, 200)
  assert.equal(writing.json().guests[0].typing, true, 'the room says that the guest is writing')
  assert.equal(service.ownerRoom('session-1').guests[0].typing, true, 'the owner sees it as well')

  const stopped = await request(`${origin}/share/${record.id}/api/room`, {
    method: 'POST',
    headers: { cookie },
    body: { id: 'guest-a', action: 'typing', typing: false },
  })
  assert.equal(stopped.json().guests[0].typing, false, 'the guest stopped writing')

  await fixture.close()
})

test('the room of the owner is a stream that carries every change', async () => {
  const fixture = await setup()
  const { origin, record, service, cookie } = fixture

  const controller = new AbortController()
  const frames = readFrames(service.presenceStream('session-1', controller.signal))

  const first = await frames.next()
  assert.equal(first.kind, 'presence')
  assert.deepEqual(first.guests, [], 'the stream opens with the room as it is')

  await request(`${origin}/share/${record.id}/api/room`, {
    method: 'POST',
    headers: { cookie },
    body: { id: 'guest-a', name: 'Ada', action: 'hello' },
  })

  const second = await frames.next()
  assert.equal(second.guests.length, 1, 'the stream carries the guest that joined')
  assert.equal(second.guests[0].name, 'Ada')

  await request(`${origin}/share/${record.id}/api/room`, {
    method: 'POST',
    headers: { cookie },
    body: { id: 'guest-a', action: 'typing', typing: true },
  })

  const third = await frames.next()
  assert.equal(third.guests[0].typing, true, 'the stream carries the words of the guest')

  // The owner that goes away takes its stream with it.
  controller.abort()

  await fixture.close()
})

test('a share that is gone takes its guests with it', async () => {
  const fixture = await setup()
  const { origin, record, service, cookie } = fixture

  await request(`${origin}/share/${record.id}/api/room`, {
    method: 'POST',
    headers: { cookie },
    body: { id: 'guest-a', name: 'Ada', action: 'hello' },
  })
  assert.equal(service.ownerRoom('session-1').guests.length, 1, 'the guest is in the room')

  assert.equal(service.remove(record.id), true, 'the share is gone')
  assert.deepEqual(service.ownerRoom('session-1').guests, [], 'the owner does not see the guests of a dead link')

  await fixture.close()
})
