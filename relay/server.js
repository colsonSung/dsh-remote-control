#!/usr/bin/env node
/**
 * Standalone relay for DeepSeek Harness Remote Control.
 *
 * Run this on a host that the internet can reach, and point the Harness
 * "Remote Control" settings page at its URL. The Harness dials out to the
 * relay, the relay replays the phone's HTTP traffic back through that tunnel,
 * and the phone loads the real Harness web app.
 *
 * Environment:
 *   RELAY_TOKEN          required, the shared secret the Harness presents
 *   RELAY_PUBLIC_URL     the URL a phone opens, e.g. https://rc.example.com
 *   PORT                 listen port (default 8080)
 *   HOST                 bind address (default 0.0.0.0)
 *   TLS_CERT / TLS_KEY   optional PEM files; when both are set the relay serves HTTPS
 *   RELAY_STATE           where the phone list is persisted (default /var/lib/dsh-relay/state.json)
 *   RELAY_LOG            'debug' for per-request logging
 */

import { readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'

import { createRelayServer } from './src/relay-server.js'

const token = process.env.RELAY_TOKEN
if (token === undefined || token.length < 16) {
  console.error('remote-control-relay: set RELAY_TOKEN to a random secret of at least 16 characters')
  process.exit(1)
}

const port = Number(process.env.PORT ?? 8080)
const host = process.env.HOST ?? '0.0.0.0'
const debug = process.env.RELAY_LOG === 'debug'

const relay = createRelayServer({
  token,
  publicBaseUrl: process.env.RELAY_PUBLIC_URL ?? `http://localhost:${port}`,
  // The phone list and the trust decisions live on disk.
  statePath: process.env.RELAY_STATE ?? '/var/lib/dsh-relay/state.json',
  log: (message, extra) => {
    if (debug || !message.startsWith('proxy')) console.log(`[relay] ${message}`, extra ?? '')
  },
})

const tlsCert = process.env.TLS_CERT
const tlsKey = process.env.TLS_KEY
const server = tlsCert !== undefined && tlsKey !== undefined
  ? createHttpsServer({ cert: readFileSync(tlsCert), key: readFileSync(tlsKey) })
  : createHttpServer()

const address = await relay.listen({ host, port, server })
console.log(`[relay] listening on ${address.url}`)
console.log(`[relay] public url ${process.env.RELAY_PUBLIC_URL ?? address.url}`)
console.log('[relay] waiting for a device to register…')

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n[relay] shutting down')
    relay.close().finally(() => process.exit(0))
  })
}
