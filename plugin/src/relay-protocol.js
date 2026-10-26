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
 * inside the frame so a relay can be a dumb pipe. A relay that advertises the
 * `binary_body` capability also accepts a body as one binary WebSocket
 * message, which is the only way to send a large body without paying for the
 * base64 inflation on a link that is the bottleneck.
 */

export const PROTOCOL_VERSION = 1

/** Management channel path (host -> relay). */
export const MANAGEMENT_PATH = '/v1/remote/create'

/** Tunnel channel path (host -> relay). */
export const TUNNEL_PATH = '/v1/remote/http'

/** Capabilities the host advertises on the tunnel channel. */
export const CAPABILITIES = ['request_chunk', 'response_chunk', 'abort']

/**
 * The capability a relay advertises when it accepts a body as one binary
 * WebSocket message.
 *
 * The host only uses it when the relay says so, so an older relay keeps
 * working with a newer host.
 */
export const CAPABILITY_BINARY_BODY = 'binary_body'

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
  return {
    type: 'register_ack',
    device_id: input.deviceId,
    public_url: input.publicUrl,
    capabilities: input.capabilities ?? [],
  }
}

/**
 * The relay refused the device.
 * @param {string} reason
 */
export function registerNakFrame(reason) {
  return { type: 'register_nak', reason }
}

/**
 * Encode a response body as one binary WebSocket message.
 *
 * The body of a big response is the one thing that does not fit into a JSON
 * frame without paying for it: base64 costs a third more bytes, and the
 * tunnel of a remote relay is exactly where the bytes are scarce. The message
 * carries the id of the request it answers, so the relay needs no ordering
 * assumption between the text frame and the binary one.
 *
 * @param {string} id the request the body answers
 * @param {Buffer} body the raw body bytes
 * @returns {Buffer}
 */
export function encodeBinaryBody(id, body) {
  const idBytes = Buffer.from(id, 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(idBytes.length, 0)
  return Buffer.concat([header, idBytes, body])
}

/**
 * Read the request id and the body out of a binary body message.
 *
 * @param {unknown} message the raw WebSocket message
 * @returns {{ id: string, body: Buffer } | undefined}
 */
export function decodeBinaryBody(message) {
  const buffer = Buffer.isBuffer(message)
    ? message
    : message instanceof ArrayBuffer
      ? Buffer.from(message)
      : ArrayBuffer.isView(message)
        ? Buffer.from(message.buffer, message.byteOffset, message.byteLength)
        : undefined
  if (buffer === undefined || buffer.length < 4) return undefined
  const length = buffer.readUInt32BE(0)
  if (buffer.length < 4 + length) return undefined
  const id = buffer.subarray(4, 4 + length).toString('utf8')
  return { id, body: buffer.subarray(4 + length) }
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
 *
 * The body is base64 and says so: a relay that has to guess would mistake a
 * binary body for text.
 *
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
    body_encoding: input.body === null || input.body === undefined ? null : 'base64',
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
 *
 * The body is base64 and says so. A relay that has to guess reads a body as
 * base64 only when the decoded bytes are valid UTF-8 — which a compressed
 * body is not, and it would then deliver the base64 text itself.
 *
 * @param {{id: string, status: number, headers: Record<string, string>, body: string | null}} input
 */
export function responseFrame(input) {
  return {
    type: 'response',
    id: input.id,
    status: input.status,
    headers: input.headers ?? {},
    body: input.body ?? null,
    body_encoding:
      input.body_encoding ?? (input.body === null || input.body === undefined ? null : 'base64'),
    ...(input.body_length === undefined ? {} : { body_length: input.body_length }),
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
