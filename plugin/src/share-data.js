/**
 * The guest data module of a shared session.
 *
 * Everything the guest page shows comes from here: the project's directory
 * tree, the text of a file, and the two projections of the session log — the
 * trajectory of what happened and the context of what the session produced.
 *
 * The module is pure: it takes the host filesystem and the session events and
 * answers with plain data. It never talks to the host on its own, and it never
 * reaches outside the project root.
 *
 * The path boundary is the important part. The host does not confine a
 * plugin's file reads — `ctx.workspaceFiles` reads whatever the filesystem can
 * reach — so this module resolves every guest path itself:
 *
 *   1. a guest path is **relative** to the project root; an absolute path is
 *      refused outright;
 *   2. `lstat` looks at the path *before* the resolution follows its last
 *      component, so a symlink is seen as a symlink;
 *   3. `resolve` turns the path into the filesystem's own identity, resolving
 *      the ancestors as well;
 *   4. `contains` compares that identity with the root's **by path segment**,
 *      so a directory that merely starts with the root's name is outside it.
 *
 * A failure is always the same failure: `{ok: false}`. The answer says
 * nothing about whether the path exists.
 */

import { isAbsolute, relative, sep } from 'node:path'

/** How many entries one directory listing carries at most. */
export const SHARE_TREE_MAX_ENTRIES = 500

/** The largest text file the guest may read. */
export const SHARE_TEXT_MAX_BYTES = 2 * 1024 * 1024

/** How many characters one trajectory detail carries at most. */
/* The output of a tool is a step of the work: it is shown folded away, so it
   is bounded. A message of the conversation is the conversation - the app
   shows it whole, and a cut through the middle of it would break the
   markdown of the reply. */
const SHARE_DETAIL_MAX_CHARS = 4000
const SHARE_MESSAGE_MAX_CHARS = 24000

/** How many characters one file name carries at most. */
const SHARE_NAME_MAX_CHARS = 120

/* ------------------------------------------------------------------ paths */

/**
 * Is this path allowed to address something inside the project root?
 *
 * A guest path is always relative: the root is the only place the guest may
 * read, so an absolute path is never needed and is always a way out.
 *
 * @param {unknown} candidate
 * @returns {boolean}
 */
export function isSafeRelativePath(candidate) {
  if (typeof candidate !== 'string') return false
  if (candidate.length === 0) return false
  if (candidate.includes('\0')) return false
  if (isAbsolute(candidate)) return false
  if (candidate.startsWith('/') || candidate.startsWith('\\')) return false
  // A `..` segment walks out of the root; the host's filesystem resolves the
  // path physically, so the segment is refused before anything is touched.
  const segments = candidate.split(/[\\/]+/)
  for (const segment of segments) {
    if (segment === '..') return false
  }
  return true
}

/**
 * Resolve one guest path inside the project root.
 *
 * The order matters and mirrors the host's own workspace files service:
 *
 *   1. `lstat` looks at the path *before* the resolution follows its last
 *      component, so a symlink is seen as a symlink and not as its target;
 *   2. `resolve` turns the path into the filesystem's own identity, which
 *      resolves the ancestors as well;
 *   3. `contains` compares that identity with the root's, and it compares
 *      path segments — a directory that merely starts with the root's name is
 *      outside it.
 *
 * @param {{ resolve: Function, contains: Function, lstat: Function }} fs the host filesystem
 * @param {string} root the project root
 * @param {string} candidate the root-relative path
 * @returns {Promise<{ ok: true, target: any, size: number | undefined } | { ok: false }>}
 */
export async function resolveWithinRoot(fs, root, candidate) {
  if (fs === undefined || fs === null) return { ok: false }
  if (typeof root !== 'string' || root.length === 0) return { ok: false }
  if (!isSafeRelativePath(candidate)) return { ok: false }
  try {
    const entry = await fs.lstat(candidate, { cwd: root })
    if (entry === undefined || entry === null) return { ok: false }
    if (entry.type === 'symlink') return { ok: false }
    if (entry.type !== 'file') return { ok: false }
    const rootTarget = await fs.resolve(root, { cwd: root })
    const target = await fs.resolve(candidate, { cwd: root })
    if (rootTarget === undefined || target === undefined) return { ok: false }
    if (!fs.contains(rootTarget, target)) return { ok: false }
    return { ok: true, target, size: typeof entry.size === 'number' ? entry.size : undefined }
  } catch {
    return { ok: false }
  }
}

