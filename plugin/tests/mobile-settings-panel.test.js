/**
 * The Settings panel is a fixed 800px two-column dialog on the desktop: a
 * 188px navigation rail beside the content column. On a phone that rail
 * squeezes the content into a few words per line, and iOS zooms the page when
 * a control below 16px takes focus or when a control is double-tapped.
 *
 * Run with: `node --test tests/mobile-settings-panel.test.js`
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'client.js')

/** Load the injected mobile stylesheet. */
async function mobileCss() {
  const styles = []
  const document = {
    head: {
      appendChild(node) {
        if (node.tagName === 'STYLE') styles.push(node)
        return node
      },
    },
    getElementById: () => null,
    createElement: (tagName) => ({ tagName: String(tagName).toUpperCase(), id: '', textContent: '' }),
    querySelectorAll: () => [],
  }
  const window = { __ModuleLoader__: { load() {} } }
  const source = await readFile(clientPath, 'utf8')
  new Function('window', 'document', `${source}\n//# sourceURL=client.js`)(window, document)
  const style = styles.find((entry) => entry.id === 'dsh-remote-control-mobile-layout')
  assert.ok(style, 'the mobile layout stylesheet must be injected')
  return style.textContent
}

test('the settings panel stacks its navigation above the content on a phone', async () => {
  const css = await mobileCss()
  assert.match(css, /\[data-shortcut-modal="settings"\][^{]*\{[^}]*flex-direction: column !important/s)
  assert.match(css, /\[data-shortcut-modal="settings"\][^{]*\{[^}]*max-width: calc\(100vw - 16px\) !important/s)
  assert.match(css, /\[data-shortcut-modal="settings"\] > nav[^{]*\{[^}]*width: 100% !important/s)
  assert.match(css, /\[data-shortcut-modal="settings"\] > nav[^{]*\{[^}]*flex-direction: row !important/s)
})

test('the settings navigation becomes a horizontal, scrollable chip row', async () => {
  const css = await mobileCss()
  assert.match(css, /\[data-shortcut-modal="settings"\] > nav > div:has\(button\)[^{]*\{[^}]*flex-direction: row !important/s)
  assert.match(css, /\[data-shortcut-modal="settings"\] > nav > div:has\(button\)[^{]*\{[^}]*overflow-x: auto !important/s)
  assert.match(css, /\[data-shortcut-modal="settings"\] > nav button[^{]*\{[^}]*flex: 0 0 auto !important/s)
})

test('the settings content column takes the whole width and scrolls', async () => {
  const css = await mobileCss()
  assert.match(css, /\[data-shortcut-modal="settings"\] > div:has\(button\)[^{]*\{[^}]*min-width: 0 !important/s)
  assert.match(css, /\[data-shortcut-modal="settings"\] > div:has\(button\)[^{]*\{[^}]*overflow-y: auto !important/s)
})

test('a phone never zooms because of a control', async () => {
  const css = await mobileCss()
  assert.match(css, /input, textarea, select[^{]*\{[^}]*font-size: 16px !important/s)
  assert.match(css, /button, \[role="button"\], a[^{]*\{[^}]*touch-action: manipulation !important/s)
  assert.match(css, /html[^{]*\{[^}]*-webkit-text-size-adjust: 100% !important/s)
})
