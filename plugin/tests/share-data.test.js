/**
 * Share data tests.
 *
 * The module is pure data: the tests hand it a filesystem that behaves like
 * the host's local backend and a session log with the real event shapes.
 *
 * Run with: `node --test tests/share-data.test.js`
 */

import assert from 'node:assert/strict'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import { test } from 'node:test'

import {
  isSafeRelativePath,
  listShareDirectory,
  isHostContext,
  projectContext,
  projectSteps,
  projectTrajectory,
  readShareText,
  resolveWithinRoot,
  SHARE_TEXT_MAX_BYTES,
  SHARE_TREE_MAX_ENTRIES,
} from '../src/share-data.js'

/**
 * A filesystem that behaves like the host's local backend.
 *
 * The host resolves a path to its real identity and compares that identity
 * with the root's by path segment, so a directory that merely starts with the
 * root's name is outside it. The fake keeps that behaviour, or the boundary
 * test would prove nothing.
 *
 * @param {string} root
 * @returns {any}
 */
function makeFs(root) {
  const display = (path, cwd) => {
    const base = cwd ?? root
    return isAbsolute(path) ? path : resolvePath(base, path)
  }
  const identity = (path, cwd) => {
    const spelled = display(path, cwd)
    try {
      return realpathSync(spelled)
    } catch {
      return resolvePath(spelled)
    }
  }
  return {
    async resolve(path, opts = {}) {
      return { targetKey: identity(path, opts.cwd), displayPath: display(path, opts.cwd) }
    },
    contains(parent, child) {
      const rel = relative(parent.targetKey, child.targetKey)
      return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    },
    async lstat(path, opts = {}) {
      try {
        const info = lstatSync(display(path, opts.cwd))
        return {
          version: 'v1',
          type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
          size: info.size,
        }
      } catch {
        return undefined
      }
    },
    async listDir(target) {
      const names = readdirSync(target.displayPath)
      const entries = []
      for (const name of names) {
        const child = identity(name, target.displayPath)
        let type = 'other'
        let size
        try {
          const info = lstatSync(child)
          type = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
          if (info.isFile()) size = info.size
        } catch {
          /* an entry that vanished is not listed */
        }
        entries.push({ name, type, target: { targetKey: child, displayPath: child }, size })
      }
      return entries
    },
    async readByteRange(target, range) {
      const buffer = readFileSync(target.displayPath)
      return buffer.subarray(range.offset, range.offset + range.length)
    },
  }
}

/**
 * A project directory with a file inside it and a few ways out of it.
 *
 * @returns {{ root: string, base: string, sibling: string }}
 */
function makeProject() {
  const base = mkdtempSync(join(tmpdir(), 'remote-control-share-data-'))
  const root = join(base, 'proj')
  const sibling = join(base, 'proj-secret')
  mkdirSync(root, { recursive: true })
  mkdirSync(sibling, { recursive: true })
  writeFileSync(join(root, 'inside.txt'), 'inside the project')
  writeFileSync(join(base, 'outside.txt'), 'outside the project')
  writeFileSync(join(sibling, 'secret.txt'), 'the sibling directory')
  // A symlink inside the project that points out of it.
  symlinkSync(join(base, 'outside.txt'), join(root, 'link.txt'))
  // A symlinked directory that points at the sibling.
  symlinkSync(sibling, join(root, 'link-dir'))
  return { root, base, sibling }
}

/* ----------------------------------------------------------- path boundary */

test('a guest path is always relative to the project root', () => {
  assert.equal(isSafeRelativePath('inside.txt'), true)
  assert.equal(isSafeRelativePath('src/deep/file.js'), true)
  assert.equal(isSafeRelativePath(''), false, 'the empty path names nothing')
  assert.equal(isSafeRelativePath('/etc/passwd'), false, 'an absolute path is refused')
  assert.equal(isSafeRelativePath('\\\\server\\share'), false)
  assert.equal(isSafeRelativePath('../outside.txt'), false, 'a parent traversal is refused')
  assert.equal(isSafeRelativePath('sub/../../outside.txt'), false)
  assert.equal(isSafeRelativePath('..'), false)
  assert.equal(isSafeRelativePath('with\0nul'), false)
  assert.equal(isSafeRelativePath(undefined), false)
})

