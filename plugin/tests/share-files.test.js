/**
 * The guest page: the Markdown it renders, the kinds it gives the files and
 * the glyphs it draws them with.
 *
 * Run with: `node --test tests/share-files.test.js`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { markdownToHtml } from '../src/share-markdown.js'
import { fileIconSvg, fileKindOf, fileSizeLabel } from '../src/share-files.js'

test('the kind of a file follows its extension', () => {
  assert.equal(fileKindOf('README.md'), 'markdown')
  assert.equal(fileKindOf('docs/guide.markdown'), 'markdown')
  assert.equal(fileKindOf('index.html'), 'html')
  assert.equal(fileKindOf('icon.svg'), 'image')
  assert.equal(fileKindOf('assets/logo.png'), 'image')
  assert.equal(fileKindOf('package.json'), 'data')
  assert.equal(fileKindOf('src/main.ts'), 'code')
  assert.equal(fileKindOf('notes.txt'), 'text')
  assert.equal(fileKindOf('Makefile'), 'text')
  assert.equal(fileKindOf('archive.zip'), 'binary')
})

test('the glyph of an entry is an svg', () => {
  for (const kind of ['directory', 'markdown', 'html', 'image', 'data', 'code', 'text', 'binary']) {
    const svg = fileIconSvg(kind)
    assert.match(svg, /^<svg /, `the ${kind} glyph is an svg`)
    assert.match(svg, /<\/svg>$/, `the ${kind} glyph is closed`)
  }
  assert.notEqual(fileIconSvg('directory', { open: true }), fileIconSvg('directory'), 'an open folder differs')
})

test('the size of a file reads as a size', () => {
  assert.equal(fileSizeLabel(512), '512 B')
  assert.equal(fileSizeLabel(2048), '2.0 KB')
  assert.equal(fileSizeLabel(5 * 1024 * 1024), '5.0 MB')
  assert.equal(fileSizeLabel(undefined), '')
})

test('the markdown renderer marks a document up', () => {
  const html = markdownToHtml('# Title\n\nA paragraph.\n')
  assert.match(html, /<h1>Title<\/h1>/)
  assert.match(html, /<p>A paragraph\.<\/p>/)
})

test('the markdown renderer keeps lists, quotes and rules', () => {
  const html = markdownToHtml('- one\n- two\n\n> quoted\n\n---\n')
  assert.match(html, /<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/)
  assert.match(html, /<blockquote>/)
  assert.match(html, /<hr>/)
})

test('the markdown renderer keeps a table', () => {
  const html = markdownToHtml('| a | b |\n| --- | ---: |\n| 1 | 2 |\n')
  assert.match(html, /<table>/)
  assert.match(html, /<th style="text-align:left">a<\/th>/)
  assert.match(html, /<th style="text-align:right">b<\/th>/)
  assert.match(html, /<td style="text-align:left">1<\/td>/)
})

test('the markdown renderer marks code up', () => {
  const html = markdownToHtml('Inline `code` here.\n\n```js\nconst answer = 42\n```\n')
  assert.match(html, /<code>code<\/code>/, 'the inline code is marked')
  assert.match(html, /<pre class="md-code"><code class="language-js">/, 'the fenced block keeps its language')
  assert.match(html, /const answer = 42/, 'the code is there')
})

test('the markdown renderer never runs the markup of the document', () => {
  const html = markdownToHtml('Hello <script>alert(1)</script> and <img src=x onerror=alert(2)>\n')
  assert.doesNotMatch(html, /<script>/, 'the script tag is escaped')
  assert.match(html, /&lt;script&gt;/, 'the script tag shows as text')
  // The text of the document may well read "onerror="; what must not happen is
  // a live tag around it.
  assert.doesNotMatch(html, /<img[^>]*onerror/, 'the image tag is not live')
})

test('the markdown renderer keeps the links safe', () => {
  const html = markdownToHtml('[good](https://example.com) and [bad](javascript:alert(1))\n')
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">good<\/a>/)
  assert.doesNotMatch(html, /javascript:/, 'a script link is dropped')
})

test('the markdown renderer resolves a relative image through the resolver', () => {
  const html = markdownToHtml('![alt](assets/logo.png)\n', {
    resolve: (source) => 'api/blob?path=' + source,
  })
  assert.match(html, /<img src="api\/blob\?path=assets\/logo\.png" alt="alt" loading="lazy">/)
})

test('the markdown renderer joins the soft wraps of a paragraph', () => {
  const html = markdownToHtml('The phone loads the *real* Harness web app through a tunnel:\nsessions, streaming output and the composer.\n')
  assert.match(html, /tunnel: sessions, streaming output/, 'the soft wrap becomes a space')
  assert.doesNotMatch(html, /tunnel:\s*<br>/, 'the soft wrap is not a break')
})

test('the markdown renderer keeps a hard break', () => {
  const html = markdownToHtml('one  \ntwo\n')
  assert.match(html, /<br>/, 'two trailing spaces ask for a break')
})
