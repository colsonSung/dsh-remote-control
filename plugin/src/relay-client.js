/**
 * Remote-control relay client — the host side of the tunnel.
 *
 * The DSH host dials OUT to a cloud relay over two WebSockets (see
 * `./relay-protocol.js` for the wire contract):
 *
 *   - a **management** channel (`/v1/remote/create`) where the host registers
 *     the device and learns the public URL the QR code encodes;
 *   - a **tunnel** channel (`/v1/remote/http`) where the relay replays the
 *     phone's HTTP traffic back to this process.
 *
 * Every tunnel request is served against the local DSH server
 * (`localBaseUrl`), which hosts the web UI and its `/api` JSON-RPC endpoint.
 *
 * Two details make the phone's very first load work:
 *
 *   1. **Header rewriting** — the phone talks to the relay, so `Host` and
 *      `Origin` arrive with the relay's authority. They are rewritten to the
 *      local authority/origin so DSH's Host/Origin fence accepts the request.
 *   2. **Launch-token injection** — the DSH server only mints a signed session
 *      cookie for `GET /` carrying `?token=<launchToken>`. The token is
 *      injected by the host, on the device root only, so it never leaves this
 *      machine.
 *
 * @example
 * ```js
 * const client = createRelayClient({
 *   relayUrl: 'ws://127.0.0.1:56131',
 *   token: 'shared-secret',
 *   deviceId: 'uuid',
 *   alias: 'Ethane-MacBook.local',
 *   platform: 'darwin',
 *   clientVersion: '1.0.0',
 *   localBaseUrl: 'http://127.0.0.1:56130',
 *   launchToken: 'process launch token',
 *   log: (msg, extra) => console.debug(msg, extra),
 * })
 * await client.start()
 * client.status()   // { state: 'online', publicUrl, error }
 * ```
 */

import { createHash } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { promisify } from 'node:util'
import {
  brotliCompress,
  constants as zlibConstants,
  gzip,
} from 'node:zlib'
import { WebSocket as NodeWebSocket } from 'ws'

import {
  bearerHeader,
  bearerSubprotocol,
  CAPABILITY_BINARY_BODY,
  CAPABILITY_WS_BINARY_BODY,
  COMPRESSED_WS_PREFIX,
  COMPRESSION_QUERY,
  chunkedResponseFrame,
  decodeFrame,
  encodeBinaryBody,
  encodeBinaryWsPayload,
  encodeFrame,
  managementUrl,
  registerFrame,
  responseChunkFrame,
  responseFrame,
  sharePublishFrame,
  shareRevokeFrame,
  tunnelUrl,
  upgradedFrame,
  wsCloseFrame,
  wsFrame,
  wsPingFrame,
  wsPongFrame,
} from './relay-protocol.js'

/* ------------------------------------------------------------------ tuning */

/** The relay's answer when it still holds a registration of this device. */
const DUPLICATE_REASON = /already registered/i

/** @type {Record<string, number>} */
const DEFAULT_OPTIONS = {
  /** First reconnect delay; doubles on every failed attempt. */
  reconnectBaseDelayMs: 1_000,
  /** Upper bound of the exponential reconnect backoff. */
  reconnectMaxDelayMs: 30_000,
  /** Keepalive ping period on both channels. */
  pingIntervalMs: 30_000,
  /** How long the WebSocket handshake may take. */
  handshakeTimeoutMs: 15_000,
  /** How long the relay may stay silent after our `register` frame. */
  registrationTimeoutMs: 15_000,
  /** How long `stop()` waits for the sockets to close before terminating. */
  closeTimeoutMs: 2_000,
  /** How long an event stream may stay quiet before the tunnel says something. */
  keepAliveMs: 60_000,
}

/** Hop-by-hop request headers that must not be forwarded upstream. */
const DROPPED_REQUEST_HEADERS = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'accept-encoding',
])

/** WebSocket handshake headers — the client must compute its own. */
const DROPPED_UPGRADE_HEADERS = new Set([
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-accept',
])

/** Response headers that describe a connection, not the payload. */
const DROPPED_RESPONSE_HEADERS = new Set(['connection', 'transfer-encoding'])

/**
 * The smallest body that is worth compressing.
 *
 * Below this the compression costs more time than the transfer saves, and the
 * phone pays the latency of the round trip anyway.
 */
const MIN_COMPRESSED_BYTES = 4 * 1024

/**
 * The smallest WebSocket payload that is worth compressing.
 *
 * A stream frame is one JSON message: the small ones (a cursor, a
 * notification) are cheap to send as they are, while a session snapshot is
 * megabytes. The line between the two is where the transfer starts to hurt.
 */
const MIN_COMPRESSED_WS_BYTES = 8 * 1024

/**
 * The content types that gain from compression.
 *
 * Images, fonts and archives are already compressed; compressing them again
 * only burns CPU on both ends.
 */
const COMPRESSIBLE_CONTENT_TYPES =
  /^(?:text\/|application\/(?:javascript|json|xml|manifest\+json)|image\/svg\+xml)/i

/**
 * The content type of a response whose body never ends.
 *
 * The plugin event stream is a Server-Sent Events endpoint: the phone opens
 * it and the events arrive as they happen. A body that never ends cannot be
 * waited for, so it travels in chunks instead of in one buffered frame.
 */
const EVENT_STREAM_CONTENT_TYPE = 'text/event-stream'

/**
 * The size of one chunk of a streamed response.
 *
 * One frame must never carry an unbounded buffer: the relay would have to
 * hold it in memory, and a frame that cannot be written without waiting for
 * the whole body defeats the purpose of streaming. 64 KiB keeps the tunnel
 * busy while the frame overhead stays in the noise.
 */
const STREAM_CHUNK_BYTES = 64 * 1024

/**
 * The size from which a response travels in chunks.
 *
 * The web app's client-module bundle is several megabytes, and a phone
 * receives it through a relay on the other side of the world. One frame puts
 * the whole body on the wire in a single burst, and WebKit — the engine behind
 * Safari — never gets its HTTP/2 window refilled in time: the transfer stalls
 * and the page stays empty. Below this size the buffered path stays: one frame
 * is cheaper, and the burst is small enough to be absorbed.
 */
const LARGE_BODY_STREAM_BYTES = 512 * 1024

/**
 * How long the session of the phone lasts.
 *
 * The server mints its own cookie for thirty days; the phone keeps the same
 * span, so both forget the session at the same time.
 */
const SESSION_COOKIE_MAX_AGE = 2592000

/**
 * How long an event stream may stay quiet before the tunnel says something.
 *
 * The relay cuts a stream that says nothing for five minutes, and a phone
 * that only reads the conversation says nothing for a long time. The tunnel
 * therefore keeps the stream alive with a comment.
 */
const STREAM_KEEPALIVE_MS = 60_000

/**
 * The comment that keeps an event stream alive.
 *
 * A line that starts with a colon is a comment in Server-Sent Events, and
 * every client ignores it.
 */
const STREAM_KEEPALIVE_COMMENT = ': keep-alive\n\n'



/** The gzip implementation, as a promise. */
const gzipAsync = promisify(gzip)

/**
 * The brotli implementation, as a promise.
 *
 * It is not available in every runtime the plugin runs in, so the caller asks
 * for it defensively.
 */
const brotliCompressAsync = typeof brotliCompress === 'function' ? promisify(brotliCompress) : undefined

/**
 * The brotli quality the tunnel compresses with.
 *
 * Six is the point where the bytes stop getting smaller fast enough: the
 * bundle of every plugin shrinks by 9% against gzip, and the Host compresses
 * on the request path — the phone waits for it. A higher quality costs seconds
 * on a nine-megabyte body and buys a percent.
 */
const BROTLI_QUALITY = 6

/**
 * The window brotli may look back over.
 *
 * Twenty-four bits is sixteen megabytes: the whole body of the client bundles
 * of every plugin, which is what gzip cannot see across.
 */
const BROTLI_WINDOW = 24

const BROTLI_PARAM_QUALITY = zlibConstants.BROTLI_PARAM_QUALITY
const BROTLI_PARAM_LGWIN = zlibConstants.BROTLI_PARAM_LGWIN
const BROTLI_PARAM_SIZE_HINT = zlibConstants.BROTLI_PARAM_SIZE_HINT

/** Subprotocol tokens allowed by RFC 6455 (`ws` validates against this too). */
const SUBPROTOCOL_PATTERN = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/

/* ---------------------------------------------------------------- helpers */

/**
 * Normalise a relay origin into a `ws://` / `wss://` base URL.
 * @param {string} relayUrl
 * @returns {string}
 */
function toWsBaseUrl(relayUrl) {
  const url = new URL(relayUrl)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new TypeError(
      `relay-client: unsupported relay protocol "${url.protocol}" (expected ws, wss, http or https)`,
    )
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.href
}

/**
 * Convert an `http(s)://` URL into its `ws(s)://` counterpart.
 * @param {string} url
 * @returns {string}
 */
function toWsUrl(url) {
  const parsed = new URL(url)
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:'
  else if (parsed.protocol === 'https:') parsed.protocol = 'wss:'
  return parsed.href
}

/**
 * Split a raw request target into its path and query parts.
 * @param {string} rawPath
 * @returns {{ pathname: string, query: string }}
 */
function splitRequestTarget(rawPath) {
  const raw = typeof rawPath === 'string' && rawPath.length > 0 ? rawPath : '/'
  const withoutHash = raw.includes('#') ? raw.slice(0, raw.indexOf('#')) : raw
  const queryAt = withoutHash.indexOf('?')
  const pathname = queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt)
  const query = queryAt === -1 ? '' : withoutHash.slice(queryAt + 1)
  return { pathname: pathname.startsWith('/') ? pathname : `/${pathname}`, query }
}

/**
 * The name the Harness server gives the browser-session cookie of one
 * authority.
 *
 * The cookie is bound to the authority it was minted for: its name is
 * `dsh-auth-<base64url(sha256(authority))>` and the signed payload carries
 * the same authority. The Harness web server listens on an ephemeral port, so
 * the authority changes whenever the app restarts — a cookie minted for the
 * previous port is worthless and the server refuses it.
 *
 * @param {string} authority `host:port` of the local server
 * @returns {string}
 */