test('four ways out of the project are all refused', async () => {
  const project = makeProject()
  const fs = makeFs(project.root)

  const escapes = [
    ['a parent traversal', '../outside.txt'],
    ['an absolute path', '/etc/passwd'],
    ['a symlinked file', 'link.txt'],
    ['a symlinked directory', 'link-dir/secret.txt'],
    ['a directory that only shares the root name', '../proj-secret/secret.txt'],
  ]
  for (const [what, path] of escapes) {
    const resolved = await resolveWithinRoot(fs, project.root, path)
    assert.equal(resolved.ok, false, `${what} is refused`)
  }

  const inside = await resolveWithinRoot(fs, project.root, 'inside.txt')
  assert.equal(inside.ok, true, 'a file inside the project opens')
  assert.equal(inside.size, 'inside the project'.length)
})

test('a directory that only shares the root name is outside it', async () => {
  const project = makeProject()
  const fs = makeFs(project.root)

  // The sibling sits next to the root and shares its first name.
  const rootTarget = await fs.resolve(project.root, { cwd: project.root })
  const siblingTarget = await fs.resolve(project.sibling, { cwd: project.root })
  assert.equal(fs.contains(rootTarget, siblingTarget), false, 'the boundary is per path segment')

  // And the listing refuses to show it.
  const listed = await listShareDirectory(fs, project.root, '../proj-secret')
  assert.equal(listed.ok, false)
})

/* -------------------------------------------------------- directory listing */

test('a listing shows one level and nothing that leaves the root', async () => {
  const project = makeProject()
  const fs = makeFs(project.root)
  mkdirSync(join(project.root, 'src'), { recursive: true })
  writeFileSync(join(project.root, 'src', 'main.js'), 'console.log(1)')

  const root = await listShareDirectory(fs, project.root, '')
  assert.equal(root.ok, true)
  assert.equal(root.path, '', 'the root is the empty path')
  const names = root.entries.map((entry) => entry.name).sort()
  assert.deepEqual(names, ['inside.txt', 'src'])
  assert.equal(
    root.entries.some((entry) => entry.name === 'link.txt'),
    false,
    'a symlinked file is not listed',
  )
  assert.equal(
    root.entries.some((entry) => entry.name === 'link-dir'),
    false,
    'a symlinked directory is not listed',
  )
  const inside = root.entries.find((entry) => entry.name === 'inside.txt')
  assert.equal(inside.kind, 'file')
  assert.equal(inside.path, 'inside.txt')
  assert.equal(inside.size, 'inside the project'.length)
  const directory = root.entries.find((entry) => entry.name === 'src')
  assert.equal(directory.kind, 'directory')
  assert.equal(directory.path, 'src')

  const nested = await listShareDirectory(fs, project.root, 'src')
  assert.equal(nested.ok, true)
  assert.equal(nested.path, 'src')
  assert.deepEqual(nested.entries.map((entry) => entry.name), ['main.js'])
  assert.equal(nested.entries[0].path, 'src/main.js', 'paths use a slash')

  // The listing never descends on its own.
  const deep = await listShareDirectory(fs, project.root, 'src/main.js')
  assert.equal(deep.ok, false, 'a file is not a directory')
})

test('a listing is cut at the entry limit', async () => {
  const project = makeProject()
  const fs = makeFs(project.root)
  const many = join(project.root, 'many')
  mkdirSync(many, { recursive: true })
  for (let index = 0; index < SHARE_TREE_MAX_ENTRIES + 5; index += 1) {
    writeFileSync(join(many, `file-${String(index).padStart(4, '0')}.txt`), 'x')
  }

  const listed = await listShareDirectory(fs, project.root, 'many')
  assert.equal(listed.ok, true)
  assert.equal(listed.entries.length, SHARE_TREE_MAX_ENTRIES, 'the listing is cut')
  assert.equal(listed.truncated, true, 'the cut is marked')
})

test('a directory outside the root is not listed', async () => {
  const project = makeProject()
  const fs = makeFs(project.root)
  for (const path of ['../', '../proj-secret', '/etc', 'link-dir']) {
    const listed = await listShareDirectory(fs, project.root, path)
    assert.equal(listed.ok, false, `${path} is refused`)
  }
})

/* ------------------------------------------------------------------ reading */

test('a text file inside the project is read', async () => {
  const project = makeProject()
  const fs = makeFs(project.root)

  const read = await readShareText(fs, project.root, 'inside.txt')
  assert.equal(read.ok, true)
  assert.equal(read.path, 'inside.txt')
  assert.equal(read.text, 'inside the project')
  assert.equal(read.size, 'inside the project'.length)
  assert.equal(read.truncated, false)
})

