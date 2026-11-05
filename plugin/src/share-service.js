/**
 * The guest-facing half of session sharing.
 *
 * A share is a link that opens one conversation to a guest who knows a
 * passcode. The guest never becomes an owner: the host's own browser session
 * stays out of it, the guest gets a cookie of its own, and the guest only ever
 * sees the one session the share names.
 *
 * The service owns three things the host does not:
 *
 *   1. **The guest credential** — the passcode check, the per-caller lockout
 *      and the cookie that carries a proved passcode.
 *   2. **The project boundary** — the host does not confine file reads (a
 *      plugin reads whatever it can reach), so this service resolves every
 *      guest path against the project root and refuses anything outside it.
 *   3. **The view** — a small, self-contained page that shows the shared
 *      conversation, and lets a write share put a message into it.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

import {
  createShare,
  deleteShare,
  getShare,
  listShares,
  shareView,
  updateShare,
} from './share-store.js'

import {
  isHostContext,
  isSafeRelativePath,
  listShareDirectory,
  projectContext,
  projectStep,
  projectSteps,
  projectTrajectory,
  readShareText,
  resolveWithinRoot,
} from './share-data.js'

import { renderGuestPage } from './share-page.js'
import { createShareRooms } from './share-room.js'
import { createShareQueues } from './share-queue.js'
import { createCollab } from './share-collab.js'
import { fileKindOf } from './share-files.js'
import {
  createAssetStore,
  SHARE_ASSET_MAX_AGE_SECONDS,
  SHARE_ASSET_MERMAID_TYPE,
} from './share-asset.js'

// The path boundary belongs to the data module; the service re-exports it so
// the tests and the reader of this file find it in one place.
export { isSafeRelativePath, resolveWithinRoot, renderGuestPage }

/** How long a proved passcode stays valid: one day. */
export const SHARE_COOKIE_MAX_AGE_SECONDS = 86_400

/** How many wrong passcodes one caller may spend before the lock bites. */
export const SHARE_MAX_FAILURES = 5

/** How long a caller stays locked out after too many wrong passcodes. */
export const SHARE_LOCKOUT_MS = 10 * 60 * 1000

/** The largest file a guest may read. */
export /** How many bytes an upload of a guest may carry: the body limit. */
const SHARE_ATTACHMENT_MAX_BYTES = 12 * 1024 * 1024

/** How long a guest may be silent before the room forgets it. */
const SHARE_GUEST_SILENCE_MS = 90_000

const SHARE_MAX_FILE_BYTES = 2 * 1024 * 1024

/** The largest number of messages the guest view carries at once. */
export const SHARE_MAX_MESSAGES = 200

/** The path the guest routes live under. */
export const SHARE_ROUTE_PREFIX = '/share/'

/** The cookie one share sets once its passcode was proved. */
export function shareCookieName(id) {
  return `dsh-share-${id}`
}

/**
 * The HMAC that backs one guest cookie.
 *
 * The secret is the device secret — the same one the relay authenticates with
 * — so a guest cookie cannot be forged without the device credential, and it
 * dies with a rotated secret.
 *
 * @param {string} secret the device secret
 * @param {string} id the share id
 * @param {number} issuedAt when the cookie was issued, in milliseconds
 * @returns {string} the base64url HMAC
 */
export function signShareCookie(secret, id, issuedAt) {
  return createHmac('sha256', secret).update(`share:${id}:${issuedAt}`).digest('base64url')
}

/**
 * The value of one guest cookie.
 *
 * The issued timestamp travels with the HMAC: the HMAC covers it, so a guest
 * cannot move it, and the server needs it to know how old the cookie is.
 *
 * @param {string} secret the device secret
 * @param {string} id the share id
 * @param {number} issuedAt when the cookie was issued, in milliseconds
 * @returns {string}
 */
export function shareCookieValue(secret, id, issuedAt) {
  return `${issuedAt}.${signShareCookie(secret, id, issuedAt)}`
}

/**
 * Is this a valid guest cookie for this share?
 *
 * @param {string} secret the device secret
 * @param {string} id the share id
 * @param {string | undefined} value the raw cookie value
 * @param {{ now?: number, maxAgeSeconds?: number }} [options]
 * @returns {boolean}
 */
export function verifyShareCookie(secret, id, value, options = {}) {
  if (typeof value !== 'string') return false
  const at = value.indexOf('.')
  if (at <= 0) return false
  const issuedAt = Number(value.slice(0, at))
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) return false
  const now = options.now ?? Date.now()
  const maxAge = options.maxAgeSeconds ?? SHARE_COOKIE_MAX_AGE_SECONDS
  const age = (now - issuedAt) / 1000
  if (age < 0 || age > maxAge) return false
  const expected = Buffer.from(shareCookieValue(secret, id, issuedAt))
  const given = Buffer.from(value)
  if (expected.length !== given.length) return false
  return timingSafeEqual(expected, given)
}

/**
 * The caller's address.
 *
 * The relay forwards the phone's address in `x-forwarded-for`, so the lockout
 * belongs to the caller and not to the host process every request arrives
 * from. Without that header every guest would share one address, and a
 * stranger could lock the owner out of their own link.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
export function callerAddress(req) {
  const forwarded = req?.headers?.['x-forwarded-for']
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded
  const first = String(value ?? '').split(',')[0].trim()
  if (first.length > 0) return first
  return String(req?.socket?.remoteAddress ?? 'unknown')
}

/**
 * One cookie value out of a `Cookie` header.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} name
 * @returns {string | undefined}
 */
export function readCookie(req, name) {
  const raw = req?.headers?.cookie
  const value = Array.isArray(raw) ? raw.join('; ') : String(raw ?? '')
  for (const segment of value.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim()
  }
  return undefined
}

/**
 * Does this request come from another site?
 *
 * The guest cookie is `SameSite=Lax`, so a cross-site form post would not
 * carry it — but the check is cheap and it closes the gap a browser with a
 * laxer policy would leave open.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function isCrossSite(req) {
  const site = String(req?.headers?.['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return true
  const origin = req?.headers?.origin
  if (typeof origin !== 'string' || origin.length === 0) return false
  const host = String(req?.headers?.host ?? '')
  if (host.length === 0) return false
  try {
    return new URL(origin).host !== host
  } catch {
    return true
  }
}

/**
 * The text of one message's content blocks.
 *
 * @param {unknown} content
 * @returns {string}
 */
export function textOfContent(content) {
  // A message may carry its words as one string or as a list of blocks.
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const entry = /** @type {Record<string, unknown>} */ (block)
    if (entry.type !== 'text') continue
    if (typeof entry.text !== 'string') continue
    parts.push(entry.text)
  }
  return parts.join('\n')
}

/**
 * The media type of one image.
 *
 * @param {string} path
 * @returns {string} the media type, or the empty string
 */
export function imageTypeOf(path) {
  const name = String(path ?? '').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  const extension = dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
  const types = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
  }
  return types[extension] ?? ''
}

/**
 * The guest view of one session event.
 *
 * Only the conversation is shown here: the rest of the log carries tool
 * calls, request headers and projections that mean nothing to a guest. A tool
 * result is a step of the agent's work, not a message of the conversation, so
 * it collapses into one line — the Trajectory tab carries the steps.
 *
 * @param {any} event
 * @returns {{ role: string, text: string, time: number, seq: number } | undefined}
 */
export function projectMessage(event) {
  if (typeof event !== 'object' || event === null) return undefined
  const type = event.type
  if (type !== 'user/message' && type !== 'assistant/message' && type !== 'tool/result') return undefined
  const data = event.data
  if (typeof data !== 'object' || data === null) return undefined
  const message = type === 'user/message' ? data : data.message
  if (typeof message !== 'object' || message === null) return undefined
  const role = /** @type {Record<string, unknown>} */ (message).role
  if (typeof role !== 'string') return undefined
  const content = /** @type {Record<string, unknown>} */ (message).content
  const text = role === 'tool'
    ? summarizeToolResult(content)
    : textOfContent(content)
  return {
    role,
    text,
    time: typeof event.time === 'number' ? event.time : 0,
    seq: typeof event.seq === 'number' ? event.seq : 0,
  }
}

