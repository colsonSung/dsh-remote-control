/**
 * Host half of `@local/remote-control`.
 *
 * The plugin mirrors Kimi Code's remote control: the host dials OUT to a relay
 * over two WebSockets, the relay replays a remote phone's HTTP traffic back
 * through that tunnel, and the QR code carries the plain access URL. The phone
 * therefore loads the real DeepSeek Harness web app — nothing phone-specific is
 * shipped here.
 *
 * Two relay modes:
 *
 *   bundled  the plugin starts a relay inside this process and listens on the
 *            local network, so a phone on the same Wi-Fi can reach it. This is
 *            the default and needs no account.
 *   external a relay deployed elsewhere (our standalone `relay/standalone.js`,
 *            or any server speaking the same protocol) is addressed by URL.
 *
 * The relay never holds a host credential: the launch token that lets the phone
 * obtain a session cookie is injected by this process, on the way out.
 */

import { watch } from 'node:fs'
import { createServer } from 'node:http'
import { basename, dirname } from 'node:path'
import { networkInterfaces } from 'node:os'
import QRCode from 'qrcode'

import { createRelayClient } from './src/relay-client.js'
import { createRelayServer } from './src/relay-server.js'
import {
  ensureAccessKey,
  ensureIdentity,
  ensurePasscode,
  readState,
  rememberPublicAddress,
  rememberRelayUrl,
  rememberEnabled,
  rotateSecret,
  secretFingerprint,
  statePath,
  wasEnabled,
} from './src/device-store.js'

/** Cordis plugin name. */
export const name = 'remote-control'

/** The exact Fetch route the Settings page talks to. */
export const ROUTE = '/api/remote-control'

/** The version this plugin reports to a relay. */
export const CLIENT_VERSION = '1.1.0'

/** The product name a relay shows for this client. */
export const CLIENT_NAME = 'dsh-desktop'

/** The ports the bundled relay tries, in order. */
const RELAY_PORT_RANGE = [56131, 56151]

/**
 * Every non-internal IPv4 address of this machine.
 *
 * A relay bound to every interface is only reachable from a phone when the
 * link carries a routable address, so the advertised URL prefers one.
 * @returns {string[]}
 */
export function lanAddresses() {
  const found = []
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal && !found.includes(address.address)) {
        found.push(address.address)
      }
    }
  }
  return found
}

/**
 * Reserve a free TCP port by binding and releasing it.
 * @param {number} port
 * @returns {Promise<number | undefined>}
 */
async function freePort(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(undefined))
    probe.listen(port, '0.0.0.0', () => {
      const { port: bound } = probe.address()
      probe.close(() => resolve(bound))
    })
  })
}

/**
 * The first non-internal IPv4 address of this machine.
 *
 * A relay bound to every interface is only reachable from a phone when the
 * link carries a routable address, so the advertised URL prefers one.
 * @returns {string | undefined}
 */
export function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return undefined
}

/**
 * Call the relay's management API.
 * @param {string} baseUrl
 * @param {string} token
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<unknown>}
 */
async function relayAdmin(baseUrl, token, path, init = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  const body = text.length > 0 ? JSON.parse(text) : undefined
  if (!response.ok) {
    const reason = body?.error ?? body?.reason ?? `HTTP ${response.status}`
    throw new Error(`relay: ${path} failed: ${reason}`)
  }
  return body
}

