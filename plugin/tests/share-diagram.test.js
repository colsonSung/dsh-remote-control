/**
 * The viewer of a diagram.
 *
 * A drawing is drawn by the library at the size it needs, and the library
 * freezes that size when it draws it: the panel may be wider or narrower than
 * it was at that moment, and the drawing does not follow it. The viewer takes
 * the size into its own hands — the drawing keeps its natural size, and the
 * viewer scales it — so that it follows the panel and can be zoomed into.
 *
 * The viewer travels into the guest page as text: the page has no build step
 * and no module loader. Text that is inlined has no module around it any
 * more, so the code has to stand on its own. The tests therefore read the
 * code as the page reads it: as text, in a scope of its own.
 *
 * Run with: `node --test tests/share-diagram.test.js`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DIAGRAM_CSS, diagramMathBundle, diagramRuntime } from '../src/share-diagram.js'

/**
 * The arithmetic of the viewer, as the page reads it: as text, evaluated in a
 * scope of its own.
 *
 * @returns {{ fitScale: Function, clampScale: Function, zoomScale: Function, scaleLabel: Function, MIN: number, MAX: number, STEP: number }}
 */
function inlinedMath() {
  // eslint-disable-next-line no-new-func
  return new Function(`return (${diagramMathBundle.toString()})()`)()
}

/**
 * The runtime of the viewer, as the page reads it.
 *
 * @returns {{ mount: Function }}
 */
function inlinedRuntime(math) {
  // eslint-disable-next-line no-new-func
  return new Function(`return (${diagramRuntime.toString()})`)()(math)
}

/* ------------------------------------------------------------------ tests */

test('the arithmetic stands on its own, as the page reads it', () => {
  // The page inlines the code as text: a function that called another one
  // would look for a name that is not there any more.
  const math = inlinedMath()
  assert.equal(typeof math.fitScale, 'function')
  assert.equal(typeof math.clampScale, 'function')
  assert.equal(typeof math.zoomScale, 'function')
  assert.equal(typeof math.scaleLabel, 'function')
  // And it still works.
  assert.equal(math.fitScale(1000, 500), 0.5)
  assert.equal(math.zoomScale(1, 2), 2)
  assert.equal(math.scaleLabel(0.375), '38%')
})

test('the runtime stands on its own, as the page reads it', () => {
  const runtime = inlinedRuntime(inlinedMath())
  assert.equal(typeof runtime.mount, 'function')
})

test('a drawing fills the width it is given', () => {
  const math = diagramMathBundle()
  // Wider than its place: it is scaled down to fit.
  assert.equal(math.fitScale(1000, 500), 0.5)
  // Narrower than its place: it keeps its own size, because blowing it up
  // would make its letters larger than the letters around it.
  assert.equal(math.fitScale(300, 500), 1)
  // A width of zero is no width at all: the drawing stays as it is.
  assert.equal(math.fitScale(1000, 0), 1)
  assert.equal(math.fitScale(0, 500), 1)
})

test('a scale never leaves the range a drawing may be read at', () => {
  const math = diagramMathBundle()
  assert.equal(math.clampScale(0.001), math.MIN)
  assert.equal(math.clampScale(1000), math.MAX)
  assert.equal(math.clampScale(0), math.MIN)
  assert.equal(math.clampScale(Number.NaN), math.MIN)
  assert.equal(math.clampScale(1.5), 1.5)
  // One step of the zoom, in and out.
  assert.equal(math.zoomScale(1, math.STEP), math.STEP)
  assert.equal(math.zoomScale(1, 1 / math.STEP), 1 / math.STEP)
  // The step itself is clamped.
  assert.equal(math.zoomScale(math.MAX, 4), math.MAX)
})

test('a few clicks take the reader to a scale they can read', () => {
  const math = diagramMathBundle()
  // A drawing that is much wider than its place is scaled down a long way:
  // the step doubles while the drawing is smaller than its own size.
  assert.equal(math.zoomStep(0.18, true), 0.36)
  assert.equal(math.zoomStep(0.36, true), 0.72)
  // And it stops at the size of the drawing itself.
  assert.equal(math.zoomStep(0.72, true), 1)
  assert.equal(math.zoomStep(1, true), 1.25)
  assert.equal(math.zoomStep(1.25, false), 1)
  assert.equal(math.zoomStep(1, false), 0.5)
  assert.equal(math.zoomStep(0.25, false), 0.125)
  // And it never leaves the range.
  assert.equal(math.zoomStep(math.MAX, true), math.MAX)
  assert.equal(math.zoomStep(math.MIN, false), math.MIN)
})

test('the stylesheet of the viewer uses the tokens of the page', () => {
  // The page owns the palette: the viewer adds no colour of its own.
  assert.match(DIAGRAM_CSS, /var\(--line\)/)
  assert.match(DIAGRAM_CSS, /var\(--surface-2\)/)
  assert.match(DIAGRAM_CSS, /var\(--accent\)/)
  assert.match(DIAGRAM_CSS, /var\(--radius-sm\)/)
  // And no colour of its own.
  assert.doesNotMatch(DIAGRAM_CSS, /#[0-9a-f]{3,8}\b/i)
  assert.doesNotMatch(DIAGRAM_CSS, /\brgba?\(/i)
  // The controls are big enough to hit, and they say what they are.
  assert.match(DIAGRAM_CSS, /\.dsh-diagram-btn\s*\{[^}]*width:\s*24px/)
  assert.match(DIAGRAM_CSS, /\.dsh-diagram-btn:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/)
  // The motion is kept short and it gives way to the reader's wishes.
  assert.match(DIAGRAM_CSS, /prefers-reduced-motion/)
})