/**
 * One line of a tool result.
 *
 * A tool result carries the raw output of a command — pages of JSON, whole
 * files. That belongs in the Trajectory tab; in the conversation it is noise,
 * so only its size is reported.
 *
 * @param {unknown} content
 * @returns {string}
 */
export function summarizeToolResult(content) {
  const text = textOfContent(Array.isArray(content) ? content : []).trim()
  if (text.length === 0) return 'Ran a tool'
  const lines = text.split('\n').length
  const size = text.length > 1024 ? `${(text.length / 1024).toFixed(1)} KB` : `${text.length} B`
  return `Ran a tool · ${lines} ${lines === 1 ? 'line' : 'lines'} · ${size}`
}

/**
 * The guest view of a list of session events.
 *
 * @param {readonly any[]} events
 * @returns {{ role: string, text: string, time: number, seq: number }[]}
 */
export function projectMessages(events) {
  const messages = []
  for (const event of events ?? []) {
    const message = projectMessage(event)
    if (message !== undefined) messages.push(message)
  }
  return messages
}

/**
 * The service.
 *
 * @param {object} options
 * @param {any} options.ctx the plugin context
 * @param {string} options.secret the device secret
 * @param {any} [options.sessionQuery] the host session query service
 * @param {any} [options.sessionController] the host session controller service
 * @param {any} [options.fs] the host filesystem service
 * @param {string | (() => string | undefined | Promise<string | undefined>) | undefined} [options.mermaidPath] where the mermaid bundle lives: a path, or a function that answers one
 * @param {(message: string, extra?: unknown) => void} [options.log]
 * @param {() => number} [options.now]
 */
