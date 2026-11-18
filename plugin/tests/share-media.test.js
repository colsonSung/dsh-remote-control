/**
 * The media header of a file: what the browser is told before the bytes.
 *
 * The type decides whether a document is painted or saved, the name decides
 * how it is saved, and the byte range decides whether a PDF viewer can jump to
 * page forty without reading the first thirty-nine.
 *
 * Run with: `node --test tests/share-media.test.js`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  contentDispositionOf,
  contentTypeOf,
  downloadNameOf,
  extensionOf,
  isPlainTextPath,
  officeExtensionOf,
  parseByteRange,
} from '../src/share-media.js'

test('the extension of a path is the last one, in lower case', () => {
  assert.equal(extensionOf('README.md'), 'md')
  assert.equal(extensionOf('folder.d/notes.TXT'), 'txt')
  assert.equal(extensionOf('Makefile'), '')
  assert.equal(extensionOf(''), '')
})

test('the media type follows the extension', () => {
  assert.equal(contentTypeOf('plan.pdf'), 'application/pdf')
  assert.equal(contentTypeOf('logo.PNG'), 'image/png')
  assert.equal(contentTypeOf('book.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert.equal(contentTypeOf('notes.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.equal(contentTypeOf('clip.mp4'), 'video/mp4')
  assert.equal(contentTypeOf('voice.mp3'), 'audio/mpeg')
  assert.equal(contentTypeOf('archive.zip'), 'application/zip')
  assert.equal(contentTypeOf('notes.txt'), 'text/plain; charset=utf-8')
  // A type nothing knows is bytes: the browser guesses nothing.
  assert.equal(contentTypeOf('blob.xyz'), 'application/octet-stream')
})

test('only the six Office formats the Host converts are Office documents', () => {
  assert.equal(officeExtensionOf('a.docx'), 'docx')
  assert.equal(officeExtensionOf('a.XLSX'), 'xlsx')
  assert.equal(officeExtensionOf('a.ppt'), 'ppt')
  assert.equal(officeExtensionOf('a.odt'), '')
  assert.equal(officeExtensionOf('a.pdf'), '')
  assert.equal(officeExtensionOf('a.txt'), '')
})

test('the text of a path is text the browser shows itself', () => {
  assert.equal(isPlainTextPath('notes.txt'), true)
  assert.equal(isPlainTextPath('data.json'), true)
  assert.equal(isPlainTextPath('plan.pdf'), false)
})

test('the name of a download is the name of the file, without its path', () => {
  assert.equal(downloadNameOf('folder/报告 一.pdf'), '报告 一.pdf')
  // A control character would break the header it travels in.
  assert.equal(downloadNameOf('a\u0000b\u001fc.txt'), 'a b c.txt')
})

test('the disposition carries both the plain and the real name', () => {
  const inline = contentDispositionOf('plan.pdf', true)
  assert.match(inline, /^inline;/)
  assert.match(inline, /filename="plan\.pdf"/)
  assert.match(inline, /filename\*=UTF-8''plan\.pdf$/)

  const save = contentDispositionOf('报告 2026.xlsx', false)
  assert.match(save, /^attachment;/)
  // The ASCII form keeps a readable name for an old client, the encoded form
  // carries the one the file really has.
  assert.match(save, /filename="__ 2026\.xlsx"/)
  assert.match(save, /filename\*=UTF-8''%E6%8A%A5%E5%91%8A%202026\.xlsx/)

  // A quote in a name cannot end the quoted form early.
  const quoted = contentDispositionOf('a"b.txt', true)
  assert.match(quoted, /filename="a_b\.txt"/)
})

test('a range says which window of the file is asked for', () => {
  assert.deepEqual(parseByteRange('bytes=0-9', 100), { start: 0, end: 9 })
  assert.deepEqual(parseByteRange('bytes=10-', 100), { start: 10, end: 99 })
  assert.deepEqual(parseByteRange('bytes=-10', 100), { start: 90, end: 99 })
  // An end past the file is the rest of the file, not an error.
  assert.deepEqual(parseByteRange('bytes=90-500', 100), { start: 90, end: 99 })
  // A window that starts past the file cannot be answered.
  assert.equal(parseByteRange('bytes=100-', 100), null)
  // Nothing asked for is the whole file.
  assert.equal(parseByteRange(undefined, 100), undefined)
  assert.equal(parseByteRange('', 100), undefined)
  // A form this route does not carry is read as no range at all.
  assert.equal(parseByteRange('bytes=0-1,4-5', 100), undefined)
  assert.equal(parseByteRange('items=0-1', 100), undefined)
  // An empty file has no window to give.
  assert.equal(parseByteRange('bytes=0-', 0), null)
})
