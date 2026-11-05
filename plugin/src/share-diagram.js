/**
 * The viewer of a diagram.
 *
 * A diagram is drawn by the library at the size it needs, and the library
 * freezes that size when it draws: the SVG comes with a maximum width in
 * pixels, and the panel may be wider or narrower than it was at that moment.
 * A diagram in a panel that is later widened therefore stays the size it was
 * drawn at — it does not follow the panel.
 *
 * The viewer takes the size into its own hands: it reads the natural size of
 * the drawing out of its view box, lets the drawing keep it, and scales the
 * drawing itself. The scale follows the width of the panel, and the reader may
 * zoom in and drag the drawing when the whole of it is too much to read at
 * once.
 *
 * The functions here travel into the guest page as text: the page has no
 * build step and no module loader, so the code is inlined into its script.
 * The pure arithmetic is therefore handed to the runtime as an argument — it
 * is written once and tested once.
 */

/**
 * The arithmetic of the viewer, in one piece.
 *
 * The page has no module loader: the code travels into it as text, and text
 * that is inlined has no module around it any more. A function that called
 * another one would therefore look for a name that is not there any more.
 * The arithmetic is therefore written as one factory that returns its own
 * functions, and the page inlines the factory — one piece of text that stands
 * on its own.
 *
 * @returns {{ fitScale: Function, clampScale: Function, zoomScale: Function, scaleLabel: Function, MIN: number, MAX: number, STEP: number }}
 */
export function diagramMathBundle() {
  /** The smallest scale a diagram may be read at. */
  var MIN = 0.1
  /** The largest scale a diagram may be read at. */
  var MAX = 8
  /** One step of the zoom. */
  var STEP = 1.25

  /**
   * The scale at which a drawing fills the width it is given.
   *
   * A drawing that is narrower than its place keeps its own size: blowing a
   * small drawing up to the width of the panel would make its letters larger
   * than the letters of the document around it.
   *
   * @param {number} naturalWidth the width of the drawing
   * @param {number} availableWidth the width it may use
   * @returns {number} the scale
   */
  function fitScale(naturalWidth, availableWidth) {
    if (!(naturalWidth > 0) || !(availableWidth > 0)) return 1
    return Math.min(1, availableWidth / naturalWidth)
  }

  /**
   * Keep a scale inside the range a diagram may be read at.
   *
   * @param {number} scale
   * @returns {number}
   */
  function clampScale(scale) {
    if (!Number.isFinite(scale) || scale <= 0) return MIN
    return Math.min(MAX, Math.max(MIN, scale))
  }

  /**
   * One step of the zoom, in or out.
   *
   * @param {number} current the scale now
   * @param {number} factor the step
   * @returns {number} the scale after the step
   */
  function zoomScale(current, factor) {
    return clampScale(current * factor)
  }

  /**
   * The scale as the reader reads it.
   *
   * @param {number} scale
   * @returns {string}
   */
  function scaleLabel(scale) {
    return `${Math.round(scale * 100)}%`
  }

  /**
   * One step of the zoom, towards a scale the reader can read.
   *
   * A drawing that is much wider than its place is scaled down a long way,
   * and a fixed step would ask for many clicks to reach a scale a person can
   * read. The step therefore doubles while the drawing is smaller than its
   * own size, and grows gently once it is at that size.
   *
   * @param {number} scale the scale now
   * @param {boolean} up whether the reader zooms in
   * @returns {number} the scale after the step
   */
  function zoomStep(scale, up) {
    if (up) {
      if (scale < 1) return clampScale(Math.min(1, scale * 2))
      return clampScale(scale * STEP)
    }
    if (scale > 1) return clampScale(scale / STEP)
    return clampScale(scale / 2)
  }

  return {
    fitScale: fitScale,
    clampScale: clampScale,
    zoomScale: zoomScale,
    zoomStep: zoomStep,
    scaleLabel: scaleLabel,
    MIN: MIN,
    MAX: MAX,
    STEP: STEP,
  }
}

/**
 * The arithmetic of the viewer, as the host reads it.
 */
export const diagramMath = diagramMathBundle()

/**
 * The stylesheet of the viewer.
 *
 * The page owns the palette: the viewer uses the tokens of the page and adds
 * no colour of its own. The controls are quiet — a diagram is the content —
 * and they use one icon family, drawn as paths.
 */