/**
 * Resolve one guest directory inside the project root.
 *
 * The same boundary as {@link resolveWithinRoot}, with a directory instead of
 * a file: a directory is not a way out either, so it goes through the same
 * `lstat`, `resolve` and `contains` steps.
 *
 * @param {{ resolve: Function, contains: Function, lstat: Function }} fs the host filesystem
 * @param {string} root the project root
 * @param {string} relativePath the root-relative directory path ('' is the root)
 * @returns {Promise<{ ok: true, target: any, rootTarget: any } | { ok: false }>}
 */
async function resolveDirectory(fs, root, relativePath) {
  if (fs === undefined || fs === null) return { ok: false }
  if (typeof root !== 'string' || root.length === 0) return { ok: false }
  const path = relativePath === undefined ? '' : relativePath
  if (path.length > 0 && !isSafeRelativePath(path)) return { ok: false }
  try {
    const rootTarget = await fs.resolve(root, { cwd: root })
    if (rootTarget === undefined) return { ok: false }
    // The root is the root: there is nothing to look up, and the host's own
    // filesystem has no answer for an empty path.
    if (path.length === 0) return { ok: true, target: rootTarget, rootTarget }
    const entry = await fs.lstat(path, { cwd: root })
    if (entry === undefined || entry === null) return { ok: false }
    if (entry.type === 'symlink') return { ok: false }
    if (entry.type !== 'directory') return { ok: false }
    const target = await fs.resolve(path, { cwd: root })
    if (target === undefined) return { ok: false }
    if (!fs.contains(rootTarget, target)) return { ok: false }
    return { ok: true, target, rootTarget }
  } catch {
    return { ok: false }
  }
}

/**
 * The guest spelling of one path: `/` separated, relative to the root.
 *
 * @param {string} relativePath
 * @returns {string}
 */
function guestPath(relativePath) {
  return relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0).join('/')
}

/* ------------------------------------------------------- directory listing */

/**
 * List one directory of the project.
 *
 * Only one level: the guest page walks the tree itself, one request per
 * directory. Every entry goes through the same boundary as a file — a
 * directory is not a way out either — so a symlink or a path that leaves the
 * root is not listed at all.
 *
 * @param {{ resolve: Function, contains: Function, lstat: Function, listDir: Function }} fs the host filesystem
 * @param {string} root the project root
 * @param {string} relativePath the root-relative directory path ('' is the root)
 * @returns {Promise<{ ok: true, path: string, entries: { name: string, path: string, kind: 'file'|'directory', size?: number }[], truncated: boolean } | { ok: false }>}
 */
export async function listShareDirectory(fs, root, relativePath) {
  const path = relativePath === undefined || relativePath === null ? '' : relativePath
  const resolved = await resolveDirectory(fs, root, path)
  if (!resolved.ok) return { ok: false }

  const parent = guestPath(path)
  /** @type {any[]} */
  let listed
  try {
    listed = await fs.listDir(resolved.target, undefined)
  } catch {
    return { ok: false }
  }
  if (!Array.isArray(listed)) return { ok: false }

  const entries = []
  let truncated = false
  for (const entry of listed) {
    if (entries.length >= SHARE_TREE_MAX_ENTRIES) {
      truncated = true
      break
    }
    const name = typeof entry?.name === 'string' ? entry.name : ''
    if (name.length === 0 || name === '.' || name === '..') continue
    const child = parent.length === 0 ? name : `${parent}/${name}`

    // The entry must be a plain child of this directory: a symlink is not
    // listed, even when it points back inside the root.
    let stat
    try {
      stat = await fs.lstat(child, { cwd: root })
    } catch {
      continue
    }
    if (stat === undefined || stat === null) continue
    if (stat.type === 'symlink') continue

    // And it must still be inside the root once the filesystem has resolved
    // it: a link or a mount may leave it.
    let childTarget
    try {
      childTarget = await fs.resolve(child, { cwd: root })
    } catch {
      continue
    }
    if (childTarget === undefined) continue
    if (!fs.contains(resolved.rootTarget, childTarget)) continue

    const kind = stat.type === 'directory' ? 'directory' : stat.type === 'file' ? 'file' : undefined
    if (kind === undefined) continue
    const listed_ = { name: name.slice(0, SHARE_NAME_MAX_CHARS), path: child, kind }
    if (typeof stat.size === 'number') listed_.size = stat.size
    entries.push(listed_)
  }

  return { ok: true, path: parent, entries, truncated }
}

