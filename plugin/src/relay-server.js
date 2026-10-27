/**
 * @file Relay server for the DSH remote-control plugin.
 *
 * The relay is the "cloud" half of a Kimi-Code-style remote control:
 *
 *   phone ──HTTP/WS──▶ relay ──tunnel WS──▶ DSH host ──▶ host's local server
 *
 * The host dials OUT, so the host may sit behind NAT; the relay never holds a
 * host credential — the host injects its own launch token into the traffic it
 * serves. The relay itself is a dumb, mostly stateless reverse proxy.
 *
 * Two host-facing WebSocket channels (see ./relay-protocol.js):
 *
 *   GET /v1/remote/create                                management
 *   GET /v1/remote/http?device_id=<id>&capabilities=...   tunnel
 *
 * Both channels are authenticated with the shared relay token, either with an
 * `Authorization: Bearer <token>` header or with the Kimi-style
 * `kimi-code.bearer.<token>` WebSocket subprotocol.
 *
 * Everything else that arrives over HTTP is phone traffic and is replayed to
 * the device's `local_base_url` through the device's tunnel socket.
 *
 * @module relay-server
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { dirname } from 'node:path'
import { randomBytes, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'

import {
  MANAGEMENT_PATH,
  TUNNEL_PATH,
  abortFrame,
  CAPABILITY_BINARY_BODY,
  CAPABILITY_WS_BINARY_BODY,
  decodeBinaryBody,
  decodeBinaryWsPayload,
  decodeFrame,
  encodeFrame,
  registerAckFrame,
  registerNakFrame,
  requestFrame,
  responseFrame,
  upgradeFrame,
  upgradedFrame,
  wsCloseFrame,
  wsFrame,
  wsPingFrame,
  wsPongFrame,
} from './relay-protocol.js'

/** Path of the relay's own management API (used by the host's Settings page). */
const DEVICES_API_PATH = '/v1/remote/devices'

/** The cookie the relay hands a phone after it presents the access link. */
const PHONE_SESSION_COOKIE = 'dsh-rc'

/**
 * The cookie that remembers a phone across visits.
 *
 * It holds the phone's own credential: a trusted phone presents it and skips
 * the access code, an unknown one still has to type the code once.
 */
const PHONE_DEVICE_COOKIE = 'dsh-device'

/** How long a phone's own credential lives. */
const PHONE_COOKIE_MAX_AGE = 180 * 24 * 60 * 60

/** How long a trusted phone's session cookie lives. */
const PHONE_SESSION_MAX_AGE = 24 * 60 * 60

/**
 * The `SameSite` of the phone's cookies.
 *
 * `Lax`, not `Strict`: the link is opened from somewhere else — a chat, a QR
 * scanner, a mail — and a `Strict` cookie is not sent on such a top level
 * navigation. The phone would arrive without its credential, be asked for
 * the access code again, and land in the owner's device list as a new
 * handset every single time. `Lax` still keeps the cookie away from cross
 * site POSTs, and the relay's own state changing routes are POSTs.
 */
const PHONE_COOKIE_SAME_SITE = 'Lax'

/** Failed passcode attempts before the relay locks a device out. */
const PASSCODE_MAX_ATTEMPTS = 5

/** How long one caller stays locked out after too many failed passcodes. */
const PASSCODE_LOCKOUT_MS = 10 * 60 * 1000

/** How many guesses a device accepts in an hour, across all callers. */
const PASSCODE_BUDGET_PER_HOUR = 60

/** The window the per-device guess budget covers. */
const PASSCODE_BUDGET_WINDOW_MS = 60 * 60 * 1000

/** Request headers that must never cross the relay hop-by-hop. */
const HOP_BY_HOP_HEADERS = new Set([
  'host',
  'connection',
  'upgrade',
  'keep-alive',
  'transfer-encoding',
  'accept-encoding',
])

/** Response headers the relay recomputes or drops before answering the phone. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
  'content-length',
])

/** How long the relay waits for the host to answer one proxied request. */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * How long a streamed response may stay quiet before the relay calls it
 * stalled.
 *
 * An event stream carries nothing between its events, and the phone waits
 * for the next one: the window has to be measured in minutes, not in the
 * seconds a request may take.
 */
const STREAM_IDLE_TIMEOUT_MS = 300_000

/** How long the relay waits for the host to accept a WebSocket upgrade. */
const UPGRADE_TIMEOUT_MS = 15_000

/** Upper bound of proxied requests in flight per device. */
const MAX_INFLIGHT_PER_DEVICE = 64

/** Upper bound of proxied requests in flight across the whole relay. */
const MAX_INFLIGHT_TOTAL = 256

/** Largest accepted alias payload. */
const MAX_ALIAS_BYTES = 4 * 1024

/** Largest accepted proxied request body. */
const MAX_BODY_BYTES = 64 * 1024 * 1024

/** Accepted shape of a device id (kept path-safe on purpose). */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/

/** Reason texts used in `register_nak` frames. */
const NAK_REASONS = {
  deviceId: 'invalid device id',
  localBaseUrl: 'invalid local_base_url',
  duplicate: 'device already registered',
}

/**
 * @typedef {object} DeviceRecord
 * @property {string} deviceId stable id chosen by the host
 * @property {string} alias human readable name
 * @property {string} platform host platform, e.g. `darwin`
 * @property {string} clientVersion host plugin version
 * @property {string} localBaseUrl base URL of the host's local server
 * @property {'online'|'offline'} status
 * @property {string} connectedAt ISO timestamp of the last registration
 * @property {string} lastSeenAt ISO timestamp of the last frame seen
 */

/**
 * @typedef {object} PendingRequest
 * @property {string} id
 * @property {any} device
 * @property {import('node:http').ServerResponse} res the phone's response
 * @property {string} session the relay's own session cookie for the phone
 * @property {(value: {status: number, headers: Record<string, string | string[]>, body: Buffer}) => void} resolve
 * @property {(reason: Error) => void} reject
 * @property {NodeJS.Timeout | undefined} timer
 * @property {Buffer[]} chunks accumulated chunked response body
 * @property {Record<string, string | string[]> | null} headers status/headers of a chunked response
 * @property {number} status
 * @property {boolean} streaming whether the response is streamed to the phone
 */

/**
 * Normalise the per-device path prefix.
 *
 * @param {unknown} value
 * @returns {string} `''` (root mount) or `/prefix` without a trailing slash
 */
function normalizeDevicePath(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed || trimmed === '/') return ''
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withSlash.replace(/\/+$/, '')
}

/**
 * Normalise a configured public base URL (no trailing slash).
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeBaseUrl(value) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\/+$/, '')
}

/**
 * Constant-time comparison of two secrets.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function secretsEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Decode a frame body. Bodies travel base64-encoded (see relay-protocol.js),
 * but a plain-text body is accepted as well so a lenient host keeps working.
 *
 * @param {unknown} value
 * @param {unknown} encoding explicit `body_encoding` hint, when the peer sent one
 * @returns {Buffer}
 */
function decodeBody(value, encoding) {
  if (value === null || value === undefined) return Buffer.alloc(0)
  if (Buffer.isBuffer(value)) return value
  if (typeof value !== 'string') return Buffer.alloc(0)
  if (encoding === 'utf8' || encoding === 'text' || encoding === 'plain') {
    return Buffer.from(value, 'utf8')
  }
  if (encoding === 'base64') return Buffer.from(value, 'base64')
  const trimmed = value.trim()
  if (!trimmed) return Buffer.alloc(0)
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && trimmed.length % 4 === 0) {
    const decoded = Buffer.from(trimmed, 'base64')
    // Only trust the base64 reading when it yields valid UTF-8 text again.
    if (isUtf8(decoded)) return decoded
  }
  return Buffer.from(value, 'utf8')
}

/**
 * @param {Buffer} buffer
 * @returns {boolean} true when the buffer is valid UTF-8
 */
function isUtf8(buffer) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return true
  } catch {
    return false
  }
}

/**
 * Copy request headers into the shape used on the wire.
 *
 * Hop-by-hop headers (and `accept-encoding`) are dropped; the relay asks the
 * host for an identity encoding so bodies stay plain.
 *
 * @param {Record<string, string | string[] | undefined>} headers
 * @returns {Record<string, string>}
 */
function sanitizeRequestHeaders(headers) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const [rawKey, rawValue] of Object.entries(headers || {})) {
    const key = rawKey.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(key)) continue
    if (key.startsWith('proxy-')) continue
    if (rawValue === undefined || rawValue === null) continue
    out[key] = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue)
  }
  out['accept-encoding'] = 'identity'
  return out
}

/**
 * Copy response headers back to the phone.
 *
 * `set-cookie` keeps its array shape so every cookie survives.
 *
 * @param {Record<string, string | string[] | undefined>} headers
 * @returns {Record<string, string | string[]>}
 */
function sanitizeResponseHeaders(headers) {
  /** @type {Record<string, string | string[]>} */
  const out = {}
  for (const [rawKey, rawValue] of Object.entries(headers || {})) {
    const key = rawKey.toLowerCase()
    if (STRIPPED_RESPONSE_HEADERS.has(key)) continue
    if (key.startsWith('proxy-')) continue
    if (rawValue === undefined || rawValue === null) continue
    out[key] = Array.isArray(rawValue) ? rawValue.map(String) : String(rawValue)
  }
  return out
}

/**
 * Join a device's `local_base_url` with a request path.
 *
 * @param {string} localBaseUrl
 * @param {string} path path (plus optional query string), always root relative
 * @returns {string}
 */