export function sessionCookieName(authority) {
  const digest = createHash('sha256').update(authority).digest('base64')
  const encoded = digest.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  return `dsh-auth-${encoded}`
}

/**
 * Read one cookie value from a request's `Cookie` header.
 *
 * @param {Record<string, unknown>} headers
 * @param {string} name
 * @returns {string | undefined}
 */
function readCookie(headers, name) {
  const raw = headers?.cookie
  const value = Array.isArray(raw) ? raw.join('; ') : String(raw ?? '')
  for (const segment of value.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim()
  }
  return undefined
}

/**
 * Add one cookie to a request's `Cookie` header.
 *
 * @param {unknown} raw the header the phone brought
 * @param {string} cookie the cookie to add, as `name=value`
 * @returns {string}
 */
function appendCookie(raw, cookie) {
  const current = Array.isArray(raw) ? raw.join('; ') : String(raw ?? '')
  if (current.length === 0) return cookie
  return `${current}; ${cookie}`
}

/**
 * The browser session cookie of the local server, as it was minted.
 *
 * The server names the cookie after the authority it serves, so only that one
 * cookie is the session.
 *
 * @param {unknown} raw the `Set-Cookie` header of the answer
 * @param {string} authority `host:port` of the local server
 * @returns {string | undefined} the cookie as `name=value`
 */
function sessionCookieOf(raw, authority) {
  const name = sessionCookieName(authority)
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]
  for (const entry of list) {
    const at = entry.indexOf('=')
    if (at === -1) continue
    if (entry.slice(0, at).trim() !== name) continue
    return `${name}=${entry.slice(at + 1).trim()}`
  }
  return undefined
}

/**
 * Whether the request already carries the Harness session cookie of the
 * current authority.
 *
 * The launch token is exchanged for a signed cookie once: the first index
 * request trades the token in, and every later request presents the cookie.
 * Injecting the token again would make the server answer a fresh redirect on
 * every page load, and the phone would follow it forever.
 *
 * A cookie of another authority does not count: the phone kept it across a
 * restart of the Harness app, the server no longer accepts it, and counting it
 * as a session would lock the phone out for good. Trading the token in again
 * is the only way back.
 *
 * @param {Record<string, unknown>} headers
 * @param {string} authority `host:port` of the local server
 * @returns {boolean}
 */
function hasSessionCookie(headers, authority) {
  return readCookie(headers, sessionCookieName(authority)) !== undefined
}

/**
 * Is this upstream path a guest request?
 *
 * A guest request is one that a share link produced. It must never receive
 * the launch token and must never be answered with an owner cookie: the guest
 * is not the owner, and a guest that could mint the owner's session would be
 * the owner.
 *
 * The relay forwards a guest link under `/share/`; `/s/` is the path the relay
 * publishes the link with, and it is refused the same way in case a relay
 * forwards it unchanged.
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function isGuestPath(pathname) {
  if (typeof pathname !== 'string' || pathname.length === 0) return false
  return pathname.startsWith('/share/') || pathname.startsWith('/s/')
}

/**
 * Compress a response body that has to travel over a slow link.
 *
 * The tunnel carries a body base64-encoded inside a JSON frame, so every byte
 * is paid for twice: once on the way to the relay and once on the way from it
 * to the phone. Compressing *before* that encoding is what makes a remote
 * relay bearable — the Harness web app is one client bundle of roughly 9 MB,
 * which compresses to less than half of that.
 *
 * The compression happens here rather than in the Harness server because that
 * server has its gzip middleware switched off by default, and this plugin is
 * the only party that knows the link is slow. The relay forwards the body and
 * the `content-encoding` header untouched, and the phone's browser
 * decompresses it on its own.
 *
 * **Brotli, not gzip.** The body that hurts most is the one that carries the
 * client bundles of every installed plugin: several megabytes of minified
 * JavaScript, concatenated. Gzip has a window of 32 KB, so it cannot see
 * across the bundles, and minified code is already dense: the big bundle
 * shrinks by 2.3× under gzip and by 3.1× under brotli. Brotli also has a
 * window of up to 16 MB and compresses *faster* than gzip at the quality that
 * matters here — the Host compresses on the request path, and the phone waits.
 *
 * Every browser that can run the Harness app understands `content-encoding:
 * br`: the app needs ES modules, and every browser with ES modules has had
 * brotli since 2016. The phone inflates it on its own, so nothing in the
 * browser half has to know about it.
 *
 * @param {number} status the upstream status
 * @param {Record<string, unknown>} headers the upstream response headers
 * @param {Buffer} body the upstream response body
 * @returns {Promise<{ headers: Record<string, unknown>, body: Buffer }>}
 */
async function compressResponse(status, headers, body) {
  if (status === 204 || status === 304) return { headers, body }
  if (body.length < MIN_COMPRESSED_BYTES) return { headers, body }
  // An encoded body stays as it is: the encoding is the server's business.
  const encoding = headers['content-encoding']
  if (typeof encoding === 'string' && encoding.length > 0) return { headers, body }
  const type = String(headers['content-type'] ?? '')
  if (!COMPRESSIBLE_CONTENT_TYPES.test(type)) return { headers, body }

  const brotli = await compressBrotli(body)
  if (brotli !== undefined && brotli.length < body.length) {
    return {
      headers: {
        ...headers,
        'content-encoding': 'br',
        'content-length': String(brotli.length),
      },
      body: brotli,
    }
  }

  let compressed
  try {
    compressed = await gzipAsync(body, { level: 6 })
  } catch {
    // A body that cannot be compressed is still a body that can be sent.
    return { headers, body }
  }
  if (compressed.length >= body.length) return { headers, body }

  return {
    headers: {
      ...headers,
      'content-encoding': 'gzip',
      'content-length': String(compressed.length),
    },
    body: compressed,
  }
}

/**
 * Compress a body with brotli.
 *
 * @param {Buffer} body the raw body
 * @returns {Promise<Buffer | undefined>} undefined when brotli is not available
 */
async function compressBrotli(body) {
  if (typeof brotliCompressAsync !== 'function') return undefined
  try {
    return await brotliCompressAsync(body, {
      params: {
        [BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [BROTLI_PARAM_LGWIN]: BROTLI_WINDOW,
        [BROTLI_PARAM_SIZE_HINT]: body.length,
      },
    })
  } catch {
    return undefined
  }
}

/**
 * Rewrite the HTML document a phone receives.
 *
 * Two things are wrong for a phone on the way out:
 *
 *   1. The web app ships its client-module bundles with `rel="preload"
 *      as="script"`, but the browser loads those bundles as ES modules. WebKit
 *      — the engine behind Safari — does not reuse a classic script preload for
 *      a module import: it cancels the preload, the import fails with it, and
 *      the page never finishes booting. `rel="modulepreload"` is the preload a
 *      module import can use.
 *   2. A focused field makes the browser zoom the page in, which on a phone
 *      leaves the composer stretched across the screen and the rail out of
 *      sight. The viewport therefore asks for a maximum scale of one, so the
 *      focus cannot magnify anything.
 *
 * Only the tunnel rewrites the document: the desktop app keeps the markup it
 * shipped with.
 *
 * @param {Buffer} body the upstream response body
 * @param {Record<string, unknown>} headers the upstream response headers
 * @returns {{ body: Buffer, headers: Record<string, unknown> }} the body and headers to serve
 */
export function rewritePhoneDocument(body, headers) {
  const source = headers ?? {}
  const type = String(source['content-type'] ?? source['Content-Type'] ?? '')
  if (!/^text\/html/i.test(type.trim())) return { body, headers: { ...source } }
  const text = body.toString('utf8')
  let rewritten = text.replace(/<link\b[^>]*>/g, (tag) => {
    if (!/rel="preload"/.test(tag)) return tag
    if (!/as="script"/.test(tag)) return tag
    const href = /href="([^"]*)"/.exec(tag)
    if (href === null || !href[1].startsWith('plugins/??')) return tag
    return tag.replace('rel="preload"', 'rel="modulepreload"').replace(/\s*as="script"/, '')
  })
  // The inspector is a tool of the desktop: it lives on the machine the app
  // runs on, and its address is a local one. A phone that is somewhere else
  // cannot reach it, and a browser that tries asks the person for the
  // permission to reach the local network — again and again, because the
  // connection is retried for as long as the page lives.
  //
  // The announcement is therefore taken out of the phone's copy of the
  // document. The inspector's client half reads it when it is there and does
  // nothing when it is not.
  rewritten = rewritten.replace(
    /<script>\s*globalThis\["__DSH_INSPECTOR__"\][\s\S]*?<\/script>/gi,
    '',
  )
  const viewportMeta = /<meta\s+name="viewport"\s+content="([^"]*)"\s*\/?>/i
  if (viewportMeta.test(rewritten)) {
    rewritten = rewritten.replace(viewportMeta, (tag, content) => {
      const parts = content
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && !/^(initial-scale|maximum-scale|user-scalable)=/i.test(part))
      parts.push('initial-scale=1', 'maximum-scale=1', 'user-scalable=no')
      // The safe-area insets only exist when the page covers the notch.
      if (!parts.some((part) => /^viewport-fit=/i.test(part))) parts.push('viewport-fit=cover')
      return `<meta name="viewport" content="${parts.join(', ')}">`
    })
  } else {
    // A document without a viewport would be laid out for a desktop window.
    const meta = '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">'
    rewritten = /<head(\s[^>]*)?>/i.test(rewritten)
      ? rewritten.replace(/<head(\s[^>]*)?>/i, (tag) => `${tag}${meta}`)
      : `${meta}${rewritten}`
  }
  if (rewritten === text) return { body, headers: { ...source } }
  const next = Buffer.from(rewritten, 'utf8')
  const out = { ...source }
  const lengthKey = 'content-length' in out ? 'content-length' : 'Content-Length' in out ? 'Content-Length' : null
  if (lengthKey !== null) out[lengthKey] = String(next.length)
  return { body: next, headers: out }
}
/**
 * Does the raw query string already carry `name`?
 * @param {string} query
 * @param {string} name
 * @returns {boolean}
 */