/**
 * Register the plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
  const identity = ensureIdentity()
  const accessKey = ensureAccessKey()
  const passcode = ensurePasscode()
  const log = (message, extra) => ctx.logger.info(`remote-control: ${message}`, extra ?? {})

  /** @type {{ enabled: boolean, relay: any, client: any, publicUrl: string | undefined, error: string | undefined }} */
  const state = {
    enabled: false,
    relay: undefined,
    client: undefined,
    publicUrl: undefined,
    error: undefined,
  }

  const stored = readState() ?? {}
  /** The operator-configured relay; empty means "use the bundled relay". */
  let externalRelayUrl = typeof stored.relayUrl === 'string' ? stored.relayUrl : ''
  /** The origin a phone opens; empty means "the machine's LAN address". */
  let publicAddress = typeof stored.publicAddress === 'string' ? stored.publicAddress : ''
  /** The base URL the bundled relay advertises to phones. */
  let bundledBaseUrl = ''

  /**
   * The local server the phone's traffic is replayed against.
   * @returns {string | undefined}
   */
  function localBaseUrl() {
    const webServer = ctx.get('webServer')
    if (webServer === undefined) return undefined
    try {
      return webServer.getOrigin()
    } catch {
      return undefined
    }
  }

  /**
   * The process launch token the phone exchanges for a session cookie.
   * @param {string} baseUrl
   * @returns {string | undefined}
   */
  function launchToken(baseUrl) {
    const connection = ctx.get('connection')
    if (connection === undefined) return undefined
    const url = new URL(connection.authenticatedUrl(baseUrl))
    return url.searchParams.get('token') ?? undefined
  }

  /**
   * Re-read the operator's settings from disk.
   *
   * The settings page and this file are two ways to say the same thing; the
   * file wins, so a script can change the public address and the running
   * tunnel follows without a restart.
   *
   * @returns {boolean} true when a setting changed
   */
  function refreshSettings() {
    const stored = readState() ?? {}
    const address = typeof stored.publicAddress === 'string' ? stored.publicAddress : ''
    const relay = typeof stored.relayUrl === 'string' ? stored.relayUrl : ''
    if (address === publicAddress && relay === externalRelayUrl) return false
    publicAddress = address
    externalRelayUrl = relay
    return true
  }

  /**
   * The devices a relay knows about, with this computer marked.
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  /**
   * The relay's own origin, whether it is the bundled one or a deployed relay.
   *
   * @returns {string | undefined}
   */
  function relayBaseUrl() {
    if (externalRelayUrl.length > 0) return externalRelayUrl
    return state.relay === undefined ? undefined : bundledBaseUrl
  }

  async function listDevices() {
    const base = relayBaseUrl()
    if (base === undefined) return []
    try {
      const devices = await relayAdmin(base, identity.secret, '/v1/remote/devices')
      return Array.isArray(devices) ? devices : []
    } catch (error) {
      log(`device list failed: ${String(error)}`)
      return []
    }
  }

  /**
   * The phones that reached this computer, with their trust flag.
   *
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async function listPhones() {
    const base = relayBaseUrl()
    if (base === undefined) return []
    try {
      const phones = await relayAdmin(
        base,
        identity.secret,
        `/v1/remote/devices/${encodeURIComponent(identity.deviceId)}/phones`,
      )
      return Array.isArray(phones) ? phones : []
    } catch (error) {
      log(`phone list failed: ${String(error)}`)
      return []
    }
  }

  /**
   * Stop the tunnel and the bundled relay.
   */
  async function stop() {
    if (state.client !== undefined) {
      await state.client.stop().catch(() => {})
      state.client = undefined
    }
    if (state.relay !== undefined) {
      await state.relay.close().catch(() => {})
      state.relay = undefined
    }
    bundledBaseUrl = ''
    state.publicUrl = undefined
    state.enabled = false
  }

  /**
   * Stop the tunnel and start it again, so a changed address takes effect.
   * @returns {Promise<void>}
   */
  async function restart() {
    await stop()
    await start()
  }

  /**
   * Start the relay and the tunnel.
   * @returns {Promise<void>}
   */
  async function start() {
    const base = localBaseUrl()
    if (base === undefined) throw new Error('remote-control: this host serves no web interface yet')
    const token = launchToken(base)
    if (token === undefined) throw new Error('remote-control: this host issues no browser session token')

    let relayUrl = externalRelayUrl
    if (relayUrl.length === 0) {
      const address = lanAddress() ?? '127.0.0.1'
      let relay
      let addressInfo
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const port = await freePort(RELAY_PORT_RANGE[0] + attempt)
        if (port === undefined) continue
        const candidate = createRelayServer({
          token: identity.secret,
          publicBaseUrl: publicAddress.length > 0 ? publicAddress : `http://${address}:${port}`,
          log: (message) => log(message),
        })
        try {
          addressInfo = await candidate.listen({ host: '0.0.0.0', port })
        } catch {
          await candidate.close().catch(() => {})
          continue
        }
        relay = candidate
        break
      }
      if (relay === undefined || addressInfo === undefined) {
        throw new Error('remote-control: no free port for the bundled relay')
      }
      bundledBaseUrl = `http://${address}:${addressInfo.port}`
      relayUrl = `ws://127.0.0.1:${addressInfo.port}`
      state.relay = relay
      log(`bundled relay listening on ${bundledBaseUrl}`)
    } else {
      relayUrl = relayUrl.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://')
    }

    const client = createRelayClient({
      relayUrl,
      token: identity.secret,
      deviceId: identity.deviceId,
      alias: identity.alias,
      platform: process.platform,
      clientVersion: CLIENT_VERSION,
      localBaseUrl: base,
      launchToken: token,
      accessKey,
      passcode,
      log: (message) => log(message),
    })
    state.client = client
    client.on('status', (next) => {
      state.publicUrl = next.publicUrl
      state.error = next.error
    })
    await client.start()
    state.publicUrl = client.status().publicUrl
    state.enabled = true
    state.error = undefined
    rememberRelayUrl(externalRelayUrl)
    log(`tunnel established, phone URL ${state.publicUrl ?? 'unknown'}`)
  }

  /**
   * The QR code for the current access URL.
   * @returns {Promise<string | undefined>}
   */
  async function qrCode() {
    if (state.publicUrl === undefined) return undefined
    try {
      return await QRCode.toString(state.publicUrl, {
        type: 'svg',
        margin: 1,
        width: 240,
        errorCorrectionLevel: 'M',
      })
    } catch (error) {
      log(`qr generation failed: ${String(error)}`)
      return undefined
    }
  }

  /**
   * The full status the Settings page renders.
   * @returns {Promise<Record<string, unknown>>}
   */
  async function status() {
    if (refreshSettings() && state.enabled) {
      // The operator changed the public address or the relay: the tunnel has
      // to re-register for the new origin to be published.
      await restart().catch((error) => {
        state.error = String(error)
      })
    }
    const clientStatus = state.client?.status() ?? { state: 'offline' }
    const devices = await listDevices()
    const marked = devices.map((device) => ({
      ...device,
      deviceId: device.deviceId ?? device.device_id ?? device.id,
      alias: device.alias ?? device.name ?? 'device',
      platform: device.platform ?? '',
      clientVersion: device.clientVersion ?? device.client_version ?? '',
      status: device.status ?? 'offline',
      isThisComputer: (device.deviceId ?? device.device_id ?? device.id) === identity.deviceId,
    }))
    if (marked.length === 0) {
      marked.push({
        deviceId: identity.deviceId,
        alias: identity.alias,
        platform: process.platform,
        clientVersion: CLIENT_VERSION,
        status: state.enabled ? 'online' : 'offline',
        isThisComputer: true,
      })
    }
    return {
      enabled: state.enabled,
      state: clientStatus.state ?? 'offline',
      publicUrl: state.publicUrl,
      relayUrl: externalRelayUrl,
      publicAddress,
      bundledRelay: state.relay !== undefined,
      localUrl: localBaseUrl(),
      qrSvg: await qrCode(),
      deviceId: identity.deviceId,
      alias: identity.alias,
      platform: process.platform,
      clientVersion: CLIENT_VERSION,
      fingerprint: secretFingerprint(identity.secret),
      passcode,
      lanAddresses: lanAddresses(),
      devices: marked,
      phones: await listPhones(),
      error: state.error,
    }
  }

  /**
   * One failed RPC result, in the shape the Connection RPC bridge expects.
   * @param {string} message
   * @returns {{ ok: false, error: { code: string, message: string, details: object } }}
   */
  function failure(message) {
    return { ok: false, error: { code: 'remote-control/failed', message, details: {} } }
  }

  /**
   * One RPC endpoint of the Settings page.
   * @param {string} endpoint
   * @param {Record<string, unknown>} payload
   * @returns {Promise<unknown>}
   */
  async function handle(endpoint, payload) {
    switch (endpoint) {
      case 'status':
        return { ok: true, value: await status() }
      case 'setEnabled': {
        const enabled = payload?.enabled === true
        try {
          if (enabled) {
            if (!state.enabled) await start()
          } else {
            await stop()
          }
          // The switch is a user decision: it outlives the process.
          rememberEnabled(enabled)
          return { ok: true, value: await status() }
        } catch (error) {
          state.error = String(error)
          return failure(String(error))
        }
      }
      case 'setPublicAddress': {
        const url = typeof payload?.url === 'string' ? payload.url.trim().replace(/\/+$/, '') : ''
        const wasOn = state.enabled
        publicAddress = url
        rememberPublicAddress(url)
        if (wasOn) await restart().catch((error) => { state.error = String(error) })
        return { ok: true, value: await status() }
      }
      case 'setRelayUrl': {
        const url = typeof payload?.url === 'string' ? payload.url.trim() : ''
        const wasOn = state.enabled
        externalRelayUrl = url
        rememberRelayUrl(url)
        if (wasOn) await restart().catch((error) => { state.error = String(error) })
        return { ok: true, value: await status() }
      }
      case 'renameDevice': {
        const deviceId = typeof payload?.deviceId === 'string' ? payload.deviceId : ''
        const alias = typeof payload?.alias === 'string' ? payload.alias.trim() : ''
        if (deviceId.length === 0 || alias.length === 0) return failure('deviceId and alias are required')
        try {
          await relayAdmin(relayBaseUrl() ?? bundledBaseUrl, identity.secret, `/v1/remote/devices/${encodeURIComponent(deviceId)}/alias`, {
            method: 'POST',
            body: JSON.stringify({ alias }),
          })
          return { ok: true, value: await status() }
        } catch (error) {
          return failure(String(error))
        }
      }
      case 'takeOffline': {
        const deviceId = typeof payload?.deviceId === 'string' ? payload.deviceId : ''
        if (deviceId.length === 0) return failure('deviceId is required')
        try {
          await relayAdmin(relayBaseUrl() ?? bundledBaseUrl, identity.secret, `/v1/remote/devices/${encodeURIComponent(deviceId)}/offline`, {
            method: 'POST',
          })
          return { ok: true, value: await status() }
        } catch (error) {
          return failure(String(error))
        }
      }
      case 'rotateSecret': {
        await stop()
        rotateSecret()
        return { ok: true, value: { rotated: true } }
      }
      case 'setDeviceRevoked': {
        const revoked = payload?.revoked === true
        const base = relayBaseUrl()
        if (base === undefined) return failure('the relay is not running')
        try {
          await relayAdmin(
            base,
            identity.secret,
            `/v1/remote/devices/${encodeURIComponent(identity.deviceId)}/revoke`,
            { method: 'POST', body: JSON.stringify({ revoked }) },
          )
          return { ok: true, value: { devices: await listDevices() } }
        } catch (error) {
          return failure(String(error))
        }
      }
      case 'setPhoneTrust': {
        const phoneId = typeof payload?.phoneId === 'string' ? payload.phoneId : ''
        if (phoneId.length === 0) return failure('phoneId is required')
        const base = relayBaseUrl()
        if (base === undefined) return failure('the relay is not running')
        try {
          await relayAdmin(
            base,
            identity.secret,
            `/v1/remote/devices/${encodeURIComponent(identity.deviceId)}/phones/${encodeURIComponent(phoneId)}/trust`,
            { method: 'POST', body: JSON.stringify({ trusted: payload?.trusted === true }) },
          )
          return { ok: true, value: { phones: await listPhones() } }
        } catch (error) {
          return failure(String(error))
        }
      }
      case 'renamePhone': {
        const phoneId = typeof payload?.phoneId === 'string' ? payload.phoneId : ''
        const alias = typeof payload?.alias === 'string' ? payload.alias.trim() : ''
        if (phoneId.length === 0 || alias.length === 0) return failure('phoneId and alias are required')
        const base = relayBaseUrl()
        if (base === undefined) return failure('the relay is not running')
        try {
          await relayAdmin(
            base,
            identity.secret,
            `/v1/remote/devices/${encodeURIComponent(identity.deviceId)}/phones/${encodeURIComponent(phoneId)}/alias`,
            { method: 'POST', body: JSON.stringify({ alias }) },
          )
          return { ok: true, value: { phones: await listPhones() } }
        } catch (error) {
          return failure(String(error))
        }
      }
      case 'removePhone': {
        const phoneId = typeof payload?.phoneId === 'string' ? payload.phoneId : ''
        if (phoneId.length === 0) return failure('phoneId is required')
        const base = relayBaseUrl()
        if (base === undefined) return failure('the relay is not running')
        try {
          await relayAdmin(
            base,
            identity.secret,
            `/v1/remote/devices/${encodeURIComponent(identity.deviceId)}/phones/${encodeURIComponent(phoneId)}/remove`,
            { method: 'POST' },
          )
          return { ok: true, value: { phones: await listPhones() } }
        } catch (error) {
          return failure(String(error))
        }
      }
      case 'rotatePasscode': {
        await stop()
        ensurePasscode(true)
        return { ok: true, value: await status() }
      }
      case 'rotateAccessKey': {
        await stop()
        ensureAccessKey(true)
        return { ok: true, value: await status() }
      }
      default:
        return failure(`unknown endpoint ${endpoint}`)
    }
  }

  // Bring the tunnel back up when it was switched on before the restart. The
  // web server and the Connection service have to exist first: they carry the
  // local origin and the launch token the relay needs.
  ctx.inject(['webServer', 'connection'], () => {
    if (!wasEnabled()) return
    start().catch((error) => {
      state.error = String(error)
      log(`the tunnel could not be restored: ${String(error)}`)
    })
  })

  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => {
      try {
        return connectionCtx.connection.fetch.register({
          path: ROUTE,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            let body
            try {
              body = await request.json()
            } catch {
              return Response.json(
                { ok: false, error: { code: 'remote-control/bad-request', message: 'body is not JSON', details: {} } },
                { status: 400 },
              )
            }
            const method = typeof body?.method === 'string' ? body.method : ''
            return Response.json(await handle(method, body?.payload ?? {}))
          },
        })
      } catch (error) {
        // A reload can apply this plugin twice; the route already exists then.
        log(`route registration failed: ${String(error)}`)
        return () => {}
      }
    }, 'remote-control: /api/remote-control')
  })

  /**
   * Follow the state file: a script, another window, or the settings page may
   * change the relay or the public address while this plugin is running, and
   * the tunnel has to follow without waiting for a client poll.
   */
  function watchSettings() {
    let timer
    const path = statePath()
    const onChange = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        if (!refreshSettings() || !state.enabled) return
        log('settings changed on disk, reconnecting the tunnel')
        restart().catch((error) => {
          state.error = String(error)
          log(`reconnect failed: ${String(error)}`)
        })
      }, 250)
    }
    // Watch the directory: the file is replaced rather than rewritten.
    const watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
      if (filename === null || String(filename) === basename(path)) onChange()
    })
    watcher.on('error', () => {})
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      watcher.close()
    }
  }

  ctx.effect(() => watchSettings(), 'remote-control: settings watcher')

  ctx.effect(() => async () => {
    await stop()
  }, 'remote-control: teardown')
}