test('a file over the size limit is cut, not refused', async () => {
  const project = makeProject()
  const fs = makeFs(project.root)
  const big = 'a'.repeat(SHARE_TEXT_MAX_BYTES + 1024)
  writeFileSync(join(project.root, 'big.txt'), big)

  const read = await readShareText(fs, project.root, 'big.txt')
  assert.equal(read.ok, true, 'a big file is still readable')
  assert.equal(read.truncated, true, 'the cut is marked')
  assert.equal(read.size, big.length)
  assert.equal(read.text.length, SHARE_TEXT_MAX_BYTES, 'the text stops at the limit')
})

test('a binary file is not text', async () => {
  const project = makeProject()
  const fs = makeFs(project.root)
  writeFileSync(join(project.root, 'binary.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))

  const read = await readShareText(fs, project.root, 'binary.bin')
  assert.equal(read.ok, false, 'a file with a NUL byte is not text')
})

test('a file outside the project is not read', async () => {
  const project = makeProject()
  const fs = makeFs(project.root)
  for (const path of ['../outside.txt', '/etc/passwd', 'link.txt', 'link-dir/secret.txt']) {
    const read = await readShareText(fs, project.root, path)
    assert.equal(read.ok, false, `${path} is refused`)
  }
})

/* -------------------------------------------------------------- projections */

/**
 * The events of one small session, in the real log shapes.
 *
 * @param {string} root the project root
 * @returns {any[]}
 */
function sampleEvents(root) {
  return [
    {
      type: 'session',
      id: 'session-1',
      cwd: root,
      createdAt: 1,
      isSeeded: false,
      version: 4,
    },
    {
      type: 'user/message',
      seq: 1,
      time: 100,
      data: {
        id: 'm1',
        role: 'user',
        content: [{ type: 'text', text: 'Please look at the project' }],
        source: { kind: 'user' },
      },
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: 200,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'm2',
          role: 'assistant',
          content: [{ type: 'text', text: 'I will read the file and edit it.' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
        stream: [],
        usage: {},
      },
    },
    {
      type: 'tool/call',
      seq: 3,
      time: 300,
      data: {
        turn: 1,
        step: 1,
        callId: 'call-1',
        name: 'read',
        arguments: JSON.stringify({ file_path: join(root, 'src', 'main.js') }),
      },
    },
    {
      type: 'tool/result',
      seq: 4,
      time: 310,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'r1',
          role: 'tool',
          source: { kind: 'tool', callId: 'call-1' },
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'console.log(1)' }],
          isError: false,
        },
      },
      sourceEventSeqs: [3],
      surfaceOp: 'append',
    },
    {
      type: 'tool/call',
      seq: 5,
      time: 400,
      data: {
        turn: 1,
        step: 1,
        callId: 'call-2',
        name: 'edit',
        arguments: JSON.stringify({
          file_path: join(root, 'src', 'main.js'),
          old_string: 'a',
          new_string: 'b',
        }),
      },
    },
    {
      type: 'tool/result',
      seq: 6,
      time: 410,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'r2',
          role: 'tool',
          source: { kind: 'tool', callId: 'call-2' },
          toolCallId: 'call-2',
          content: [{ type: 'text', text: 'Edited' }],
          isError: true,
        },
      },
      sourceEventSeqs: [5],
      surfaceOp: 'append',
    },
    {
      type: 'tool/call',
      seq: 7,
      time: 500,
      data: {
        turn: 1,
        step: 1,
        callId: 'call-3',
        name: 'bash',
        arguments: JSON.stringify({
          description: 'Run the test suite',
          command: `node --test ${join(root, 'tests')}`,
        }),
      },
    },
    {
      type: 'todo/write',
      seq: 8,
      time: 600,
      data: {
        todos: [
          { content: 'Read the file', status: 'completed' },
          { content: 'Edit the file', status: 'in_progress' },
        ],
      },
    },
  ]
}

