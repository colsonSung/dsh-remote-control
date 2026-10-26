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
import { gzip } from 'node:zlib'
import { WebSocket as NodeWebSocket } from 'ws'

import {
  bearerHeader,
  bearerSubprotocol,
  CAPABILITY_BINARY_BODY,
  decodeFrame,
  encodeBinaryBody,
  encodeFrame,
  managementUrl,
  registerFrame,
  responseFrame,
  tunnelUrl,
  upgradedFrame,
  wsCloseFrame,
  wsFrame,
  wsPingFrame,
  wsPongFrame,
} from './relay-protocol.js'

/* ------------------------------------------------------------------ tuning */

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
 * The content types that gain from compression.
 *
 * Images, fonts and archives are already compressed; compressing them again
 * only burns CPU on both ends.
 */
const COMPRESSIBLE_CONTENT_TYPES =
  /^(?:text\/|application\/(?:javascript|json|xml|manifest\+json)|image\/svg\+xml)/i

/** The gzip implementation, as a promise. */
const gzipAsync = promisify(gzip)

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
    /** @type {boolean} */
    this._stopped = true

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
        this._setState('online')
        this._log('registered with the relay', { publicUrl, binaryBodies: this._binaryBodies })
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
   * @param {string} rawPath
   * @param {Record<string, unknown>} [headers] the raw (pre-rewrite) headers
   * @param {{ method?: string, forceToken?: boolean }} [options]
   * @returns {{ url: string, pathname: string, query: string, isDeviceRoot: boolean, tokenInjected: boolean }}
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
    // The server only mints a session cookie for `GET /?token=…`.
    const canInject =
      method === 'GET' &&
      isDeviceRoot &&
      this.launchToken.length > 0 &&
      !hasQueryParam(query, 'token')
    const tokenInjected =
      canInject &&
      (options.forceToken === true || !hasSessionCookie(headers, this.localAuthority))

    let search = query
    if (tokenInjected) search = appendQueryParam(query, 'token', this.launchToken)
    target.search = search ? `?${search}` : ''

    return { url: target.href, pathname: relative, query: search, isDeviceRoot, tokenInjected }
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
    const { url, pathname, query } = resolved

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

    const controller = new AbortController()
    this._requests.set(id, { controller })

    try {
      let response = await this._performHttpRequest({
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
      if (response.status === 401 && !resolved.tokenInjected) {
        const retry = this._resolveUpstream(rawPath, frame.headers, { method, forceToken: true })
        if (retry.tokenInjected) {
          this._log('the session cookie was refused; retrying with the launch token', {
            id,
            path: pathname,
          })
          response = await this._performHttpRequest({
            method,
            url: retry.url,
            headers,
            body,
            controller,
          })
        }
      }
      const compressed = await compressResponse(response.status, response.headers, response.body)
      if (this._binaryBodies && compressed.body.length > 0) {
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
   * Perform the actual upstream HTTP request.
   * @param {{ method: string, url: string, headers: Record<string, string>, body: Buffer|null, controller: AbortController }} options
   * @returns {Promise<{ status: number, headers: Record<string, unknown>, body: Buffer }>}
   */
  _performHttpRequest({ method, url, headers, body, controller }) {
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
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => {
            const buffer = Buffer.concat(chunks)
            resolve({
              status: res.statusCode ?? 502,
              headers: this._normalizeResponseHeaders(res.headers, buffer.length),
              body: buffer,
            })
          })
          res.on('error', reject)
        },
      )
      request.on('error', reject)
      if (body && body.length > 0) request.write(body)
      request.end()
    })
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

    const { url, pathname } = this._resolveUpstream(
      typeof frame.path === 'string' ? frame.path : '/',
      frame.headers,
    )
    const target = toWsUrl(url)

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

    const bridge = { local, pending: [] }
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
      this._sendTunnel(wsFrame({ id, data: payload.toString('base64'), binary: isBinary === true }))
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
      if (local.readyState !== this._WebSocket.OPEN) this._sendUpgradeFailure(id)
    })
  }

  /**
   * Tell the relay that the local WebSocket could not be established.
   * @param {string} id
   */
  _sendUpgradeFailure(id) {
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
