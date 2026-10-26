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

/* ------------------------------------------------------- compressed payloads */

/**
 * The marker that opens a compressed WebSocket payload.
 *
 * A session snapshot is megabytes of JSON, and a remote relay is exactly
 * where the bytes are scarce: the same payload travels twice (host -> relay
 * -> phone) and every byte is paid for twice. The host therefore compresses
 * the payload and marks it, so the phone knows to inflate it before the peer
 * protocol on it sees the bytes.
 *
 * The marker travels as the first bytes of a *binary* WebSocket message, so
 * the relay forwards it without knowing anything about compression.
 */
export const COMPRESSED_WS_PREFIX = 'DSHRC1'

/**
 * The query parameter a phone adds to its stream URL to announce that it can
 * inflate a compressed payload.
 *
 * The host only compresses when the phone asked for it, so an older phone
 * keeps working against a newer host.
 */
export const COMPRESSION_QUERY = 'rcz'

/**
 * Does this payload carry the compressed marker?
 *
 * @param {Buffer | Uint8Array} payload the raw WebSocket payload
 * @returns {boolean}
 */
export function isCompressedWsPayload(payload) {
  const bytes = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(payload.buffer ?? payload, payload.byteOffset ?? 0, payload.byteLength)
  if (bytes.length < COMPRESSED_WS_PREFIX.length) return false
  return bytes.subarray(0, COMPRESSED_WS_PREFIX.length).toString('latin1') === COMPRESSED_WS_PREFIX
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
  //
  // The encoding travels with it as well. A relay that has to guess reads a
  // payload as base64 only when the decoded bytes are valid UTF-8 again —
  // which a compressed payload is not, and it would then deliver the base64
  // text itself.
  return {
    type: 'ws_frame',
    id: input.id,
    data: input.data,
    binary: input.binary === true,
    body_encoding: 'base64',
  }
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
 *
 * The encoding travels with the chunk: a relay that has to guess reads the
 * bytes as base64 only when they are valid UTF-8 again, and a chunk of a
 * binary body is not.
 *
 * @param {{id: string, chunk: string, last: boolean}} input base64 payload
 */
export function responseChunkFrame(input) {
  return {
    type: 'response_chunk',
    id: input.id,
    chunk: input.chunk,
    last: input.last === true,
    body_encoding: 'base64',
  }
}

/**
 * The response head of a body that arrives in chunks.
 *
 * A response that never ends (an event stream) cannot be waited for: the
 * relay would time it out and the phone would get a 504 instead of the
 * events. The head says so, and the chunks follow.
 *
 * @param {{id: string, status: number, headers: Record<string, string>}} input
 */
export function chunkedResponseFrame(input) {
  return {
    type: 'response',
    id: input.id,
    status: input.status,
    headers: input.headers ?? {},
    chunked: true,
    body: null,
    body_encoding: null,
  }
}

/**
 * The relay aborted one in-flight request.
 * @param {string} id
 */
export function abortFrame(id) {
  return { type: 'abort', id }
}

/* ------------------------------------------------- binary websocket payloads */

/**
 * The capability a relay advertises when it accepts a WebSocket payload as
 * one binary tunnel message.
 *
 * A payload that travels as a JSON frame pays for the base64 inflation, and
 * the biggest one - a session snapshot - is megabytes. A relay that takes
 * the bytes as they are saves a third of the bytes on the way out.
 */
export const CAPABILITY_WS_BINARY_BODY = 'ws_binary_body'

/** The kind byte that marks one binary tunnel message as a WebSocket payload. */
const BINARY_KIND_WS_PAYLOAD = 1

/**
 * Encode one WebSocket payload as one binary tunnel message.
 *
 * The message names the bridge it belongs to and says whether the payload
 * was text or binary, so the relay can hand the phone the same kind of
 * message the local socket delivered.
 *
 * @param {string} id the bridge this payload belongs to
 * @param {Buffer} payload the raw payload
 * @param {boolean} binary whether the local socket delivered it as binary
 * @returns {Buffer}
 */
export function encodeBinaryWsPayload(id, payload, binary) {
  const idBytes = Buffer.from(id, 'utf8')
  const header = Buffer.alloc(6)
  header.writeUInt8(BINARY_KIND_WS_PAYLOAD, 0)
  header.writeUInt8(binary === true ? 1 : 0, 1)
  header.writeUInt32BE(idBytes.length, 2)
  return Buffer.concat([header, idBytes, payload])
}

/**
 * Read one WebSocket payload out of a binary tunnel message.
 *
 * @param {unknown} message the raw WebSocket message
 * @returns {{ id: string, payload: Buffer, binary: boolean } | undefined}
 */
export function decodeBinaryWsPayload(message) {
  const buffer = Buffer.isBuffer(message)
    ? message
    : message instanceof ArrayBuffer
      ? Buffer.from(message)
      : ArrayBuffer.isView(message)
        ? Buffer.from(message.buffer, message.byteOffset, message.byteLength)
        : undefined
  if (buffer === undefined || buffer.length < 6) return undefined
  if (buffer.readUInt8(0) !== BINARY_KIND_WS_PAYLOAD) return undefined
  const length = buffer.readUInt32BE(2)
  if (buffer.length < 6 + length) return undefined
  const id = buffer.subarray(6, 6 + length).toString('utf8')
  return { id, payload: buffer.subarray(6 + length), binary: buffer.readUInt8(1) === 1 }
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