export function createShareService(options = {}) {
  // The room of every share: the guests, the files they hold and the frames
  // they hear. The Host serves the event stream of every guest, so this is
  // already the one place where the guests of a share meet.
  //
  // The owner of the share is not a guest of the room, but it has to see who
  // is in it: the sinks of the owner wait for the changes of the room and
  // carry them to the browser that holds the conversation.
  /** @type {Map<string, Set<(line: string) => void>>} the owners that watch, by session */
  const ownerSinks = new Map()
  const rooms = options.rooms ?? createShareRooms({
    onPresence: (shareId) => { publishOwnerPresence(shareId) },
    now: options.now,
  })
  /** @type {Map<string, NodeJS.Timeout>} the saves that wait for the guests to stop typing */
  const pendingSaves = new Map()
  /** @type {Map<string, { close: () => Promise<void> }>} the watchers of the files guests have open */
  const watchers = new Map()
  /** @type {Map<string, { text: string, at: number }[]>} the words the guests sent, by share */
  const sentWordsByShare = new Map()

  /**
   * Keep the words a guest sent, so that a message the Host records shorter
   * can be told to the guest.
   *
   * @param {string} shareId
   * @param {string} text
   */
  function sentWords(shareId, text) {
    const list = sentWordsByShare.get(shareId) ?? []
    list.push({ text, at: Date.now(), again: false })
    while (list.length > 20) list.shift()
    sentWordsByShare.set(shareId, list)
  }

  /**
   * The name of the guest that sent a message.
   *
   * The room knows the name of every guest that joined it, and the room is
   * the truth about it: a guest that is in the room is the one whose name the
   * room carries. The name in the body of the request is only a fallback, for
   * a guest that sends before it has said hello.
   *
   * @param {any} share
   * @param {any} body
   * @returns {string}
   */
  function guestNameOf(share, body) {
    const guestId = typeof body?.guest === 'string' ? body.guest : ''
    const known = rooms.view(share.id).guests.find((guest) => guest.id === guestId)
    const name = known?.name ?? (typeof body?.from === 'string' ? body.from : '')
    // The name is shown to the other guests of the share: it is a label, not
    // a document, and it must not be able to break the line it sits in.
    return name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40)
  }

  /**
   * Say a word of a guest again, whole.
   *
   * The Host recorded the message shorter than it was given, and the words
   * that are missing would otherwise be lost. The message goes through the
   * queue a second time, and it is not sent a third time if the Host cuts
   * it again.
   *
   * @param {any} share
   * @param {string} text
   * @returns {Promise<void>}
   */
  async function sayAgain(share, text) {
    try {
      // The words are said again as a steer: a message that waits in the
      // queue is cut by the Host, and the point of this one is to arrive
      // whole.
      await promptSession(share, text, new AbortController().signal, undefined, 'steer')
    } catch (error) {
      log('share: a message could not be said again', { error: String(error) })
    }
  }
  const { ctx, secret, log = () => {}, now = () => Date.now() } = options
  // The documents the guests edit together, one per file of a share. It is
  // made after the log, which it reports to.
  const collab = options.collab ?? createCollab({ log })

  // The libraries the guest page loads. The store keeps the bytes in memory
  // and knows where the library lives; the request never says.
  const assets = createAssetStore({ path: options.mermaidPath, log })

  /**
   * Resolve one host service: the explicit one wins, the context is the
   * fallback.
   * @param {string} name
   * @param {any} explicit
   * @returns {any}
   */
  function service(name, explicit) {
    if (explicit !== undefined) return explicit
    if (ctx === undefined || typeof ctx.get !== 'function') return undefined
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }

  /**
   * The queue of every shared conversation.
   *
   * The Host digests the messages of a conversation one at a time, so the
   * plugin keeps the queue itself: one message is handed to the Host at a
   * time, the next waits behind it, and every guest of the share is told
   * where their words stand.
   */
  const queues = createShareQueues({
    follow: async (request, signal) => {
      const controller = service('sessionController', options.sessionController)
      if (controller === undefined || typeof controller.follow !== 'function') return undefined
      return controller.follow(request, signal)
    },
    prompt: async (share, item, signal) => {
      await promptSession(share, item.text, signal, item.parts)
    },
    onChange: (shareId, frame) => {
      // The queue is one thing that the guests of a share all see: it goes to
      // every one of them at the same moment.
      rooms.broadcast(shareId, frame)
    },
    log,
    now,
  })

  /** @type {Map<string, { failures: number, firstFailureAt: number, lockedUntil: number }>} */
  const attempts = new Map()

  /**
   * The room of every share of one conversation, as the owner sees it.
   *
   * A conversation may be shared more than once, and every share has its own
   * room: the view of the owner gathers them, so the owner sees everybody who
   * is in the conversation and not only the ones of one link.
   *
   * @param {string} sessionId
   * @returns {{ kind: 'presence', sessionId: string, guests: any[], locks: any[] }}
   */
  function ownerRoom(sessionId) {
    const guests = []
    const locks = []
    for (const share of listShares()) {
      if (share.sessionId !== sessionId) continue
      if (share.revokedAt !== null && share.revokedAt !== undefined) continue
      const view = rooms.view(share.id)
      for (const guest of view.guests) guests.push({ ...guest, shareId: share.id })
      for (const lock of view.locks) locks.push({ ...lock, shareId: share.id })
    }
    return { kind: 'presence', sessionId, guests, locks }
  }

  /**
   * Tell the owner of a conversation who is in its room.
   *
   * @param {string} shareId
   */
  function publishOwnerPresence(shareId) {
    const share = getShare(shareId)
    if (share === undefined) return
    publishOwnerRoom(share.sessionId)
  }

  /**
   * Tell the owner of a conversation who is in its room.
   *
   * @param {string} sessionId
   */
  function publishOwnerRoom(sessionId) {
    const sinks = ownerSinks.get(sessionId)
    if (sinks === undefined || sinks.size === 0) return
    const line = `data: ${JSON.stringify(ownerRoom(sessionId))}\n\n`
    for (const sink of sinks) {
      try {
        sink(line)
      } catch (error) {
        // The owner that went away takes its sink with it; the others carry on.
      }
    }
  }

  /**
   * The live room of one conversation, as a stream of frames.
   *
   * The owner of a conversation does not poll for it: the stream carries every
   * change of the room, so the browser that holds the conversation knows who
   * is in it and who is writing, without asking.
   *
   * @param {string} sessionId
   * @param {AbortSignal} [signal] the signal of the request: the stream ends
   *   with it
   * @returns {ReadableStream<Uint8Array>}
   */
  function presenceStream(sessionId, signal) {
    const encoder = new TextEncoder()
    let closed = false
    let heartbeat = null
    let unsubscribe = () => {}
    let stream = null
    const close = () => {
      if (closed) return
      closed = true
      if (heartbeat !== null) clearInterval(heartbeat)
      heartbeat = null
      unsubscribe()
      if (stream === null) return
      try {
        stream.close()
      } catch (error) {
        // The stream is already closed.
      }
    }
    return new ReadableStream({
      start(controller) {
        stream = controller
        const sink = (line) => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(line))
          } catch (error) {
            // The browser that went away is not waiting for the frame.
          }
        }
        let sinks = ownerSinks.get(sessionId)
        if (sinks === undefined) {
          sinks = new Set()
          ownerSinks.set(sessionId, sinks)
        }
        sinks.add(sink)
        unsubscribe = () => {
          sinks.delete(sink)
          if (sinks.size === 0) ownerSinks.delete(sessionId)
        }
        // The owner sees the room as it is, and every change of it after.
        sink(`data: ${JSON.stringify(ownerRoom(sessionId))}\n\n`)
        // A stream that says nothing for a while is cut by the proxies between
        // the browser and the Host, so the stream says that it is alive.
        heartbeat = setInterval(() => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(': keep-alive\n\n'))
          } catch (error) {
            close()
          }
        }, 20_000)
        if (signal !== undefined) {
          if (signal.aborted) close()
          else signal.addEventListener('abort', close, { once: true })
        }
      },
      cancel() {
        close()
      },
    })
  }

  /**
   * Is this caller locked out?
   * @param {string} address
   * @returns {boolean}
   */
  function isLocked(address) {
    const record = attempts.get(address)
    if (record === undefined) return false
    if (record.lockedUntil <= now()) return false
    return true
  }

  /**
   * Record one wrong passcode.
   * @param {string} address
   */
  function recordFailure(address) {
    const stamp = now()
    const existing = attempts.get(address)
    // The counter starts over when the lock has run out or when the window
    // the failures were counted in has passed. A record without a lock is not
    // stale: it is the counter of the attempts that are still running.
    const expired = existing !== undefined && existing.lockedUntil > 0 && existing.lockedUntil <= stamp
    const stale = existing === undefined || expired || stamp - existing.firstFailureAt > SHARE_LOCKOUT_MS
    if (stale) {
      attempts.set(address, { failures: 1, firstFailureAt: stamp, lockedUntil: 0 })
      return
    }
    existing.failures += 1
    if (existing.failures >= SHARE_MAX_FAILURES) {
      existing.lockedUntil = stamp + SHARE_LOCKOUT_MS
    }
  }

  /**
   * Forget the failures of a caller that proved the passcode.
   * @param {string} address
   */
  function clearFailures(address) {
    attempts.delete(address)
  }

  /**
   * Does this passcode open this share?
   *
   * The comparison takes the same time for every wrong code, so a caller
   * cannot learn the passcode by measuring the answer.
   *
   * @param {any} share
   * @param {string} passcode
   * @returns {boolean}
   */
  function passcodeMatches(share, passcode) {
    if (typeof passcode !== 'string' || passcode.length === 0) return false
    const expected = Buffer.from(String(share.passcode))
    const given = Buffer.from(passcode)
    if (expected.length !== given.length) return false
    return timingSafeEqual(expected, given)
  }

  /**
   * The share a request addresses, when it addresses one at all.
   *
   * @param {string} id
   * @returns {any | undefined}
   */
  function resolveShare(id) {
    if (typeof id !== 'string' || id.length === 0) return undefined
    const share = getShare(id)
    if (share === undefined) return undefined
    if (share.revokedAt !== null && share.revokedAt !== undefined) return undefined
    return share
  }

  /**
   * The project root of one share.
   *
   * The root is a snapshot of the session's own directory, taken when the
   * share was created. The session's directory never moves afterwards, so the
   * snapshot stays right — and a share cannot be pointed at another project
   * later.
   *
   * @param {any} share
   * @returns {Promise<string | undefined>}
   */
  async function projectRootOf(share) {
    const stored = share?.projectRoot
    if (typeof stored === 'string' && stored.length > 0) return stored
    const query = service('sessionQuery', options.sessionQuery)
    if (query === undefined) return undefined
    try {
      const observation = await query.observeSession(share.sessionId, { projectionMode: 'none' })
      const cwd = observation?.header?.cwd
      return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
    } catch {
      return undefined
    }
  }

  /**
   * The title the session gave itself.
   *
   * The durable title travels with the log as a `session/title` event; the
   * host's own title service answers for a session it still holds in memory,
   * which is not every session.
   *
   * @param {readonly any[]} events
   * @returns {string | null}
   */
  function titleFromEvents(events) {
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]
      if (event?.type !== 'session/title') continue
      const title = event.data?.title
      if (typeof title === 'string' && title.length > 0) return title
    }
    return null
  }

  /**
   * The events of the shared session.
   *
   * The guest reads the conversation from the session's durable log: a live
   * session's own view carries only its latest state, while the log holds the
   * whole conversation the owner shared. A live session flushes its pending
   * events before the log is read, so the last message is in there too.
   *
   * @param {any} share
   * @returns {Promise<readonly any[]>}
   */
  async function readEvents(share) {
    const persistence = service('sessionPersistence', options.sessionPersistence)
    if (persistence !== undefined && typeof persistence.open === 'function') {
      try {
        await persistence.flush?.()
        const handle = await persistence.open(share.sessionId, 'read', {})
        try {
          const read = await handle.read(0, undefined, {})
          const events = read?.events
          if (Array.isArray(events) && events.length > 0) return events
        } finally {
          await handle.close?.()
        }
      } catch (error) {
        log('share: the session log could not be read', { error: String(error) })
      }
    }
    const query = service('sessionQuery', options.sessionQuery)
    if (query === undefined || typeof query.observeSession !== 'function') return []
    try {
      const observation = await query.observeSession(share.sessionId, { projectionMode: 'none' })
      return observation?.events ?? []
    } catch {
      return []
    }
  }

  /**
   * The guest view of the shared session.
   *
   * @param {any} share
   * @returns {Promise<{ share: any, session: any, messages: any[] }>}
   */
  async function readState(share) {
    const query = service('sessionQuery', options.sessionQuery)
    const root = await projectRootOf(share)
    const events = await readEvents(share)
    const title = titleFromEvents(events) ?? await readTitle(share, query)
    // The guest reads the same steps the app's trajectory shows: what was
    // asked, what the agent answered and what it did in between.
    const messages = projectSteps(events, { root: await projectRootOf(share) }).steps.slice(-SHARE_MAX_MESSAGES)
    return {
      share: { id: share.id, title: share.title, permission: share.permission },
      session: { title, cwd: root ?? null },
      messages,
    }
  }

  /**
   * The title of the shared session.
   *
   * @param {any} share
   * @param {any} query
   * @returns {Promise<string | null>}
   */
  async function readTitle(share, query) {
    if (query === undefined || typeof query.readTitle !== 'function') return null
    try {
      const snapshot = await query.readTitle(share.sessionId, new AbortController().signal)
      const title = snapshot?.title
      return typeof title === 'string' && title.length > 0 ? title : null
    } catch {
      return null
    }
  }
  /**
   * Put a message into the shared session.
   *
   * The host's session controller takes the request and an AbortSignal: it
   * reads the signal first, so an undefined one is refused before the message
   * is even looked at.
   *
   * @param {any} share
   * @param {string} text
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  async function promptSession(share, text, signal, parts = undefined, mode = 'queue') {
    const controller = service('sessionController', options.sessionController)
    if (controller === undefined || typeof controller.prompt !== 'function') {
      throw new Error('the host cannot deliver a message to a session')
    }
    // The content of the message: the words, and the upload that came with
    // them.
    const content = [{ type: 'text', text }]
    if (Array.isArray(parts)) {
      for (const part of parts) content.push(part)
    }
    await controller.prompt(
      {
        requestId: randomUUID(),
        sessionId: share.sessionId,
        mode,
        content,
      },
      signal ?? new AbortController().signal,
    )
  }

  return {
    /* ---------------------------------------------------------- owner side */

    /**
     * Let go of everything this service holds.
     *
     * The documents of the guests keep a timer of their own, and the files
     * they watch keep a handle: both are let go when the plugin is.
     *
     * @returns {Promise<void>}
     */
    async dispose() {
      for (const timer of pendingSaves.values()) clearTimeout(timer)
      pendingSaves.clear()
      for (const watcher of watchers.values()) {
        try {
          await watcher.close()
        } catch (error) {
          // A watcher that is already gone is not a failure.
        }
      }
      watchers.clear()
      // Every queue keeps a follower of the session it watches: they are let
      // go with the service.
      queues.dispose()
      collab.close()
    },

    /**
     * Add one share.
     *
     * @param {{ sessionId: string, title: string, permission: 'read'|'write', projectRoot: string }} input
     * @returns {any} the stored record
     */
    create(input) {
      return createShare({
        sessionId: input.sessionId,
        title: input.title,
        permission: input.permission,
        projectRoot: input.projectRoot,
      })
    },

    /**
     * Every share record.
     * @returns {any[]}
     */
    list() {
      return listShares()
    },

    /**
     * Revoke one share without forgetting it.
     *
     * @param {string} id
     * @returns {boolean} whether a record was revoked
     */
    disable(id) {
      const share = getShare(id)
      if (share === undefined) return false
      // A revoked share has no conversation left: the words that wait in its
      // queue are not said to the agent.
      queues.drop(id)
      if (share.revokedAt !== null && share.revokedAt !== undefined) return true
      updateShare(id, { revokedAt: now() })
      return true
    },

    /**
     * Remove one share.
     *
     * @param {string} id
     * @returns {boolean} whether a record was removed
     */
    remove(id) {
      queues.drop(id)
      const share = getShare(id)
      const removed = deleteShare(id)
      if (removed && share !== undefined) {
        // The room of a share that is gone is gone with it, and the owner of
        // the conversation must not keep seeing the guests of a dead link.
        rooms.drop(id)
        publishOwnerRoom(share.sessionId)
      }
      return removed
    },

    /**
     * The room of a conversation, as the owner sees it.
     *
     * @param {string} sessionId
     * @returns {{ kind: 'presence', sessionId: string, guests: any[], locks: any[] }}
     */
    ownerRoom(sessionId) {
      return ownerRoom(sessionId)
    },

    /**
     * The live room of a conversation, as a stream of frames.
     *
     * @param {string} sessionId
     * @param {AbortSignal} [signal]
     * @returns {ReadableStream<Uint8Array>}
     */
    presenceStream(sessionId, signal) {
      return presenceStream(sessionId, signal)
    },

    /**
     * The owner view of one share.
     *
     * @param {any} share
     * @param {{ link: string | null }} options
     * @returns {any}
     */
    view(share, viewOptions = {}) {
      return shareView(share, viewOptions)
    },

    /**
     * The link a guest opens, when a relay can carry it.
     *
     * @param {string} id
     * @param {string | null} relayPublicBase
     * @returns {string | null}
     */
    link(id, relayPublicBase) {
      if (typeof relayPublicBase !== 'string' || relayPublicBase.length === 0) return null
      return `${relayPublicBase.replace(/\/+$/, '')}/s/${id}`
    },

    /**
     * The title of a session, for a share that was created without one.
     *
     * The session id is a poor name for a conversation: a guest opening the
     * link sees the title the owner gave it.
     *
     * @param {string} sessionId
     * @returns {Promise<string | null>}
     */
    async titleOf(sessionId) {
      const events = await readEvents({ sessionId })
      const fromLog = titleFromEvents(events)
      if (fromLog !== null) return fromLog
      const query = service('sessionQuery', options.sessionQuery)
      if (query === undefined || typeof query.readTitle !== 'function') return null
      try {
        const snapshot = await query.readTitle(sessionId, new AbortController().signal)
        const title = snapshot?.title
        return typeof title === 'string' && title.length > 0 ? title : null
      } catch {
        return null
      }
    },

    /* ---------------------------------------------------------- guest side */

    /**
     * Serve one guest request.
     *
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @returns {Promise<void>}
     */
    async handle(req, res) {
      try {
        await this.route(req, res)
      } catch (error) {
        log('share: a guest request failed', { error: String(error) })
        // A request that already answered may not answer twice: the answer
        // that is on the wire stands, and the connection is closed.
        if (res.headersSent) {
          res.end()
          return
        }
        sendText(res, 500, 'internal error')
      }
    },

    /**
     * The route table of the guest surface.
     *
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @returns {Promise<void>}
     */
    async route(req, res) {
      const raw = String(req.url ?? '/')
      const pathname = raw.split('?')[0]
      if (!pathname.startsWith(SHARE_ROUTE_PREFIX)) {
        sendText(res, 404, 'not found')
        return
      }
      const rest = pathname.slice(SHARE_ROUTE_PREFIX.length)
      const slash = rest.indexOf('/')
      const id = decodeSegment(slash === -1 ? rest : rest.slice(0, slash))
      const tail = slash === -1 ? '' : rest.slice(slash + 1)
      const segments = tail.length === 0 ? [] : tail.split('/').map(decodeSegment)

      const share = resolveShare(id)
      if (share === undefined) {
        // An unknown and a revoked share answer the same way, so a guest
        // cannot learn which ids exist.
        sendText(res, 404, 'not found')
        return
      }

      const method = String(req.method ?? 'GET').toUpperCase()
      const address = callerAddress(req)

      if (segments.length === 0) {
        if (method !== 'GET' && method !== 'HEAD') {
          sendText(res, 405, 'method not allowed')
          return
        }
        this.servePage(req, res, share, address)
        return
      }

      if (segments.length === 1 && segments[0] === 'unlock') {
        if (method !== 'POST') {
          sendText(res, 405, 'method not allowed')
          return
        }
        if (isCrossSite(req)) {
          sendText(res, 403, 'forbidden')
          return
        }
        await this.serveUnlock(req, res, share, address)
        return
      }

      if (segments.length === 2 && segments[0] === 'api') {
        const action = segments[1]
        if (action === 'state') {
          if (method !== 'GET') {
            sendText(res, 405, 'method not allowed')
            return
          }
          if (!this.requireGuest(req, res, share)) return
          await this.serveState(req, res, share)
          return
        }
        if (action === 'stream') {
          if (method !== 'GET') {
            sendText(res, 405, 'method not allowed')
            return
          }
          if (!this.requireGuest(req, res, share)) return
          await this.serveStream(req, res, share)
          return
        }
        if (action === 'message') {
          if (method !== 'POST') {
            sendText(res, 405, 'method not allowed')
            return
          }
          if (isCrossSite(req)) {
            sendText(res, 403, 'forbidden')
            return
          }
          if (!this.requireGuest(req, res, share)) return
          await this.serveMessage(req, res, share)
          return
        }
        if (action === 'file') {
          if (method !== 'GET' && method !== 'HEAD') {
            sendText(res, 405, 'method not allowed')
            return
          }
          if (!this.requireGuest(req, res, share)) return
          await this.serveFile(req, res, share)
          return
        }
        if (action === 'tree') {
          if (method !== 'GET') {
            sendText(res, 405, 'method not allowed')
            return
          }
          if (!this.requireGuest(req, res, share)) return
          await this.serveTree(req, res, share)
          return
        }
        if (action === 'room') {
          if (method === 'GET') {
            if (!this.requireGuest(req, res, share)) return
            sendJson(res, 200, rooms.view(share.id))
            return
          }
          if (method === 'POST') {
            if (!this.requireGuest(req, res, share)) return
            const body = await readJsonBody(req)
            const guestId = String(body?.id ?? '').slice(0, 64)
            if (guestId.length === 0) {
              sendJson(res, 400, { ok: false, error: 'the guest needs an id' })
              return
            }
            const action2 = String(body?.action ?? 'hello')
            if (action2 === 'leave') {
              rooms.leave(share.id, guestId)
              await this.stopWatching(share, body?.file)
              sendJson(res, 200, { ok: true, ...rooms.view(share.id) })
              return
            }
            rooms.join(share.id, { id: guestId, name: body?.name })
            rooms.sweep(share.id, SHARE_GUEST_SILENCE_MS)
            if (action2 === 'focus') {
              rooms.update(share.id, guestId, { file: String(body?.file ?? '').slice(0, 512), name: body?.name })
              await this.watchFile(share, String(body?.file ?? ''))
            } else if (action2 === 'editing') {
              const path = String(body?.file ?? '').slice(0, 512)
              if (body?.editing === true && path.length > 0) {
                const lock = rooms.lock(share.id, guestId, path)
                if (!lock.ok) {
                  sendJson(res, 423, { ok: false, error: 'someone else is editing this file', guest: lock.guest })
                  return
                }
                await this.watchFile(share, path)
              } else {
                rooms.unlock(share.id, guestId, path)
              }
            } else if (action2 === 'typing') {
              // A guest says that it is writing, or that it stopped. The owner
              // of the conversation sees it, and so does every other guest.
              rooms.setTyping(share.id, guestId, body?.typing === true)
            } else {
              rooms.update(share.id, guestId, { name: body?.name })
            }
            const view = rooms.view(share.id)
            rooms.announce(share.id)
            sendJson(res, 200, { ok: true, ...view })
            return
          }
          sendText(res, 405, 'method not allowed')
          return
        }
        if (action === 'annotate') {
          if (method !== 'POST') {
            sendText(res, 405, 'method not allowed')
            return
          }
          if (!this.requireGuest(req, res, share)) return
          if (share.permission !== 'write') {
            sendJson(res, 403, { ok: false, error: 'this share is read-only' })
            return
          }
          await this.serveAnnotate(req, res, share)
          return
        }
        if (action === 'attach') {
          if (method !== 'POST') {
            sendText(res, 405, 'method not allowed')
            return
          }
          if (!this.requireGuest(req, res, share)) return
          if (share.permission !== 'write') {
            sendJson(res, 403, { ok: false, error: 'this share is read-only' })
            return
          }
          await this.serveAttachment(req, res, share)
          return
        }
        if (action === 'collab') {
          if (method !== 'POST') {
            sendText(res, 405, 'method not allowed')
            return
          }
          if (!this.requireGuest(req, res, share)) return
          await this.serveCollab(req, res, share)
          return
        }
        if (action === 'edit') {
          if (method !== 'POST') {
            sendText(res, 405, 'method not allowed')
            return
          }
          if (!this.requireGuest(req, res, share)) return
          if (share.permission !== 'write') {
            sendJson(res, 403, { ok: false, error: 'this share is read-only' })
            return
          }
          await this.serveEdit(req, res, share)
          return
        }
        if (action === 'blob') {
          if (method !== 'GET' && method !== 'HEAD') {
            sendText(res, 405, 'method not allowed')
            return
          }
          if (!this.requireGuest(req, res, share)) return
          await this.serveBlob(req, res, share)
          return
        }
        if (action === 'asset') {
          if (method !== 'GET' && method !== 'HEAD') {
            sendText(res, 405, 'method not allowed')
            return
          }
          if (!this.requireGuest(req, res, share)) return
          await this.serveAsset(req, res, share)
          return
        }
        if (action === 'trajectory') {
          if (method !== 'GET') {
            sendText(res, 405, 'method not allowed')
            return
          }
          if (!this.requireGuest(req, res, share)) return
          await this.serveProjection(req, res, share, 'trajectory')
          return
        }
        if (action === 'context') {
          if (method !== 'GET') {
            sendText(res, 405, 'method not allowed')
            return
          }
          if (!this.requireGuest(req, res, share)) return
          await this.serveProjection(req, res, share, 'context')
          return
        }
      }

      sendText(res, 404, 'not found')
    },

    /**
     * The guest page.
     *
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {any} share
     * @param {string} address
     */
    servePage(req, res, share, address) {
      const unlocked = this.isUnlocked(req, share)
      if (!unlocked) {
        sendHtml(res, 200, renderGuestPage({ share, unlocked: false }))
        return
      }
      touch(share.id)
      sendHtml(res, 200, renderGuestPage({ share, unlocked: true }))
    },

    /**
     * Check a passcode and hand out the guest cookie.
     *
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {any} share
     * @param {string} address
     * @returns {Promise<void>}
     */
    async serveUnlock(req, res, share, address) {
      if (isLocked(address)) {
        sendJson(res, 429, { ok: false, error: 'too many attempts' })
        return
      }
      const body = await readJsonBody(req)
      const passcode = typeof body?.passcode === 'string' ? body.passcode : ''
      if (!passcodeMatches(share, passcode)) {
        recordFailure(address)
        sendJson(res, 401, { ok: false, error: 'the passcode is wrong' })
        return
      }
      clearFailures(address)
      touch(share.id)
      const issuedAt = now()
      const value = shareCookieValue(secret, share.id, issuedAt)
      res.setHeader(
        'set-cookie',
        // The cookie is bound to the share id and signed, so it is scoped to
        // that share rather than to a path: behind a relay the guest's page
        // lives under '/s/<id>' while the host answers '/share/<id>', and a
        // path-scoped cookie would never travel back.
        `${shareCookieName(share.id)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SHARE_COOKIE_MAX_AGE_SECONDS}`,
      )
      sendJson(res, 200, { ok: true })
    },

    /**
     * Does this request carry a valid guest cookie?
     *
     * @param {import('node:http').IncomingMessage} req
     * @param {any} share
     * @returns {boolean}
     */
    isUnlocked(req, share) {
      const value = readCookie(req, shareCookieName(share.id))
      return verifyShareCookie(secret, share.id, value, { now: now() })
    },

    /**
     * Refuse a request that carries no guest cookie.
     *
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {any} share
     * @returns {boolean} whether the request may continue
     */
    requireGuest(req, res, share) {
      if (this.isUnlocked(req, share)) {
        touch(share.id)
        return true
      }
      sendJson(res, 401, { ok: false, error: 'the passcode is required' })
      return false
    },

    /**
     * The state of the shared session.
     *
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {any} share
     * @returns {Promise<void>}
     */
    async serveState(req, res, share) {
      const state = await readState(share)
      sendJson(res, 200, state)
    },

    /**
     * The live stream of the shared session.
     *
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {any} share
     * @returns {Promise<void>}
     */
    async serveStream(req, res, share) {
      const controller = service('sessionController', options.sessionController)
      if (controller === undefined || typeof controller.follow !== 'function') {
        sendText(res, 501, 'not implemented')
        return
      }
      const abort = new AbortController()
      req.on('close', () => abort.abort())
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write(': connected\n\n')
      // The frames of the room reach the guests through the same stream: who
      // is here, what they have open, and what changed under them. The way
      // out is bound before anything can throw, so the way back never meets
      // it uninitialised.
      let unsubscribe = () => {}
      try {
        const frames = controller.follow(
          {
            address: { kind: 'session', sessionId: share.sessionId },
            maxMessages: SHARE_MAX_MESSAGES,
          },
          abort.signal,
        )
        if (frames === undefined || typeof frames[Symbol.asyncIterator] !== 'function') {
          // The head is already sent: the stream simply ends.
          res.end()
          return
        }
        const titles = new Map()
        const root = await projectRootOf(share)
        // The words the guests sent, in the order they sent them: the Host
        // sometimes records a message shorter than it was given, and the
        // guest is told when that happens.
        const sent = sentWordsByShare.get(share.id) ?? []
        sentWordsByShare.set(share.id, sent)
        unsubscribe = rooms.subscribe(share.id, (line) => {
          if (abort.signal.aborted) return
          res.write(line)
        })
        // The guest that joins a conversation that is already working is told
        // where the words stand: the queue is the state of the conversation,
        // and it is told the same way to every guest.
        const queue = queues.state(share.id)
        if (queue !== undefined) res.write(`data: ${JSON.stringify(queue)}\n\n`)
        for await (const frame of frames) {
          if (abort.signal.aborted) break
          // The Host may record a message shorter than it was given.
          const events = frame.type === 'snapshot'
            ? (frame.records ?? []).map((record) => record?.event).filter((event) => event !== undefined)
            : (frame.type === 'event' ? [frame.event] : [])
          for (const event of events) {
            if (event?.type !== 'user/message' || isHostContext(event.data)) continue
            // The text of a message, in whichever shape it carries it.
            const text = textOfContent(event.data?.content).trim()
            if (text.length === 0) continue
            const match = sent.find((entry) => entry.again !== true && entry.text.startsWith(text) && entry.text.length > text.length)
            if (match === undefined) continue
            match.again = true
            sent.splice(sent.indexOf(match), 1)
            // Every guest of the share is told: the words of one of them were
            // cut, and the others saw it happen.
            rooms.broadcast(share.id, { kind: 'shortened', recorded: text, sent: match.text })
            // The words that are missing are said again, whole.
            void sayAgain(share, match.text)
          }
          const payload = framePayload(frame, { root, titles })
          if (payload === undefined) continue
          res.write(`data: ${JSON.stringify(payload)}\n\n`)
        }
      } catch (error) {
        log('share: the event stream ended', { error: String(error) })
      } finally {
        unsubscribe?.()
        abort.abort()
        res.end()
      }
    },

    /**
     * Put a guest message into the shared session.
     *
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {any} share
     * @returns {Promise<void>}
     */
    async serveMessage(req, res, share) {
      if (share.permission !== 'write') {
        sendJson(res, 403, { ok: false, error: 'this share is read-only' })
        return
      }
      const body = await readJsonBody(req, SHARE_ATTACHMENT_MAX_BYTES)
      const text = typeof body?.text === 'string' ? body.text.trim() : ''
      // The upload that came with the message: an image the model can look at,
      // or a file the model can read.
      const upload = body?.upload !== undefined && body?.upload !== null ? body.upload : undefined
      if (text.length === 0 && upload === undefined) {
        sendJson(res, 400, { ok: false, error: 'the message is empty' })
        return
      }
      try {
        // The guest may walk away mid-send: the admission is then cancelled
        // instead of waking an agent for nobody.
        const abort = new AbortController()
        req.on('aborted', () => abort.abort())
        const parts = await this.buildUpload(share, upload, abort.signal)
        const words = text.length > 0 ? text : '(an upload)'
        sentWords(share.id, words)
        // The message waits in the queue of the conversation: the Host
        // digests one message at a time, and the queue is what keeps the
        // Host from holding several at once.
        const queued = queues.enqueue(share, {
          text: words,
          parts,
          from: guestNameOf(share, body),
          at: now(),
        })
        sendJson(res, 200, { ok: true, queued: true, id: queued.id, position: queued.position })
      } catch (error) {
        log('share: the message was refused', { error: String(error) })
        sendJson(res, 502, { ok: false, error: 'the message was refused', reason: String(error?.message ?? error) })
        return
      }
    },

    /**
     * Read one file inside the project root.
     *
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {any} share
     * @returns {Promise<void>}
     */
    async serveFile(req, res, share) {
      const fs = service('fs', options.fs)
      const root = await projectRootOf(share)
      if (fs === undefined || root === undefined) {
        sendText(res, 403, 'forbidden')
        return
      }
      const url = new URL(String(req.url ?? '/'), 'http://share.invalid')
      const candidate = url.searchParams.get('path') ?? ''
      // A file that is too large is read up to the cap and marked truncated:
      // the guest still sees the beginning of it instead of an error.
      const read = await readShareText(fs, root, candidate)
      if (!read.ok) {
        // A file that is not text is told so: the guest learns that this file
        // cannot be previewed, and not that it cannot be read.
        if (await this.isBinary(fs, root, candidate)) {
          sendText(res, 415, 'this file is not text')
          return
        }
        // A path outside the root and a path that does not exist answer the
        // same way: the guest learns nothing about the machine.
        sendText(res, 403, 'forbidden')
        return
      }
      const body = Buffer.from(read.text, 'utf8')
      // The version of the file travels with it: a guest that edits this text
      // saves against this version, and the Host refuses the save when the
      // file moved on.
      let version = ''
      try {
        const info = await fs.lstat(candidate, { cwd: root })
        version = info?.version ?? ''
      } catch (error) {
        version = ''
      }
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': String(body.length),
        'x-dsh-share-truncated': read.truncated ? 'true' : 'false',
        'x-dsh-share-version': version,
        'cache-control': 'no-store',
      })
      res.end(body)
    },

    /**
     * List one directory inside the project root.
     *
     * The guest browses the task's own project folder, so the listing is
     * bounded by the same root as the file reads: a path outside it answers
     * the same way as a path that does not exist.
     *
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {any} share
     * @returns {Promise<void>}
     */
    async serveTree(req, res, share) {
      const fs = service('fs', options.fs)
      const root = await projectRootOf(share)
      if (fs === undefined || root === undefined) {
        sendText(res, 403, 'forbidden')
        return
      }
      const url = new URL(String(req.url ?? '/'), 'http://share.invalid')
      const candidate = url.searchParams.get('path') ?? ''
      const listing = await listShareDirectory(fs, root, candidate)
      if (!listing.ok) {
        sendText(res, 403, 'forbidden')
        return
      }
      sendJson(res, 200, listing)
    },

    /**
     * The trajectory or the context of the shared session.
     *
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {any} share
     * @param {'trajectory' | 'context'} kind
     * @returns {Promise<void>}
     */
    /**
     * Put the text of a collaborative document into the file.
     *
     * The write is guarded by the version the text was based on: when the
     * agent wrote the file in the meantime, the write is refused, the
     * document starts again from the file as it is now, and the guests are
     * told that their work was set aside.
     *
     * @param {any} share
     * @param {string} path
     * @returns {Promise<void>}
     */
    async saveDocument(share, path) {
      const fs = service('fs', options.fs)
      const root = await projectRootOf(share)
      const entry = collab.find(share.id, path)
      if (fs === undefined || root === undefined || entry === undefined) return
      const resolved = await resolveWithinRoot(fs, root, path)
      if (!resolved.ok) return
      const text = collab.textOf(entry)
      // The guard is the version the text was based on: the version of the
      // file now would let the write over the work the agent did.
      let current = ''
      try {
        const info = await fs.lstat(path, { cwd: root })
        current = info?.version ?? ''
      } catch (error) {
        current = ''
      }
      if (current.length === 0) return
      const version = typeof entry.baseVersion === 'string' && entry.baseVersion.length > 0 ? entry.baseVersion : current
      try {
        const outcome = await fs.writeText(
          resolved.target,
          text,
          { kind: 'replaceIfVersion', version },
          undefined,
          { mode: 'workspace-write', workspaceRoot: root, sessionId: share.sessionId },
        )
        entry.baseVersion = outcome?.version ?? current
        rooms.broadcast(share.id, { kind: 'collab-saved', path, version: entry.baseVersion, length: text.length })
      } catch (error) {
        log('share: the document could not be written', { path, error: String(error) })
        // The file moved on. What the guest wrote is not thrown away: the
        // document keeps it, the guests are told that it did not reach the
        // file, and the text reaches the file when the guest says so.
        entry.blocked = true
        rooms.broadcast(share.id, {
          kind: 'collab-save-failed',
          path,
          version: current,
          reason: 'the file changed while you were editing it',
        })
      }
    },

    /**
     * The write of a document waits a moment: the guests are still typing.
     *
     * @param {any} share
     * @param {string} path
     */
    scheduleSave(share, path) {
      const key = `${share.id}\u0000${path}`
      const waiting = pendingSaves.get(key)
      if (waiting !== undefined) clearTimeout(waiting)
      const timer = setTimeout(() => {
        pendingSaves.delete(key)
        void this.saveDocument(share, path)
      }, 800)
      if (typeof timer.unref === 'function') timer.unref()
      pendingSaves.set(key, timer)
    },

    /**
     * Draft one annotation for the guest.
     *
     * The guest picks a passage of the document and writes what has to
     * change; the model is asked for the wording of the annotation, and the
     * guest decides whether to send it.
     *
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {any} share
     * @returns {Promise<void>}
     */
    async serveAnnotate(req, res, share) {
      const body = await readJsonBody(req)
      const payload = body?.payload ?? body
      try {
        const { draftAnnotation, serviceOf } = await import('./share-annotate.js')
        const result = await draftAnnotation(payload, {
          get llm() {
            return serviceOf(ctx, 'llm')
          },
          get agentDefaultModel() {
            return serviceOf(ctx, 'agentDefaultModel')
          },
        })
        sendJson(res, 200, { ok: true, result })
      } catch (error) {
        log('share: an annotation could not be drafted', { error: String(error) })
        sendJson(res, 200, {
          ok: false,
          error: { code: 'share-annotate/failed', message: error instanceof Error ? error.message : String(error) },
        })
      }
    },

    /**
     * The parts of a message that carry an upload of a guest.
     *
     * An image goes into the message as it is: the Host keeps it. A file is
     * uploaded first, and the receipt of that upload goes into the message.
     *
     * @param {any} share
     * @param {any} upload
     * @returns {Promise<any[]>} the parts of the message
     */
    async buildUpload(share, upload, signal) {
      if (upload === undefined || upload === null) return []
      const name = String(upload.name ?? 'upload').slice(0, 120)
      const mediaType = String(upload.mediaType ?? '').toLowerCase()
      const data = String(upload.data ?? '')
      if (data.length === 0) return []
      if (mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType === 'image/webp' || mediaType === 'image/gif') {
        return [{ type: 'image', mediaType, data, name }]
      }
      const uploads = service('fileUploads', options.fileUploads)
      const agents = service('agents', options.agents)
      const agent = agents?.get?.(share.sessionId)
      if (uploads === undefined || agent === undefined) {
        // A file that cannot be uploaded is named in the message instead of
        // being lost.
        return []
      }
      try {
        // The Host takes one spelling of base64: the bytes are re-encoded
        // here, so what the guest sent does not have to know it.
        const canonical = Buffer.from(data, 'base64').toString('base64')
        const receipt = await uploads.upload(agent, { data: canonical, name }, signal)
        return [{ type: 'file', receiptId: receipt?.receiptId ?? receipt }]
      } catch (error) {
        // A file the Host will not take does not take the message with it.
        log('share: a file could not be uploaded', { error: String(error) })
        return []
      }
    },

    /**
     * Take an upload of a guest and turn it into an attachment.
     *
     * An image becomes an image the model can look at, any other file becomes
     * a file the model can read. Both are kept by the Host, not by the guest.
     *
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {any} share
     * @returns {Promise<void>}
     */
    async serveAttachment(req, res, share) {
      const attachments = service('attachments', options.attachments)
      if (attachments === undefined) {
        sendJson(res, 501, { ok: false, error: 'this host keeps no attachments' })
        return
      }
      const body = await readJsonBody(req, SHARE_ATTACHMENT_MAX_BYTES)
      const name = String(body?.name ?? 'upload').slice(0, 120)
      const mediaType = String(body?.mediaType ?? '').toLowerCase()
      const encoded = String(body?.data ?? '')
      if (encoded.length === 0) {
        sendJson(res, 400, { ok: false, error: 'the upload carries nothing' })
        return
      }
      let bytes
      try {
        bytes = new Uint8Array(Buffer.from(encoded, 'base64'))
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'the upload is not readable' })
        return
      }
      try {
        if (mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType === 'image/webp' || mediaType === 'image/gif') {
          const saved = await attachments.saveImages([{ data: bytes, mediaType, name }])
          const ref = saved?.[0]
          sendJson(res, 200, { ok: true, kind: 'image', attachment: ref, mediaType, name, bytes: bytes.length })
          return
        }
        const ref = await attachments.saveFile({ data: bytes, name })
        sendJson(res, 200, { ok: true, kind: 'file', attachment: ref, name, bytes: bytes.length })
      } catch (error) {
        log('share: an upload was refused', { error: String(error) })
        sendJson(res, 415, { ok: false, error: 'the host refused the upload' })
      }
    },

    /**
     * The collaborative document of a file.
     *
     * A guest joins a document, sends its changes and its cursors; the Host
     * keeps the document and hands every change to the other guests of the
     * room.
     *
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {any} share
     * @returns {Promise<void>}
     */
    async serveCollab(req, res, share) {
      const fs = service('fs', options.fs)
      const root = await projectRootOf(share)
      if (fs === undefined || root === undefined) {
        sendJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      const body = await readJsonBody(req)
      const path = String(body?.path ?? '').slice(0, 512)
      const client = Number(body?.client ?? 0)
      if (path.length === 0) {
        sendJson(res, 400, { ok: false, error: 'the document needs a path' })
        return
      }
      const resolved = await resolveWithinRoot(fs, root, path)
      if (!resolved.ok) {
        sendJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      const action = String(body?.action ?? 'open')
      if (action === 'open') {
        let text = ''
        try {
          text = await fs.readText(resolved.target, undefined)
        } catch (error) {
          text = ''
        }
        const entry = collab.open(share.id, path, text)
        if (Number.isFinite(client) && client > 0) entry.clients.add(client)
        try {
          const info = await fs.lstat(path, { cwd: root })
          entry.baseVersion = info?.version ?? ''
        } catch (error) {
          entry.baseVersion = ''
        }
        sendJson(res, 200, {
          ok: true,
          state: collab.stateOf(entry),
          awareness: collab.awarenessOf(entry),
          client,
        })
        return
      }
      const entry = collab.find(share.id, path)
      if (entry === undefined) {
        sendJson(res, 409, { ok: false, error: 'the document is gone' })
        return
      }
      if (action === 'update') {
        if (!collab.applyUpdate(entry, String(body?.update ?? ''))) {
          sendJson(res, 400, { ok: false, error: 'the change could not be applied' })
          return
        }
        rooms.broadcast(share.id, {
          kind: 'collab',
          path,
          update: String(body?.update ?? ''),
          from: Number(body?.client ?? 0),
        })
        // A document whose write was refused waits for the guest: saving it
        // again would fail again, and the guest is the one who has to say
        // what the file should hold.
        if (entry.blocked !== true) this.scheduleSave(share, path)
        sendJson(res, 200, { ok: true })
        return
      }
      if (action === 'awareness') {
        collab.applyAwareness(entry, String(body?.update ?? ''))
        rooms.broadcast(share.id, {
          kind: 'awareness',
          path,
          update: String(body?.update ?? ''),
          from: Number(body?.client ?? 0),
        })
        sendJson(res, 200, { ok: true })
        return
      }
      if (action === 'leave') {
        collab.leave(entry, client)
        rooms.broadcast(share.id, { kind: 'awareness', path, update: '', from: client })
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 400, { ok: false, error: 'the action is not known' })
    },

    /**
     * Whether a file holds something other than text.
     *
     * @param {any} fs
     * @param {string} root
     * @param {string} path
     * @returns {Promise<boolean>}
     */
    async isBinary(fs, root, path) {
      const resolved = await resolveWithinRoot(fs, root, path)
      if (!resolved.ok) return false
      try {
        const bytes = await fs.readByteRange(resolved.target, { offset: 0, length: 512 }, undefined)
        return bytes.includes(0)
      } catch (error) {
        return false
      }
    },

    /**
     * Put a guest's text into a file of the project.
     *
     * The write is guarded: the guest says which version of the file it
     * worked on, and the Host refuses the write when the file moved on. The
     * refusal carries the text the file holds now, so the guest can see what
     * it did not expect - the agent's work, most of the time.
     *
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {any} share
     * @returns {Promise<void>}
     */
    async serveEdit(req, res, share) {
      const fs = service('fs', options.fs)
      const root = await projectRootOf(share)
      if (fs === undefined || root === undefined) {
        sendJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      const body = await readJsonBody(req)
      const candidate = String(body?.path ?? '')
      const content = typeof body?.content === 'string' ? body.content : null
      const expected = typeof body?.version === 'string' ? body.version : ''
      if (content === null || candidate.length === 0) {
        sendJson(res, 400, { ok: false, error: 'the edit needs a path and a text' })
        return
      }
      const resolved = await resolveWithinRoot(fs, root, candidate)
      if (!resolved.ok) {
        sendJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      // One guest holds a file at a time: the other one is told who has it.
      // The holder is compared by its id: the guest that holds the file may
      // save it.
      const holderId = rooms.holderId(share.id, candidate)
      if (holderId !== undefined && holderId !== String(body?.guest ?? '')) {
        sendJson(res, 423, { ok: false, error: 'someone else is editing this file', guest: rooms.holder(share.id, candidate) })
        return
      }
      const current = await fs.lstat(candidate, { cwd: root })
      if (current === undefined || current === null) {
        sendJson(res, 404, { ok: false, error: 'the file is gone' })
        return
      }
      if (expected.length > 0 && expected !== current.version) {
        let text = ''
        try {
          text = await fs.readText(resolved.target, undefined)
        } catch (error) {
          text = ''
        }
        sendJson(res, 409, {
          ok: false,
          error: 'the file changed while you were editing it',
          version: current.version,
          current: text,
        })
        return
      }
      try {
        // The write runs under the project root of the share: the Host fences
        // a write by the policy it is given, and the default one belongs to
        // another workspace.
        const outcome = await fs.writeText(
          resolved.target,
          content,
          { kind: 'replaceIfVersion', version: current.version },
          undefined,
          { mode: 'workspace-write', workspaceRoot: root, sessionId: share.sessionId },
        )
        // A document that is open in an editor takes the new version as its
        // base: the guest has just said what the file should hold.
        const open = collab.find(share.id, candidate)
        if (open !== undefined) {
          open.baseVersion = outcome?.version ?? current.version
          open.blocked = false
        }
        rooms.broadcast(share.id, { kind: 'file', path: candidate, version: outcome?.version ?? current.version, changedBy: 'guest' })
        sendJson(res, 200, { ok: true, version: outcome?.version ?? current.version })
      } catch (error) {
        log('share: the file could not be written', { error: String(error) })
        let current = ''
        try {
          const info = await fs.lstat(candidate, { cwd: root })
          current = info?.version ?? ''
        } catch (readError) {
          current = ''
        }
        sendJson(res, 409, { ok: false, error: 'the file changed while you were editing it', version: current, reason: String(error?.message ?? error) })
      }
    },

    /**
     * Watch the file a guest has open, so the room hears when it changes.
     *
     * @param {any} share
     * @param {string} path
     * @returns {Promise<void>}
     */
    async watchFile(share, path) {
      if (path.length === 0 || watchers.has(path)) return
      const fs = service('fs', options.fs)
      const root = await projectRootOf(share)
      if (fs === undefined || root === undefined) return
      const resolved = await resolveWithinRoot(fs, root, path)
      if (!resolved.ok) return
      try {
        const abort = new AbortController()
        const close = await fs.watch(resolved.target, () => {
          void this.announceChange(share, path)
        }, abort.signal)
        watchers.set(path, {
          close: async () => {
            abort.abort()
            await close()
          },
        })
      } catch (error) {
        // A backend that cannot watch is not a reason to fail the guest.
        log('share: a file could not be watched', { error: String(error) })
      }
    },

    /**
     * Stop watching a file no guest looks at any more.
     *
     * @param {any} share
     * @param {string} path
     * @returns {Promise<void>}
     */
    async stopWatching(share, path) {
      const name = String(path ?? '')
      if (name.length === 0) return
      const view = rooms.view(share.id)
      const stillOpen = view.guests.some((guest) => guest.file === name)
      if (stillOpen) return
      const watcher = watchers.get(name)
      if (watcher === undefined) return
      watchers.delete(name)
      await watcher.close()
    },

    /**
     * Tell the room that a file changed, and with which version.
     *
     * @param {any} share
     * @param {string} path
     * @returns {Promise<void>}
     */
    async announceChange(share, path) {
      const fs = service('fs', options.fs)
      const root = await projectRootOf(share)
      if (fs === undefined || root === undefined) return
      let version = ''
      try {
        const info = await fs.lstat(path, { cwd: root })
        version = info?.version ?? ''
      } catch (error) {
        version = ''
      }
      rooms.broadcast(share.id, { kind: 'file', path, version, changedBy: 'workspace' })
      // A document the guests are editing in starts again: what they had is
      // not the file any more.
      const entry = collab.find(share.id, path)
      if (entry !== undefined) {
        let current = ''
        try {
          const resolved = await resolveWithinRoot(fs, root, path)
          if (resolved.ok) current = await fs.readText(resolved.target, undefined)
        } catch (error) {
          current = ''
        }
        collab.reset(entry, current)
        entry.baseVersion = version
        rooms.broadcast(share.id, { kind: 'collab-reset', path, reason: 'the file was rewritten' })
      }
    },

    async serveBlob(req, res, share) {
      const fs = service('fs', options.fs)
      const root = await projectRootOf(share)
      if (fs === undefined || root === undefined) {
        sendText(res, 403, 'forbidden')
        return
      }
      const url = new URL(String(req.url ?? '/'), 'http://share.invalid')
      const candidate = url.searchParams.get('path') ?? ''
      // The boundary first: a path outside the project answers the same way
      // here as it does for the text of a file.
      const resolved = await resolveWithinRoot(fs, root, candidate)
      if (!resolved.ok) {
        sendText(res, 403, 'forbidden')
        return
      }
      // Only the images the preview shows travel as bytes; everything else is
      // text the guest reads.
      const type = imageTypeOf(candidate)
      if (type === '' || fileKindOf(candidate) !== 'image') {
        sendText(res, 415, 'not an image')
        return
      }
      try {
        const bytes = await fs.readByteRange(resolved.target, { offset: 0, length: SHARE_MAX_FILE_BYTES }, undefined)
        const buffer = Buffer.from(bytes?.buffer ?? bytes, bytes?.byteOffset ?? 0, bytes?.byteLength ?? bytes?.length ?? 0)
        res.writeHead(200, {
          'content-type': type,
          'content-length': String(buffer.length),
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        })
        res.end(buffer)
      } catch (error) {
        log('share: an image could not be read', { error: String(error) })
        sendText(res, 403, 'forbidden')
      }
    },

    /**
     * Serve one library to the guest page.
     *
     * The guest page has no build step, so the diagram library travels to
     * the browser as the file it is on the disk. The name in the request
     * picks the library and nothing else: an unknown name answers 404, and
     * so does a library that is not installed.
     *
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {any} share
     * @returns {Promise<void>}
     */
    async serveAsset(req, res, share) {
      const url = new URL(String(req.url ?? '/'), 'http://share.invalid')
      const name = url.searchParams.get('name') ?? ''
      const asset = await assets.read(name)
      if (!asset.ok) {
        // An unknown name and a library that is not installed are both a
        // closed door: the guest learns nothing about the host beyond that
        // the route serves no file of its own choosing.
        sendText(res, 404, asset.reason === 'missing' ? 'mermaid is unavailable' : 'not found')
        return
      }
      const cacheControl = `public, max-age=${SHARE_ASSET_MAX_AGE_SECONDS}`
      const given = String(req.headers['if-none-match'] ?? '')
      if (given.length > 0 && given.split(',').some((tag) => tag.trim() === asset.etag)) {
        res.writeHead(304, { etag: asset.etag, 'cache-control': cacheControl })
        res.end()
        return
      }
      res.writeHead(200, {
        'content-type': SHARE_ASSET_MERMAID_TYPE,
        'content-length': String(asset.body.length),
        'cache-control': cacheControl,
        etag: asset.etag,
        'x-content-type-options': 'nosniff',
      })
      res.end(asset.body)
    },

    async serveProjection(req, res, share, kind) {
      const events = await readEvents(share)
      const root = await projectRootOf(share)
      sendJson(res, 200, kind === 'trajectory'
        ? projectTrajectory(events, { root })
        : projectContext(events, { root }))
    },
  }

  /**
   * Remember that a share was used.
   * @param {string} id
   */
  function touch(id) {
    updateShare(id, { lastUsedAt: now() })
  }
}

/**
 * The guest view of one stream frame.
 *
 * @param {any} frame
 * @returns {any | undefined}
 */
export function framePayload(frame, options = {}) {
  if (typeof frame !== 'object' || frame === null) return undefined
  if (frame.type === 'snapshot') {
    return {
      kind: 'snapshot',
      cursor: typeof frame.cursor === 'number' ? frame.cursor : 0,
      messages: projectSteps((frame.records ?? []).map((record) => record?.event), options).steps,
    }
  }
  if (frame.type === 'event') {
    const step = projectStep(frame.event, options)
    if (step === undefined) return undefined
    return { kind: 'message', message: step }
  }
  return undefined
}

/**
 * Decode one path segment.
 *
 * @param {string} value
 * @returns {string}
 */
function decodeSegment(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Read a JSON request body.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
async function readJsonBody(req, max = 4 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > max) break
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * Send a JSON answer.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body ?? {})
  // A response that already carries its head may not be given another one.
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Send a plain text answer.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} body
 */
function sendText(res, status, body) {
  // A response that already carries its head may not be given another one.
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Send an HTML answer.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} body
 */
function sendHtml(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Escape one string for the HTML page.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