function joinBaseUrl(localBaseUrl, path) {
  const base = new URL(localBaseUrl)
  const basePath = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base.origin}${basePath}${suffix}`
}

/**
 * @param {unknown} value
 * @returns {boolean} true when the value looks like an http(s) server
 */
function isServerLike(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof /** @type {any} */ (value).on === 'function' &&
      typeof /** @type {any} */ (value).listen === 'function',
  )
}

/**
 * Create a relay server.
 *
 * @param {object} [options]
 * @param {string} options.token shared secret the host presents (required)
 * @param {string} [options.publicBaseUrl] base URL a phone should open; defaults to the request `Host`
 * @param {string} [options.devicePath] per-device path prefix, `''` mounts at the root
 * @param {(message: string, extra?: Record<string, unknown>) => void} [options.log]
 * @param {number} [options.requestTimeoutMs] how long the relay waits for the host; defaults to 30 s
 * @param {number} [options.streamIdleTimeoutMs] how long a stream may stay quiet; defaults to 5 min
 * @returns {{
 *   listen: (options?: {host?: string, port?: number, server?: http.Server | https.Server}) => Promise<{host: string, port: number}>,
 *   address: () => {host: string | null, port: number, url: string | null},
 *   setPublicBaseUrl: (url: string) => string,
 *   close: () => Promise<void>,
 *   devices: () => DeviceRecord[],
 * }}
 */
export function createRelayServer(options = {}) {
  const {
    token,
    publicBaseUrl: rawPublicBaseUrl,
    devicePath: rawDevicePath,
    log: rawLog,
    statePath: rawStatePath,
    requestTimeoutMs: rawRequestTimeoutMs,
    streamIdleTimeoutMs: rawStreamIdleTimeoutMs,
  } = options || {}

  if (typeof token !== 'string' || token.trim() === '') {
    throw new TypeError('createRelayServer: `token` is required')
  }

  const secret = token.trim()
  const devicePath = normalizeDevicePath(rawDevicePath)
  /** @type {string} base URL used to build `register_ack.public_url` */
  let configuredPublicBaseUrl = normalizeBaseUrl(rawPublicBaseUrl)
  const log = typeof rawLog === 'function' ? rawLog : () => {}
  const bearerProtocol = `kimi-code.bearer.${secret}`
  // How long the relay waits for the host: a hard deadline for a request that
  // has not been answered yet, an idle window for one that streams.
  const requestTimeoutMs =
    Number.isFinite(rawRequestTimeoutMs) && Number(rawRequestTimeoutMs) > 0
      ? Number(rawRequestTimeoutMs)
      : REQUEST_TIMEOUT_MS
  // How long a stream may stay quiet. An event stream is quiet most of the
  // time - the plugin hot-reload stream says nothing until something changes -
  // so the window that guards a request is far too short for one. The host
  // keeps the connection open, and a stream that really dies closes it.
  const streamIdleTimeoutMs =
    Number.isFinite(rawStreamIdleTimeoutMs) && Number(rawStreamIdleTimeoutMs) > 0
      ? Number(rawStreamIdleTimeoutMs)
      : STREAM_IDLE_TIMEOUT_MS

  /** @type {Map<string, any>} */
  const devices = new Map()
  /** @type {Map<string, PendingRequest>} */
  const inflight = new Map()
  /** @type {Map<string, {id: string, device: any, resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
  const pendingUpgrades = new Map()
  /** @type {Map<string, {id: string, device: any, peer: WebSocket}>} */
  const bridges = new Map()

  /** @type {http.Server | https.Server | null} */
  let server = null
  /** @type {WebSocketServer | null} */
  let wss = null
  let closing = false
  /** @type {Promise<void> | null} */
  let closePromise = null
  /** Monotonic counter used to find the most recently registered device. */
  let registrationCounter = 0

  /* --------------------------------------------------------------- logging */

  /**
   * Log through the user supplied callback; a broken logger never breaks the relay.
   *
   * @param {string} message
   * @param {Record<string, unknown>} [extra]
   */
  function logInfo(message, extra) {
    try {
      log(message, extra)
    } catch {
      /* ignore logger failures */
    }
  }

  /* ----------------------------------------------------------------- urls */

  /**
   * The mount point of one device, e.g. `/rc/<deviceId>`.
   *
   * @param {string} deviceId
   * @returns {string}
   */
  function deviceMount(deviceId) {
    return `${devicePath}/${deviceId}`
  }

  /**
   * The URL a phone should open for one device.
   *
   * @param {string} deviceId
   * @param {string} baseUrl
   * @returns {string}
   */
  function publicUrlFor(deviceId, baseUrl, accessKey) {
    const base = `${baseUrl}${deviceMount(deviceId)}/?rc=1&from=dsh_desktop`
    return accessKey ? `${base}&k=${encodeURIComponent(accessKey)}` : base
  }

  /**
   * Resolve the public base URL for one request.
   *
   * @param {import('node:http').IncomingMessage} req
   * @returns {string}
   */
  function resolvePublicBaseUrl(req) {
    if (configuredPublicBaseUrl) return configuredPublicBaseUrl
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim()
    const scheme = forwardedProto || 'http'
    const host = String(req.headers.host || '').trim()
    return host ? `${scheme}://${host}` : 'http://127.0.0.1'
  }

  /**
   * (Re)set the public base URL used for `register_ack.public_url`.
   *
   * The host usually learns its listening port only after `listen()` resolves,
   * so it sets the base URL afterwards.
   *
   * @param {string} url
   * @returns {string} the normalised base URL
   */
  function setPublicBaseUrl(url) {
    configuredPublicBaseUrl = normalizeBaseUrl(url)
    logInfo('relay: public base url updated', { publicBaseUrl: configuredPublicBaseUrl })
    return configuredPublicBaseUrl
  }

  /* ----------------------------------------------------------------- auth */

  /**
   * Check the relay credential on an incoming HTTP request.
   *
   * @param {import('node:http').IncomingMessage} req
   * @returns {boolean}
   */
  function isAuthorizedRequest(req) {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^bearer\s+(.+)$/i.exec(header.trim())
    if (!match) return false
    return secretsEqual(match[1].trim(), secret)
  }

  /**
   * Check the relay credential on an incoming WebSocket upgrade.
   *
   * Accepts the `Authorization: Bearer <token>` header and the Kimi-style
   * `kimi-code.bearer.<token>` subprotocol.
   *
   * @param {import('node:http').IncomingMessage} req
   * @returns {boolean}
   */
  function isAuthorizedUpgrade(req) {
    if (isAuthorizedRequest(req)) return true
    const header = req.headers['sec-websocket-protocol']
    if (typeof header !== 'string') return false
    return header
      .split(',')
      .map((value) => value.trim())
      .some((value) => secretsEqual(value, bearerProtocol))
  }

  /* --------------------------------------------------------------- devices */

  /**
   * Compute the effective status of one device.
   *
   * @param {any} device
   * @returns {'online'|'offline'}
   */
  function computeStatus(device) {
    if (device.revoked) return 'offline'
    const tunnelOpen = device.tunnelSocket && device.tunnelSocket.readyState === WebSocket.OPEN
    const managementOpen =
      device.managementSocket && device.managementSocket.readyState === WebSocket.OPEN
    return tunnelOpen || managementOpen ? 'online' : 'offline'
  }

  /**
   * Refresh the cached status of one device.
   *
   * @param {any} device
   */
  function refreshStatus(device) {
    device.status = computeStatus(device)
  }

  /**
   * Public view of one device.
   *
   * @param {any} device
   * @returns {DeviceRecord}
   */
  function toDeviceRecord(device) {
    return {
      deviceId: device.deviceId,
      alias: device.alias,
      platform: device.platform,
      clientVersion: device.clientVersion,
      localBaseUrl: device.localBaseUrl,
      status: device.status,
      connectedAt: device.connectedAt,
      lastSeenAt: device.lastSeenAt,
    }
  }

  /**
   * Close a socket without letting a failure escape.
   *
   * @param {WebSocket | null | undefined} socket
   * @param {number} [code]
   */
  function closeSocket(socket, code = 1000) {
    if (!socket) return
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(code, 'relay closed')
      }
    } catch {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------ ws helpers */

  /**
   * Send one frame on a socket.
   *
   * @param {WebSocket | null | undefined} socket
   * @param {Record<string, unknown>} frame
   * @returns {boolean} true when the frame was handed to the socket
   */
  function sendFrame(socket, frame) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    try {
      socket.send(encodeFrame(frame))
      return true
    } catch (error) {
      logInfo('relay: failed to write frame', { error: String(error) })
      return false
    }
  }

  /**
   * Send one frame to the host through a device's tunnel.
   *
   * @param {any} device
   * @param {Record<string, unknown>} frame
   * @returns {boolean}
   */
  function sendToHost(device, frame) {
    return sendFrame(device && device.tunnelSocket, frame)
  }

  /**
   * Parse an incoming WebSocket message into a frame.
   *
   * @param {Buffer | string} data
   * @returns {Record<string, unknown> | null}
   */
  function parseFrame(data) {
    const text = typeof data === 'string' ? data : String(data)
    try {
      return decodeFrame(text)
    } catch (error) {
      logInfo('relay: ignoring malformed frame', { error: String(error) })
      return null
    }
  }

  /* ----------------------------------------------------------- http server */

  /**
   * Answer a request with a short plain-text body.
   *
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {string} message
   */
  function sendPlain(res, status, message) {
    const body = `${message}\n`
    try {
      res.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      })
      res.end(body)
    } catch {
      /* client already gone */
    }
  }

  /**
   * Answer a request with JSON.
   *
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {unknown} payload
   */
  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload)
    try {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      })
      res.end(body)
    } catch {
      /* client already gone */
    }
  }

  /**
   * Read a bounded request body.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {number} limit
   * @returns {Promise<Buffer>}
   */
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      /** @type {Buffer[]} */
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('payload too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }

  /**
   * Main HTTP entry point.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handleRequest(req, res) {
    let url
    try {
      url = new URL(req.url || '/', 'http://relay.invalid')
    } catch {
      sendPlain(res, 400, 'bad request')
      return
    }
    const pathname = url.pathname

    if (pathname === MANAGEMENT_PATH || pathname === TUNNEL_PATH) {
      sendPlain(res, 426, 'websocket upgrade required')
      return
    }

    if (pathname === DEVICES_API_PATH || pathname.startsWith(`${DEVICES_API_PATH}/`)) {
      await handleDevicesApi(req, res, url)
      return
    }

    await handlePhoneRequest(req, res, url)
  }

  /* ------------------------------------------------------- management API */

  /**
   * The phones that reached one device.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   * @param {any} device
   * @param {string[]} rest the path after `devices/<id>/phones`
   * @returns {Promise<void>}
   */
  async function handlePhonesApi(req, res, url, device, rest) {
    if (rest.length === 0) {
      if (req.method !== 'GET') {
        sendPlain(res, 405, 'method not allowed')
        return
      }
      const list = [...device.phones.values()].map((phone) => ({
        id: phone.id,
        label: phone.label,
        userAgent: phone.userAgent,
        firstSeenAt: phone.firstSeenAt,
        lastSeenAt: phone.lastSeenAt,
        lastIp: phone.lastIp,
        trusted: phone.trusted === true,
        unlocks: phone.unlocks ?? 0,
      }))
      sendJson(res, 200, list)
      return
    }

    if (rest.length !== 2) {
      sendPlain(res, 404, 'not found')
      return
    }

    let phoneId = rest[0]
    try {
      phoneId = decodeURIComponent(phoneId)
    } catch {
      sendPlain(res, 400, 'invalid phone id')
      return
    }
    const phoneAction = rest[1]
    let phone
    for (const candidate of device.phones.values()) {
      if (candidate.id === phoneId) {
        phone = candidate
        break
      }
    }
    if (phone === undefined) {
      sendPlain(res, 404, 'unknown phone')
      return
    }

    if (phoneAction === 'trust') {
      if (req.method !== 'POST') {
        sendPlain(res, 405, 'method not allowed')
        return
      }
      let payload
      try {
        const raw = await readBody(req, MAX_ALIAS_BYTES)
        payload = JSON.parse(raw.toString('utf8') || '{}')
      } catch {
        sendPlain(res, 400, 'invalid json body')
        return
      }
      if (!payload || typeof payload !== 'object' || typeof payload.trusted !== 'boolean') {
        sendPlain(res, 400, 'trusted must be a boolean')
        return
      }
      phone.trusted = payload.trusted
      markStateDirty(device)
      logInfo('relay: phone trust updated', { deviceId: device.deviceId, phoneId: phone.id, trusted: phone.trusted })
      sendJson(res, 200, { ok: true })
      return
    }

    if (phoneAction === 'alias') {
      if (req.method !== 'POST') {
        sendPlain(res, 405, 'method not allowed')
        return
      }
      let payload
      try {
        const raw = await readBody(req, MAX_ALIAS_BYTES)
        payload = JSON.parse(raw.toString('utf8') || '{}')
      } catch {
        sendPlain(res, 400, 'invalid json body')
        return
      }
      if (!payload || typeof payload !== 'object' || typeof payload.alias !== 'string') {
        sendPlain(res, 400, 'alias must be a string')
        return
      }
      const alias = payload.alias.trim()
      if (!alias || alias.length > 128) {
        sendPlain(res, 400, 'alias must be a non-empty string of at most 128 characters')
        return
      }
      phone.label = alias
      markStateDirty(device)
      sendJson(res, 200, { ok: true })
      return
    }

    if (phoneAction === 'remove') {
      if (req.method !== 'POST' && req.method !== 'DELETE') {
        sendPlain(res, 405, 'method not allowed')
        return
      }
      for (const [token, candidate] of device.phones) {
        if (candidate.id === phoneId) {
          device.phones.delete(token)
          // A forgotten phone loses its session with it.
          device.phoneSessions.delete(phoneSessionToken(device.deviceId, token))
          break
        }
      }
      markStateDirty(device)
      logInfo('relay: phone removed', { deviceId: device.deviceId, phoneId })
      sendJson(res, 200, { ok: true })
      return
    }

    sendPlain(res, 404, 'not found')
  }

  /**
   * The relay's own management API (host Settings page).
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   */
  async function handleDevicesApi(req, res, url) {
    if (!isAuthorizedRequest(req)) {
      res.setHeader('www-authenticate', 'Bearer realm="dsh-relay"')
      sendPlain(res, 401, 'unauthorized')
      return
    }

    const segments = url.pathname.split('/').filter(Boolean)
    // segments: ['v1', 'remote', 'devices', ...rest]
    const rest = segments.slice(3)

    if (rest.length === 0) {
      if (req.method !== 'GET') {
        sendPlain(res, 405, 'method not allowed')
        return
      }
      const list = []
      const seen = new Set()
      for (const device of devices.values()) {
        const record = toDeviceRecord(device)
        delete record.localBaseUrl
        list.push(record)
        seen.add(device.deviceId)
      }
      // The devices that are away still belong on the list, otherwise the
      // owner could not revoke them.
      for (const [deviceId, known] of persistedDevices) {
        if (seen.has(deviceId)) continue
        list.push({
          deviceId,
          alias: known.alias ?? '',
          platform: known.platform ?? '',
          clientVersion: known.clientVersion ?? '',
          status: 'offline',
          connectedAt: known.firstSeenAt ?? null,
          lastSeenAt: known.lastSeenAt ?? null,
        })
      }
      sendJson(res, 200, list)
      return
    }

    if (rest.length !== 2 && rest.length !== 4) {
      sendPlain(res, 404, 'not found')
      return
    }

    let deviceId = rest[0]
    try {
      deviceId = decodeURIComponent(deviceId)
    } catch {
      sendPlain(res, 400, 'invalid device id')
      return
    }
    const action = rest[1]
    const device = devices.get(deviceId)
    if (!device) {
      // An away device: the owner can still revoke it or rename it.
      const known = persistedDevices.get(deviceId)
      if (known === undefined) {
        sendPlain(res, 404, 'unknown device')
        return
      }
      if (action === 'revoke' && req.method === 'POST') {
        const revoked = known.revoked === true ? false : true
        known.revoked = revoked
        persistedDevices.set(deviceId, known)
        if (revoked) revokedDevices.add(deviceId)
        else revokedDevices.delete(deviceId)
        markStateDirty(device)
        sendJson(res, 200, { ok: true })
        return
      }
      if (action === 'alias' && req.method === 'POST') {
        let payload
        try {
          const raw = await readBody(req, MAX_ALIAS_BYTES)
          payload = JSON.parse(raw.toString('utf8') || '{}')
        } catch {
          sendPlain(res, 400, 'invalid json body')
          return
        }
        const alias = String(payload?.alias ?? '').trim()
        if (!alias || alias.length > 128) {
          sendPlain(res, 400, 'alias must be a non-empty string of at most 128 characters')
          return
        }
        known.alias = alias
        known.aliasLocked = true
        persistedDevices.set(deviceId, known)
        markStateDirty(device)
        sendJson(res, 200, { ok: true })
        return
      }
      sendPlain(res, 404, 'not found')
      return
    }

    // The phones that reached this device: the list, the trust flag, the name
    // and the removal.
    if (action === 'phones') {
      await handlePhonesApi(req, res, url, device, rest.slice(2))
      return
    }

    if (action === 'alias') {
      if (req.method !== 'POST') {
        sendPlain(res, 405, 'method not allowed')
        return
      }
      let payload
      try {
        const raw = await readBody(req, MAX_ALIAS_BYTES)
        payload = JSON.parse(raw.toString('utf8') || '{}')
      } catch {
        sendPlain(res, 400, 'invalid json body')
        return
      }
      if (!payload || typeof payload !== 'object' || typeof payload.alias !== 'string') {
        sendPlain(res, 400, 'alias must be a string')
        return
      }
      const alias = payload.alias.trim()
      if (!alias || alias.length > 128) {
        sendPlain(res, 400, 'alias must be a non-empty string of at most 128 characters')
        return
      }
      device.alias = alias
      // The owner named it: the device may not rename it back.
      device.aliasLocked = true
      const known = persistedDevices.get(deviceId)
      if (known !== undefined) {
        known.alias = alias
        known.aliasLocked = true
        persistedDevices.set(deviceId, known)
      }
      markStateDirty(device)
      logInfo('relay: device alias updated', { deviceId })
      sendJson(res, 200, { ok: true })
      return
    }

    if (action === 'offline') {
      if (req.method !== 'POST') {
        sendPlain(res, 405, 'method not allowed')
        return
      }
      takeDeviceOffline(device)
      logInfo('relay: device taken offline', { deviceId })
      sendJson(res, 200, { ok: true })
      return
    }

    if (action === 'revoke') {
      if (req.method !== 'POST') {
        sendPlain(res, 405, 'method not allowed')
        return
      }
      let payload
      try {
        const raw = await readBody(req, MAX_ALIAS_BYTES)
        payload = JSON.parse(raw.toString('utf8') || '{}')
      } catch {
        sendPlain(res, 400, 'invalid json body')
        return
      }
      const revoked = payload?.revoked === true
      device.revoked = revoked
      markStateDirty(device)
      if (revoked) {
        // The device is refused from now on, reconnects included.
        closeSocket(device.managementSocket, 1000)
        closeSocket(device.tunnelSocket, 1000)
        device.managementSocket = null
        device.tunnelSocket = null
        refreshStatus(device)
      }
      logInfo('relay: device revoked', { deviceId, revoked })
      sendJson(res, 200, { ok: true })
      return
    }

    sendPlain(res, 404, 'not found')
  }

  /**
   * Close a device's channels and mark it offline.
   *
   * @param {any} device
   */
  function takeDeviceOffline(device) {
    // A transient disconnect: the host reconnects on its own. The sticky
    // refusal is the separate `revoke` action.
    closeSocket(device.managementSocket, 1000)
    closeSocket(device.tunnelSocket, 1000)
    device.managementSocket = null
    device.tunnelSocket = null
    refreshStatus(device)
  }

  /* ------------------------------------------------------- phone proxying */

  /**
   * The device that serves requests which carry no device prefix.
   *
   * The phone loads the real DSH web app through the relay, and that app
   * uses absolute paths (`/assets/...`, `/api/...`). Those requests reach the
   * relay root, so they are served by the most recently registered device.
   *
   * @returns {any | null}
   */
  function defaultDevice() {
    let best = null
    for (const device of devices.values()) {
      if (device.status !== 'online') continue
      if (!device.localBaseUrl) continue
      if (!best || device.registeredSeq > best.registeredSeq) best = device
    }
    return best
  }

  /**
   * Resolve the device a phone request belongs to.
   *
   * A path that starts with `/<deviceId>/` is scoped to that device and the
   * prefix is stripped before the request is forwarded. Every other path
   * belongs to the default device and is forwarded unchanged.
   *
   * @param {string} pathname
   * @returns {{device: any, path: string, scoped: boolean} | null}
   */
  function resolveTarget(pathname) {
    let best = null
    for (const device of devices.values()) {
      const mount = deviceMount(device.deviceId)
      if (pathname === mount) {
        if (!best || mount.length > best.mount.length) best = { device, mount, rest: '/' }
        continue
      }
      if (pathname.startsWith(`${mount}/`)) {
        if (!best || mount.length > best.mount.length) {
          best = { device, mount, rest: pathname.slice(mount.length) || '/' }
        }
      }
    }
    if (best) return { device: best.device, path: best.rest, scoped: true }

    const fallback = defaultDevice()
    if (fallback) return { device: fallback, path: pathname, scoped: false }
    return null
  }

  /**
   * Add the relay's own session cookie to a response.
   *
   * @param {Record<string, any>} headers
   * @param {string} session
   */
  function appendSessionCookie(headers, session) {
    const cookie = `${PHONE_SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Strict`
    const existing = headers['set-cookie']
    if (Array.isArray(existing)) headers['set-cookie'] = [...existing, cookie]
    else if (typeof existing === 'string') headers['set-cookie'] = [existing, cookie]
    else headers['set-cookie'] = [cookie]
  }

  /**
   * Read one cookie value from a request.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {string} name
   * @returns {string}
   */
  function readCookie(req, name) {
    const raw = req.headers.cookie
    if (typeof raw !== 'string' || raw.length === 0) return ''
    for (const part of raw.split(';')) {
      const index = part.indexOf('=')
      if (index === -1) continue
      if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
    }
    return ''
  }

  /**
   * The session token of one phone.
   *
   * The token is derived, not random: a relay that restarts can recompute it
   * from the phone's own credential and the relay's secret, so a deploy does
   * not lock every phone out until it types the access code again. Removing a
   * phone from the list takes its session with it.
   *
   * @param {string} deviceId the device the phone belongs to
   * @param {string} phoneToken the phone's own credential
   * @returns {string}
   */
  function phoneSessionToken(deviceId, phoneToken) {
    return createHmac('sha256', secret)
      .update(`session:${deviceId}:${phoneToken}`)
      .digest('base64url')
  }

  /**
   * Decide whether a phone request carries a valid access credential.
   *
   * The access key in the link is the credential: it is accepted once, and the
   * relay then hands the phone its own session cookie so the app's absolute
   * asset and API URLs — which carry no key — keep working.
   *
   * @param {any} device
   * @param {import('node:http').IncomingMessage} req
   * @param {URL} url
   * @returns {{ ok: boolean, session: string }}
   */
  function authorizePhone(device, req, url) {
    const phone = phoneOfRequest(device, req)
    const trusted = phone !== undefined && phone.trusted === true
    // A device that registered without a key keeps the older behaviour: the
    // device id in the link is the only credential.
    if (!device.accessKey) return { ok: true, session: '' }

    // An unlocked phone carries the relay's own session cookie; that is the
    // only way past the passcode.
    const cookie = readCookie(req, PHONE_SESSION_COOKIE)
    if (cookie) {
      if (device.phoneSessions.has(cookie)) return { ok: true, session: '' }
      // A session that was minted before the relay restarted is still good:
      // the token is derived from the phone's own credential, so the relay can
      // recompute it.
      if (phone !== undefined) {
        const derived = phoneSessionToken(device.deviceId, phone.token)
        if (secretsEqual(cookie, derived)) {
          device.phoneSessions.add(cookie)
          return { ok: true, session: '' }
        }
      }
    }

    const key = url.searchParams.get('k') ?? ''
    if (!device.accessKey || !secretsEqual(key, device.accessKey)) {
      return { ok: false, session: '', reason: 'link' }
    }
    if (!device.passcode) {
      // No passcode configured: the link itself is the credential.
      const session = newSessionFor(device, phone)
      device.phoneSessions.add(session)
      return { ok: true, session }
    }
    if (trusted) {
      // A phone the owner marked as trusted skips the access code.
      const session = newSessionFor(device, phone)
      device.phoneSessions.add(session)
      return { ok: true, session }
    }
    // The link is valid, but the device asks for a passcode before it hands
    // out a session.
    return { ok: false, session: '', reason: 'passcode' }
  }

  /**
   * Mint the session token of one phone.
   *
   * @param {any} device the device the phone belongs to
   * @param {any} phone the phone record
   * @returns {string}
   */
  function newSessionFor(device, phone) {
    if (phone === undefined || typeof phone.token !== 'string') {
      return randomBytes(24).toString('base64url')
    }
    return phoneSessionToken(device.deviceId, phone.token)
  }

  /**
   * The file the relay keeps its phone list in.
   *
   * The trust decisions must outlive the relay process, so they live on disk;
   * the device's own credentials (access key, access code) do not, because the
   * host registers them again on every start.
   */
  function stateFilePath() {
    return typeof rawStatePath === 'string' ? rawStatePath : ''
  }

  /**
   * Load the persisted phone list.
   */
  function loadPersistedState() {
    const path = stateFilePath()
    if (!path) return
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      for (const deviceId of parsed?.revoked ?? []) revokedDevices.add(deviceId)
      for (const [deviceId, record] of Object.entries(parsed?.devices ?? {})) {
        if (typeof deviceId !== 'string' || deviceId.length === 0) continue
        persistedDevices.set(deviceId, { ...record })
      }
      for (const [deviceId, phones] of Object.entries(parsed?.phones ?? {})) {
        const list = []
        for (const phone of phones ?? []) {
          if (typeof phone?.token !== 'string' || phone.token.length === 0) continue
          list.push({ ...phone, id: phone.id ?? randomUUID() })
        }
        if (list.length > 0) persistedPhones.set(deviceId, list)
      }
    } catch {
      // A missing or unreadable file simply means "no known phones".
    }
  }

  /**
   * Give a freshly registered device the phones it had before the relay
   * restarted.
   *
   * @param {any} device
   */
  function restorePhones(device) {
    const saved = persistedPhones.get(device.deviceId)
    if (saved === undefined) return
    for (const phone of saved) {
      device.phones.set(phone.token, { ...phone })
    }
  }

  /**
   * Write the phone list back, atomically.
   */
  function persistState() {
    const path = stateFilePath()
    if (!path) return
    const phones = {}
    // The revoked devices survive the relay restart.
    for (const deviceId of revokedDevices) {
      const device = devices.get(deviceId)
      if (device !== undefined) device.revoked = true
    }
    // The offline devices keep their phones too: the list has to survive the
    // relay restarting while a computer is away.
    for (const [deviceId, list] of persistedPhones) {
      phones[deviceId] = list.map((phone) => ({ ...phone }))
    }
    for (const [deviceId, device] of devices) {
      if (device.revoked === true) revokedDevices.add(deviceId)
    }
    for (const [deviceId, device] of devices) {
      if (device.phones.size === 0) continue
      phones[deviceId] = [...device.phones.values()].map((phone) => ({
        id: phone.id,
        token: phone.token,
        label: phone.label,
        userAgent: phone.userAgent,
        firstSeenAt: phone.firstSeenAt,
        lastSeenAt: phone.lastSeenAt,
        lastIp: phone.lastIp,
        trusted: phone.trusted === true,
        unlocks: phone.unlocks ?? 0,
      }))
    }
    try {
      mkdirSync(dirname(path), { recursive: true })
      for (const [deviceId, device] of devices) {
        const known = persistedDevices.get(deviceId) ?? {}
        persistedDevices.set(deviceId, {
          alias: device.alias || known.alias || '',
          aliasLocked: device.aliasLocked === true || known.aliasLocked === true,
          platform: device.platform || known.platform || '',
          clientVersion: device.clientVersion || known.clientVersion || '',
          firstSeenAt: known.firstSeenAt ?? device.connectedAt ?? new Date().toISOString(),
          lastSeenAt: device.lastSeenAt ?? known.lastSeenAt ?? new Date().toISOString(),
        })
      }
      const registry = {}
      for (const [deviceId, record] of persistedDevices) registry[deviceId] = record
      const temporary = `${path}.tmp`
      writeFileSync(temporary, `${JSON.stringify({ phones, revoked: [...revokedDevices], devices: registry }, null, 2)}\n`, 'utf8')
      renameSync(temporary, path)
    } catch {
      // Persistence is best effort; the relay keeps serving without it.
    }
  }

  /** The debounce timer for the persistence write. */
  let persistTimer

  /** The phones of devices that are not registered right now. */
  const persistedPhones = new Map()

  /** The devices the owner revoked; they stay refused until restored. */
  const revokedDevices = new Set()

  /** The devices the relay has seen, so an away device still shows up. */
  const persistedDevices = new Map()
  /**
   * Note that the phone list changed and schedule a write.
   *
   * @param {any} [_device]
   */
  function markStateDirty(_device) {
    if (!stateFilePath()) return
    if (persistTimer !== undefined) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = undefined
      persistState()
    }, 500)
    persistTimer.unref?.()
  }

  /**
   * The phone behind a request, if it presented its own credential.
   *
   * @param {any} device
   * @param {import('node:http').IncomingMessage} req
   * @returns {any | undefined}
   */
  function phoneOfRequest(device, req) {
    const token = readCookie(req, PHONE_DEVICE_COOKIE)
    if (!token) return undefined
    const phone = device.phones?.get(token)
    if (phone === undefined) return undefined
    phone.lastSeenAt = new Date().toISOString()
    phone.lastIp = callerAddress(req)
    return phone
  }

  /**
   * The phone whose record matches a caller that lost its credential.
   *
   * A phone that arrives without its cookie — a browser that cleared it, a
   * web view with its own storage, a private tab — would otherwise be a new
   * device on every visit, and the owner's list would fill up with one
   * handset. The caller address and the User-Agent together name the same
   * device well enough to continue its record.
   *
   * A trusted record is never handed out this way: the trust belongs to the
   * phone that proved itself with its own credential, not to whoever shares
   * its address. Such a caller gets a record of its own, and still has to
   * type the access code.
   *
   * @param {any} device
   * @param {import('node:http').IncomingMessage} req
   * @returns {any | undefined}
   */
  function matchingPhone(device, req) {
    const ip = callerAddress(req)
    const userAgent = String(req.headers['user-agent'] ?? '')
    if (ip === '' || userAgent === '') return undefined
    let best
    for (const phone of device.phones.values()) {
      if (phone.trusted === true) continue
      if (phone.lastIp !== ip) continue
      if (phone.userAgent !== userAgent) continue
      if (best === undefined || (phone.lastSeenAt ?? '') > (best.lastSeenAt ?? '')) best = phone
    }
    return best
  }

  /**
   * Remember a phone after it unlocked, and hand it its own credential.
   *
   * @param {any} device
   * @param {import('node:http').IncomingMessage} req
   * @returns {{ token: string, record: any }}
   */
  function rememberPhone(device, req) {
    const existing = phoneOfRequest(device, req) ?? matchingPhone(device, req)
    const token = existing?.token ?? randomBytes(32).toString('base64url')
    const userAgent = String(req.headers['user-agent'] ?? '')
    const record = existing ?? {
      id: randomUUID(),
      token,
      label: labelFromUserAgent(userAgent),
      userAgent,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      lastIp: callerAddress(req),
      trusted: false,
      unlocks: 0,
    }
    record.lastSeenAt = new Date().toISOString()
    record.lastIp = callerAddress(req)
    record.unlocks = (record.unlocks ?? 0) + 1
    device.phones.set(token, record)
    markStateDirty(device)
    return { token, record }
  }

  /**
   * A readable name for a phone, derived from its User-Agent.
   *
   * @param {string} userAgent
   * @returns {string}
   */
  function labelFromUserAgent(userAgent) {
    const agent = String(userAgent ?? '')
    const platform = /iPhone/.test(agent)
      ? 'iPhone'
      : /iPad/.test(agent)
        ? 'iPad'
        : /Android/.test(agent)
          ? 'Android'
          : /Mac OS X|Macintosh/.test(agent)
            ? 'Mac'
            : /Windows/.test(agent)
              ? 'Windows'
              : /Linux/.test(agent)
                ? 'Linux'
                : ''
    const browser = /Edg\//.test(agent)
      ? 'Edge'
      : /OPR\//.test(agent)
        ? 'Opera'
        : /Chrome\//.test(agent)
          ? 'Chrome'
          : /Firefox\//.test(agent)
            ? 'Firefox'
            : /Safari\//.test(agent)
              ? 'Safari'
              : ''
    if (platform && browser) return `${platform} · ${browser}`
    return platform || browser || '手机'
  }

  /**
   * Check a submitted passcode, with a lockout after repeated failures.
   *
   * @param {any} device
   * @param {string} submitted
   * @returns {{ ok: boolean, locked: boolean }}
   */
  function checkPasscode(device, submitted, ip) {
    const now = Date.now()
    const key = ip || 'unknown'

    // A global budget caps how many guesses the device accepts in an hour, so
    // a distributed attack cannot walk the code space.
    if (now - (device.windowStart ?? 0) > PASSCODE_BUDGET_WINDOW_MS) {
      device.windowStart = now
      device.windowCount = 0
    }
    if ((device.windowCount ?? 0) >= PASSCODE_BUDGET_PER_HOUR) {
      return { ok: false, locked: true }
    }

    // The lockout belongs to the caller, not to the device: a stranger typing
    // wrong codes must not lock the owner's own phone out.
    const entry = device.failedByIp.get(key) ?? { count: 0, lockedUntil: 0 }
    if (entry.lockedUntil > now) return { ok: false, locked: true }

    if (device.passcode && secretsEqual(submitted ?? '', device.passcode)) {
      entry.count = 0
      entry.lockedUntil = 0
      device.failedByIp.set(key, entry)
      return { ok: true, locked: false }
    }

    entry.count += 1
    let locked = false
    if (entry.count >= PASSCODE_MAX_ATTEMPTS) {
      // The attempt that exhausts the budget already answers "locked", so the
      // caller learns at once that guessing further is pointless.
      entry.count = 0
      entry.lockedUntil = now + PASSCODE_LOCKOUT_MS
      locked = true
    }
    device.failedByIp.set(key, entry)
    device.windowCount = (device.windowCount ?? 0) + 1
    return { ok: false, locked }
  }

  /**
   * The caller's address, preferring the address the proxy in front recorded.
   *
   * @param {import('node:http').IncomingMessage} req
   * @returns {string}
   */
  function callerAddress(req) {
    const forwarded = req.headers['x-forwarded-for']
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded
    const first = String(value ?? '').split(',')[0].trim()
    if (first.length > 0) return first
    return String(req.socket?.remoteAddress ?? 'unknown')
  }

  /**
   * The page a phone sees before it may control the agent.
   *
   * It asks for the device's passcode; the answer is posted back to the same
   * URL, and a correct code leaves a session cookie behind.
   *
   * @param {any} device
   * @param {string} action
   * @param {string} [error]
   * @returns {string}
   */
  function unlockPage(device, action, error) {
    const note = error === undefined ? '' : `<p class="error">${error}</p>`
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>访问码 · DeepSeek Harness</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: flex; align-items: center; justify-content: center;
         font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
         background: #f6f7f9; color: #1c1f23; padding: 24px; }
  @media (prefers-color-scheme: dark) { body { background: #14161a; color: #e6e8eb; }
    .card { background: #1c1f24 !important; border-color: #2c3038 !important; } }
  .card { background: #fff; border: 1px solid #e3e6ea; border-radius: 14px; padding: 28px 24px;
          max-width: 360px; width: 100%; box-shadow: 0 10px 30px rgba(0,0,0,.06); }
  h1 { font-size: 17px; margin: 0 0 6px; }
  p.sub { margin: 0 0 18px; font-size: 13px; color: #6b7280; }
  @media (prefers-color-scheme: dark) { p.sub { color: #9aa1ab; } }
  label { display: block; font-size: 12px; color: #6b7280; margin-bottom: 6px; }
  @media (prefers-color-scheme: dark) { label { color: #9aa1ab; } }
  input { width: 100%; font-size: 20px; letter-spacing: .32em; text-align: center; padding: 12px 10px;
          border: 1px solid #d5d9de; border-radius: 10px; background: #fff; color: inherit; }
  @media (prefers-color-scheme: dark) { input { background: #14161a; border-color: #2c3038; } }
  input:focus { outline: 2px solid #2f6feb; outline-offset: 1px; }
  button { width: 100%; margin-top: 14px; padding: 12px; font-size: 15px; font-weight: 500; color: #fff;
           background: #2f6feb; border: 0; border-radius: 10px; cursor: pointer; }
  button:active { background: #2b62d4; }
  .error { margin: 0 0 12px; padding: 10px 12px; border-radius: 8px; font-size: 13px;
           background: #fdecec; color: #b3261e; }
  @media (prefers-color-scheme: dark) { .error { background: #3a1f1f; color: #f2b8b5; } }
  .hint { margin: 16px 0 0; font-size: 12px; color: #8b919b; }
  .dev { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
  <form class="card" method="post" action="${action}">
    <h1>需要访问码</h1>
    <p class="sub">这台电脑上的智能体受访问码保护。输入电脑端显示的 8 位数字即可继续。</p>
    ${note}
    <label for="p">访问码</label>
    <input id="p" name="p" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="one-time-code"
           autofocus placeholder="••••••••">
    <button type="submit">解锁</button>
    <p class="hint">设备：<span class="dev">${device.alias || device.deviceId}</span></p>
  </form>
</body>
</html>`
  }

  /**
   * Ask a phone for the device's passcode, and unlock it when the code is right.
   *
   * The link alone is not enough: the device holds a passcode, the phone has
   * to type it once, and the relay then issues its own session cookie.
   *
   * @param {any} device
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   * @param {string} method
   * @returns {Promise<void>}
   */
  async function serveUnlock(device, req, res, url, method) {
    const action = `${url.pathname}${url.search}`
    if (method !== 'POST') {
      sendHtml(res, 200, unlockPage(device, action))
      return
    }

    let body = Buffer.alloc(0)
    try {
      body = await readBody(req, MAX_BODY_BYTES)
    } catch {
      sendHtml(res, 413, unlockPage(device, action, '请求过大'))
      return
    }
    const submitted = new URLSearchParams(body.toString('utf8')).get('p') ?? ''
    const verdict = checkPasscode(device, submitted, callerAddress(req))
    if (!verdict.ok) {
      if (verdict.locked) {
        res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '600' })
        res.end('尝试次数过多，请 10 分钟后再试')
        return
      }
      sendHtml(res, 401, unlockPage(device, action, '访问码不正确'))
      return
    }

    // The phone keeps its own credential, so the owner can recognise it and
    // mark it trusted; a trusted phone skips the access code from then on.
    const phone = rememberPhone(device, req)
    const session = newSessionFor(device, phone)
    device.phoneSessions.add(session)
    res.writeHead(303, {
      location: url.pathname,
      'set-cookie': [
        `${PHONE_SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=${PHONE_COOKIE_SAME_SITE}; Max-Age=${PHONE_SESSION_MAX_AGE}`,
        `${PHONE_DEVICE_COOKIE}=${phone.token}; Path=/; HttpOnly; SameSite=${PHONE_COOKIE_SAME_SITE}; Max-Age=${PHONE_COOKIE_MAX_AGE}`,
      ],
      'cache-control': 'no-store',
    })
    res.end()
  }

  /**
   * Answer with an HTML page.
   *
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {string} html
   */
  function sendHtml(res, status, html) {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    })
    res.end(html)
  }

  /**
   * Proxy one phone request to the device's `local_base_url`.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   */
  async function handlePhoneRequest(req, res, url) {
    const target = resolveTarget(url.pathname)
    if (!target) {
      sendPlain(res, 503, 'no online device')
      return
    }
    const { device, path } = target
    const method = (req.method || 'GET').toUpperCase()

    if (device.status === 'offline' || device.revoked) {
      sendPlain(res, 403, 'device is offline')
      return
    }
    const access = authorizePhone(device, req, url)
    if (!access.ok) {
      if (access.reason === 'passcode') {
        await serveUnlock(device, req, res, url, method)
        return
      }
      sendPlain(res, 401, 'a valid access link is required')
      return
    }
    const tunnelOpen = device.tunnelSocket && device.tunnelSocket.readyState === WebSocket.OPEN
    if (!tunnelOpen) {
      sendPlain(res, 503, 'device has no live tunnel')
      return
    }

    const search = url.search || ''
    const upstreamPath = `${path}${search}`

    let body = Buffer.alloc(0)
    try {
      body = await readBody(req, MAX_BODY_BYTES)
    } catch {
      sendPlain(res, 413, 'payload too large')
      return
    }

    const headers = sanitizeRequestHeaders(req.headers)
    const forwarded = String(req.socket.remoteAddress || '')
    if (forwarded && !headers['x-forwarded-for']) headers['x-forwarded-for'] = forwarded
    if (!headers['x-forwarded-proto']) headers['x-forwarded-proto'] = 'http'
    if (body.length > 0) headers['content-length'] = String(body.length)
    else delete headers['content-length']

    if (device.mode === 'push') {
      await serveFromLocalBase(device, method, upstreamPath, headers, body, res, access.session)
      return
    }
    serveThroughTunnel(device, method, upstreamPath, headers, body, res, access.session)
  }

  /**
   * Forward one phone request through the device's tunnel socket and answer
   * the phone with the host's response.
   *
   * @param {any} device
   * @param {string} method
   * @param {string} path path plus query string, relative to `local_base_url`
   * @param {Record<string, string>} headers
   * @param {Buffer} body
   * @param {import('node:http').ServerResponse} res
   */
  function serveThroughTunnel(device, method, path, headers, body, res, session) {
    const perDevice = [...inflight.values()].filter((entry) => entry.device === device).length
    if (perDevice >= MAX_INFLIGHT_PER_DEVICE || inflight.size >= MAX_INFLIGHT_TOTAL) {
      sendPlain(res, 503, 'too many in-flight requests')
      return
    }

    const id = randomUUID()
    const frame = requestFrame({ id, method, path, headers, body: null })
    if (body.length > 0) {
      frame.body = body.toString('base64')
      frame.body_encoding = 'base64'
    }

    /** @type {PendingRequest} */
    const pending = {
      id,
      device,
      res,
      session,
      chunks: [],
      headers: null,
      status: 0,
      streaming: false,
      timer: undefined,
      resolve: (value) => {
        if (!inflight.has(id)) return
        inflight.delete(id)
        clearTimeout(pending.timer)
        if (pending.streaming === true) {
          // The head is on the wire already, so the body cannot be sent as one
          // piece any more: it becomes the last chunk of the stream.
          try {
            res.end(value.body)
          } catch {
            /* client already gone */
          }
          return
        }
        const responseHeaders = sanitizeResponseHeaders(value.headers || {})
        responseHeaders['content-length'] = String(value.body.length)
        if (session) appendSessionCookie(responseHeaders, session)
        try {
          res.writeHead(value.status, responseHeaders)
          res.end(value.body)
        } catch {
          /* client already gone */
        }
      },
      reject: (reason) => {
        if (!inflight.has(id)) return
        inflight.delete(id)
        clearTimeout(pending.timer)
        if (res.headersSent) {
          // The head is on the wire already, so the status can no longer be
          // changed: the stream is cut instead of answered with a 502.
          try {
            res.destroy()
          } catch {
            /* client already gone */
          }
          return
        }
        sendPlain(res, 502, reason && reason.message ? reason.message : 'upstream error')
      },
    }

    inflight.set(id, pending)
    armRequestTimer(pending)

    if (!sendToHost(device, frame)) {
      inflight.delete(id)
      clearTimeout(pending.timer)
      sendPlain(res, 503, 'device has no live tunnel')
      return
    }

    // The phone may walk away while the host is still working.
    res.on('close', () => {
      if (!res.writableEnded && inflight.has(id)) {
        inflight.delete(id)
        clearTimeout(pending.timer)
        sendToHost(device, abortFrame(id))
      }
    })
  }

  /**
   * (Re)arm the timer of one in-flight request.
   *
   * Before the response head arrives the timer is a hard deadline: the host
   * has to answer within the window. Once the response streams, it becomes an
   * idle timer: every chunk that arrives pushes the deadline out, so a live
   * stream is never killed while a stalled one still is.
   *
   * @param {PendingRequest} pending
   * @param {number} [delay] the window in milliseconds
   */
  function armRequestTimer(pending, delay = pending.streaming ? streamIdleTimeoutMs : requestTimeoutMs) {
    clearTimeout(pending.timer)
    pending.timer = setTimeout(() => {
      if (!inflight.has(pending.id)) return
      inflight.delete(pending.id)
      sendToHost(pending.device, abortFrame(pending.id))
      if (pending.res.headersSent) {
        // The head is on the wire already, so the status can no longer be
        // changed: the stream is cut instead of answered with a 504.
        logInfo('relay: a streamed response stalled', { id: pending.id })
        try {
          pending.res.destroy()
        } catch {
          /* client already gone */
        }
        return
      }
      sendPlain(pending.res, 504, 'host did not answer in time')
    }, delay)
  }

  /**
   * Write the head of a streamed response to the phone.
   *
   * The length of such a body is unknown, so no content-length is sent and
   * Node falls back to chunked transfer encoding. Everything else travels as
   * the host sent it.
   *
   * The head is flushed, not only stored: a phone that waits for the head of
   * an event stream has to get it before the first event arrives.
   *
   * @param {PendingRequest} pending
   */
  function writeStreamHead(pending) {
    const headers = sanitizeResponseHeaders(pending.headers || {})
    delete headers['content-length']
    if (pending.session) appendSessionCookie(headers, pending.session)
    try {
      pending.res.writeHead(pending.status || 200, headers)
      pending.res.flushHeaders?.()
    } catch (error) {
      logInfo('relay: failed to write the response head', { error: String(error) })
    }
  }

  /**
   * Forward one chunk of a streamed response to the phone.
   *
   * @param {PendingRequest} pending
   * @param {Buffer} chunk
   */
  function writeStreamChunk(pending, chunk) {
    if (chunk.length === 0) return
    if (pending.res.writableEnded || pending.res.destroyed) return
    try {
      pending.res.write(chunk)
    } catch (error) {
      logInfo('relay: failed to forward a chunk', { error: String(error) })
    }
  }

  /**
   * Finish a streamed response.
   *
   * @param {PendingRequest} pending
   */
  function endStream(pending) {
    if (!inflight.has(pending.id)) return
    inflight.delete(pending.id)
    clearTimeout(pending.timer)
    try {
      pending.res.end()
    } catch (error) {
      logInfo('relay: failed to end the streamed response', { error: String(error) })
    }
  }

  /**
   * Execute a phone request directly against the device's `local_base_url`.
   *
   * Used when the host drives the relay (it pushes request frames) and as the
   * compatibility path of the tunnel protocol.
   *
   * @param {any} device
   * @param {string} method
   * @param {string} path
   * @param {Record<string, string>} headers
   * @param {Buffer} body
   * @param {import('node:http').ServerResponse} res
   */
  async function serveFromLocalBase(device, method, path, headers, body, res, session) {
    let target
    try {
      target = joinBaseUrl(device.localBaseUrl, path)
    } catch {
      sendPlain(res, 502, 'invalid local_base_url')
      return
    }
    try {
      const result = await performHttpRequest(target, method, headers, body)
      const responseHeaders = sanitizeResponseHeaders(result.headers)
      responseHeaders['content-length'] = String(result.body.length)
      if (session) appendSessionCookie(responseHeaders, session)
      res.writeHead(result.status, responseHeaders)
      res.end(result.body)
    } catch (error) {
      sendPlain(res, 502, `upstream request failed: ${String(error && error.message)}`)
    }
  }

  /**
   * Perform a plain HTTP(S) request.
   *
   * @param {string} url
   * @param {string} method
   * @param {Record<string, string>} headers
   * @param {Buffer} body
   * @returns {Promise<{status: number, headers: Record<string, string | string[]>, body: Buffer}>}
   */
  function performHttpRequest(url, method, headers, body) {
    return new Promise((resolve, reject) => {
      let target
      try {
        target = new URL(url)
      } catch (error) {
        reject(error)
        return
      }
      const transport = target.protocol === 'https:' ? https : http
      const outgoing = { ...headers }
      if (body.length > 0) outgoing['content-length'] = String(body.length)
      const request = transport.request(
        target,
        { method, headers: outgoing },
        (response) => {
          /** @type {Buffer[]} */
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => {
            resolve({
              status: response.statusCode || 502,
              headers: response.headers,
              body: Buffer.concat(chunks),
            })
          })
          response.on('error', reject)
        },
      )
      request.on('error', reject)
      if (body.length > 0) request.write(body)
      request.end()
    })
  }

  /* ------------------------------------------------------------- channels */

  /**
   * Handle a WebSocket upgrade request.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} head
   */
  function handleUpgrade(req, socket, head) {
    let url
    try {
      url = new URL(req.url || '/', 'http://relay.invalid')
    } catch {
      rejectUpgrade(socket, 400, 'bad request')
      return
    }

    if (url.pathname === MANAGEMENT_PATH) {
      if (!isAuthorizedUpgrade(req)) {
        rejectUpgrade(socket, 401, 'unauthorized')
        return
      }
      acceptUpgrade(req, socket, head, (client) => openManagementChannel(client, req))
      return
    }

    if (url.pathname === TUNNEL_PATH) {
      if (!isAuthorizedUpgrade(req)) {
        rejectUpgrade(socket, 401, 'unauthorized')
        return
      }
      const deviceId = url.searchParams.get('device_id')
      if (!deviceId || !DEVICE_ID_PATTERN.test(deviceId)) {
        rejectUpgrade(socket, 400, 'missing or invalid device_id')
        return
      }
      acceptUpgrade(req, socket, head, (client) => openTunnelChannel(client, deviceId))
      return
    }

    // Anything else is a phone-facing WebSocket (e.g. `/api/remote.mux`).
    openPhoneBridge(req, socket, head, url)
  }

  /**
   * Complete a WebSocket handshake for one of the host-facing channels.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} head
   * @param {(client: WebSocket) => void} onAccepted
   */
  function acceptUpgrade(req, socket, head, onAccepted) {
    if (!wss) {
      rejectUpgrade(socket, 503, 'relay is not running')
      return
    }
    try {
      wss.handleUpgrade(req, socket, head, (client) => {
        onAccepted(client)
      })
    } catch (error) {
      logInfo('relay: websocket handshake failed', { error: String(error) })
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Answer a failed WebSocket upgrade with a plain HTTP response.
   *
   * @param {import('node:stream').Duplex} socket
   * @param {number} status
   * @param {string} message
   */
  function rejectUpgrade(socket, status, message) {
    const body = `${message}\n`
    const headers = [
      `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Error'}`,
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
    ]
    if (status === 401) headers.push('WWW-Authenticate: Bearer realm="dsh-relay"')
    try {
      socket.write(`${headers.join('\r\n')}\r\n\r\n${body}`)
    } catch {
      /* ignore */
    }
    try {
      socket.destroy()
    } catch {
      /* ignore */
    }
  }

  /**
   * Management channel: the host announces itself here.
   *
   * @param {WebSocket} socket
   * @param {import('node:http').IncomingMessage} req
   */
  function openManagementChannel(socket, req) {
    /** @type {any} */
    let device = null

    socket.on('message', (data) => {
      const frame = parseFrame(data)
      if (!frame) return
      try {
        if (frame.type === 'register') {
          // A revoked device is refused at the door, reconnects included.
          const registered = frame.device_id
          if (typeof registered === 'string' && revokedDevices.has(registered)) {
            sendFrame(socket, registerNakFrame('this device was revoked by the owner'))
            closeSocket(socket, 1000)
            logInfo('relay: a revoked device tried to register', { deviceId: registered })
            return
          }
          device = handleRegisterFrame(socket, frame, req)
          return
        }
        if (frame.type === 'revoke') {
          const reason = typeof frame.reason === 'string' ? frame.reason : 'revoked by host'
          if (device) {
            logInfo('relay: device revoked by host', { deviceId: device.deviceId, reason })
            takeDeviceOffline(device)
          }
          closeSocket(socket, 1000)
          return
        }
        if (device) device.lastSeenAt = new Date().toISOString()
        logInfo('relay: ignoring frame on management channel', { type: frame.type })
      } catch (error) {
        logInfo('relay: management frame failed', { error: String(error) })
      }
    })

    socket.on('error', (error) => {
      logInfo('relay: management socket error', { error: String(error) })
    })

    socket.on('close', () => {
      if (device && device.managementSocket === socket) {
        device.managementSocket = null
        refreshStatus(device)
        logInfo('relay: management socket closed', { deviceId: device.deviceId })
      }
    })
  }

  /**
   * Handle a `register` frame on the management channel.
   *
   * @param {WebSocket} socket
   * @param {Record<string, any>} frame
   * @param {import('node:http').IncomingMessage} req
   * @returns {any | null} the device record when the registration was accepted
   */
  function handleRegisterFrame(socket, frame, req) {
    const deviceId = typeof frame.device_id === 'string' ? frame.device_id.trim() : ''
    const localBaseUrl = typeof frame.local_base_url === 'string' ? frame.local_base_url.trim() : ''

    if (!deviceId || !DEVICE_ID_PATTERN.test(deviceId)) {
      sendFrame(socket, registerNakFrame(NAK_REASONS.deviceId))
      closeSocket(socket, 1000)
      return null
    }
    if (!isHttpUrl(localBaseUrl)) {
      sendFrame(socket, registerNakFrame(NAK_REASONS.localBaseUrl))
      closeSocket(socket, 1000)
      return null
    }

    const existing = devices.get(deviceId)
    if (
      existing &&
      existing.managementSocket &&
      existing.managementSocket !== socket &&
      existing.managementSocket.readyState === WebSocket.OPEN
    ) {
      sendFrame(socket, registerNakFrame(NAK_REASONS.duplicate))
      closeSocket(socket, 1000)
      return null
    }

    const now = new Date().toISOString()
    const device = existing || createDeviceRecord(deviceId, now)

    // An alias the owner set is the owner's property: a device that
    // re-registers must not take it back.
    if (device.aliasLocked !== true) {
      device.alias = typeof frame.alias === 'string' ? frame.alias : device.alias
    }
    device.platform = typeof frame.platform === 'string' ? frame.platform : device.platform
    device.clientVersion =
      typeof frame.client_version === 'string' ? frame.client_version : device.clientVersion
    device.localBaseUrl = localBaseUrl
    if (typeof frame.access_key === 'string' && frame.access_key !== device.accessKey) {
      // A rotated key invalidates every phone session that used the old one.
      device.accessKey = frame.access_key
      device.phoneSessions.clear()
    }
    if (typeof frame.passcode === 'string' && frame.passcode !== device.passcode) {
      // A rotated passcode invalidates every phone session unlocked with the
      // old one, so a leaked code stops working immediately.
      device.passcode = frame.passcode
      device.phoneSessions.clear()
      device.failedByIp.clear()
      device.windowStart = 0
      device.windowCount = 0
    }
    device.connectedAt = now
    device.lastSeenAt = now
    const known = persistedDevices.get(deviceId)
    if (known !== undefined) {
      if (known.aliasLocked === true) {
        device.aliasLocked = true
        device.alias = known.alias || device.alias
      }
      known.alias = device.alias || known.alias
      known.aliasLocked = device.aliasLocked === true
      known.platform = device.platform || known.platform
      known.clientVersion = device.clientVersion || known.clientVersion
      known.lastSeenAt = now
      persistedDevices.set(deviceId, known)
    } else {
      persistedDevices.set(deviceId, {
        alias: device.alias,
        aliasLocked: device.aliasLocked === true,
        platform: device.platform,
        clientVersion: device.clientVersion,
        firstSeenAt: now,
        lastSeenAt: now,
      })
    }
    // `revoked` is the owner's decision and outlives a reconnect: only the
    // owner can lift it.
    device.managementSocket = socket
    device.registeredSeq = ++registrationCounter
    refreshStatus(device)
    devices.set(deviceId, device)
    if (revokedDevices.has(deviceId)) device.revoked = true
    restorePhones(device)
    // A device that has just registered belongs in the persisted registry, so
    // it survives a relay restart and can still be revoked while it is away.
    markStateDirty(device)

    const publicUrl = publicUrlFor(deviceId, resolvePublicBaseUrl(req), device.accessKey)
    sendFrame(
      socket,
      registerAckFrame({
        deviceId,
        publicUrl,
        capabilities: [CAPABILITY_BINARY_BODY, CAPABILITY_WS_BINARY_BODY],
      }),
    )
    logInfo('relay: device registered', { deviceId, publicUrl })
    return device
  }

  /**
   * Build an empty device record.
   *
   * @param {string} deviceId
   * @param {string} now ISO timestamp
   * @returns {any}
   */
  function createDeviceRecord(deviceId, now) {
    return {
      deviceId,
      alias: '',
      platform: '',
      clientVersion: '',
      localBaseUrl: '',
      accessKey: '',
      passcode: '',
      phoneSessions: new Set(),
      /** The phones that reached this device, keyed by their own token. */
      phones: new Map(),
      failedByIp: new Map(),
      windowStart: 0,
      windowCount: 0,
      status: 'offline',
      connectedAt: now,
      lastSeenAt: now,
      managementSocket: null,
      tunnelSocket: null,
      revoked: false,
      offlineRequested: false,
      mode: 'pull',
      registeredSeq: 0,
    }
  }

  /**
   * @param {string} value
   * @returns {boolean} true when the value is an http(s) URL
   */
  function isHttpUrl(value) {
    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }

  /**
   * Tunnel channel: the host opens it for one device and answers request
   * frames on it.
   *
   * @param {WebSocket} socket
   * @param {string} deviceId
   */
  function openTunnelChannel(socket, deviceId) {
    const now = new Date().toISOString()
    const device = devices.get(deviceId) || createDeviceRecord(deviceId, now)
    devices.set(deviceId, device)

    if (device.tunnelSocket && device.tunnelSocket !== socket) {
      closeSocket(device.tunnelSocket, 1000)
    }
    device.tunnelSocket = socket
    device.lastSeenAt = now
    refreshStatus(device)
    logInfo('relay: tunnel channel opened', { deviceId })

    socket.on('message', (data, isBinary) => {
      // A binary message carries neither a frame nor always a body: it can
      // hold a WebSocket payload or the body of a response. The payload says
      // so itself, so it is read first; anything else is a body. The flag is
      // what tells a frame apart from both: a text frame that arrives in one
      // piece is handed over as a Buffer, too.
      if (isBinary === true) {
        const payload = decodeBinaryWsPayload(data)
        if (payload !== undefined) {
          try {
            handleHostBinaryWsPayload(device, payload)
          } catch (error) {
            logInfo('relay: binary ws payload failed', { deviceId, error: String(error) })
          }
          return
        }
        try {
          handleHostBinaryBody(device, data)
        } catch (error) {
          logInfo('relay: binary body failed', { deviceId, error: String(error) })
        }
        return
      }
      const frame = parseFrame(data)
      if (!frame) return
      try {
        handleTunnelFrame(device, frame)
      } catch (error) {
        logInfo('relay: tunnel frame failed', { deviceId, error: String(error) })
      }
    })

    socket.on('error', (error) => {
      logInfo('relay: tunnel socket error', { deviceId, error: String(error) })
    })

    socket.on('close', () => {
      if (device.tunnelSocket === socket) {
        device.tunnelSocket = null
        refreshStatus(device)
        logInfo('relay: tunnel channel closed', { deviceId })
      }
    })
  }

  /**
   * Handle one frame received on a tunnel channel.
   *
   * @param {any} device
   * @param {Record<string, any>} frame
   */
  function handleTunnelFrame(device, frame) {
    device.lastSeenAt = new Date().toISOString()

    switch (frame.type) {
      case 'response':
        handleHostResponse(device, frame)
        return
      case 'response_chunk':
        handleHostResponseChunk(device, frame)
        return
      case 'upgraded':
        handleHostUpgraded(device, frame)
        return
      case 'ws_frame':
        handleHostWsFrame(device, frame)
        return
      case 'ws_ping':
        handleHostWsPing(device, frame)
        return
      case 'ws_pong':
        handleHostWsPong(device, frame)
        return
      case 'ws_close':
        handleHostWsClose(device, frame)
        return
      case 'abort':
        handleHostAbort(device, frame)
        return
      case 'request':
        // Compatibility path: the host drives the request itself and expects
        // the relay to execute it against the device's local base URL.
        device.mode = 'push'
        void executeHostRequest(device, frame)
        return
      case 'upgrade':
        device.mode = 'push'
        void executeHostUpgrade(device, frame)
        return
      default:
        logInfo('relay: ignoring frame on tunnel channel', {
          deviceId: device.deviceId,
          type: frame.type,
        })
    }
  }

  /**
   * Complete an in-flight request with a full response frame.
   *
   * A `response` frame that carries an id of a pending upgrade means the host
   * could not open the upstream WebSocket; the phone is told right away.
   *
   * @param {any} device
   * @param {Record<string, any>} frame
   */
  function handleHostResponse(device, frame) {
    const id = String(frame.id)
    const pending = inflight.get(id)
    if (!pending) {
      const upgrade = pendingUpgrades.get(id)
      if (upgrade) {
        pendingUpgrades.delete(id)
        clearTimeout(upgrade.timer)
        upgrade.reject(new Error(`host refused the upgrade (${Number(frame.status) || 502})`))
      }
      return
    }
    if (frame.chunked === true) {
      // A response that streams: the head carries the status and the headers,
      // the body follows in chunks. The head goes to the phone right away and
      // every chunk is forwarded as it arrives, so a response that never ends
      // (an event stream) reaches the phone instead of being timed out.
      pending.status = Number(frame.status) || 200
      pending.headers = frame.headers || {}
      pending.chunks = []
      pending.streaming = true
      writeStreamHead(pending)
      // From here on the timer is an idle timer: a stream that keeps sending
      // must not die on the deadline that guards a request with no answer.
      armRequestTimer(pending)
      return
    }
    if (frame.body_encoding === 'binary') {
      // The body arrives as one binary WebSocket message. The text frame
      // carries the status and the headers, the message the bytes; both name
      // the request, so their order does not matter.
      pending.status = Number(frame.status) || 200
      pending.headers = frame.headers || {}
      pending.awaitingBinaryBody = true
      if (pending.binaryBody !== undefined) {
        pending.awaitingBinaryBody = false
        pending.resolve({
          status: pending.status,
          headers: pending.headers || {},
          body: pending.binaryBody,
        })
      }
      return
    }
    pending.resolve({
      status: Number(frame.status) || 200,
      headers: frame.headers || {},
      body: decodeBody(frame.body, frame.body_encoding),
    })
  }

  /**
   * Take the body of a response out of one binary WebSocket message.
   *
   * A body that travels in a binary message costs no base64 inflation, which
   * matters on a relay that sits on the other side of the world: the web app
   * is one bundle of several megabytes, and the link is the bottleneck.
   *
   * @param {any} device
   * @param {Buffer} message the raw WebSocket message
   */
  function handleHostBinaryBody(device, message) {
    const decoded = decodeBinaryBody(message)
    if (decoded === undefined) {
      logInfo('relay: ignoring an unreadable binary body', { deviceId: device?.deviceId })
      return
    }
    const pending = inflight.get(decoded.id)
    if (!pending) return
    pending.binaryBody = decoded.body
    if (pending.awaitingBinaryBody !== true) return
    pending.awaitingBinaryBody = false
    pending.resolve({
      status: pending.status,
      headers: pending.headers || {},
      body: pending.binaryBody,
    })
  }

  /**
   * Forward one chunk of a chunked response.
   *
   * A response that streams is handed to the phone as it arrives; one that
   * arrives without a head is still collected, so a host that does not know
   * about the chunked head keeps working.
   *
   * @param {any} device
   * @param {Record<string, any>} frame
   */
  function handleHostResponseChunk(device, frame) {
    const pending = inflight.get(String(frame.id))
    if (!pending) return
    const chunk = decodeBody(frame.chunk, frame.body_encoding)
    if (pending.streaming === true) {
      // The phone gets the bytes as they arrive, and every chunk pushes the
      // idle window out.
      armRequestTimer(pending)
      writeStreamChunk(pending, chunk)
      if (frame.last === true) endStream(pending)
      return
    }
    if (pending.status === 0) {
      pending.status = Number(frame.status) || 200
      pending.headers = frame.headers || {}
    }
    pending.chunks.push(chunk)
    if (frame.last === true) {
      pending.resolve({
        status: pending.status,
        headers: pending.headers || {},
        body: Buffer.concat(pending.chunks),
      })
    }
  }

  /**
   * The host accepted a WebSocket upgrade.
   *
   * @param {any} device
   * @param {Record<string, any>} frame
   */
  function handleHostUpgraded(device, frame) {
    const id = String(frame.id)
    const pending = pendingUpgrades.get(id)
    if (!pending) return
    pendingUpgrades.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(frame)
  }

  /**
   * Forward one WebSocket payload to the phone.
   *
   * @param {any} device
   * @param {Record<string, any>} frame
   */
  function handleHostWsFrame(device, frame) {
    const payload = decodeBody(frame.data, frame.body_encoding)
    forwardWsPayload(String(frame.id), payload, frame.binary === true)
  }

  /**
   * Forward one WebSocket payload that arrived as a binary tunnel message.
   *
   * A payload that travels as a binary message pays for no base64 inflation,
   * and the biggest one - a session snapshot - is megabytes.
   *
   * @param {any} device
   * @param {{id: string, payload: Buffer, binary: boolean}} decoded
   */
  function handleHostBinaryWsPayload(device, decoded) {
    forwardWsPayload(String(decoded.id), decoded.payload, decoded.binary === true)
  }

  /**
   * Hand one WebSocket payload to the phone's socket.
   *
   * The kind of the message travels with the payload: guessing it from the
   * bytes turns a binary payload into a text one and breaks the peer protocol.
   *
   * @param {string} id the bridge the payload belongs to
   * @param {Buffer} payload
   * @param {boolean} binary whether the payload is a binary one
   */
  function forwardWsPayload(id, payload, binary) {
    const bridge = bridges.get(id)
    if (!bridge) return
    try {
      if (bridge.peer.readyState !== WebSocket.OPEN) return
      if (binary === true) bridge.peer.send(payload)
      else bridge.peer.send(payload.toString('utf8'))
    } catch (error) {
      logInfo('relay: failed to forward ws frame', { error: String(error) })
    }
  }

  /**
   * The host closed one bridged WebSocket.
   *
   * @param {any} device
   * @param {Record<string, any>} frame
   */
  function handleHostWsClose(device, frame) {
    const id = String(frame.id)
    const bridge = bridges.get(id)
    if (!bridge) return
    bridges.delete(id)
    try {
      if (bridge.peer.readyState === WebSocket.OPEN) bridge.peer.close(Number(frame.code) || 1000)
    } catch {
      /* ignore */
    }
  }

  /**
   * The host aborted one in-flight request.
   *
   * @param {any} device
   * @param {Record<string, any>} frame
   */
  function handleHostAbort(device, frame) {
    const pending = inflight.get(String(frame.id))
    if (!pending) return
    pending.reject(new Error('host aborted the request'))
  }

  /* ---------------------------------------------- host driven (compat path) */

  /**
   * Execute a request frame that the host pushed to the relay.
   *
   * @param {any} device
   * @param {Record<string, any>} frame
   */
  async function executeHostRequest(device, frame) {
    const id = String(frame.id)
    const method = typeof frame.method === 'string' ? frame.method.toUpperCase() : 'GET'
    const path = typeof frame.path === 'string' ? frame.path : '/'
    const headers = sanitizeRequestHeaders(frame.headers || {})
    const body = decodeBody(frame.body, frame.body_encoding)
    try {
      const target = joinBaseUrl(device.localBaseUrl || '', path)
      const result = await performHttpRequest(target, method, headers, body)
      sendToHost(
        device,
        responseFrame({
          id,
          status: result.status,
          headers: result.headers,
          body: result.body.length ? result.body.toString('base64') : null,
        }),
      )
    } catch (error) {
      logInfo('relay: host driven request failed', {
        deviceId: device.deviceId,
        error: String(error),
      })
      sendToHost(device, responseFrame({ id, status: 502, headers: {}, body: null }))
    }
  }

  /**
   * Open a WebSocket to the device's local base URL for a host driven upgrade.
   *
   * @param {any} device
   * @param {Record<string, any>} frame
   */
  function executeHostUpgrade(device, frame) {
    const id = String(frame.id)
    const path = typeof frame.path === 'string' ? frame.path : '/'
    let target
    try {
      target = toWebSocketUrl(device.localBaseUrl || 'http://127.0.0.1', path)
    } catch (error) {
      logInfo('relay: host driven upgrade failed', {
        deviceId: device.deviceId,
        error: String(error),
      })
      return
    }

    const headers = sanitizeRequestHeaders(frame.headers || {})
    stripWebSocketHandshakeHeaders(headers)

    let client
    try {
      client = new WebSocket(target.href, { headers })
    } catch (error) {
      logInfo('relay: host driven upgrade failed', {
        deviceId: device.deviceId,
        error: String(error),
      })
      return
    }
    client.on('open', () => {
      sendToHost(device, upgradedFrame(id))
      attachBridge(device, id, client)
    })
    client.on('error', (error) => {
      logInfo('relay: local websocket error', { deviceId: device.deviceId, error: String(error) })
    })
  }

  /**
   * Build a `ws:`/`wss:` URL from a base URL and a path.
   *
   * @param {string} localBaseUrl
   * @param {string} path
   * @returns {URL}
   */
  function toWebSocketUrl(localBaseUrl, path) {
    const base = new URL(localBaseUrl)
    const basePath = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname
    const suffix = path.startsWith('/') ? path : `/${path}`
    const url = new URL(`${base.origin}${basePath}${suffix}`)
    if (url.protocol === 'https:') url.protocol = 'wss:'
    else if (url.protocol === 'http:') url.protocol = 'ws:'
    return url
  }

  /**
   * Remove handshake specific headers before dialling a WebSocket.
   *
   * @param {Record<string, string>} headers
   */
  function stripWebSocketHandshakeHeaders(headers) {
    delete headers['sec-websocket-key']
    delete headers['sec-websocket-version']
    delete headers['sec-websocket-extensions']
    delete headers['sec-websocket-protocol']
    delete headers['upgrade']
    delete headers['connection']
  }

  /* ------------------------------------------------------- phone ws bridge */

  /**
   * Bridge a phone WebSocket (e.g. `/api/remote.mux`) to the host.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} head
   * @param {URL} url
   */
  function openPhoneBridge(req, socket, head, url) {
    const target = resolveTarget(url.pathname)
    if (!target) {
      rejectUpgrade(socket, 503, 'no online device')
      return
    }
    const { device, path } = target

    if (device.status === 'offline' || device.revoked) {
      rejectUpgrade(socket, 403, 'device is offline')
      return
    }
    if (device.mode === 'push') {
      openLocalBridge(device, req, socket, head, path)
      return
    }
    const tunnelOpen = device.tunnelSocket && device.tunnelSocket.readyState === WebSocket.OPEN
    if (!tunnelOpen) {
      rejectUpgrade(socket, 503, 'device has no live tunnel')
      return
    }

    const id = randomUUID()
    const headers = sanitizeRequestHeaders(req.headers)
    const search = url.search || ''

    const pending = {
      id,
      device,
      timer: setTimeout(() => {
        pendingUpgrades.delete(id)
        rejectUpgrade(socket, 504, 'host did not accept the upgrade')
      }, UPGRADE_TIMEOUT_MS),
      reject: (reason) => {
        pendingUpgrades.delete(id)
        clearTimeout(pending.timer)
        rejectUpgrade(socket, 502, reason && reason.message ? reason.message : 'upgrade refused')
      },
      resolve: (frame) => {
        const protocol = typeof frame.protocol === 'string' ? frame.protocol : ''
        if (protocol) {
          const offered = String(req.headers['sec-websocket-protocol'] || '')
            .split(',')
            .map((value) => value.trim())
          if (offered.includes(protocol)) req.__relaySubprotocol = protocol
        }
        if (!wss) {
          rejectUpgrade(socket, 503, 'relay is not running')
          return
        }
        try {
          wss.handleUpgrade(req, socket, head, (client) => {
            attachBridge(device, id, client)
          })
        } catch (error) {
          logInfo('relay: phone websocket handshake failed', { error: String(error) })
          try {
            socket.destroy()
          } catch {
            /* ignore */
          }
        }
      },
    }

    pendingUpgrades.set(id, pending)
    sendToHost(device, upgradeFrame({ id, path: `${path}${search}`, headers }))
  }

  /**
   * Bridge a phone WebSocket directly to the device's local base URL.
   *
   * @param {any} device
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} head
   * @param {string} path
   */
  function openLocalBridge(device, req, socket, head, path) {
    let target
    try {
      target = toWebSocketUrl(device.localBaseUrl || 'http://127.0.0.1', path)
    } catch {
      rejectUpgrade(socket, 502, 'invalid local_base_url')
      return
    }

    const headers = sanitizeRequestHeaders(req.headers)
    stripWebSocketHandshakeHeaders(headers)

    let client
    try {
      client = new WebSocket(target.href, { headers })
    } catch {
      rejectUpgrade(socket, 502, 'cannot reach local_base_url')
      return
    }

    let handshaken = false
    client.on('open', () => {
      handshaken = true
      if (!wss) {
        rejectUpgrade(socket, 503, 'relay is not running')
        return
      }
      try {
        wss.handleUpgrade(req, socket, head, (phone) => {
          phone.on('message', (data) => {
            const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
            try {
              if (isUtf8(payload)) client.send(payload.toString('utf8'))
              else client.send(payload)
            } catch {
              /* ignore */
            }
          })
          client.on('message', (data) => {
            const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
            try {
              if (phone.readyState !== WebSocket.OPEN) return
              if (isUtf8(payload)) phone.send(payload.toString('utf8'))
              else phone.send(payload)
            } catch {
              /* ignore */
            }
          })
          phone.on('close', (code) => {
            try {
              client.close(code || 1000)
            } catch {
              /* ignore */
            }
          })
          client.on('close', (code) => {
            try {
              if (phone.readyState === WebSocket.OPEN) phone.close(code || 1000)
            } catch {
              /* ignore */
            }
          })
        })
      } catch (error) {
        logInfo('relay: local websocket handshake failed', { error: String(error) })
        try {
          socket.destroy()
        } catch {
          /* ignore */
        }
      }
    })
    client.on('error', (error) => {
      if (!handshaken) rejectUpgrade(socket, 502, 'cannot reach local_base_url')
      else logInfo('relay: local websocket error', { error: String(error) })
    })
  }

  /**
   * Attach one WebSocket peer to a bridge and pump its payloads to the host.
   *
   * @param {any} device
   * @param {string} id
   * @param {WebSocket} peer
   */
  /**
   * Deliver a ping from the host to the phone's socket.
   * @param {any} device
   * @param {Record<string, any>} frame
   */
  function handleHostWsPing(device, frame) {
    const bridge = bridges.get(String(frame.id ?? ''))
    if (!bridge || !bridge.peer) return
    try {
      bridge.peer.ping(Buffer.from(String(frame.data ?? ''), 'base64'))
    } catch (error) {
      logInfo('relay: websocket ping failed', { error: String(error) })
    }
  }

  /**
   * Deliver a pong from the host to the phone's socket.
   * @param {any} device
   * @param {Record<string, any>} frame
   */
  function handleHostWsPong(device, frame) {
    const bridge = bridges.get(String(frame.id ?? ''))
    if (!bridge || !bridge.peer) return
    try {
      bridge.peer.pong(Buffer.from(String(frame.data ?? ''), 'base64'))
    } catch (error) {
      logInfo('relay: websocket pong failed', { error: String(error) })
    }
  }

  function attachBridge(device, id, peer) {
    const bridge = { id, device, peer }
    bridges.set(id, bridge)

    peer.on('message', (data, isBinary) => {
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
      sendToHost(device, wsFrame({ id, data: payload.toString('base64'), binary: isBinary === true }))
    })
    // Control frames belong to the bridge: the Harness host pings its browser
    // and drops a socket that stays silent, so a ping must reach the phone and
    // the phone's pong must travel back.
    peer.on('ping', (data) => {
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'utf8')
      sendToHost(device, wsPingFrame({ id, data: payload.toString('base64') }))
    })
    peer.on('pong', (data) => {
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'utf8')
      sendToHost(device, wsPongFrame({ id, data: payload.toString('base64') }))
    })
    peer.on('close', (code) => {
      if (bridges.get(id) === bridge) {
        bridges.delete(id)
        sendToHost(device, wsCloseFrame({ id, code: code || 1000 }))
      }
    })
    peer.on('error', (error) => {
      logInfo('relay: websocket peer error', { deviceId: device.deviceId, error: String(error) })
    })
  }

  /* ----------------------------------------------------------- public API */

  /**
   * Start listening.
   *
   * When `options.server` is given the relay uses that server (for example a
   * TLS server) instead of creating a plain one.
   *
   * @param {{host?: string, port?: number, server?: http.Server | https.Server}} [options]
   * @returns {Promise<{host: string, port: number}>}
   */
  function listen(options = {}) {
    if (server) return Promise.reject(new Error('relay: already listening'))
    if (closing) return Promise.reject(new Error('relay: closed'))
    const host = typeof options.host === 'string' && options.host ? options.host : '0.0.0.0'
    const port = Number.isFinite(options.port) ? Number(options.port) : 0

    const requestListener = (req, res) => {
      handleRequest(req, res).catch((error) => {
        logInfo('relay: request failed', { error: String(error) })
        if (!res.headersSent) sendPlain(res, 500, 'internal error')
        else res.end()
      })
    }
    const upgradeListener = (req, socket, head) => {
      try {
        handleUpgrade(req, socket, head)
      } catch (error) {
        logInfo('relay: upgrade failed', { error: String(error) })
        try {
          socket.destroy()
        } catch {
          /* ignore */
        }
      }
    }
    const clientErrorListener = (error, socket) => {
      logInfo('relay: client error', { error: String(error) })
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    }

    const provided = options.server
    /** @type {http.Server | https.Server} */
    const httpServer = isServerLike(provided)
      ? /** @type {http.Server} */ (provided)
      : http.createServer(requestListener)

    if (isServerLike(provided)) {
      httpServer.on('request', requestListener)
    }
    httpServer.on('upgrade', upgradeListener)
    httpServer.on('clientError', clientErrorListener)

    const websocketServer = new WebSocketServer({
      noServer: true,
      handleProtocols(protocols, request) {
        const requested = request && request.__relaySubprotocol
        if (requested && protocols.has(requested)) return requested
        if (protocols.has(bearerProtocol)) return bearerProtocol
        // Strict clients reject a handshake that drops the subprotocol they
        // asked for, so echo the first offered one.
        for (const protocol of protocols) return protocol
        return false
      },
    })
    websocketServer.on('error', (error) => {
      logInfo('relay: websocket server error', { error: String(error) })
    })

    server = httpServer
    wss = websocketServer

    return new Promise((resolve, reject) => {
      const onError = (error) => {
        httpServer.off('listening', onListening)
        server = null
        wss = null
        reject(error)
      }
      const onListening = () => {
        httpServer.off('error', onError)
        const info = httpServer.address()
        const actualPort = info && typeof info === 'object' ? info.port : port
        logInfo('relay: listening', { host, port: actualPort })
        resolve({ host, port: actualPort })
      }
      httpServer.once('error', onError)
      httpServer.once('listening', onListening)
      if (httpServer.listening) {
        httpServer.off('error', onError)
        httpServer.off('listening', onListening)
        onListening()
        return
      }
      httpServer.listen(port, host)
    })
  }

  /**
   * The address the relay listens on.
   *
   * @returns {{host: string | null, port: number, url: string | null}}
   */
  function address() {
    if (!server) return { host: null, port: 0, url: null }
    const info = server.address()
    if (!info || typeof info !== 'object') return { host: null, port: 0, url: null }
    const host = info.address
    const wildcard = host === '0.0.0.0' || host === '::' || host === ''
    const urlHost = wildcard ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host
    return { host, port: info.port, url: `http://${urlHost}:${info.port}` }
  }

  /**
   * All known devices.
   *
   * @returns {DeviceRecord[]}
   */
  function devices_() {
    return [...devices.values()].map(toDeviceRecord)
  }

  /**
   * Stop the relay and release every socket.
   *
   * @returns {Promise<void>}
   */
  function close() {
    if (closePromise) return closePromise
    closing = true
    // Flush a pending write: the phone list must not be lost because the relay
    // was stopped inside the debounce window.
    if (persistTimer !== undefined) {
      clearTimeout(persistTimer)
      persistTimer = undefined
      persistState()
    }
    closePromise = (async () => {
      for (const pending of inflight.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('relay is closing'))
      }
      inflight.clear()

      for (const pending of pendingUpgrades.values()) {
        clearTimeout(pending.timer)
      }
      pendingUpgrades.clear()

      for (const bridge of bridges.values()) {
        try {
          if (bridge.peer && bridge.peer.readyState === WebSocket.OPEN) {
            bridge.peer.close(1001, 'relay closing')
          }
        } catch {
          /* ignore */
        }
      }
      bridges.clear()

      for (const device of devices.values()) {
        closeSocket(device.managementSocket, 1001)
        closeSocket(device.tunnelSocket, 1001)
        device.managementSocket = null
        device.tunnelSocket = null
        refreshStatus(device)
      }

      if (wss) {
        // Let the peers finish the closing handshake before forcing the
        // remaining sockets down.
        await new Promise((resolve) => setTimeout(resolve, 50))
        for (const client of wss.clients) {
          try {
            client.terminate()
          } catch {
            /* ignore */
          }
        }
        try {
          wss.close()
        } catch {
          /* ignore */
        }
      }

      if (server) {
        const httpServer = server
        server = null
        wss = null
        try {
          httpServer.closeAllConnections?.()
        } catch {
          /* ignore */
        }
        await new Promise((resolve) => {
          let settled = false
          const done = () => {
            if (settled) return
            settled = true
            resolve()
          }
          const timer = setTimeout(done, 2000)
          try {
            httpServer.close(() => {
              clearTimeout(timer)
              done()
            })
          } catch {
            clearTimeout(timer)
            done()
          }
        })
      }
      logInfo('relay: closed')
    })()
    return closePromise
  }

  // The phone list has to survive a relay restart, so it is read from disk
  // before the first device registers.
  loadPersistedState()

  return { listen, address, setPublicBaseUrl, close, devices: devices_ }
}
