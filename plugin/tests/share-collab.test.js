/**
 * The collaborative documents of a share.
 *
 * Run with: `node --test tests/share-collab.test.js`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as Y from 'yjs'
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness'

import { createCollab } from '../src/share-collab.js'

test('a document opens with the text of the file', () => {
  const collab = createCollab()
  const entry = collab.open('share-1', 'src/main.js', 'const answer = 42\n')
  assert.equal(collab.textOf(entry), 'const answer = 42\n', 'the document holds the text of the file')
  assert.equal(collab.find('share-1', 'src/main.js'), entry, 'the document is found by its share and path')
  assert.equal(collab.find('share-2', 'src/main.js'), undefined, 'a document of another share is another document')
  collab.close()
})

test('a change of a guest reaches the document and the other guests', () => {
  const collab = createCollab()
  const entry = collab.open('share-1', 'src/main.js', 'hello\n')

  // The guest that types produces an update the way the browser does: the
  // document hands out the change as it happens.
  const guest = new Y.Doc()
  Y.applyUpdate(guest, Buffer.from(collab.stateOf(entry), 'base64'))
  let produced = null
  guest.on('update', (bytes) => { produced = bytes })

  guest.getText('content').insert(5, 'world')
  assert.ok(produced !== null, 'the change is produced')

  const update = Buffer.from(produced).toString('base64')
  assert.equal(collab.applyUpdate(entry, update), true, 'the change is taken')
  assert.equal(collab.textOf(entry), 'helloworld\n', 'the document holds the change')

  // The state that goes to another guest carries the change with it.
  const second = new Y.Doc()
  Y.applyUpdate(second, Buffer.from(collab.stateOf(entry), 'base64'))
  assert.equal(second.getText('content').toString(), 'helloworld\n', 'the other guest sees the change')
  guest.destroy()
  second.destroy()
  collab.close()
})

test('the cursors of the guests travel with the document', () => {
  const collab = createCollab()
  const entry = collab.open('share-1', 'src/main.js', 'hello\n')

  const guest = new Y.Doc()
  const awareness = new Awareness(guest)
  awareness.setLocalStateField('user', { name: 'Ada', color: '#4176e6' })
  awareness.setLocalStateField('cursor', { anchor: 3, head: 3 })
  const update = Buffer.from(encodeAwarenessUpdate(awareness, [guest.clientID])).toString('base64')
  assert.equal(collab.applyAwareness(entry, update), true, 'the cursors are taken')

  const cursors = Buffer.from(collab.awarenessOf(entry), 'base64')
  assert.ok(cursors.length > 0, 'the cursors travel to the other guests')

  // A guest that leaves takes its cursors with it.
  collab.leave(entry, guest.clientID)
  assert.equal(collab.awarenessOf(entry), '', 'the cursors of a guest that left are gone')

  awareness.destroy()
  guest.destroy()
  collab.close()
})

test('a document starts again when the agent rewrites the file', () => {
  const collab = createCollab()
  const entry = collab.open('share-1', 'src/main.js', 'hello\n')
  entry.text.insert(5, 'world')
  assert.equal(collab.textOf(entry), 'helloworld\n')

  collab.reset(entry, 'the agent wrote this\n')
  assert.equal(collab.textOf(entry), 'the agent wrote this\n', 'the document holds what the file holds now')
  collab.close()
})

test('a document no guest has open is forgotten', () => {
  const collab = createCollab()
  collab.open('share-1', 'src/main.js', 'hello\n')
  assert.equal(collab.size(), 1, 'the document is there')
  assert.equal(collab.sweep(0), 1, 'it is forgotten when nobody holds it')
  assert.equal(collab.size(), 0, 'the document is gone')
})