/**
 * Read one text file of the project.
 *
 * A file over the size limit is **truncated**, not refused: the guest sees the
 * beginning of a big file rather than an error. A file that is not text — the
 * bytes are not valid UTF-8, or they carry a NUL — is not readable at all.
 *
 * @param {{ resolve: Function, contains: Function, lstat: Function, readByteRange: Function }} fs the host filesystem
 * @param {string} root the project root
 * @param {string} relativePath the root-relative file path
 * @returns {Promise<{ ok: true, path: string, text: string, size: number, truncated: boolean } | { ok: false }>}
 */
export async function readShareText(fs, root, relativePath) {
  const resolved = await resolveWithinRoot(fs, root, relativePath)
  if (!resolved.ok) return { ok: false }

  const size = resolved.size ?? 0
  let bytes
  try {
    bytes = await fs.readByteRange(resolved.target, { offset: 0, length: SHARE_TEXT_MAX_BYTES }, undefined)
  } catch {
    return { ok: false }
  }
  if (bytes === undefined || bytes === null) return { ok: false }
  const buffer = Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length)

  // The host's own rule: a NUL byte means the file is not text.
  if (buffer.includes(0)) return { ok: false }

  const truncated = size > buffer.length
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    if (!truncated) return { ok: false }
    // The cut fell inside a multi-byte character: the tail is replaced
    // rather than the whole file refused.
    text = new TextDecoder('utf-8').decode(buffer)
  }

  return { ok: true, path: guestPath(relativePath), text, size, truncated }
}

/* -------------------------------------------------------------- projections */

/**
 * The project root of a session, taken from the log itself when the caller
 * does not name it.
 *
 * The header event carries the session's `cwd`, and that directory never
 * moves afterwards: it is the boundary every path is measured against.
 *
 * @param {readonly any[]} events
 * @param {string | undefined} explicit the root the caller knows
 * @returns {string | undefined}
 */
function rootOf(events, explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  for (const event of events ?? []) {
    if (event?.type !== 'session') continue
    const cwd = event.cwd ?? event.data?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) return cwd
  }
  return undefined
}

/**
 * The guest spelling of one absolute path.
 *
 * A path inside the project root becomes relative; a path outside it is
 * dropped — the guest learns nothing about the machine the agent works on.
 *
 * @param {string} value
 * @param {string | undefined} root
 * @returns {string | undefined}
 */
function guestPathOf(value, root) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (!isAbsolute(value)) {
    // Already relative: it is inside the root by construction.
    if (value.split(/[\\/]+/).some((segment) => segment === '..')) return undefined
    return guestPath(value)
  }
  if (root === undefined) return undefined
  const rel = relative(root, value)
  if (rel.length === 0) return ''
  if (isAbsolute(rel)) return undefined
  if (rel === '..' || rel.startsWith(`..${sep}`)) return undefined
  return guestPath(rel)
}

/**
 * Hide the host's absolute paths in one piece of text.
 *
 * A path inside the project root becomes relative; every other absolute path
 * becomes `<path>`. The guest sees the shape of the work, not the machine.
 *
 * @param {string} text
 * @param {string | undefined} root
 * @returns {string}
 */
function redactPaths(text, root) {
  if (typeof text !== 'string' || text.length === 0) return ''
  return text.replace(/\/[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)+/g, (match) => {
    const inside = guestPathOf(match, root)
    return inside ?? '<path>'
  })
}

/**
 * Cut one piece of text down to the length a guest page can show.
 *
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
function clip(text, max = SHARE_DETAIL_MAX_CHARS) {
  if (typeof text !== 'string') return ''
  if (text.length <= max) return text
  // The cut falls on a line, so a paragraph does not end in the middle of a
  // word.
  const cut = text.slice(0, max)
  const line = cut.lastIndexOf('\n')
  return `${line > max * 0.6 ? cut.slice(0, line) : cut}…`
}

/**
 * The text of one message's content blocks.
 *
 * @param {unknown} content
 * @returns {string}
 */