function hasQueryParam(query, name) {
  if (!query) return false
  const wanted = name.toLowerCase()
  for (const part of query.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const rawKey = eq === -1 ? part : part.slice(0, eq)
    let key = rawKey.replace(/\+/g, ' ')
    try {
      key = decodeURIComponent(key)
    } catch {
      /* keep the raw key when it is not valid percent-encoding */
    }
    if (key.toLowerCase() === wanted) return true
  }
  return false
}

/**
 * Read one query parameter's value.
 *
 * @param {string} query the raw query string
 * @param {string} name the parameter to read
 * @returns {string | undefined} the decoded value, or undefined when absent
 */
function queryParamValue(query, name) {
  if (!query) return undefined
  const wanted = name.toLowerCase()
  for (const part of query.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const rawKey = eq === -1 ? part : part.slice(0, eq)
    let key = rawKey.replace(/\+/g, ' ')
    try {
      key = decodeURIComponent(key)
    } catch {
      /* keep the raw key when it is not valid percent-encoding */
    }
    if (key.toLowerCase() !== wanted) continue
    if (eq === -1) return ''
    const rawValue = part.slice(eq + 1).replace(/\+/g, ' ')
    try {
      return decodeURIComponent(rawValue)
    } catch {
      return rawValue
    }
  }
  return undefined
}

/**
 * Append one query parameter, preserving every existing one.
 * @param {string} query
 * @param {string} name
 * @param {string} value
 * @returns {string}
 */
function appendQueryParam(query, name, value) {
  const encoded = `${name}=${encodeURIComponent(value)}`
  return query ? `${query}&${encoded}` : encoded
}

/**
 * Remove one query parameter, preserving every other one.
 *
 * The phone announces its compression support in the query of its stream
 * URL. That parameter is ours, not the DSH server's, so it must not reach
 * the local server.
 *
 * @param {string} query the raw query string
 * @param {string} name the parameter to drop
 * @returns {string}
 */
function removeQueryParam(query, name) {
  if (!query) return ''
  const wanted = name.toLowerCase()
  const kept = []
  for (const part of query.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const rawKey = eq === -1 ? part : part.slice(0, eq)
    let key = rawKey.replace(/\+/g, ' ')
    try {
      key = decodeURIComponent(key)
    } catch {
      /* keep the raw key when it is not valid percent-encoding */
    }
    if (key.toLowerCase() === wanted) continue
    kept.push(part)
  }
  return kept.join('&')
}

/**
 * Remove one query parameter from a URL, preserving every other one.
 *
 * @param {string} url the absolute URL
 * @param {string} name the parameter to drop
 * @returns {string}
 */
function removeQueryParamFromUrl(url, name) {
  const at = url.indexOf('?')
  if (at === -1) return url
  const path = url.slice(0, at)
  const query = removeQueryParam(url.slice(at + 1), name)
  return query.length === 0 ? path : `${path}?${query}`
}

/**
 * Split the compression announcement out of an upgrade path.
 *
 * A phone that can inflate a compressed payload adds the `rcz` parameter to
 * the query of its stream URL. The parameter is ours, so it is taken out
 * before the path reaches the local DSH server.
 *
 * @param {string} rawPath the path the relay forwarded
 * @returns {{ path: string, compress: boolean }}
 */
function splitCompressionQuery(rawPath) {
  const { pathname, query } = splitRequestTarget(rawPath)
  // The value decides, not the presence: a phone that sends `rcz=0` asks for
  // the payload as it is.
  if (queryParamValue(query, COMPRESSION_QUERY) !== '1') return { path: rawPath, compress: false }
  const rest = removeQueryParam(query, COMPRESSION_QUERY)
  return { path: rest ? `${pathname}?${rest}` : pathname, compress: true }
}

/**
 * Normalise a header value to the string form Node's http client expects.
 * @param {unknown} value
 * @returns {string}
 */
function headerValue(value) {
  if (Array.isArray(value)) return value.join(', ')
  if (value === undefined || value === null) return ''
  return String(value)
}

/**
 * Does the response head describe an event stream?
 *
 * The content type is compared case-insensitively and without its
 * parameters, so `Text/Event-Stream; charset=utf-8` is recognised as well.
 *
 * @param {Record<string, unknown>} headers the upstream response headers
 * @returns {boolean}
 */
