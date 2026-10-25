/**
 * Wire contract between a DSH host and a remote-control relay.
 *
 * The shape follows Kimi Code's public remote-control protocol (public npm
 * package `@moonshot-ai/remote-control`): the host dials OUT to the relay over
 * two WebSockets, the relay replays the phone's HTTP traffic back through the
 * tunnel, and the QR code carries a plain access URL.
 *
 * Two channels, both opened by the host:
 *
 *   GET /v1/remote/create                                  management
 *   GET /v1/remote/http?device_id=<id>&capabilities=...     tunnel
 *
 * Every frame is one JSON text message. Binary bodies travel base64-encoded
 * inside the frame so a relay can be a dumb pipe.
 */

export const PROTOCOL_VERSION = 1

/** Management channel path (host -> relay). */
export const MANAGEMENT_PATH = '/v1/remote/create'

/** Tunnel channel path (host -> relay). */
export const TUNNEL_PATH = '/v1/remote/http'

/** Capabilities the host advertises on the tunnel channel. */
export const CAPABILITIES = ['request_chunk', 'response_chunk', 'abort']

/** WS subprotocol carrying the relay credential, Kimi-style: `kimi-code.bearer.<token>`. */
export function bearerSubprotocol(token) {
  return `kimi-code.bearer.${token}`
}

/** The `Authorization` header value for the relay credential. */
export function bearerHeader(token) {
  return `Bearer ${token}`
}

/* ------------------------------------------------------------------ frames */

/** @param {Record<string, unknown>} frame */
export function encodeFrame(frame) {
  return JSON.stringify(frame)
}

/**
 * Decode one relay frame.
 * @param {string} text
 * @returns {Record<string, unknown>}
 * @throws {TypeError} when the text is not a JSON object.
 */
export function decodeFrame(text) {
  const value = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('relay: frame must be a JSON object')
  }
  if (typeof value.type !== 'string') throw new TypeError('relay: frame needs a type')
  return value
}

/**
 * The host announces itself on the management channel.
 * @param {{deviceId: string, alias: string, platform: string, clientVersion: string, localBaseUrl: string, accessKey?: string, passcode?: string}} input
 */
export function registerFrame(input) {
  return {
    type: 'register',
    device_id: input.deviceId,
    alias: input.alias,
    platform: input.platform,
    client_version: input.clientVersion,
    local_base_url: input.localBaseUrl,
    access_key: input.accessKey ?? '',
    passcode: input.passcode ?? '',
    capabilities: [...CAPABILITIES],
  }
}

/**
 * The relay accepted the device and publishes the access URL the QR encodes.
 * @param {{deviceId: string, publicUrl: string}} input
 */
export function registerAckFrame(input) {
  return { type: 'register_ack', device_id: input.deviceId, public_url: input.publicUrl }
}

/**
 * The relay refused the device.
 * @param {string} reason
 */
export function registerNakFrame(reason) {
  return { type: 'register_nak', reason }
}

/**
 * The relay withdrew the device (revoked, quota exceeded, admin action).
 * @param {string} reason
 */
export function revokeFrame(reason) {
  return { type: 'revoke', reason }
}

/* ----------------------------------------------------------- tunnel frames */

/**
 * A phone HTTP request travelling relay -> host.
 * @param {{id: string, method: string, path: string, headers: Record<string, string>, body: string | null}} input
 */
export function requestFrame(input) {
  return {
    type: 'request',
    id: input.id,
    method: input.method,
    path: input.path,
    headers: input.headers ?? {},
    body: input.body ?? null,
  }
}

/**
 * A phone WebSocket upgrade travelling relay -> host.
 * @param {{id: string, path: string, headers: Record<string, string>}} input
 */
export function upgradeFrame(input) {
  return { type: 'upgrade', id: input.id, path: input.path, headers: input.headers ?? {} }
}

/**
 * The host's HTTP response travelling host -> relay.
 * @param {{id: string, status: number, headers: Record<string, string>, body: string | null}} input
 */
export function responseFrame(input) {
  return {
    type: 'response',
    id: input.id,
    status: input.status,
    headers: input.headers ?? {},
    body: input.body ?? null,
  }
}

/**
 * The host accepted a WebSocket upgrade.
 * @param {string} id
 */
export function upgradedFrame(id) {
  return { type: 'upgraded', id }
}

/**
 * One WebSocket payload frame travelling in either direction.
 * @param {{id: string, data: string}} input base64 payload
 */
export function wsFrame(input) {
  // The frame kind travels with the payload: a text frame must stay text on
  // the other side, or the peer protocol on it breaks.
  return { type: 'ws_frame', id: input.id, data: input.data, binary: input.binary === true }
}

/**
 * A WebSocket ping travelling in either direction.
 *
 * Control frames must be bridged: the Harness host pings its browser every two
 * seconds and drops a socket that shows no activity, and a ping that never
 * reaches the browser (or its pong that never comes back) ends the stream.
 *
 * @param {{id: string, data?: string}} input base64 payload
 */
export function wsPingFrame(input) {
  return { type: 'ws_ping', id: input.id, data: input.data ?? '' }
}

/**
 * A WebSocket pong travelling in either direction.
 * @param {{id: string, data?: string}} input base64 payload
 */
export function wsPongFrame(input) {
  return { type: 'ws_pong', id: input.id, data: input.data ?? '' }
}

/**
 * One WebSocket closed.
 * @param {{id: string, code?: number}} input
 */
export function wsCloseFrame(input) {
  return { type: 'ws_close', id: input.id, code: input.code ?? 1000 }
}

/**
 * A chunk of a request body, when the host asked for chunked bodies.
 * @param {{id: string, chunk: string, last: boolean}} input base64 payload
 */
export function requestChunkFrame(input) {
  return { type: 'request_chunk', id: input.id, chunk: input.chunk, last: input.last === true }
}

/**
 * A chunk of a response body.
 * @param {{id: string, chunk: string, last: boolean}} input base64 payload
 */
export function responseChunkFrame(input) {
  return { type: 'response_chunk', id: input.id, chunk: input.chunk, last: input.last === true }
}

/**
 * The relay aborted one in-flight request.
 * @param {string} id
 */
export function abortFrame(id) {
  return { type: 'abort', id }
}

/* ------------------------------------------------------------- URL helpers */

/**
 * The tunnel channel URL for one device.
 * @param {string} baseUrl relay origin, e.g. `https://code-rc.example`
 * @param {string} deviceId
 */
export function tunnelUrl(baseUrl, deviceId) {
  const url = new URL(TUNNEL_PATH, baseUrl)
  url.searchParams.set('device_id', deviceId)
  url.searchParams.set('capabilities', CAPABILITIES.join(','))
  return url.href
}

/**
 * The management channel URL for one relay.
 * @param {string} baseUrl
 */
export function managementUrl(baseUrl) {
  return new URL(MANAGEMENT_PATH, baseUrl).href
}
