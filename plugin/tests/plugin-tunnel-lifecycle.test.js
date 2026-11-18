/**
 * @file The plugin must never keep two relay clients alive.
 *
 * Two clients with the same device id fight over the relay's registration: the
 * relay keeps one of them and refuses the other, and the refused one keeps
 * opening tunnels that steal the traffic from the winner. The plugin reaches
 * for the tunnel from several places — the settings page, the file watcher,
 * the restore after a restart — so a start that runs while an earlier one is
 * still up has to let the older client go first.
 *
 * Run with: `node --test tests/plugin-tunnel-lifecycle.test.js`
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createRelayServer } from '../src/relay-server.js'
import { ROUTE, apply } from '../index.js'

const SECRET = 'lifecycle-secret'
const DEVICE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

/**
 * Reserve a free TCP port.
 *
 * @returns {Promise<number>}
 */
async function freePort() {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/**
 * Wait for a moment.
 *
 * @param {number} ms - how long to wait.
 * @returns {Promise<void>}
 */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A cordis context with just enough surface for the plugin.
 *
 * @param {string} origin - the address of the host the plugin serves.
 * @param {string[]} messages - every line the plugin logs.
 * @returns {any}
 */
function makeCtx(origin, messages) {
  const injects = []
  const disposers = []
  const routes = new Map()
  const services = {
    webServer: {
      getOrigin: () => origin,
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    connection: {
      authenticatedUrl: (base) => `${base}?token=launch-token`,
      fetch: {
        register: (spec) => {
          routes.set(spec.path, spec)
          return () => routes.delete(spec.path)
        },
      },
    },
  }
  const injected = {
    effect: (fn, name) => {
      const dispose = fn()
      disposers.push({ name, dispose })
      return dispose
    },
    webServer: services.webServer,
    connection: services.connection,
  }
  const ctx = {
    logger: {
      info: (message) => messages.push(String(message)),
      warn: (message) => messages.push(String(message)),
      error: (message) => messages.push(String(message)),
    },
    inject: (keys, cb) => {
      injects.push({ keys, cb })
    },
    effect: (fn, name) => {
      const dispose = fn()
      disposers.push({ name, dispose })
      return dispose
    },
    get: (key) => services[key],
  }
  return {
    ctx,
    routes,
    disposers,
    /**
     * Let the plugin's own injections run.
     *
     * @param {string[]} skip - the injections to hold back, by their keys.
     */
    flush: (skip = []) => {
      for (const entry of injects) {
        if (skip.includes(entry.keys.join(','))) continue
        entry.cb(injected)
      }
    },
  }
}

/**
 * Ask the plugin one of its RPC endpoints.
 *
 * @param {Map<string, any>} routes - the routes the plugin registered.
 * @param {string} method - the endpoint.
 * @param {Record<string, unknown>} payload - the endpoint's argument.
 * @returns {Promise<any>}
 */
async function call(routes, method, payload = {}) {
  const route = routes.get(ROUTE)
  assert.ok(route !== undefined, 'the plugin answers on its own route')
  const response = await route.fetch({
    json: async () => ({ method, payload }),
  })
  return response.json()
}

/**
 * Wait until the plugin reports a live tunnel.
 *
 * @param {Map<string, any>} routes - the routes the plugin registered.
 * @param {number} timeoutMs - how long to wait.
 * @returns {Promise<any>}
 */
async function waitForOnline(routes, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let last = undefined
  while (Date.now() < deadline) {
    last = await call(routes, 'status')
    if (last?.value?.state === 'online') return last
    await wait(100)
  }
  return last
}

test('a start that runs while another one is up replaces the older client', async (t) => {
  const port = await freePort()
  const relay = createRelayServer({ token: SECRET, log: () => {} })
  await relay.listen({ host: '127.0.0.1', port })
  t.after(() => relay.close())

  const profile = mkdtempSync(join(tmpdir(), 'dsh-remote-control-'))
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = profile
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  })

  mkdirSync(join(profile, 'plugins'), { recursive: true })
  writeFileSync(
    join(profile, 'plugins', 'remote-control.json'),
    `${JSON.stringify(
      {
        deviceId: DEVICE_ID,
        alias: 'Test Host',
        secret: SECRET,
        accessKey: 'test-access-key',
        passcode: '12345678',
        relayUrl: `http://127.0.0.1:${port}`,
        publicAddress: '',
        enabled: true,
      },
      null,
      2,
    )}\n`,
  )

  const messages = []
  const host = makeCtx('http://127.0.0.1:56103', messages)
  apply(host.ctx)
  t.after(async () => {
    for (const entry of host.disposers) {
      await entry.dispose?.()
    }
  })

  // The settings page switches the tunnel on before the plugin's own restore
  // runs: the two starts overlap. The routes come first, the restore last.
  host.flush(['webServer,connection'])
  const switched = await call(host.routes, 'setEnabled', { enabled: true })
  assert.equal(switched.ok, true, 'the tunnel starts')
  host.flush()

  const status = await waitForOnline(host.routes)
  assert.equal(status?.value?.state, 'online', 'the tunnel is up')
  assert.equal(Boolean(status?.value?.error), false, 'the plugin reports no error')

  // The device is the only one on the relay, and the plugin owns it.
  const devices = status?.value?.devices ?? []
  assert.equal(devices.length, 1, 'the relay knows one device')
  assert.equal(devices[0].deviceId, DEVICE_ID)
  assert.equal(devices[0].isThisComputer, true)

  // A client that was left behind would keep asking for the registration and
  // would be told that the device is taken.
  const refusals = messages.filter((line) => line.includes('refused the device'))
  assert.deepEqual(refusals, [], 'no client is left behind asking for the registration')
})