function isEventStreamResponse(headers) {
  const type = String(headers?.['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  return type === EVENT_STREAM_CONTENT_TYPE
}

/**
 * Parse a `Sec-WebSocket-Protocol` header into a list of subprotocols.
 * @param {unknown} value
 * @returns {string[]}
 */
function parseSubprotocols(value) {
  if (!value) return []
  const raw = Array.isArray(value) ? value.join(',') : String(value)
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && SUBPROTOCOL_PATTERN.test(entry))
}

/* -------------------------------------------------------------- the client */

/**
 * A relay client: one management channel + one tunnel channel, plus the
 * request/upgrade serving logic in front of the local DSH server.
 */
export class RelayClient {
  /**
   * @param {object} options
   * @param {string} options.relayUrl           Relay origin (`ws://`, `wss://`, `http://` or `https://`).
   * @param {string} options.token              Shared secret (Bearer header + bearer subprotocol).
   * @param {string} options.deviceId           Stable device identifier.
   * @param {string} [options.alias]            Human readable device name.
   * @param {string} [options.platform]         Platform tag (`darwin`, `linux`, ...).
   * @param {string} [options.clientVersion]    Host client version.
   * @param {string} options.localBaseUrl       Base URL of the local DSH server.
   * @param {string} [options.launchToken]      Process launch token injected on the device root.
   * @param {string} [options.accessKey]        Per-device access key the relay demands from a phone.
   * @param {string} [options.passcode]         Per-device passcode a phone must type before it may connect.
   * @param {(message: string, extra?: unknown) => void} [options.log]
   * @param {typeof NodeWebSocket} [options.WebSocketImpl] WebSocket implementation (testing seam).
   */
  constructor(options = {}) {
    const {
      relayUrl,
      token,
      deviceId,
      alias = '',
      platform = process.platform,
      clientVersion = '0.0.0',
      localBaseUrl,
      launchToken = '',
      accessKey = '',
      passcode = '',
      log,
      WebSocketImpl = NodeWebSocket,
      ...tuning
    } = options

    if (!relayUrl) throw new TypeError('relay-client: relayUrl is required')
    if (!token) throw new TypeError('relay-client: token is required')
    if (!deviceId) throw new TypeError('relay-client: deviceId is required')
    if (!localBaseUrl) throw new TypeError('relay-client: localBaseUrl is required')

    /** @type {string} */
    this.relayBaseUrl = toWsBaseUrl(relayUrl)
    /** @type {string} */
    this.token = token
    /** @type {string} */
    this.deviceId = deviceId
    /** @type {string} */
    this.alias = alias
    /** @type {string} */
    this.platform = platform
    /** @type {string} */
    this.clientVersion = clientVersion
    /** @type {string} */
    this.localBaseUrl = localBaseUrl.replace(/\/+$/, '')
    /** @type {string} */
    this.launchToken = launchToken
    /** @type {string} */
    this.accessKey = accessKey
    /** @type {string} */
    this.passcode = passcode
    /** @type {(message: string, extra?: unknown) => void} */
    this.log = typeof log === 'function' ? log : () => {}

    const local = new URL(this.localBaseUrl)
    /** @type {string} `host:port` of the local DSH server. */
    this.localAuthority = local.host
    /** @type {string} `scheme://host:port` of the local DSH server. */
    this.localOrigin = local.origin

    this.pingIntervalMs = tuning.pingIntervalMs ?? DEFAULT_OPTIONS.pingIntervalMs
    /** @type {number} how long an event stream may stay quiet. */
    this.keepAliveMs = tuning.keepAliveMs ?? DEFAULT_OPTIONS.keepAliveMs
    this.reconnectBaseDelayMs = tuning.reconnectBaseDelayMs ?? DEFAULT_OPTIONS.reconnectBaseDelayMs
    this.reconnectMaxDelayMs = tuning.reconnectMaxDelayMs ?? DEFAULT_OPTIONS.reconnectMaxDelayMs
    this.handshakeTimeoutMs = tuning.handshakeTimeoutMs ?? DEFAULT_OPTIONS.handshakeTimeoutMs
    this.registrationTimeoutMs =
      tuning.registrationTimeoutMs ?? DEFAULT_OPTIONS.registrationTimeoutMs
    this.closeTimeoutMs = tuning.closeTimeoutMs ?? DEFAULT_OPTIONS.closeTimeoutMs

    /** @type {typeof NodeWebSocket} */
    this._WebSocket = WebSocketImpl
    /** @type {string} */
    this._subprotocol = bearerSubprotocol(token)
    /** @type {boolean} Some relays ignore the subprotocol; we then talk plain. */
    this._useSubprotocol = SUBPROTOCOL_PATTERN.test(this._subprotocol)

    /** @type {'offline'|'connecting'|'online'|'error'} */
    this._state = 'offline'
    /** @type {string|null} */
    this._publicUrl = null
    /** @type {string|null} */
    this._error = null
    /** @type {boolean} */
    this._registered = false
    /** @type {boolean} whether the relay accepts a body as a binary message */
    this._binaryBodies = false
    /** @type {boolean} whether the relay accepts a ws payload as a binary message */
    this._binaryWsPayloads = false
    /** @type {boolean} */
    this._stopped = true
    /** @type {{ id: string, revoked: boolean }[]} the shared sessions the relay routes */
    this._shares = []

    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map()
    /** @type {{ management: object|null, tunnel: object|null }} */
    this._sessions = { management: null, tunnel: null }
    /** @type {Map<string, { controller: AbortController }>} */
    this._requests = new Map()
    /** @type {Map<string, { local: any, pending: any[] }>} */
    this._bridges = new Map()
    /** @type {Map<string, NodeJS.Timeout>} */
    this._reconnectTimers = new Map()
    /**
     * The browser session of the local server, minted for the phone.
     *
     * The server hands the cookie out with the launch token, and answers with
     * a redirect to the clean URL. The phone would have to follow that
     * redirect over the link, and a browser that does not keep the cookie
     * follows it again on every request. The cookie is therefore minted here,
     * once, and carried into the phone's request.
     *
     * @type {string | undefined}
     */
    this._sessionCookie = undefined
    /** @type {Promise<string | null>|undefined} */
    this._sessionCookiePending = undefined
    /** @type {number} */
    this._managementAttempts = 0
    /** @type {number} */
    this._tunnelAttempts = 0
    /** @type {Promise<any>|null} */
    this._startPromise = null
    /** @type {((value: any) => void)|null} */
    this._resolveStart = null
    /** @type {((reason: Error) => void)|null} */
    this._rejectStart = null
  }

  /* ------------------------------------------------------------ public API */

  /**
   * Current connection state.
   * @returns {{ state: 'offline'|'connecting'|'online'|'error', publicUrl: string|null, error: string|null }}
   */
  status() {
    return {
      state: this._state,
      publicUrl: this._publicUrl,
      error: this._error,
    }
  }

  /**
   * The shared sessions the relay routes for this device.
   *
   * The list travels with the next registration, so a relay that restarted
   * learns the guest links again.
   *
   * @returns {{ id: string, revoked: boolean }[]}
   */
  shares() {
    return this._shares.map((share) => ({ ...share }))
  }

  /**
   * Replace the list of shared sessions.
   *
   * @param {{ id: string, revoked?: boolean }[]} shares
   * @returns {{ id: string, revoked: boolean }[]}
   */
  setShares(shares) {
    this._shares = (Array.isArray(shares) ? shares : [])
      .filter((share) => typeof share?.id === 'string' && share.id.length > 0)
      .map((share) => ({
        id: share.id,
        revoked: share.revoked === true,
        revokedAt: Number.isFinite(share.revokedAt) ? share.revokedAt : null,
      }))
    return this.shares()
  }

  /**
   * Publish one shared session to the relay.
   *
   * The relay routes the guest link to this device; the frame tells it that
   * the link exists and whether it is still open.
   *
   * @param {string} shareId
   * @param {boolean} [revoked]
   * @returns {boolean} whether the frame was sent
   */
  publishShare(shareId, revoked = false, revokedAt = null) {
    if (typeof shareId !== 'string' || shareId.length === 0) return false
    const entry = { id: shareId, revoked: revoked === true, revokedAt: revokedAt ?? null }
    const at = this._shares.findIndex((share) => share.id === shareId)
    if (at === -1) this._shares.push(entry)
    else this._shares[at] = entry
    return this._send(
      this._sessions.management?.socket,
      sharePublishFrame({ shareId, deviceId: this.deviceId, revoked: revoked === true, revokedAt: revokedAt ?? null }),
    )
  }

  /**
   * Withdraw one shared session from the relay.
   *
   * The share stays in the registration list, marked as revoked: a relay that
   * restarts must learn that the link is closed, not that it never existed.
   *
   * @param {string} shareId
   * @returns {boolean} whether the frame was sent
   */
  revokeShare(shareId, revokedAt = Date.now()) {
    if (typeof shareId !== 'string' || shareId.length === 0) return false
    const at = this._shares.findIndex((share) => share.id === shareId)
    if (at === -1) this._shares.push({ id: shareId, revoked: true, revokedAt })
    else this._shares[at] = { id: shareId, revoked: true, revokedAt }
    return this._send(
      this._sessions.management?.socket,
      shareRevokeFrame({ shareId, deviceId: this.deviceId, revokedAt }),
    )
  }

  /**
   * Subscribe to a client event. Returns an unsubscribe function.
   *
   * Events:
   *   - `status` — the status object changed (payload: `client.status()`).
   *   - `revoke` — the relay withdrew the device (payload: the reason string).
   *   - `error` — a recoverable client error (payload: `Error`).
   *
   * @param {string} event
   * @param {(payload: any) => void} listener
   * @returns {() => void}
   */
  on(event, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('relay-client: listener must be a function')
    }
    let listeners = this._listeners.get(event)
    if (!listeners) {
      listeners = new Set()
      this._listeners.set(event, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  /**
   * Open both channels. Resolves once the management channel is registered
   * (the relay answered with `register_ack`).
   *
   * Rejects when the relay refuses the device (`register_nak`), when the first
   * management connection fails, or when the client is stopped before the
   * registration completes. A rejected `start()` does not kill the client:
   * it keeps retrying in the background and `status()` reports the state.
   *
   * @returns {Promise<{ state: string, publicUrl: string|null, error: string|null }>}
   */
  start() {
    if (this._state === 'online') return Promise.resolve(this.status())
    if (this._startPromise) return this._startPromise

    this._stopped = false
    this._error = null
    this._setState('connecting')

    const promise = new Promise((resolve, reject) => {
      this._resolveStart = resolve
      this._rejectStart = reject
    })
    // Keep an unobserved rejection from crashing the process; the caller still
    // receives the very same (rejected) promise.
    promise.catch(() => {})
    this._startPromise = promise

    this._connectManagement()
    this._connectTunnel()

    return promise
  }

  /**
   * Close both channels, abort every in-flight request and release resources.
   * @returns {Promise<void>}
   */
  async stop() {
    await this._shutdown(null)
  }

  /* ---------------------------------------------------------- state/events */

  /**
   * @param {'offline'|'connecting'|'online'|'error'} state
   * @param {string|null} [error]
   */
  _setState(state, error = null) {
    const changed = this._state !== state || this._error !== error
    this._state = state
    this._error = error
    if (changed) this._emit('status', this.status())
  }

  /**
   * @param {string} event
   * @param {unknown} payload
   */
  _emit(event, payload) {
    const listeners = this._listeners.get(event)
    if (!listeners || listeners.size === 0) return
    for (const listener of [...listeners]) {
      try {
        listener(payload)
      } catch (err) {
        this._log('event listener failed', { event, error: err })
      }
    }
  }

  /**
   * @param {string} message
   * @param {unknown} [extra]
   */
  _log(message, extra) {
    try {
      this.log(`relay-client: ${message}`, extra)
    } catch {
      /* a broken logger must never take the client down */
    }
  }

  /* -------------------------------------------------------- channel wiring */

  /**
   * Open (or reopen) the management channel.
   */
  _connectManagement() {
    if (this._stopped) return
    this._clearReconnectTimer('management')
    const url = managementUrl(this.relayBaseUrl)
    this._openSocket(url, 'management')
  }

  /**
   * Open (or reopen) the tunnel channel.
   */
  _connectTunnel() {
    if (this._stopped) return
    this._clearReconnectTimer('tunnel')
    const url = tunnelUrl(this.relayBaseUrl, this.deviceId)
    this._openSocket(url, 'tunnel')
  }

  /**
   * Create one channel socket and wire its lifecycle.
   * @param {string} url
   * @param {'management'|'tunnel'} role
   */
  _openSocket(url, role) {
    const headers = { authorization: bearerHeader(this.token) }
    const protocols = this._useSubprotocol ? [this._subprotocol] : []
    const socketOptions = {
      headers,
      // `ws` takes the subprotocol through the `protocols` argument; the
      // `protocol` field is kept for documentation/compatibility.
      protocol: this._subprotocol,
      handshakeTimeout: this.handshakeTimeoutMs,
    }

    /** @type {any} */
    let socket
    try {
      socket = new this._WebSocket(url, protocols, socketOptions)
    } catch (err) {
      this._log(`failed to open the ${role} channel`, { url, error: err })
      this._handleChannelFailure(role, err)
      return
    }

    const session = {
      role,
      socket,
      alive: true,
      pingTimer: null,
      registrationTimer: null,
    }
    this._sessions[role] = session

    socket.on('open', () => {
      this._log(`${role} channel open`, { url })
      session.alive = true
      this._startPing(session)
      if (role === 'management') {
        this._managementAttempts = 0
        this._sendRegister(session)
      } else {
        this._tunnelAttempts = 0
        if (this._registered) this._setState('online')
      }
    })

    socket.on('message', (data) => {
      this._handleRawFrame(role, session, data)
    })

    socket.on('pong', () => {
      session.alive = true
    })

    socket.on('error', (err) => {
      const message = err && err.message ? err.message : String(err)
      this._log(`${role} channel error`, { url, error: message })
      if (/subprotocol/i.test(message) && this._useSubprotocol) {
        // The relay did not echo the bearer subprotocol. Drop it and retry
        // immediately; the Authorization header still carries the credential.
        this._useSubprotocol = false
        this._log('relay did not echo the bearer subprotocol, retrying without it')
        session.fastReconnect = true
      }
      if (role === 'management' && this._startPromise) {
        this._rejectStartOnce(
          err instanceof Error ? err : new Error(`relay-client: ${message}`),
        )
      }
      this._emit('error', err instanceof Error ? err : new Error(message))
    })

    socket.on('close', (code, reason) => {
      this._teardownSession(session)
      if (this._stopped) return
      this._log(`${role} channel closed`, { code, reason: reason?.toString() })
      if (role === 'management') {
        this._registered = false
        if (this._state !== 'error') this._setState('connecting')
      }
      this._scheduleReconnect(role, Boolean(session.fastReconnect))
    })
  }

  /**
   * Send the `register` frame and arm the registration timeout.
   * @param {object} session
   */
  _sendRegister(session) {
    const frame = registerFrame({
      deviceId: this.deviceId,
      alias: this.alias,
      platform: this.platform,
      clientVersion: this.clientVersion,
      localBaseUrl: this.localBaseUrl,
      accessKey: this.accessKey,
      passcode: this.passcode,
      shares: this._shares,
    })
    this._send(session.socket, frame)
    if (session.registrationTimer) clearTimeout(session.registrationTimer)
    session.registrationTimer = setTimeout(() => {
      session.registrationTimer = null
      if (session.socket?.readyState === this._WebSocket.OPEN) {
        this._log('the relay did not acknowledge the registration, reconnecting')
        this._rejectStartOnce(
          new Error('relay-client: the relay did not acknowledge the registration'),
        )
        try {
          session.socket.terminate()
        } catch {
          /* ignore */
        }
      }
    }, this.registrationTimeoutMs)
  }

  /**
   * Start the keepalive ping on a channel.
   * @param {object} session
   */
  _startPing(session) {
    if (session.pingTimer) clearInterval(session.pingTimer)
    session.pingTimer = setInterval(() => {
      const socket = session.socket
      if (!socket || socket.readyState !== this._WebSocket.OPEN) return
      if (!session.alive) {
        this._log(`${session.role} channel missed a pong, reconnecting`)
        try {
          socket.terminate()
        } catch {
          /* ignore */
        }
        return
      }
      session.alive = false
      try {
        socket.ping()
      } catch (err) {
        this._log('ping failed', { error: err })
      }
    }, this.pingIntervalMs)
  }

  /**
   * Release the timers of a closed channel.
   * @param {object} session
   */
  _teardownSession(session) {
    if (!session) return
    if (session.pingTimer) {
      clearInterval(session.pingTimer)
      session.pingTimer = null
    }
    if (session.registrationTimer) {
      clearTimeout(session.registrationTimer)
      session.registrationTimer = null
    }
    if (this._sessions[session.role] === session) this._sessions[session.role] = null
  }

  /**
   * Schedule the next connection attempt with a capped exponential backoff.
   * @param {'management'|'tunnel'} role
   * @param {boolean} [immediate]
   */
  _scheduleReconnect(role, immediate = false) {
    if (this._stopped) return
    this._clearReconnectTimer(role)

    const attempts =
      role === 'management' ? this._managementAttempts++ : this._tunnelAttempts++
    const base = Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectBaseDelayMs * 2 ** Math.max(0, attempts - 1),
    )
    const delay = immediate ? 0 : Math.round(base * (0.8 + Math.random() * 0.4))

    const timer = setTimeout(() => {
      this._reconnectTimers.delete(role)
      if (this._stopped) return
      if (role === 'management') this._connectManagement()
      else this._connectTunnel()
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
    this._reconnectTimers.set(role, timer)
    this._log(`reconnecting the ${role} channel in ${delay}ms`, { attempts })
  }

  /**
   * @param {'management'|'tunnel'} role
   */
  _clearReconnectTimer(role) {
    const timer = this._reconnectTimers.get(role)
    if (timer) {
      clearTimeout(timer)
      this._reconnectTimers.delete(role)
    }
  }

  /**
   * React to a channel that could not even be created.
   * @param {'management'|'tunnel'} role
   * @param {unknown} err
   */
  _handleChannelFailure(role, err) {
    if (role === 'management' && this._startPromise) {
      this._rejectStartOnce(err instanceof Error ? err : new Error(String(err)))
    }
    this._scheduleReconnect(role)
  }

  /* --------------------------------------------------------- frame handling */

  /**
   * Decode and dispatch one incoming frame. Never throws.
   * @param {'management'|'tunnel'} role
   * @param {object} session
   * @param {unknown} data
   */
  _handleRawFrame(role, session, data) {
    let frame
    try {
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
      frame = decodeFrame(text)
    } catch (err) {
      this._log(`ignoring an undecodable ${role} frame`, { error: err })
      return
    }

    try {
      if (role === 'management') this._handleManagementFrame(frame, session)
      else this._handleTunnelFrame(frame)
    } catch (err) {
      this._log(`failed to handle a ${role} frame`, { type: frame?.type, error: err })
      this._emit('error', err instanceof Error ? err : new Error(String(err)))
    }
  }

  /**
   * @param {Record<string, unknown>} frame
   */
  _handleManagementFrame(frame, session) {
    switch (frame.type) {
      case 'register_ack': {
        // The relay answered: the registration timeout has served its purpose
        // and must not tear down a healthy channel later on.
        if (session?.registrationTimer) {
          clearTimeout(session.registrationTimer)
          session.registrationTimer = null
        }
        this._registered = true
        const publicUrl =
          typeof frame.public_url === 'string'
            ? frame.public_url
            : typeof frame.publicUrl === 'string'
              ? frame.publicUrl
              : null
        this._publicUrl = publicUrl
        // A relay that accepts a body as a binary message saves the base64
        // inflation on every response; an older one keeps the JSON frame.
        const capabilities = Array.isArray(frame.capabilities) ? frame.capabilities : []
        this._binaryBodies = capabilities.includes(CAPABILITY_BINARY_BODY)
        // The same for a WebSocket payload: the biggest one of all — a
        // session snapshot — pays for no base64 when it travels as a binary
        // message. An older relay keeps the JSON frame.
        this._binaryWsPayloads = capabilities.includes(CAPABILITY_WS_BINARY_BODY)
        this._setState('online')
        this._log('registered with the relay', {
          publicUrl,
          binaryBodies: this._binaryBodies,
          binaryWsPayloads: this._binaryWsPayloads,
        })
        this._resolveStartOnce(this.status())
        break
      }
      case 'register_nak': {
        const reason =
          typeof frame.reason === 'string' && frame.reason
            ? frame.reason
            : 'the relay refused the device'
        this._log('the relay refused the device', { reason })
        this._rejectStartOnce(new Error(`relay-client: ${reason}`))
        this._setState('error', reason)
        if (DUPLICATE_REASON.test(reason)) {
          // A duplicate registration is transient: the relay may still be
          // holding the registration of a connection that is already gone — a
          // dropped network leaves such a socket open on the relay, and it
          // refuses this device until the relay notices. The client keeps
          // trying, so the computer comes back on its own once the relay
          // lets go of the stale registration.
          this._log('the relay still holds this device; retrying')
          try {
            session.socket?.terminate()
          } catch {
            /* ignore */
          }
          break
        }
        void this._shutdown(reason, 'error')
        break
      }
      case 'revoke': {
        const reason = typeof frame.reason === 'string' ? frame.reason : 'revoked'
        this._log('the relay revoked the device', { reason })
        this._emit('revoke', reason)
        this._setState('offline', reason)
        void this._shutdown(reason)
        break
      }
      default:
        this._log('ignoring an unknown management frame', { type: frame.type })
    }
  }

  /**
   * @param {Record<string, unknown>} frame
   */
  _handleTunnelFrame(frame) {
    switch (frame.type) {
      case 'request':
        void this._handleRequest(frame)
        break
      case 'upgrade':
        void this._handleUpgrade(frame)
        break
      case 'abort':
        this._abortRequest(String(frame.id))
        break
      case 'ws_frame':
        this._handleBridgeFrame(frame)
        break
      case 'ws_ping':
        this._handleBridgePing(frame)
        break
      case 'ws_pong':
        this._handleBridgePong(frame)
        break
      case 'ws_close':
        this._handleBridgeClose(frame)
        break
      case 'request_chunk':
      case 'response_chunk':
        this._log('chunked frames are not supported by this client', {
          type: frame.type,
          id: frame.id,
        })
        break
      default:
        this._log('ignoring an unknown tunnel frame', { type: frame.type })
    }
  }

  /* --------------------------------------------------------------- serving */

  /**
   * Resolve a tunnel request path into the upstream URL.
   *
   * The relay may forward the phone's device-scoped path (`/<deviceId>/...`);
   * that prefix is stripped so the request lands on the local DSH server.
   *
   * The launch token is only injected on the device root, and only while the
   * phone holds no session cookie of the current authority (see
   * `hasSessionCookie`). `forceToken` trades it in regardless, which is how a
   * refused session is recovered.
   *
   * A guest request never gets the token. The guest is a stranger with a
   * passcode, and the launch token is the owner's credential: handing it out
   * would make every guest the owner.
   *
   * @param {string} rawPath
   * @param {Record<string, unknown>} [headers] the raw (pre-rewrite) headers
   * @param {{ method?: string, forceToken?: boolean }} [options]
   * @returns {{ url: string, pathname: string, query: string, isDeviceRoot: boolean, isGuest: boolean, tokenInjected: boolean }}
   */
  _resolveUpstream(rawPath, headers, options = {}) {
    const { pathname, query } = splitRequestTarget(rawPath)

    const prefix = `/${this.deviceId}`
    let relative = pathname
    if (relative === prefix) relative = '/'
    else if (relative.startsWith(`${prefix}/`)) relative = relative.slice(prefix.length)

    const base = new URL(this.localBaseUrl)
    const basePath = base.pathname.replace(/\/+$/, '')
    const target = new URL(this.localBaseUrl)
    target.search = ''
    target.hash = ''
    target.pathname = `${basePath}${relative}` || '/'

    const method = (options.method ?? 'GET').toUpperCase()
    const isDeviceRoot = relative === '/'
    const isGuest = isGuestPath(relative)
    // The server only mints a session cookie for `GET /?token=…`.
    const canInject =
      method === 'GET' &&
      isDeviceRoot &&
      !isGuest &&
      this.launchToken.length > 0 &&
      !hasQueryParam(query, 'token')
    const bringsToken = hasQueryParam(query, 'token')
    const tokenInjected =
      canInject &&
      (options.forceToken === true || !hasSessionCookie(headers, this.localAuthority))

    // The compression announcement is ours, not the DSH server's: it never
    // reaches the local server, on any path.
    let search = removeQueryParam(query, COMPRESSION_QUERY)
    if (tokenInjected) search = appendQueryParam(search, 'token', this.launchToken)
    target.search = search ? `?${search}` : ''

    return { url: target.href, pathname: relative, query: search, isDeviceRoot, isGuest, tokenInjected, bringsToken }
  }

  /**
   * Rewrite the phone's headers for the local server.
   *
   * `Host` and `Origin` are the relay's, so they are replaced with the local
   * authority/origin; everything else (cookie, sec-fetch-*, content-type,
   * accept, ...) is preserved.
   *
   * @param {Record<string, unknown>} headers
   * @param {boolean} [forUpgrade] drop the WebSocket handshake headers too
   * @returns {Record<string, string>}
   */
  _rewriteHeaders(headers, forUpgrade = false) {
    const out = {}
    for (const [rawName, rawValue] of Object.entries(headers || {})) {
      const name = rawName.toLowerCase()
      if (DROPPED_REQUEST_HEADERS.has(name)) continue
      if (forUpgrade && DROPPED_UPGRADE_HEADERS.has(name)) continue
      if (name === 'host') continue
      if (name === 'origin') {
        out.origin = this.localOrigin
        continue
      }
      out[name] = headerValue(rawValue)
    }
    out.host = this.localAuthority
    out['accept-encoding'] = 'identity'
    return out
  }

  /**
   * Serve one `request` frame against the local DSH server.
   * @param {Record<string, unknown>} frame
   */
  async _handleRequest(frame) {
    const id = String(frame.id ?? '')
    const method = String(frame.method ?? 'GET').toUpperCase()
    const headers = this._rewriteHeaders(frame.headers)
    const rawPath = typeof frame.path === 'string' ? frame.path : '/'
    const resolved = this._resolveUpstream(rawPath, frame.headers, { method })
    let { url, pathname, query } = resolved

    let body = null
    if (typeof frame.body === 'string' && frame.body.length > 0) {
      const encoding = frame.body_encoding
      if (encoding === 'utf8' || encoding === 'text' || encoding === 'plain') {
        body = Buffer.from(frame.body, 'utf8')
      } else {
        body = Buffer.from(frame.body, 'base64')
      }
    }

    // The upstream request is framed by the body we actually have, so a
    // mismatching `content-length` from the phone can never stall it.
    delete headers['content-length']
    if (body && body.length > 0) headers['content-length'] = String(body.length)

    // The phone's first request to the app root is answered with a cookie and
    // a redirect: the server mints the session and sends the browser to the
    // clean URL. Through a relay that redirect costs a whole extra round trip
    // over the link — and a browser that does not keep the cookie pays it
    // again on every request, which is a loop the phone never leaves.
    //
    // The Host mints the cookie for us instead: one local call, and the phone
    // gets the app in a single hop.
    //
    // The session of the phone is the one the host holds. Whenever the phone
    // does not carry a valid one — because its browser dropped it, or
    // because the app moved its port — the host attaches the session it
    // minted, so the phone is never refused for a cookie it cannot help.
    //
    // A guest never gets it: the launch token and the session are the
    // owner's credential, and a guest that could trade them in would be the
    // owner.
    let mintedCookie = null
    if (!resolved.isGuest && !resolved.bringsToken && !hasSessionCookie(headers, this.localAuthority)) {
      const minted = await this._mintSessionCookie()
      if (minted !== null) {
        headers.cookie = appendCookie(headers.cookie, minted)
        // The cookie is the session now: the token would only make the server
        // mint another one and send the phone on another round trip.
        if (resolved.tokenInjected === true) url = removeQueryParamFromUrl(url, 'token')
        // The cookie has to reach the phone as well: the server would have
        // sent it with its redirect, and there is no redirect any more. A
        // phone without the cookie in its own jar is a phone whose every
        // later request is refused.
        mintedCookie = minted
      }
    }

    const controller = new AbortController()
    this._requests.set(id, { controller })

    try {
      let opened = await this._openHttpRequest({
        method,
        url,
        headers,
        body,
        controller,
      })
      // A phone can hold a session the server no longer accepts: the Harness
      // app restarted on another port, or the signing secret changed. The
      // server answers 401, and only the launch token buys a fresh cookie —
      // without this retry the phone stays locked out for good.
      //
      // A guest request never gets that retry: the launch token is the owner's
      // credential, and a guest that could trade it in would be the owner.
      if (opened.status === 401 && !resolved.tokenInjected && !resolved.isGuest) {
        const retry = this._resolveUpstream(rawPath, frame.headers, { method, forceToken: true })
        if (retry.tokenInjected) {
          this._log('the session cookie was refused; retrying with the launch token', {
            id,
            path: pathname,
          })
          // The cookie the Host minted for us is worthless now: the app
          // restarted and moved its port, or its secret changed. The next
          // request mints a new one.
          this._sessionCookie = undefined
          // The refused body is of no use: it is dropped, not read.
          opened.response.resume()
          opened = await this._openHttpRequest({
            method,
            url: retry.url,
            headers,
            body,
            controller,
          })
        }
      }

      // An event stream never ends: the head goes out first and the body
      // follows in chunks, so the relay does not time the request out and
      // the phone gets the events instead of a 504.
      if (isEventStreamResponse(opened.rawHeaders)) {
        await this._streamResponse(id, opened, controller, pathname)
        return
      }

      const raw = await this._readResponseBody(opened.response)
      // A phone is usually Safari, and Safari cannot boot the app from a
      // classic script preload. The rewrite only touches the phone's copy.
      const { body: buffer, headers: rewrittenHeaders } = rewritePhoneDocument(raw, opened.rawHeaders)
      const response = {
        status: opened.status,
        headers: this._normalizeResponseHeaders(rewrittenHeaders, buffer.length),
        body: buffer,
      }
      if (mintedCookie !== null && response.headers['set-cookie'] === undefined) {
        response.headers['set-cookie'] = [
          `${mintedCookie}; Max-Age=${SESSION_COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Strict`,
        ]
      }
      const compressed = await compressResponse(response.status, response.headers, response.body)
      if (compressed.body.length >= LARGE_BODY_STREAM_BYTES) {
        // The client-module bundle is several megabytes. One frame reaches the
        // phone as one burst, and WebKit's HTTP/2 window never catches up: the
        // transfer stalls and the page never finishes booting. Chunked frames
        // let the relay hand the body over as it arrives.
        const headers = { ...compressed.headers }
        delete headers['content-length']
        this._sendTunnel(
          chunkedResponseFrame({
            id,
            status: response.status,
            headers,
          }),
        )
        for (let at = 0; at < compressed.body.length; at += STREAM_CHUNK_BYTES) {
          const end = Math.min(at + STREAM_CHUNK_BYTES, compressed.body.length)
          this._sendTunnel(
            responseChunkFrame({
              id,
              chunk: compressed.body.subarray(at, end).toString('base64'),
              last: end >= compressed.body.length,
            }),
          )
        }
      } else if (this._binaryBodies && compressed.body.length > 0) {
        // A binary message carries the body without the base64 inflation.
        this._sendTunnelBody(id, response.status, compressed.headers, compressed.body)
      } else {
        this._sendTunnel(
          responseFrame({
            id,
            status: response.status,
            headers: compressed.headers,
            body: compressed.body.length > 0 ? compressed.body.toString('base64') : null,
          }),
        )
      }
      this._log('served a tunnel request', { id, method, path: pathname + query, status: response.status })
    } catch (err) {
      if (controller.signal.aborted || (err && err.name === 'AbortError')) {
        this._log('the relay aborted an in-flight request', { id })
        return
      }
      this._log('the upstream request failed', { id, path: pathname, error: err })
      this._sendTunnel(
        responseFrame({
          id,
          status: 502,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: Buffer.from('bad gateway', 'utf8').toString('base64'),
        }),
      )
    } finally {
      this._requests.delete(id)
    }
  }

  /**
   * Start the upstream HTTP request and hand back its head.
   *
   * The head arrives before the body, and what happens with the body depends
   * on it: an event stream never ends, so it has to be forwarded while it
   * runs instead of being waited for.
   *
   * @param {{ method: string, url: string, headers: Record<string, string>, body: Buffer|null, controller: AbortController }} options
   * @returns {Promise<{ status: number, rawHeaders: Record<string, unknown>, response: import('node:http').IncomingMessage }>}
   */
  _openHttpRequest({ method, url, headers, body, controller }) {
    return new Promise((resolve, reject) => {
      const target = new URL(url)
      const secure = target.protocol === 'https:'
      const transport = secure ? https : http
      const request = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (secure ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method,
          headers,
          signal: controller.signal,
        },
        (res) => {
          resolve({
            status: res.statusCode ?? 502,
            rawHeaders: res.headers,
            response: res,
          })
        },
      )
      request.on('error', reject)
      if (body && body.length > 0) request.write(body)
      request.end()
    })
  }

  /**
   * The browser session of the local server, minted for the phone.
   *
   * The launch token is the Host's own credential: the server hands out the
   * session cookie for the current authority and answers with a redirect to
   * the clean URL. The redirect is of no use to the phone — it would have to
   * follow it over the link — so only the cookie is kept, and the phone's
   * request carries it from then on.
   *
   * @returns {Promise<string | undefined>} the cookie as `name=value`
   */
  /**
   * Read the whole body of one upstream response.
   *
   * @param {import('node:http').IncomingMessage} response
   * @returns {Promise<Buffer>}
   */
  _readResponseBody(response) {
    return new Promise((resolve, reject) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve(Buffer.concat(chunks)))
      response.on('error', reject)
    })
  }

  /**
   * Forward one event stream to the relay, chunk by chunk.
   *
   * A stream that never ends cannot be waited for: the relay would time the
   * request out and the phone would get a 504 instead of the events. The head
   * goes out first, the body follows in chunks, and the last chunk closes
   * the response on the relay's side.
   *
   * The head carries neither a length (it is unknown) nor an encoding (the
   * host does not compress a streamed body).
   *
   * @param {string} id the request this stream answers
   * @param {{ status: number, rawHeaders: Record<string, unknown>, response: import('node:http').IncomingMessage }} opened the upstream response
   * @param {AbortController} controller aborts the upstream request
   * @param {string} pathname the upstream path (for the log)
   */
  async _streamResponse(id, opened, controller, pathname) {
    const headers = this._normalizeResponseHeaders(opened.rawHeaders, 0)
    // The length of a streamed body is unknown.
    delete headers['content-length']
    // The host does not compress a streamed body, so the head must not claim
    // an encoding. An encoding the upstream applied itself is kept: the
    // phone inflates the stream on its own, and dropping the header would
    // show garbage.
    const encoding = String(headers['content-encoding'] ?? '')
    if (encoding && encoding.toLowerCase() !== 'identity') {
      this._log('the upstream event stream is encoded', { id, path: pathname, encoding })
    } else {
      delete headers['content-encoding']
    }

    this._sendTunnel(
      chunkedResponseFrame({
        id,
        status: opened.status,
        headers,
      }),
    )
    this._log('streaming a tunnel response', { id, path: pathname, status: opened.status })

    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      this._sendTunnel(responseChunkFrame({ id, chunk: '', last: true }))
    }

    try {
      // The relay cuts a stream that stays quiet: its idle window is five
      // minutes, and a phone that only reads the conversation sends nothing
      // for a long time. The stream is therefore kept alive with a comment —
      // the shape Server-Sent Events defines for exactly this — so the phone
      // keeps its session, misses nothing, and does not have to fetch the
      // conversation again after a cut.
      //
      // One read is outstanding at a time, and it is never dropped: a chunk
      // that arrives while a keep-alive is being sent waits for its turn.
      const iterator = opened.response[Symbol.asyncIterator]()
      let pending = iterator.next()
      for (;;) {
        if (controller.signal.aborted) break
        let timer = null
        const keepAlive = new Promise((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'keepalive' }), this.keepAliveMs)
          timer.unref?.()
        })
        const step = await Promise.race([
          pending.then((value) => ({ kind: 'chunk', value })),
          keepAlive,
        ])
        if (timer !== null) clearTimeout(timer)
        if (step.kind === 'keepalive') {
          // The keep-alive won the race: the chunk that is on its way keeps
          // waiting.
          if (controller.signal.aborted) break
          this._sendTunnel(
            responseChunkFrame({
              id,
              chunk: Buffer.from(STREAM_KEEPALIVE_COMMENT, 'utf8').toString('base64'),
              last: false,
            }),
          )
          continue
        }
        if (step.value.done) break
        const chunk = Buffer.isBuffer(step.value.value)
          ? step.value.value
          : Buffer.from(String(step.value.value ?? ''), 'utf8')
        // An aborted request must not send another chunk.
        if (controller.signal.aborted) break
        // One frame never carries more than one bounded piece of the body.
        for (let at = 0; at < chunk.length; at += STREAM_CHUNK_BYTES) {
          if (controller.signal.aborted) break
          const piece = chunk.subarray(at, Math.min(at + STREAM_CHUNK_BYTES, chunk.length))
          this._sendTunnel(
            responseChunkFrame({ id, chunk: piece.toString('base64'), last: false }),
          )
        }
        pending = iterator.next()
      }
    } catch (err) {
      // A stream that dies must not leave the phone hanging: the last chunk
      // closes the response on the relay's side as well.
      if (controller.signal.aborted || (err && err.name === 'AbortError')) {
        this._log('the relay aborted the event stream', { id, path: pathname })
      } else {
        this._log('the event stream failed', { id, path: pathname, error: err })
      }
    }
    close()
  }

  /**
   * Forward the upstream response headers, keeping repeated headers (such as
   * `set-cookie`) as arrays.
   * @param {Record<string, unknown>} headers
   * @param {number} bodyLength
   * @returns {Record<string, unknown>}
   */
  _normalizeResponseHeaders(headers, bodyLength) {
    const out = {}
    let hasContentLength = false
    for (const [rawName, rawValue] of Object.entries(headers || {})) {
      const name = rawName.toLowerCase()
      if (DROPPED_RESPONSE_HEADERS.has(name)) continue
      if (name === 'content-length') hasContentLength = true
      out[name] = Array.isArray(rawValue) ? rawValue.map((v) => String(v)) : String(rawValue ?? '')
    }
    if (!hasContentLength && bodyLength > 0) out['content-length'] = String(bodyLength)
    return out
  }

  /**
   * Abort the in-flight upstream request for `id`.
   * @param {string} id
   */
  _abortRequest(id) {
    const pending = this._requests.get(id)
    if (!pending) return
    try {
      pending.controller.abort()
    } catch {
      /* ignore */
    }
    this._requests.delete(id)
  }

  /* -------------------------------------------------------- ws  upgrades */

  /**
   * Bridge a phone WebSocket to the local DSH server.
   * @param {Record<string, unknown>} frame
   */
  _handleUpgrade(frame) {
    const id = String(frame.id ?? '')
    const headers = this._rewriteHeaders(frame.headers, true)
    const protocols = parseSubprotocols(headers['sec-websocket-protocol'])
    delete headers['sec-websocket-protocol']

    // The phone announces that it can inflate a compressed payload in the
    // query of its stream URL. That parameter is ours: it must not reach
    // the local server.
    const upgrade = splitCompressionQuery(
      typeof frame.path === 'string' ? frame.path : '/',
    )

    const { url, pathname } = this._resolveUpstream(
      upgrade.path,
      frame.headers,
    )
    const target = toWsUrl(url)

    // The stream of the app is an owner peer: it needs the session of the
    // phone. A session the server refuses is replaced by a fresh one when the
    // bridge is retried — see `_retryUpgradeWithFreshCookie`.
    this._openLocalBridge(id, target, protocols, headers, upgrade, pathname, 0)
  }

  /**
   * Open the local WebSocket of one phone bridge.
   *
   * @param {string} id the bridge this socket belongs to
   * @param {string} target the local WebSocket URL
   * @param {string[]} protocols the subprotocols the phone offered
   * @param {Record<string, string>} headers the headers for the local server
   * @param {{ path: string, compress: boolean }} upgrade the upgrade the relay asked for
   * @param {string} pathname the local path, for the log
   * @param {number} attempt how often the upgrade has been tried
   */
  _openLocalBridge(id, target, protocols, headers, upgrade, pathname, attempt) {
    /** @type {any} */
    let local
    try {
      local = new this._WebSocket(target, protocols, {
        headers,
        protocol: protocols[0],
        handshakeTimeout: this.handshakeTimeoutMs,
      })
    } catch (err) {
      this._log('failed to open the local websocket', { id, error: err })
      this._sendUpgradeFailure(id)
      return
    }

    const bridge = { local, pending: [], compress: upgrade.compress, chain: Promise.resolve(), failed: false }
    this._bridges.set(id, bridge)

    local.on('open', () => {
      this._log('the local websocket is open', { id, path: pathname })
      this._sendTunnel(upgradedFrame(id))
      for (const queued of bridge.pending.splice(0)) {
        this._safeSendLocal(bridge, queued.payload, queued.binary)
      }
    })

    local.on('message', (data, isBinary) => {
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
      // The frames of one stream are ordered, and a compressed frame takes a
      // moment to build: the queue keeps the order the peer protocol needs.
      bridge.chain = bridge.chain
        .then(() => this._sendBridgePayload(bridge, id, payload, isBinary === true))
        .catch((err) => {
          this._log('failed to forward a websocket payload', { id, error: err })
        })
    })

    // The Harness host pings its browser and drops a socket that stays
    // silent, so the control frames travel through the relay in both
    // directions instead of dying at the bridge.
    local.on('ping', (data) => {
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'utf8')
      this._sendTunnel(wsPingFrame({ id, data: payload.toString('base64') }))
    })
    local.on('pong', (data) => {
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'utf8')
      this._sendTunnel(wsPongFrame({ id, data: payload.toString('base64') }))
    })

    local.on('close', (code) => {
      this._bridges.delete(id)
      this._sendTunnel(wsCloseFrame({ id, code: typeof code === 'number' ? code : 1000 }))
    })

    local.on('error', (err) => {
      this._log('the local websocket failed', { id, error: err })
      if (local.readyState !== this._WebSocket.OPEN) this._sendUpgradeFailure(id, bridge)
    })

    // The server answers a handshake it refuses with a status instead of
    // switching protocols. A 401 means the session cookie the phone holds is
    // no longer good: the app restarted and the authority moved with it. The
    // host mints a fresh one and tries once more, so the phone does not have
    // to reload the page to get its stream back.
    local.on('unexpected-response', (_request, response) => {
      const status = Number(response?.statusCode ?? 0)
      if (status === 401 && attempt === 0) {
        void this._retryUpgradeWithFreshCookie(id, target, protocols, headers, upgrade, pathname)
        return
      }
      this._log('the local websocket was refused', { id, status })
      this._sendUpgradeFailure(id, bridge)
    })
  }

  /**
   * Mint a fresh browser session cookie and open the bridge with it.
   *
   * The launch token is the host's own credential: the server answers the
   * device root with it and mints a cookie for the current authority. The
   * cookie never travels to the phone - only the fresh stream does.
   *
   * @param {string} id the bridge this socket belongs to
   * @param {string} target the local WebSocket URL
   * @param {string[]} protocols the subprotocols the phone offered
   * @param {Record<string, string>} headers the headers for the local server
   * @param {{ path: string, compress: boolean }} upgrade the upgrade the relay asked for
   * @param {string} pathname the local path, for the log
   */
  async _retryUpgradeWithFreshCookie(id, target, protocols, headers, upgrade, pathname) {
    this._log('the phone session was refused; minting a fresh cookie', { id, path: pathname })
    const cookie = await this._mintSessionCookie()
    if (cookie === null) {
      this._sendUpgradeFailure(id)
      return
    }
    this._bridges.delete(id)
    this._openLocalBridge(id, target, protocols, { ...headers, cookie }, upgrade, pathname, 1)
  }

  /**
   * Mint a browser session cookie for the local server.
   *
   * @returns {Promise<string | null>} the `name=value` pair, or null
   */
  async _mintSessionCookie() {
    if (this.launchToken.length === 0) return null
    // The cookie is kept: the phone asks for the app root again and again,
    // and one minting is enough for all of them. The session is refused when
    // the app moves its port, and then the cookie is dropped and a new one is
    // minted.
    if (this._sessionCookie !== undefined) return this._sessionCookie
    if (this._sessionCookiePending !== undefined) return this._sessionCookiePending
    const pending = (async () => {
      const controller = new AbortController()
      try {
        const resolved = this._resolveUpstream('/', {}, { method: 'GET', forceToken: true })
        const opened = await this._openHttpRequest({
          method: 'GET',
          url: resolved.url,
          headers: { host: this.localAuthority, accept: '*/*' },
          body: null,
          controller,
        })
        opened.response.resume()
        const raw = opened.rawHeaders['set-cookie']
        const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
        for (const entry of list) {
          const pair = String(entry).split(';')[0].trim()
          if (pair.startsWith('dsh-auth-')) {
            this._sessionCookie = pair
            return pair
          }
        }
        this._log('the server minted no session cookie', { status: opened.status })
        return null
      } catch (err) {
        this._log('failed to mint a session cookie', { error: err })
        return null
      }
    })()
    this._sessionCookiePending = pending
    try {
      return await pending
    } finally {
      this._sessionCookiePending = undefined
    }
  }

  /**
   * Tell the relay that the local WebSocket could not be established.
   *
   * @param {string} id
   * @param {{ failed?: boolean }} [bridge] the bridge, so the failure is sent once
   */
  _sendUpgradeFailure(id, bridge) {
    if (bridge?.failed === true) return
    if (bridge !== undefined) bridge.failed = true
    this._sendTunnel(
      responseFrame({
        id,
        status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: Buffer.from('bad gateway', 'utf8').toString('base64'),
      }),
    )
  }

  /**
   * Forward one WebSocket payload to the phone.
   *
   * A big payload is compressed: the tunnel of a remote relay is where the
   * bytes are scarce, and the same payload crosses the link twice (host to
   * relay, relay to phone). The phone asked for this with the `rcz`
   * parameter, so it knows how to inflate the payload.
   *
   * A relay that takes a WebSocket payload as a binary tunnel message gets
   * the bytes as they are: the base64 inflation of a JSON frame costs a third
   * more bytes on the link that is the bottleneck, and the biggest payload
   * of all — a session snapshot — is megabytes.
   *
   * @param {{ local: any, pending: any[], compress: boolean }} bridge
   * @param {string} id the bridge this payload belongs to
   * @param {Buffer} payload the raw payload
   * @param {boolean} isBinary whether the local socket delivered it as binary
   */
  async _sendBridgePayload(bridge, id, payload, isBinary) {
    if (bridge.compress && payload.length >= MIN_COMPRESSED_WS_BYTES) {
      const compressed = await this._compressWsPayload(payload)
      if (compressed !== payload) {
        // A compressed payload travels as one binary message: the relay
        // forwards it as it is, and the phone inflates it before the peer
        // protocol on it sees the bytes.
        if (this._binaryWsPayloads) {
          this._sendTunnelBinary(encodeBinaryWsPayload(id, compressed, true))
          return
        }
        this._sendTunnel(wsFrame({ id, data: compressed.toString('base64'), binary: true }))
        return
      }
    }
    if (this._binaryWsPayloads) {
      // The kind of the payload travels with it: a text frame must stay text
      // on the other side, or the peer protocol on it breaks.
      this._sendTunnelBinary(encodeBinaryWsPayload(id, payload, isBinary))
      return
    }
    this._sendTunnel(wsFrame({ id, data: payload.toString('base64'), binary: isBinary }))
  }

  /**
   * Compress one WebSocket payload.
   *
   * The compressed payload starts with the marker the phone looks for. A
   * payload that does not get smaller is returned unchanged, so the caller
   * falls back to sending it as it is.
   *
   * @param {Buffer} payload the raw payload
   * @returns {Promise<Buffer>}
   */
  async _compressWsPayload(payload) {
    const prefix = Buffer.from(COMPRESSED_WS_PREFIX, 'latin1')
    try {
      const body = await gzipAsync(payload, { level: 6 })
      if (body.length + prefix.length >= payload.length) return payload
      return Buffer.concat([prefix, body])
    } catch (err) {
      this._log('failed to compress a websocket payload', { error: err })
      return payload
    }
  }

  /**
   * Deliver a ping from the relay to the local socket.
   * @param {Record<string, unknown>} frame
   */
  _handleBridgePing(frame) {
    const id = String(frame.id ?? '')
    const bridge = this._bridges.get(id)
    if (!bridge) return
    try {
      bridge.local.ping?.(Buffer.from(String(frame.data ?? ''), 'base64'))
    } catch (err) {
      this._log('failed to forward a ping', { id, error: err })
    }
  }

  /**
   * Deliver a pong from the relay to the local socket.
   * @param {Record<string, unknown>} frame
   */
  _handleBridgePong(frame) {
    const id = String(frame.id ?? '')
    const bridge = this._bridges.get(id)
    if (!bridge) return
    try {
      bridge.local.pong?.(Buffer.from(String(frame.data ?? ''), 'base64'))
    } catch (err) {
      this._log('failed to forward a pong', { id, error: err })
    }
  }

  /**
   * Forward one `ws_frame` from the relay to the local socket.
   * @param {Record<string, unknown>} frame
   */
  _handleBridgeFrame(frame) {
    const id = String(frame.id ?? '')
    const bridge = this._bridges.get(id)
    if (!bridge) return
    let payload
    try {
      payload = Buffer.from(String(frame.data ?? ''), 'base64')
    } catch {
      payload = Buffer.from(String(frame.data ?? ''), 'utf8')
    }
    this._safeSendLocal(bridge, payload, frame.binary === true)
  }

  /**
   * Close the local socket of a bridge when the relay closes it.
   * @param {Record<string, unknown>} frame
   */
  _handleBridgeClose(frame) {
    const id = String(frame.id ?? '')
    const bridge = this._bridges.get(id)
    if (!bridge) return
    try {
      if (bridge.local.readyState === this._WebSocket.OPEN) {
        bridge.local.close(typeof frame.code === 'number' ? frame.code : 1000)
      } else {
        bridge.local.terminate?.()
      }
    } catch (err) {
      this._log('failed to close the local websocket', { id, error: err })
    }
  }

  /**
   * @param {{ local: any, pending: Buffer[] }} bridge
   * @param {Buffer} payload
   */
  _safeSendLocal(bridge, payload, binary = false) {
    try {
      if (bridge.local.readyState === this._WebSocket.OPEN) {
        bridge.local.send(payload, { binary })
        return
      }
      bridge.pending.push({ payload, binary })
      if (bridge.pending.length > 64) bridge.pending.shift()
    } catch (err) {
      this._log('failed to write to the local websocket', { error: err })
    }
  }

  /* --------------------------------------------------------------- output */

  /**
   * @param {any} socket
   * @param {Record<string, unknown>} frame
   * @returns {boolean}
   */
  _send(socket, frame) {
    if (!socket || socket.readyState !== this._WebSocket.OPEN) return false
    try {
      socket.send(encodeFrame(frame))
      return true
    } catch (err) {
      this._log('failed to send a frame', { type: frame?.type, error: err })
      return false
    }
  }

  /**
   * @param {Record<string, unknown>} frame
   * @returns {boolean}
   */
  _sendTunnel(frame) {
    return this._send(this._sessions.tunnel?.socket, frame)
  }

  /**
   * Send one binary message on the tunnel channel.
   *
   * A payload that travels as a binary message pays for no base64 inflation,
   * which matters on a link where the bytes are scarce: the WebSocket
   * payload of a session snapshot is megabytes, and the base64 of a JSON
   * frame is a third more.
   *
   * @param {Buffer} message the raw message
   * @returns {boolean}
   */
  _sendTunnelBinary(message) {
    const socket = this._sessions.tunnel?.socket
    if (!socket || socket.readyState !== this._WebSocket.OPEN) return false
    try {
      socket.send(message)
      return true
    } catch (err) {
      this._log('failed to send a binary message', { error: err })
      return false
    }
  }

  /**
   * Send a response whose body travels as one binary WebSocket message.
   *
   * The text frame carries the status and the headers, the binary message the
   * bytes. Both name the request they belong to, so the relay does not have
   * to rely on their order.
   *
   * @param {string} id the request the body answers
   * @param {number} status the upstream status
   * @param {Record<string, unknown>} headers the upstream response headers
   * @param {Buffer} body the raw body bytes
   * @returns {boolean}
   */
  _sendTunnelBody(id, status, headers, body) {
    const socket = this._sessions.tunnel?.socket
    if (!socket || socket.readyState !== this._WebSocket.OPEN) return false
    this._sendTunnel(
      responseFrame({
        id,
        status,
        headers,
        body: null,
        body_encoding: 'binary',
        body_length: body.length,
      }),
    )
    try {
      socket.send(encodeBinaryBody(id, body))
      return true
    } catch (err) {
      this._log('failed to send the response body', { id, error: err })
      return false
    }
  }

  /* -------------------------------------------------------------- shutdown */

  /**
   * @param {string|null} reason
   * @param {'offline'|'error'} [state] the state the client ends up in
   */
  async _shutdown(reason, state = 'offline') {
    this._stopped = true
    this._registered = false
    this._clearReconnectTimer('management')
    this._clearReconnectTimer('tunnel')

    this._rejectStartOnce(new Error('relay-client: the client was stopped'))

    const management = this._sessions.management
    const tunnel = this._sessions.tunnel
    await Promise.all([
      this._closeSocket(management?.socket),
      this._closeSocket(tunnel?.socket),
    ])

    for (const [id] of this._requests) this._abortRequest(id)
    this._requests.clear()

    for (const [id, bridge] of this._bridges) {
      try {
        if (bridge.local.readyState === this._WebSocket.OPEN) bridge.local.close(1000)
        else bridge.local.terminate?.()
      } catch {
        /* ignore */
      }
      this._bridges.delete(id)
    }

    this._publicUrl = null
    this._setState(state, reason)
  }

  /**
   * Close a socket, waiting a bit before terminating it.
   * @param {any} socket
   */
  _closeSocket(socket) {
    if (!socket) return Promise.resolve()
    return new Promise((resolve) => {
      if (socket.readyState === this._WebSocket.CLOSED) {
        resolve()
        return
      }
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        try {
          socket.terminate?.()
        } catch {
          /* ignore */
        }
        finish()
      }, this.closeTimeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      socket.once('close', finish)
      try {
        socket.close(1000, 'client stopped')
      } catch {
        try {
          socket.terminate?.()
        } catch {
          /* ignore */
        }
        finish()
      }
    })
  }

  /**
   * @param {any} value
   */
  _resolveStartOnce(value) {
    const resolve = this._resolveStart
    this._resolveStart = null
    this._rejectStart = null
    this._startPromise = null
    if (resolve) resolve(value)
  }

  /**
   * @param {Error} error
   */
  _rejectStartOnce(error) {
    const reject = this._rejectStart
    this._resolveStart = null
    this._rejectStart = null
    this._startPromise = null
    if (reject) reject(error)
  }
}

/**
 * Create a relay client.
 * @param {ConstructorParameters<typeof RelayClient>[0]} options
 * @returns {RelayClient}
 */
export function createRelayClient(options) {
  return new RelayClient(options)
}

export default createRelayClient