test('the trajectory reads the real event shapes', () => {
  const project = makeProject()
  const events = sampleEvents(project.root)

  const { steps } = projectTrajectory(events)
  assert.ok(Array.isArray(steps))

  const prompt = steps.find((step) => step.kind === 'prompt')
  assert.ok(prompt, 'the prompt is a step')
  assert.equal(prompt.role, 'user')
  assert.equal(prompt.detail, 'Please look at the project')
  assert.equal(prompt.time, 100)
  assert.equal(prompt.seq, 1)

  const answer = steps.find((step) => step.kind === 'answer')
  assert.ok(answer, 'the answer is a step')
  assert.equal(answer.role, 'assistant')
  assert.equal(answer.detail, 'I will read the file and edit it.')

  const read = steps.find((step) => step.kind === 'read')
  assert.ok(read, 'a tool call is a step')
  assert.equal(read.title, 'Read src/main.js', 'the path is relative to the root')
  assert.equal(read.seq, 3)

  const edit = steps.find((step) => step.kind === 'edit')
  assert.ok(edit)
  assert.equal(edit.title, 'Edit src/main.js — failed', 'a failed tool result marks its step')

  const command = steps.find((step) => step.kind === 'command')
  assert.ok(command)
  assert.equal(command.title, 'Run a command')
  assert.equal(command.detail, 'Run the test suite')

  const todo = steps.find((step) => step.kind === 'todo')
  assert.ok(todo)
  assert.equal(todo.detail, '1 of 2 done')

  for (const step of steps) {
    assert.equal(typeof step.title, 'string')
    assert.equal(typeof step.detail, 'string')
    assert.equal(typeof step.time, 'number')
    assert.equal(typeof step.seq, 'number')
  }
})

test('the trajectory never shows a path outside the project', () => {
  const project = makeProject()
  const events = [
    {
      type: 'tool/call',
      seq: 1,
      time: 1,
      data: {
        callId: 'c1',
        name: 'read',
        arguments: JSON.stringify({ file_path: '/etc/passwd' }),
      },
    },
    {
      type: 'tool/call',
      seq: 2,
      time: 2,
      data: {
        callId: 'c2',
        name: 'bash',
        arguments: JSON.stringify({ description: `look at /Users/someone/.ssh/id_rsa`, command: 'ls' }),
      },
    },
  ]

  const { steps } = projectTrajectory(events, { root: project.root })
  const text = JSON.stringify(steps)
  assert.doesNotMatch(text, /\/etc\/passwd/, 'a path outside the root is not shown')
  assert.doesNotMatch(text, /\/Users\/someone/, 'a path outside the root is not shown')
  assert.equal(steps[0].title, 'Read a file', 'the step survives without the path')
  assert.doesNotMatch(steps[1].detail, /\/Users\/someone/, 'a path in a detail is hidden')
})

test('the context lists the files the session produced', () => {
  const project = makeProject()
  const events = sampleEvents(project.root)

  const { files, summary } = projectContext(events)
  assert.ok(Array.isArray(files))
  assert.equal(files.length, 1)
  assert.equal(files[0].path, 'src/main.js', 'the path is relative to the root')
  assert.equal(files[0].kind, 'edited')
  assert.equal(typeof summary, 'string')
  assert.ok(summary.length > 0)
  assert.doesNotMatch(summary, new RegExp(project.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the summary hides the root')
})

test('the context of a session without files still says something', () => {
  const { files, summary } = projectContext([])
  assert.deepEqual(files, [])
  assert.match(summary, /no file/i)
})

test('the projections survive a log without events', () => {
  assert.deepEqual(projectTrajectory([]), { steps: [] })
  assert.deepEqual(projectTrajectory(undefined), { steps: [] })
  assert.deepEqual(projectContext(undefined), { files: [], summary: 'The session produced no file.' })
})

test('the context of the Host is not a word of anyone', () => {
  // The Host writes a snapshot of its context into the session before every
  // turn. The app keeps it out of the transcript, and so does the guest.
  const events = [
    {
      type: 'user/message',
      seq: 0,
      time: 1,
      data: {
        id: 'm1',
        role: 'user',
        content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1: 2026-11-02T18:19:32+08:00[Asia/Shanghai]' }],
        source: { kind: 'time-context', form: 'snapshot' },
      },
    },
    {
      type: 'user/message',
      seq: 1,
      time: 2,
      data: {
        id: 'm2',
        role: 'user',
        content: [{ type: 'text', text: 'a word of a person' }],
        source: { kind: 'user' },
      },
    },
  ]
  const { steps } = projectSteps(events)
  assert.equal(steps.length, 1, 'only the word of a person is shown')
  assert.equal(steps[0].detail, 'a word of a person')
  assert.equal(isHostContext({ source: { kind: 'time-context' } }), true)
  assert.equal(isHostContext({ source: { kind: 'user' } }), false)
  assert.equal(isHostContext({}), false)
})