export const DIAGRAM_CSS = `
.dsh-diagram {
  margin: 0 0 12px; border: 1px solid var(--line); border-radius: var(--radius-sm);
  background: var(--surface-2); overflow: hidden;
}
.dsh-diagram-bar {
  display: flex; align-items: center; gap: 4px; padding: 4px 8px;
  border-bottom: 1px solid var(--line); background: var(--surface);
}
.dsh-diagram-btn {
  width: 24px; height: 24px; display: grid; place-items: center; padding: 0;
  border: 1px solid transparent; border-radius: var(--radius-sm);
  background: transparent; color: var(--muted); cursor: pointer;
}
.dsh-diagram-btn:hover { background: var(--surface-3); color: var(--text); }
.dsh-diagram-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; color: var(--text); }
.dsh-diagram-btn svg { display: block; }
.dsh-diagram-scale {
  min-width: 46px; padding: 0 4px; text-align: center;
  font-size: 11px; line-height: 1.4; color: var(--faint); font-variant-numeric: tabular-nums;
}
.dsh-diagram-spacer { flex: 1; }
.dsh-diagram-hint {
  padding-right: 4px; font-size: 11px; line-height: 1.4; color: var(--faint);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dsh-diagram-viewport {
  overflow: auto; max-height: 68vh; padding: 0; cursor: grab;
  touch-action: pan-x pan-y; overscroll-behavior: contain;
}
.dsh-diagram-viewport[data-panning="true"] { cursor: grabbing; }
.dsh-diagram-viewport:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.dsh-diagram-canvas { padding: 12px; width: max-content; }
.dsh-diagram-content { transform-origin: 0 0; width: max-content; }
.dsh-diagram-content svg { display: block; max-width: none !important; }
@media (prefers-reduced-motion: no-preference) {
  .dsh-diagram-content { transition: transform .12s cubic-bezier(.23,1,.32,1); }
}
`

/**
 * The runtime of the viewer.
 *
 * It is written as one function so that it can travel into the page as text.
 * Everything it needs comes with it: the arithmetic is handed in, and the
 * rest it builds itself.
 *
 * @param {{ fitScale: Function, clampScale: Function, zoomScale: Function, scaleLabel: Function }} math
 * @returns {{ mount: (holder: any, svg: any) => any }}
 */