export function textOfContent(content) {
  // A message may carry its words as one string or as a list of blocks.
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const entry = /** @type {Record<string, unknown>} */ (block)
    if (entry.type !== 'text') continue
    if (typeof entry.text !== 'string') continue
    parts.push(entry.text)
  }
  return parts.join('\n')
}

/**
 * The arguments of one tool call, parsed.
 *
 * The host stores the arguments as the JSON text the model produced, so a
 * malformed call is not fatal: the raw text is used instead.
 *
 * @param {unknown} raw the JSON text of the call's arguments
 * @returns {any}
 */
function argumentsOf(raw) {
  if (typeof raw !== 'string') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/**
 * One tool call, as a step the guest can read.
 *
 * @param {any} data the `tool/call` payload
 * @param {string | undefined} root
 * @returns {{ kind: string, title: string, detail: string }}
 */
function stepOfToolCall(data, root) {
  const name = typeof data?.name === 'string' ? data.name : 'tool'
  const args = argumentsOf(data?.arguments)
  const record = typeof args === 'object' && args !== null ? args : {}
  const filePath = guestPathOf(record.file_path ?? record.path, root)
  const pattern = typeof record.pattern === 'string' ? record.pattern : undefined

  switch (name) {
    case 'read':
      return {
        kind: 'read',
        title: filePath === undefined ? 'Read a file' : `Read ${filePath}`,
        detail: filePath === undefined ? '' : '',
      }
    case 'write':
      return {
        kind: 'write',
        title: filePath === undefined ? 'Write a file' : `Write ${filePath}`,
        detail: filePath === undefined ? '' : '',
      }
    case 'edit':
      return {
        kind: 'edit',
        title: filePath === undefined ? 'Edit a file' : `Edit ${filePath}`,
        detail: filePath === undefined ? '' : '',
      }
    case 'bash': {
      const description = typeof record.description === 'string' ? record.description : ''
      return {
        kind: 'command',
        title: 'Run a command',
        detail: clip(redactPaths(description, root)),
      }
    }
    case 'grep':
      return {
        kind: 'search',
        title: pattern === undefined ? 'Search the project' : `Search for ${clip(pattern, 80)}`,
        detail: filePath === undefined ? '' : `in ${filePath}`,
      }
    case 'glob':
      return {
        kind: 'search',
        title: pattern === undefined ? 'Find files' : `Find files matching ${clip(pattern, 80)}`,
        detail: filePath === undefined ? '' : `in ${filePath}`,
      }
    case 'todo_write':
      return { kind: 'todo', title: 'Update the todo list', detail: '' }
    case 'send_message':
      return { kind: 'team', title: 'Message a teammate', detail: '' }
    case 'team_task_create':
      return { kind: 'team', title: 'Create a shared task', detail: '' }
    case 'team_task_update':
      return { kind: 'team', title: 'Update a shared task', detail: '' }
    case 'team_task_get':
    case 'team_task_list':
      return { kind: 'team', title: 'Read the shared task board', detail: '' }
    case 'job_output':
      return { kind: 'job', title: 'Read a background job', detail: '' }
    case 'job_kill':
      return { kind: 'job', title: 'Stop a background job', detail: '' }
    case 'cordis_inspect_list':
      return { kind: 'inspect', title: 'Inspect the host API', detail: '' }
    case 'cordis_inspect_query':
      return { kind: 'inspect', title: 'Read a host API contract', detail: '' }
    default:
      return { kind: 'tool', title: name, detail: '' }
  }
}

/**
 * The trajectory of a session: what was asked, what was answered, and what
 * the agent did in between.
 *
 * The projection reads the real log shapes:
 *
 *   - `user/message` — `data: {id, role, content, source}`;
 *   - `assistant/message` — `data: {turn, step, message, stream, usage}`;
 *   - `tool/call` — `data: {turn, step, callId, name, arguments}`;
 *   - `tool/result` — `data: {turn, step, message, error, meta}` with
 *     `sourceEventSeqs` pointing back at the call.
 *
 * @param {readonly any[]} events the session events
 * @param {{ root?: string }} [options] the project root, when the caller knows it
 * @returns {{ steps: { kind: string, title: string, detail: string, role?: string, time: number, seq: number }[] }}
 */
/**
 * Whether one message is the Host's own context and not a word of anyone.
 *
 * The Host writes a snapshot of its context into the session before every
 * turn - the time it sampled, the time zone of the browser, the time since
 * the last message. The app keeps those out of the transcript, and so does
 * the guest.
 *
 * @param {any} data the data of the message
 * @returns {boolean}
 */
export function isHostContext(data) {
  const source = data?.source
  if (typeof source !== 'object' || source === null) return false
  const kind = source.kind
  // Only a word of a person is a word of a person: the context of the Host,
  // the instructions of the workspace and the like are written by the Host.
  if (typeof kind !== 'string' || kind.length === 0) return false
  return kind !== 'user'
}

export function projectSteps(events, options = {}) {
  const list = Array.isArray(events) ? events : []
  const root = rootOf(list, options.root)
  /** @type {{ kind: string, title: string, detail: string, role?: string, time: number, seq: number }[]} */
  const steps = []
  /** @type {Map<number, number>} the step index of every tool call, by its sequence */
  const calls = new Map()

  for (const event of list) {
    if (typeof event !== 'object' || event === null) continue
    const type = event.type
    const time = typeof event.time === 'number' ? event.time : 0
    const seq = typeof event.seq === 'number' ? event.seq : 0
    const data = typeof event.data === 'object' && event.data !== null ? event.data : {}

    if (type === 'user/message') {
      // The context of the Host is not a word of anyone.
      if (isHostContext(data)) continue
      const text = clip(redactPaths(textOfContent(data.content), root), SHARE_MESSAGE_MAX_CHARS)
      steps.push({ kind: 'prompt', title: 'You asked', detail: text, role: 'user', time, seq })
      continue
    }
    if (type === 'assistant/message') {
      const message = data.message
      const text = clip(redactPaths(textOfContent(message?.content), root), SHARE_MESSAGE_MAX_CHARS)
      if (text.length === 0) continue
      steps.push({ kind: 'answer', title: 'The agent replied', detail: text, role: 'assistant', time, seq })
      continue
    }
    if (type === 'tool/call') {
      const step = stepOfToolCall(data, root)
      steps.push({ ...step, time, seq })
      calls.set(seq, steps.length - 1)
      continue
    }
    if (type === 'tool/result') {
      const message = data.message
      const failed = message?.isError === true || data.error !== undefined
      const text = clip(redactPaths(textOfContent(message?.content), root))
      const sources = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []
      let step = undefined
      for (const source of sources) {
        const index = calls.get(source)
        if (index === undefined) continue
        step = steps[index]
        break
      }
      if (step === undefined) {
        steps.push({
          kind: 'result',
          title: failed ? 'A tool failed' : 'A tool finished',
          detail: text,
          time,
          seq,
        })
        continue
      }
      if (failed) {
        step.title = `${step.title} — failed`
        step.detail = text.length > 0 ? text : step.detail
      } else if (step.detail.length === 0 && text.length > 0) {
        step.detail = text
      }
      continue
    }
    if (type === 'todo/write') {
      const todos = Array.isArray(data.todos) ? data.todos : []
      const done = todos.filter((todo) => todo?.status === 'completed').length
      steps.push({
        kind: 'todo',
        title: 'Update the todo list',
        detail: todos.length === 0 ? '' : `${done} of ${todos.length} done`,
        time,
        seq,
      })
      continue
    }
  }

  return { steps }
}

/**
 * The trajectory of one session.
 *
 * @param {readonly any[]} events the session events
 * @param {{ root?: string }} [options] the project root, when the caller knows it
 * @returns {{ steps: { kind: string, title: string, detail: string, role?: string, time: number, seq: number }[] }}
 */
export function projectTrajectory(events, options = {}) {
  return projectSteps(events, options)
}

/**
 * The step of one event, for the live stream.
 *
 * A tool result names the call it belongs to, so the stream keeps the titles
 * of the calls it has seen and lends them to the results that follow.
 *
 * @param {any} event
 * @param {{ root?: string, titles?: Map<number, string> }} [options]
 * @returns {{ kind: string, title: string, detail: string, role?: string, time: number, seq: number } | undefined}
 */
export function projectStep(event, options = {}) {
  if (typeof event !== 'object' || event === null) return undefined
  const type = event.type
  const time = typeof event.time === 'number' ? event.time : 0
  const seq = typeof event.seq === 'number' ? event.seq : 0
  const data = typeof event.data === 'object' && event.data !== null ? event.data : {}
  const titles = options.titles instanceof Map ? options.titles : new Map()

  if (type === 'user/message') {
    if (isHostContext(data)) return undefined
    return { kind: 'prompt', title: 'You asked', detail: clip(redactPaths(textOfContent(data.content), options.root), SHARE_MESSAGE_MAX_CHARS), role: 'user', time, seq }
  }
  if (type === 'assistant/message') {
    const text = clip(redactPaths(textOfContent(data.message?.content), options.root), SHARE_MESSAGE_MAX_CHARS)
    if (text.length === 0) return undefined
    return { kind: 'answer', title: 'The agent replied', detail: text, role: 'assistant', time, seq }
  }
  if (type === 'tool/call') {
    const step = stepOfToolCall(data, options.root)
    titles.set(seq, step.title)
    return { ...step, time, seq }
  }
  if (type === 'tool/result') {
    const message = data.message
    const failed = message?.isError === true || data.error !== undefined
    const text = clip(redactPaths(textOfContent(message?.content), options.root))
    const sources = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []
    let title = undefined
    for (const source of sources) {
      const known = titles.get(source)
      if (known === undefined) continue
      title = known
      break
    }
    if (title === undefined) {
      return { kind: 'result', title: failed ? 'A tool failed' : 'A tool finished', detail: text, time, seq }
    }
    return { kind: 'tool', title: failed ? `${title} — failed` : title, detail: text, time, seq }
  }
  return undefined
}

/**
 * The context of a session: the files it produced and a line about it.
 *
 * The files come from the write and edit tool calls in the log, so they are
 * the files the agent actually touched — not a guess from the transcript.
 *
 * @param {readonly any[]} events the session events
 * @param {{ root?: string }} [options] the project root, when the caller knows it
 * @returns {{ files: { path: string, kind: string }[], summary: string }}
 */
export function projectContext(events, options = {}) {
  const list = Array.isArray(events) ? events : []
  const root = rootOf(list, options.root)
  /** @type {Map<string, string>} */
  const files = new Map()
  let tools = 0
  let commands = 0

  for (const event of list) {
    if (typeof event !== 'object' || event === null) continue
    if (event.type !== 'tool/call') continue
    const data = typeof event.data === 'object' && event.data !== null ? event.data : {}
    const name = typeof data.name === 'string' ? data.name : 'tool'
    tools += 1
    if (name === 'bash') commands += 1
    if (name !== 'write' && name !== 'edit') continue
    const args = argumentsOf(data.arguments)
    const record = typeof args === 'object' && args !== null ? args : {}
    const path = guestPathOf(record.file_path ?? record.path, root)
    if (path === undefined || path.length === 0) continue
    if (files.has(path)) continue
    files.set(path, name === 'write' ? 'written' : 'edited')
  }

  const written = [...files.values()].filter((kind) => kind === 'written').length
  const edited = files.size - written
  const parts = []
  if (files.size === 0) parts.push('The session produced no file')
  else if (written === 0) parts.push(`The session edited ${files.size} file${files.size === 1 ? '' : 's'}`)
  else if (edited === 0) parts.push(`The session wrote ${files.size} file${files.size === 1 ? '' : 's'}`)
  else parts.push(`The session wrote ${written} and edited ${edited} file${edited === 1 ? '' : 's'}`)
  if (commands > 0) parts.push(`ran ${commands} command${commands === 1 ? '' : 's'}`)
  else if (tools > 0) parts.push(`used ${tools} tool${tools === 1 ? '' : 's'}`)

  return {
    files: [...files.entries()].map(([path, kind]) => ({ path, kind })),
    summary: `${parts.join(', ')}.`,
  }
}
