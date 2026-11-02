/**
 * The libraries the guest page loads.
 *
 * The guest page has no build step and no module loader, so a diagram
 * library travels to the browser as a plain file the host serves under the
 * share. The library is not a dependency of this plugin — it lives in the
 * node_modules of another plugin — so this plugin has to work without it:
 * the path is looked up at runtime, the bytes are cached once they are read,
 * and a library that is not installed is a plain 404 rather than a plugin
 * that refuses to start.
 *
 * Only the mermaid bundle is served. The name in the request is matched
 * against one list, and the path of the file is resolved by this module
 * rather than by the request — so a guest can ask for the library and for
 * nothing else.
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The asset name of the diagram library. */
export const SHARE_ASSET_MERMAID = 'mermaid'

/** The asset name of the collaborative editor's library. */
export const SHARE_ASSET_YJS = 'yjs'

/** The media type of the mermaid bundle. */
export const SHARE_ASSET_MERMAID_TYPE = 'application/javascript; charset=utf-8'

/** The media type of the collaborative editor's bundle. */
export const SHARE_ASSET_YJS_TYPE = 'application/javascript; charset=utf-8'

/** The bundle of the collaborative editor, which travels with this plugin. */
const YJS_BUNDLE = join('src', 'vendor', 'yjs-browser.js')

/** How long a browser may keep the library: a day. */
export const SHARE_ASSET_MAX_AGE_SECONDS = 86_400

/** The root of this plugin: the workspace folder that holds it. */
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The workspace the plugin lives in: the folder above the plugin. */
const WORKSPACE_ROOT = resolve(PLUGIN_ROOT, '..')

/** The library inside a node_modules folder. */
const LIBRARY = join('node_modules', 'mermaid', 'dist', 'mermaid.min.js')

/**
 * Every place the mermaid bundle may live.
 *
 * The plugin must not depend on another plugin being installed, so the
 * places are searched in order and the first one that holds the file wins.
 * A plugin that is checked out elsewhere — in a profile, in a bundle — simply
 * finds none of them, and the route answers 404.
 *
 * @returns {string[]} the candidate paths
 */
export function mermaidCandidates() {
  const candidates = [
    // The sibling plugin of this workspace keeps the library.
    join(WORKSPACE_ROOT, 'markdown-mermaid-preview', LIBRARY),
    // A workspace-wide install.
    join(WORKSPACE_ROOT, LIBRARY),
    // An install right beside this plugin.
    join(PLUGIN_ROOT, LIBRARY),
  ]
  return [...new Set(candidates)]
}

/**
 * The path of the mermaid bundle, when it is installed.
 *
 * @param {readonly string[]} [candidates] the places to look, in order
 * @returns {Promise<string | undefined>} the path, or `undefined` when the
 *   library is not installed
 */
export async function findMermaidPath(candidates = mermaidCandidates()) {
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate)
      if (info.isFile()) return candidate
    } catch {
      // Not there: the next candidate may hold it.
    }
  }
  return undefined
}

/**
 * The resolver of the library's path.
 *
 * A path answers the question directly, a function looks it up, and nothing
 * at all falls back to the search of the candidate places.
 *
 * @param {string | (() => string | undefined | Promise<string | undefined>) | undefined} value
 * @returns {() => string | undefined | Promise<string | undefined>}
 */
export function toResolver(value) {
  if (typeof value === 'function') return value
  if (typeof value === 'string' && value.length > 0) return () => value
  return findMermaidPath
}

/**
 * The store of the guest assets.
 *
 * The library is a megabyte or more, so the bytes are read once and kept in
 * memory: a guest page asks for the library once, and a second guest of the
 * same host gets it from the memory rather than from the disk.
 *
 * @param {object} [options]
 * @param {string | (() => string | undefined | Promise<string | undefined>) | undefined} [options.path] where the library lives
 * @param {(message: string, extra?: unknown) => void} [options.log]
 */
export function createAssetStore(options = {}) {
  const log = options.log ?? (() => {})
  /** The libraries and where each of them lives. */
  const resolvers = {
    [SHARE_ASSET_MERMAID]: toResolver(options.path),
    // The collaborative editor travels with this plugin: it is part of the
    // package, not a library of another one.
    [SHARE_ASSET_YJS]: async () => join(PLUGIN_ROOT, YJS_BUNDLE),
  }
  /** @type {Map<string, { body: Buffer, etag: string }>} */
  const cache = new Map()

  return {
    /**
     * The bytes of one asset.
     *
     * @param {string} name the name the guest asked for
     * @returns {Promise<{ ok: true, body: Buffer, etag: string } | { ok: false, reason: 'unknown' | 'missing' }>}
     */
    async read(name) {
      // The name is matched exactly against the list of libraries: a name of
      // the guest's own choosing never reaches the file system.
      const resolvePath = Object.prototype.hasOwnProperty.call(resolvers, name) ? resolvers[name] : undefined
      if (resolvePath === undefined) return { ok: false, reason: 'unknown' }
      const cached = cache.get(name)
      if (cached !== undefined) return { ok: true, body: cached.body, etag: cached.etag }
      let path
      try {
        path = await resolvePath()
      } catch (error) {
        log('share: a library could not be found', { name, error: String(error) })
        return { ok: false, reason: 'missing' }
      }
      if (typeof path !== 'string' || path.length === 0) return { ok: false, reason: 'missing' }
      let body
      try {
        body = await readFile(path)
      } catch (error) {
        // A path that was there when it was looked up may be gone by the time
        // it is read: that is a missing library, not a broken host.
        log('share: a library could not be read', { name, path, error: String(error) })
        return { ok: false, reason: 'missing' }
      }
      const etag = etagOf(body)
      cache.set(name, { body, etag })
      return { ok: true, body, etag }
    },
  }
}

/**
 * The entity tag of one body.
 *
 * @param {Buffer} body
 * @returns {string}
 */
function etagOf(body) {
  return `"${createHash('sha1').update(body).digest('base64url')}"`
}