export function diagramRuntime(math) {
  /** The space around the drawing inside the viewport, in pixels. */
  var GUTTER = 24

  /** The icons of the controls, drawn as paths so that they follow the theme. */
  var ICONS = {
    out: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.2" stroke="currentColor" stroke-width="1.3"/><path d="M10.2 10.2 14 14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M5.4 7h3.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    in: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.2" stroke="currentColor" stroke-width="1.3"/><path d="M10.2 10.2 14 14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M5.4 7h3.2M7 5.4v3.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    fit: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  }

  /**
   * The natural size of a drawing.
   *
   * The library writes the size into the view box of the drawing; that is
   * the size it drew for, and the size the reader may ask for with "1:1".
   *
   * @param {any} svg
   * @returns {{ width: number, height: number }}
   */
  function naturalSize(svg) {
    var box = null
    try {
      box = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : null
    } catch (error) {
      box = null
    }
    var width = box && box.width > 0 ? box.width : parseFloat(svg.getAttribute('width')) || 0
    var height = box && box.height > 0 ? box.height : parseFloat(svg.getAttribute('height')) || 0
    if (!(width > 0) || !(height > 0)) {
      var rect = svg.getBoundingClientRect()
      width = rect.width
      height = rect.height
    }
    return { width: width, height: height }
  }

  /**
   * Build the viewer of one drawing.
   *
   * @param {any} holder the element the drawing sits in
   * @param {any} svg the drawing
   * @returns {any} the figure, or null when the drawing has no size
   */
  function mount(holder, svg) {
    if (holder === null || holder === undefined || svg === null || svg === undefined) return null
    var natural = naturalSize(svg)
    if (!(natural.width > 0) || !(natural.height > 0)) return null

    // The size is ours now. The library froze a maximum width when it drew
    // the diagram, and the panel is not always the width it was then.
    svg.style.maxWidth = 'none'
    svg.style.width = natural.width + 'px'
    svg.style.height = natural.height + 'px'
    svg.removeAttribute('width')
    svg.removeAttribute('height')

    var figure = document.createElement('figure')
    figure.className = 'dsh-diagram'

    var bar = document.createElement('div')
    bar.className = 'dsh-diagram-bar'

    var readout = document.createElement('span')
    readout.className = 'dsh-diagram-scale'
    readout.setAttribute('role', 'status')
    readout.setAttribute('aria-live', 'polite')

    var viewport = document.createElement('div')
    viewport.className = 'dsh-diagram-viewport'
    viewport.tabIndex = 0
    viewport.setAttribute('role', 'img')
    viewport.setAttribute('aria-label', 'A diagram. It can be zoomed and dragged.')

    var canvas = document.createElement('div')
    canvas.className = 'dsh-diagram-canvas'
    var content = document.createElement('div')
    content.className = 'dsh-diagram-content'
    content.appendChild(svg)
    canvas.appendChild(content)
    viewport.appendChild(canvas)

    var scale = 1
    var follows = true
    var hint = null

    /**
     * The width the drawing may use.
     * @returns {number}
     */
    var available = function () {
      return Math.max(80, viewport.clientWidth - GUTTER)
    }

    /**
     * Put the drawing at a scale.
     *
     * @param {number} next
     */
    var apply = function (next) {
      scale = math.clampScale(next)
      content.style.transform = 'scale(' + scale + ')'
      canvas.style.width = Math.round(natural.width * scale) + 'px'
      canvas.style.height = Math.round(natural.height * scale) + 'px'
      readout.textContent = math.scaleLabel(scale)
      // The hint appears when there is something to drag: a drawing that
      // fits its place needs no advice.
      if (hint !== null) {
        hint.hidden = !(
          canvas.offsetWidth > viewport.clientWidth ||
          canvas.offsetHeight > viewport.clientHeight
        )
      }
    }

    /**
     * Fit the drawing to the width of the panel.
     */
    var fit = function () {
      follows = true
      apply(math.fitScale(natural.width, available()))
    }

    /**
     * Zoom to a scale of the reader's own choosing.
     *
     * @param {number} next the scale to go to
     * @param {number} [atX] the point of the zoom, in the viewport
     * @param {number} [atY]
     */
    var zoomTo = function (next, atX, atY) {
      follows = false
      var before = scale
      next = math.clampScale(next)
      if (next === before) return
      if (typeof atX === 'number' && typeof atY === 'number') {
        // The point under the pointer stays under the pointer.
        var contentX = (atX + viewport.scrollLeft) / before
        var contentY = (atY + viewport.scrollTop) / before
        apply(next)
        viewport.scrollLeft = contentX * next - atX
        viewport.scrollTop = contentY * next - atY
        return
      }
      apply(next)
    }

    /**
     * Zoom by a factor, as the wheel does it.
     *
     * @param {number} factor
     * @param {number} [atX]
     * @param {number} [atY]
     */
    var zoom = function (factor, atX, atY) {
      zoomTo(math.zoomScale(scale, factor), atX, atY)
    }

    /**
     * Zoom to the next scale the reader can read.
     *
     * @param {number} next
     */
    var zoomBy = function (next) {
      zoomTo(next)
    }

    /**
     * A control of the bar.
     *
     * @param {string} icon
     * @param {string} label
     * @param {Function} onClick
     * @returns {any}
     */
    var button = function (icon, label, onClick) {
      var node = document.createElement('button')
      node.className = 'dsh-diagram-btn'
      node.type = 'button'
      node.setAttribute('aria-label', label)
      node.title = label
      node.innerHTML = icon
      node.addEventListener('click', function (event) {
        event.preventDefault()
        onClick()
      })
      return node
    }

    bar.appendChild(button(ICONS.out, 'Zoom out', function () { zoomBy(math.zoomStep(scale, false)) }))
    bar.appendChild(button(ICONS.in, 'Zoom in', function () { zoomBy(math.zoomStep(scale, true)) }))
    bar.appendChild(readout)
    bar.appendChild(button(ICONS.fit, 'Fit to the width', fit))

    var spacer = document.createElement('span')
    spacer.className = 'dsh-diagram-spacer'
    bar.appendChild(spacer)

    hint = document.createElement('span')
    hint.className = 'dsh-diagram-hint'
    hint.textContent = 'Drag to move'
    hint.hidden = true
    bar.appendChild(hint)

    figure.appendChild(bar)
    figure.appendChild(viewport)

    if (holder.parentNode !== null) holder.parentNode.replaceChild(figure, holder)

    // The panel can be resized and it can take the whole page: the drawing
    // follows the width of the panel as long as the reader has not zoomed.
    if (typeof ResizeObserver === 'function') {
      var observer = new ResizeObserver(function () {
        if (follows) fit()
      })
      observer.observe(viewport)
    } else {
      window.addEventListener('resize', function () {
        if (follows) fit()
      })
    }

    // A drag moves the drawing when it is larger than the viewport.
    var dragging = false
    var lastX = 0
    var lastY = 0
    viewport.addEventListener('pointerdown', function (event) {
      if (event.button !== 0) return
      if (viewport.scrollWidth <= viewport.clientWidth && viewport.scrollHeight <= viewport.clientHeight) return
      dragging = true
      lastX = event.clientX
      lastY = event.clientY
      viewport.setAttribute('data-panning', 'true')
      if (typeof viewport.setPointerCapture === 'function') {
        try { viewport.setPointerCapture(event.pointerId) } catch (error) { /* the browser decides */ }
      }
    })
    viewport.addEventListener('pointermove', function (event) {
      if (!dragging) return
      viewport.scrollLeft -= event.clientX - lastX
      viewport.scrollTop -= event.clientY - lastY
      lastX = event.clientX
      lastY = event.clientY
    })
    var stopDragging = function () {
      if (!dragging) return
      dragging = false
      viewport.removeAttribute('data-panning')
    }
    viewport.addEventListener('pointerup', stopDragging)
    viewport.addEventListener('pointercancel', stopDragging)

    // The wheel zooms when the reader asks for it with the keyboard held
    // down; otherwise it scrolls, as it does everywhere else.
    viewport.addEventListener('wheel', function (event) {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      var rect = viewport.getBoundingClientRect()
      var factor = event.deltaY < 0 ? 1.1 : 1 / 1.1
      zoom(factor, event.clientX - rect.left, event.clientY - rect.top)
    }, { passive: false })

    // The keyboard reaches the drawing as well.
    viewport.addEventListener('keydown', function (event) {
      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        zoomBy(math.zoomStep(scale, true))
        return
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        zoomBy(math.zoomStep(scale, false))
        return
      }
      if (event.key === '0') {
        event.preventDefault()
        fit()
      }
    })

    fit()
    return figure
  }

  return { mount: mount }
}
