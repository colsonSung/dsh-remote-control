/**
 * Client half of `dsh-remote-control`: the Settings page named
 * "Remote Control".
 *
 * The page mirrors Kimi Code's panel — a switch, a QR code that carries the
 * access URL, a copy/open pair, a security note, and a "Remote device
 * management" list — and talks to the Host over the generic Connection RPC
 * channel `/remote-control`.
 *
 * The file also carries the browser half of the compressed stream protocol:
 * a WebSocket shim that inflates a compressed Remote stream payload before
 * the app reads it. It is installed while this bundle script runs, because
 * the app opens its stream socket before the plugin factories run.
 */

/* --------------------------------------------------------------- shim start */

/**
 * The browser half of the compressed stream protocol.
 *
 * The Host compresses a big Remote stream payload and sends it as one
 * binary WebSocket message that starts with the ASCII marker `DSHRC1`.
 * The app's own stream client only reads text messages, so the phone
 * inflates the payload before the app sees it.
 *
 * The shim lives in a function of its own: the file may be evaluated
 * twice in one page, and a top level `const` would throw the second time.
 */
function remoteControlStreamShim() {
  /* ------------------------------------------------- compressed stream shim */

  /* contract:begin — written by tools/sync-contract.js from src/relay-protocol.js */
  /**
   * The marker that opens a compressed WebSocket payload.
   *
   * A copy of `COMPRESSED_WS_PREFIX` from `src/relay-protocol.js`: the
   * browser half cannot import the Node-side protocol module, so the copy is
   * generated from it (`node tools/sync-contract.js`) and checked by
   * `tests/protocol-contract.test.js`.
   */
  const COMPRESSED_WS_PREFIX = 'DSHRC1'

  /**
   * The query parameter a phone adds to its stream URL to announce that it
   * can inflate a compressed payload.
   *
   * A copy of `COMPRESSION_QUERY` from `src/relay-protocol.js`.
   */
  const COMPRESSION_QUERY = 'rcz'
  /* contract:end */

  /** The exact route the app opens for its Remote stream. */
  const MUX_PATH = '/api/remote.mux'

  /** The ASCII bytes of the marker, as the host writes them. */
  const COMPRESSED_MARKER_BYTES = new Uint8Array(
    Array.from(COMPRESSED_WS_PREFIX, (character) => character.charCodeAt(0)),
  )

  /**
   * The guard that keeps a second evaluation of this file harmless.
   *
   * A global registry symbol: the module scope is new on every evaluation,
   * the symbol is the same in every one of them.
   */
  const COMPRESSED_SOCKET_FLAG = Symbol.for('dsh.remote-control.compressed-stream-socket')

  /**
   * Where the installer is published, so the factory body can call it.
   *
   * A global registry symbol, for the same reason as the guard above.
   */
  const COMPRESSED_SOCKET_INSTALLER = Symbol.for('dsh.remote-control.compressed-stream-socket.install')

  /** How long a pending payload may hold back the close event. */
  const CLOSE_FLUSH_TIMEOUT = 10000

  /**
   * Describe one socket URL: the URL to open, and whether it is the Remote
   * stream route.
   *
   * Every other socket keeps the URL it was given.
   *
   * @param {string | URL} url
   * @returns {{ url: string, mux: boolean }}
   */
  function describeSocketUrl(url) {
    const raw = typeof url === 'string' ? url : String(url)
    let parsed
    try {
      parsed = new URL(raw)
    } catch {
      return { url: raw, mux: false }
    }
    if (!parsed.pathname.endsWith(MUX_PATH)) return { url: raw, mux: false }
    // The announcement is a promise: this browser can inflate what the host
    // sends. A browser without DecompressionStream keeps the payload as it
    // is, so it must not ask for a compressed one.
    if (!canInflatePayload()) return { url: raw, mux: true }
    return { url: appendCompressionQuery(raw, parsed), mux: true }
  }

  /**
   * Can this browser inflate a compressed payload?
   *
   * @returns {boolean}
   */
  function canInflatePayload() {
    return typeof DecompressionStream === 'function'
  }

  /**
   * Add the compression announcement to a stream URL.
   *
   * The URL keeps everything it carried; only the query grows, and a URL
   * that already carries the announcement keeps it as it is.
   *
   * @param {string} raw the URL as it was given
   * @param {URL} parsed the parsed URL
   * @returns {string}
   */
  function appendCompressionQuery(raw, parsed) {
    if (parsed.searchParams.has(COMPRESSION_QUERY)) return raw
    const hashIndex = raw.indexOf('#')
    const hash = hashIndex === -1 ? '' : raw.slice(hashIndex)
    const withoutHash = hashIndex === -1 ? raw : raw.slice(0, hashIndex)
    const queryIndex = withoutHash.indexOf('?')
    const path = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex)
    const query = queryIndex === -1 ? '' : withoutHash.slice(queryIndex + 1)
    const announcement = `${COMPRESSION_QUERY}=1`
    const next = query.length === 0 ? announcement : `${query}&${announcement}`
    return `${path}?${next}${hash}`
  }

  /**
   * The bytes of one binary message.
   *
   * @param {unknown} data the raw event data
   * @returns {Promise<Uint8Array | undefined>} undefined when the data is not binary
   */
  async function binaryBytes(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data)
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      return new Uint8Array(await data.arrayBuffer())
    }
    return undefined
  }

  /**
   * Does this payload carry the compressed marker?
   *
   * @param {Uint8Array} bytes
   * @returns {boolean}
   */
  function hasCompressedMarker(bytes) {
    if (bytes.length < COMPRESSED_MARKER_BYTES.length) return false
    for (let index = 0; index < COMPRESSED_MARKER_BYTES.length; index += 1) {
      if (bytes[index] !== COMPRESSED_MARKER_BYTES[index]) return false
    }
    return true
  }

  /**
   * Inflate one gzip payload into text.
   *
   * @param {Uint8Array} bytes the gzip bytes
   * @returns {Promise<string>}
   */
  async function inflateGzip(bytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('this browser cannot inflate a compressed payload')
    }
    const stream = new DecompressionStream('gzip')
    const writer = stream.writable.getWriter()
    const writing = (async () => {
      await writer.write(bytes)
      await writer.close()
    })()
    const reading = (async () => {
      const reader = stream.readable.getReader()
      const chunks = []
      for (;;) {
        const result = await reader.read()
        if (result.done) break
        chunks.push(result.value)
      }
      return chunks
    })()
    // Both sides run at the same time: the write only finishes when the
    // read drains the stream.
    writing.catch(() => undefined)
    reading.catch(() => undefined)
    const [, chunks] = await Promise.all([writing, reading])
    let length = 0
    for (const chunk of chunks) length += chunk.length
    const out = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return new TextDecoder('utf-8').decode(out)
  }

  /**
   * Is this byte part of a base64 alphabet?
   *
   * @param {number} byte
   * @returns {boolean}
   */
  function isBase64Byte(byte) {
    if (byte >= 0x41 && byte <= 0x5a) return true
    if (byte >= 0x61 && byte <= 0x7a) return true
    if (byte >= 0x30 && byte <= 0x39) return true
    return byte === 0x2b || byte === 0x2f
  }

  /**
   * Read ASCII bytes as a string.
   *
   * The conversion runs in chunks: a payload of a few hundred kilobytes
   * would blow the argument limit of a single call.
   *
   * @param {Uint8Array} bytes
   * @returns {string}
   */
  function binaryBytesToString(bytes) {
    let text = ''
    const chunk = 8192
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      text += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk))
    }
    return text
  }

  /**
   * Decode one base64 payload into bytes.
   *
   * @param {Uint8Array} bytes the ASCII base64 text
   * @returns {Uint8Array}
   */
  function base64ToBytes(bytes) {
    const text = binaryBytesToString(bytes)
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(text)
    const binary = atob(text)
    const out = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      out[index] = binary.charCodeAt(index)
    }
    return out
  }

  /**
   * The base64 fallback of an older relay.
   *
   * A relay that guesses the encoding of a frame hands the phone the base64
   * *text* of a binary payload instead of the bytes, because gzip bytes are
   * not valid UTF-8. The phone decodes the text and inflates it.
   *
   * The guess stays strict: a payload that is not base64, that does not
   * carry the marker, or that does not inflate, is none of our business and
   * is delivered as it came.
   *
   * @param {Uint8Array} bytes
   * @returns {Promise<string | undefined>}
   */
  async function decodeBase64Payload(bytes) {
    if (bytes.length === 0 || bytes.length % 4 !== 0) return undefined
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index]
      // The padding may only sit at the very end.
      if (byte === 0x3d && index >= bytes.length - 2) continue
      if (!isBase64Byte(byte)) return undefined
    }
    let decoded
    try {
      decoded = base64ToBytes(bytes)
    } catch {
      return undefined
    }
    if (!hasCompressedMarker(decoded)) return undefined
    try {
      return await inflateGzip(decoded.subarray(COMPRESSED_MARKER_BYTES.length))
    } catch {
      return undefined
    }
  }

  /**
   * Decode one socket payload.
   *
   * @param {unknown} data the raw event data
   * @returns {Promise<{ passThrough: true } | { text: string } | undefined>} undefined drops the message
   */
  async function decodeSocketPayload(data) {
    if (typeof data === 'string') return { passThrough: true }
    const bytes = await binaryBytes(data)
    if (bytes === undefined) return { passThrough: true }
    if (hasCompressedMarker(bytes)) {
      try {
        return { text: await inflateGzip(bytes.subarray(COMPRESSED_MARKER_BYTES.length)) }
      } catch (error) {
        console.warn('[remote-control] failed to inflate a compressed stream payload', error)
        return undefined
      }
    }
    const text = await decodeBase64Payload(bytes)
    if (text === undefined) return { passThrough: true }
    return { text }
  }

  /**
   * The same event, carrying the decoded text.
   *
   * The original event is reused when the browser allows it: it keeps the
   * origin, the timestamp and the target the browser set on it.
   *
   * @param {MessageEvent} event
   * @param {string} text
   * @returns {MessageEvent}
   */
  function withEventData(event, text) {
    try {
      Object.defineProperty(event, 'data', { value: text, configurable: true, enumerable: true, writable: true })
      return event
    } catch {
      return new MessageEvent('message', {
        data: text,
        origin: event.origin,
        lastEventId: event.lastEventId,
        source: event.source,
        ports: event.ports,
      })
    }
  }

  /**
   * Install the shim that inflates a compressed stream payload.
   *
   * The guard on `window` keeps a second call harmless: the file may be
   * evaluated twice in one page, and the shim may only be installed once.
   *
   * @returns {void}
   */
  function installCompressedStreamSocket() {
    if (window[COMPRESSED_SOCKET_FLAG] === true) return
    const OriginalWebSocket = window.WebSocket
    if (typeof OriginalWebSocket !== 'function') return

    /**
     * One WebSocket that can inflate a compressed stream payload.
     *
     * Every socket behaves exactly like the native one. Only the Remote
     * stream route changes: it announces that it can inflate a compressed
     * payload, and it turns a compressed binary message back into the text
     * the app expects.
     */
    class CompressedStreamSocket extends OriginalWebSocket {
      /**
       * @param {string | URL} url
       * @param {string | string[]} [protocols]
       */
      constructor(url, protocols) {
        const target = describeSocketUrl(url)
        super(target.url, protocols)
        /** Whether this socket carries the Remote stream. @type {boolean} */
        this._rcMux = target.mux
        /** The listeners of this socket, by event type. @type {Map<string, object[]>} */
        this._rcListeners = new Map()
        /** The delivery chain: one link per message that waits. @type {Promise<void>} */
        this._rcChain = Promise.resolve()
        /** How many messages wait for their turn. @type {number} */
        this._rcPending = 0
        /** The `onmessage` handler of this socket. @type {Function | null} */
        this._rcOnMessage = null
        /** The `onclose` handler of this socket. @type {Function | null} */
        this._rcOnClose = null
        /** The close event, waiting for the pending payloads. @type {CloseEvent | undefined} */
        this._rcCloseEvent = undefined
        /** The guard that delivers the close event once. @type {boolean} */
        this._rcCloseFlushed = false
        /** The timer that releases the close event. @type {any} */
        this._rcCloseTimer = undefined
        if (target.mux !== true) return
        // A compressed payload is binary, and the marker has to be readable
        // from its first bytes.
        this.binaryType = 'arraybuffer'
        super.addEventListener('message', (event) => { this._rcReceive(event) })
        super.addEventListener('close', (event) => { this._rcClosed(event) })
      }

      /**
       * Register a listener.
       *
       * @param {string} type
       * @param {EventListenerOrEventListenerObject | null} listener
       * @param {boolean | AddEventListenerOptions} [options]
       * @returns {void}
       */
      addEventListener(type, listener, options) {
        if (this._rcMux === true && (type === 'message' || type === 'close')) {
          this._rcAdd(type, listener, options)
          return
        }
        super.addEventListener(type, listener, options)
      }

      /**
       * Remove a listener.
       *
       * @param {string} type
       * @param {EventListenerOrEventListenerObject | null} listener
       * @param {boolean | EventListenerOptions} [options]
       * @returns {void}
       */
      removeEventListener(type, listener, options) {
        if (this._rcMux === true && (type === 'message' || type === 'close')) {
          this._rcRemove(type, listener, options)
          return
        }
        super.removeEventListener(type, listener, options)
      }

      /** @returns {Function | null} */
      get onmessage() {
        if (this._rcMux === true) return this._rcOnMessage
        return super.onmessage
      }

      /** @param {Function | null} value */
      set onmessage(value) {
        if (this._rcMux === true) {
          this._rcOnMessage = typeof value === 'function' ? value : null
          return
        }
        super.onmessage = value
      }

      /** @returns {Function | null} */
      get onclose() {
        if (this._rcMux === true) return this._rcOnClose
        return super.onclose
      }

      /** @param {Function | null} value */
      set onclose(value) {
        if (this._rcMux === true) {
          this._rcOnClose = typeof value === 'function' ? value : null
          return
        }
        super.onclose = value
      }

      /**
       * Add one listener of a rewritten event type.
       *
       * @param {string} type
       * @param {EventListenerOrEventListenerObject | null} listener
       * @param {boolean | AddEventListenerOptions} [options]
       * @returns {void}
       */
      _rcAdd(type, listener, options) {
        if (listener === null || listener === undefined) return
        const capture = typeof options === 'boolean' ? options : options?.capture === true
        const once = options?.once === true
        const signal = options?.signal
        const entries = this._rcEntries(type)
        // The DOM ignores a second registration of the same listener for
        // the same capture flag.
        if (entries.some((entry) => entry.listener === listener && entry.capture === capture)) return
        entries.push({ type, listener, capture, once })
        this._rcListeners.set(type, entries)
        if (signal === undefined || signal === null) return
        if (signal.aborted === true) {
          this._rcRemove(type, listener, capture)
          return
        }
        signal.addEventListener('abort', () => { this._rcRemove(type, listener, capture) }, { once: true })
      }

      /**
       * Remove one listener of a rewritten event type.
       *
       * @param {string} type
       * @param {EventListenerOrEventListenerObject | null} listener
       * @param {boolean | EventListenerOptions} [options]
       * @returns {void}
       */
      _rcRemove(type, listener, options) {
        const capture = typeof options === 'boolean' ? options : options?.capture === true
        const entries = this._rcListeners.get(type)
        if (entries === undefined) return
        const index = entries.findIndex((entry) => entry.listener === listener && entry.capture === capture)
        if (index === -1) return
        entries.splice(index, 1)
      }

      /**
       * The listeners of one event type.
       *
       * @param {string} type
       * @returns {object[]}
       */
      _rcEntries(type) {
        const entries = this._rcListeners.get(type)
        return entries === undefined ? [] : [...entries]
      }

      /**
       * Call one listener.
       *
       * @param {object} entry
       * @param {Event} event
       * @returns {void}
       */
      _rcInvoke(entry, event) {
        if (entry.once === true) this._rcRemove(entry.type, entry.listener, entry.capture)
        const listener = entry.listener
        if (typeof listener === 'function') {
          listener.call(this, event)
          return
        }
        if (typeof listener?.handleEvent === 'function') listener.handleEvent(event)
      }

      /**
       * Handle one native message event.
       *
       * @param {MessageEvent} event
       * @returns {void}
       */
      _rcReceive(event) {
        // A text message needs no work, and the common case stays
        // synchronous: the app reads the frame right away.
        if (typeof event.data === 'string' && this._rcPending === 0) {
          this._rcDeliver(event)
          return
        }
        this._rcEnqueue(event)
      }

      /**
       * Put one message behind the ones that wait for their turn.
       *
       * @param {MessageEvent} event
       * @returns {void}
       */
      _rcEnqueue(event) {
        this._rcPending += 1
        this._rcChain = this._rcChain
          .then(() => this._rcProcess(event))
          .catch((error) => {
            console.warn('[remote-control] failed to read a stream payload', error)
          })
          .then(() => {
            this._rcPending -= 1
          })
      }

      /**
       * Decode one message and hand it to the listeners.
       *
       * @param {MessageEvent} event
       * @returns {Promise<void>}
       */
      async _rcProcess(event) {
        const decoded = await decodeSocketPayload(event.data)
        if (decoded === undefined) return
        if (decoded.passThrough === true) {
          this._rcDeliver(event)
          return
        }
        this._rcDeliver(event, decoded.text)
      }

      /**
       * Hand one message to the listeners of this socket.
       *
       * @param {MessageEvent} event
       * @param {string} [text] the decoded text; the event keeps its own data when omitted
       * @returns {void}
       */
      _rcDeliver(event, text) {
        const delivery = text === undefined ? event : withEventData(event, text)
        for (const entry of this._rcEntries('message')) {
          this._rcInvoke(entry, delivery)
        }
        if (this._rcOnMessage !== null) this._rcOnMessage.call(this, delivery)
      }

      /**
       * Handle the native close event.
       *
       * The close waits for the payloads that are still on their way: the
       * browser delivers every message it received before the close, and
       * the app reads its last frame there.
       *
       * @param {CloseEvent} event
       * @returns {void}
       */
      _rcClosed(event) {
        this._rcCloseEvent = event
        const flush = () => { this._rcFlushClose() }
        this._rcChain.then(flush, flush)
        // A payload that never arrives must not keep the close hostage.
        this._rcCloseTimer = window.setTimeout(flush, CLOSE_FLUSH_TIMEOUT)
      }

      /**
       * Deliver the close event to the listeners of this socket.
       *
       * @returns {void}
       */
      _rcFlushClose() {
        if (this._rcCloseFlushed === true) return
        this._rcCloseFlushed = true
        if (this._rcCloseTimer !== undefined) {
          window.clearTimeout(this._rcCloseTimer)
          this._rcCloseTimer = undefined
        }
        const event = this._rcCloseEvent
        if (event === undefined) return
        for (const entry of this._rcEntries('close')) {
          this._rcInvoke(entry, event)
        }
        if (this._rcOnClose !== null) this._rcOnClose.call(this, event)
      }
    }

    window[COMPRESSED_SOCKET_FLAG] = true
    window.WebSocket = CompressedStreamSocket
  }

  // The shim has to be in place before the app opens its stream socket.
  //
  // The client module loader runs a plugin bundle in two steps: executing the
  // bundle script only REGISTERS the factory, and the factory runs later, when
  // the entry is materialized. The stream socket is opened while the app's own
  // modules are materialized, so a shim installed from the factory alone can be
  // too late. Installing it here, at the moment the bundle script executes, is
  // early enough: the loader fetches and runs the bundle of every plugin that
  // declares `dsh.client.immediately` before it materializes any entry, and
  // this plugin declares it.
  //
  // The factory body calls the installer as well; the guard on `window` makes
  // that second call a no-op.
  window[COMPRESSED_SOCKET_INSTALLER] = installCompressedStreamSocket
  installCompressedStreamSocket()
}

remoteControlStreamShim()

/* ---------------------------------------------------------------- shim end */

/* -------------------------------------------------------------- layout */

/**
 * The mobile layout of the sidebar.
 *
 * Below 1024px the app keeps the expanded sidebar as a column beside the
 * conversation, which leaves the conversation a sliver: on a 393px phone the
 * sidebar takes 280px and the conversation the remaining 113px. On a phone an
 * expanded sidebar covers the whole screen instead - the frame gives the
 * sidebar every pixel and the conversation goes behind it, where the sidebar's
 * own collapse control brings it back.
 *
 * The rule is written against the shell's own attributes
 * (`data-shell-overlay` and `data-sidebar-collapsed`), not against the
 * build's hashed class names, so it survives a release. If the frame ever
 * changes shape, the selector simply stops matching and the app keeps its own
 * layout.
 *
 * @returns {void}
 */
function installMobileSidebarLayout() {
  if (typeof document === 'undefined' || document.head === null) return
  const id = 'dsh-remote-control-mobile-layout'
  if (document.getElementById(id) !== null) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = [
    '@media (max-width: 1023px) {',
    '  /* The expanded sidebar takes the whole screen: the frame gives it every',
    '     pixel and the conversation goes behind it.',
    '     A frame that already carries the sidebar-appearance drawer (`sa-frame`)',
    '     belongs to that plugin: it positions the column itself, so this grid',
    '     stays only as the fallback for a profile without that plugin. Two',
    '     plugins stretching the same column makes the layout depend on',
    '     stylesheet order, which is not worth keeping. */',
    '  :has(> [data-shell-overlay]):not([data-sidebar-collapsed]):not(.sa-frame) {',
    '    grid-template-columns: 100% 0 0 !important;',
    '  }',
    '  /* The drawer is the whole screen now: its resize handle has nothing',
    '     to resize and would sit in the middle of the phone. */',
    '  :has(> [data-shell-overlay]):not([data-sidebar-collapsed]) > [data-side="sidebar"] {',
    '    display: none !important;',
    '  }',
    '  /* The shell\'s own open and collapse controls are 28px glyphs in a',
    '     corner. On a phone they get a visible surface and a bigger touch',
    '     target - without moving, so the control next to them keeps its',
    '     place. */',
    '  [data-dsh-sidebar-toggle] {',
    '    position: relative !important;',
    '    background: var(--dsw-alias-interactive-bg-hover) !important;',
    '    border-radius: var(--dsw-radius-md) !important;',
    '  }',
    '  [data-dsh-sidebar-toggle]::after {',
    '    content: "";',
    '    position: absolute;',
    '    inset: -8px;',
    '  }',
    '}',
  ].join('\n')
  document.head.appendChild(style)
}

// The layout rule is independent of the shim: it only needs the document.
installMobileSidebarLayout()

/** Where the control marker is published, so a test can drive it. */
const SIDEBAR_CONTROL_MARKER = Symbol.for('dsh.remote-control.mark-sidebar-controls')

/**
 * Mark the shell's own sidebar controls on a phone.
 *
 * The shell has both controls already - the panel icon in the expanded
 * sidebar's top strip and the brand mark in the collapsed rail - but on a
 * phone they are 28px glyphs in a corner, which is easy to walk past. The
 * rules below make them unmistakable there and leave the desktop alone.
 *
 * The buttons are found by the accessible name the shell gives them, so no
 * build-hashed class name is involved.
 *
 * @param {string} collapseLabel the shell's label for the collapse control
 * @param {string} openLabel the shell's label for the open control
 * @returns {void}
 */
function markSidebarControls(collapseLabel, openLabel) {
  if (typeof document === 'undefined') return
  const narrow = window.matchMedia('(max-width: 1023px)').matches
  // The shell may append the shortcut to the name, so a prefix counts too -
  // but only the name itself, so the right sidebar's own button is not caught.
  const is = (label, expected) => label === expected || label.startsWith(`${expected} `)
  for (const element of document.querySelectorAll('button[aria-label]')) {
    const label = element.getAttribute('aria-label') ?? ''
    if (is(label, collapseLabel)) element.setAttribute('data-dsh-sidebar-toggle', 'collapse')
    else if (is(label, openLabel)) element.setAttribute('data-dsh-sidebar-toggle', 'open')
    else if (element.hasAttribute('data-dsh-sidebar-toggle')) {
      element.removeAttribute('data-dsh-sidebar-toggle')
    }
  }
  // The rules are phone-only, so the markers are only worth keeping there.
  if (!narrow) {
    for (const element of document.querySelectorAll('[data-dsh-sidebar-toggle]')) {
      element.removeAttribute('data-dsh-sidebar-toggle')
    }
  }
}

window[SIDEBAR_CONTROL_MARKER] = markSidebarControls

window.__ModuleLoader__.load({
  id: 'dsh-remote-control',
  factory(require) {
    // The shim was installed while this bundle script ran, which is early
    // enough: the app opens its stream socket only after the client module
    // loader has loaded every plugin module. The call below keeps the
    // guarantee inside the factory as well; the guard makes it a no-op.
    window[Symbol.for('dsh.remote-control.compressed-stream-socket.install')]?.()

    const React = require('react')
    const h = React.createElement

    /** The locale namespace this page owns. */
    const NS = 'remote-control'

    /** The exact Fetch route the Host serves. */
    const ROUTE = '/api/remote-control'

    const DICTIONARY = {
      en: {
        nav: 'Remote Control',
        title: 'Remote Control',
        subtitle: 'Once turned on, open the link on another device to control the agent on this computer',
        on: 'Remote Control is on',
        off: 'Remote Control is off',
        qrCaption: 'Scan with your phone to open',
        copyLink: 'Copy link',
        copied: 'Copied',
        openLink: 'Open link',
        security: 'Keep this computer awake and online. The phone asks for the access code before it can control this agent — share neither the link nor the code.',
        passcode: 'Access code',
        passcodeHint: 'The phone must type this 8-digit code once before it can control the agent. It never travels in the link.',
        copyPasscode: 'Copy code',
        rotatePasscode: 'Change code',
        passcodeRotated: 'A new access code is in use; the old one no longer works.',
        phones: 'Devices that connected',
        phonesHint: 'A device that is trusted skips the access code from then on.',
        phoneTrusted: 'Trusted',
        phoneTrust: 'Trust this device',
        phoneLastSeen: 'Last seen',
        phoneFirstSeen: 'First seen',
        removePhone: 'Remove device',
        removePhoneConfirm: 'Remove this device? It will have to enter the access code again.',
        phoneRemoved: 'The device was removed.',
        devices: 'Remote device management',
        refresh: 'Refresh',
        thisComputer: 'This computer',
        online: 'Online',
        offline: 'Offline',
        rename: 'Rename',
        takeOffline: 'Take offline',
        takeOfflineHint: 'Disconnects it now; it reconnects on its own.',
        revoke: 'Revoke access',
        revokeHint: 'Refuses this device until you restore it.',
        restore: 'Restore access',
        restoreHint: 'Lets the device register again.',
        revoked: 'Revoked',
        renamed: 'Device renamed',
        takenOffline: 'Device taken offline',
        failed: 'Remote control failed',
        relayUrl: 'Relay server',
        relayUrlHint: 'Leave empty to use the relay bundled with this app (local network only).',
        relayUrlPlaceholder: 'https://relay.example.com',
        applyRelay: 'Use relay',
        publicAddress: 'Public address',
        publicAddressHint: 'Optional: the origin a phone opens, when a tunnel or reverse proxy fronts the relay. Empty means this computer\'s local network address.',
        publicAddressPlaceholder: 'https://rc.example.com',
        applyAddress: 'Use address',
        fingerprint: 'Credential',
        noLink: 'No access link yet — turn Remote Control on.',
        connecting: 'Connecting to the relay…',
        restartRequired: 'The host plugin is not active yet — restart the Harness to load it.',
      },
      zh: {
        nav: '远程控制',
        title: '远程控制',
        subtitle: '开启后，在其他设备上打开链接即可控制本机上的智能体',
        on: '远程控制已开启',
        off: '远程控制已关闭',
        qrCaption: '用手机扫码打开',
        copyLink: '复制链接',
        copied: '已复制',
        openLink: '打开链接',
        security: '请保持电脑唤醒并联网。手机需要先输入访问码才能控制本机智能体——链接和访问码都不要外传。',
        passcode: '访问码',
        passcodeHint: '手机首次访问需输入这 8 位数字，之后才会话保持登录。访问码不会出现在链接里。',
        copyPasscode: '复制访问码',
        rotatePasscode: '更换访问码',
        passcodeRotated: '已启用新访问码，旧访问码立即失效。',
        phones: '访问过的设备',
        phonesHint: '标记为信任后，该设备以后可以免访问码登录。',
        phoneTrusted: '已信任',
        phoneTrust: '信任此设备',
        phoneLastSeen: '最近访问',
        phoneFirstSeen: '首次访问',
        removePhone: '移除设备',
        removePhoneConfirm: '移除该设备？它之后需要重新输入访问码。',
        phoneRemoved: '该设备已被移除。',
        devices: '远程设备管理',
        refresh: '刷新',
        thisComputer: '本机',
        online: '在线',
        offline: '离线',
        rename: '重命名',
        takeOffline: '下线',
        takeOfflineHint: '立刻断开它，设备会自己重连。',
        revoke: '撤销访问',
        revokeHint: '持续拒绝该设备，直到你恢复为止。',
        restore: '恢复访问',
        restoreHint: '允许该设备重新接入。',
        revoked: '已撤销',
        renamed: '设备已重命名',
        takenOffline: '设备已下线',
        failed: '远程控制失败',
        relayUrl: '中继服务地址',
        relayUrlHint: '留空则使用内置中继（仅局域网可达）。',
        relayUrlPlaceholder: 'https://relay.example.com',
        applyRelay: '使用该中继',
        publicAddress: '公网地址',
        publicAddressHint: '可选：当隧道或反向代理挡在中继前面时，填手机实际打开的地址；留空则使用本机的局域网地址。',
        publicAddressPlaceholder: 'https://rc.example.com',
        applyAddress: '使用该地址',
        fingerprint: '凭据',
        noLink: '还没有访问链接 —— 请先开启远程控制。',
        connecting: '正在连接中继服务…',
        restartRequired: '宿主插件尚未生效 —— 请重启 Harness 以加载。',
      },
    }

    const CSS = `
.rc-section{display:flex;flex-direction:column;gap:16px;max-width:720px;color:var(--dsw-alias-label-primary)}
.rc-card{display:flex;flex-direction:column;gap:12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:16px;background:var(--dsw-alias-bg-layer-1)}
.rc-row{display:flex;justify-content:space-between;align-items:center;gap:24px}
.rc-headline{font-size:14px;line-height:20px;font-weight:500}
.rc-description{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-top:4px}
.rc-switch{position:relative;width:40px;height:22px;border-radius:11px;border:none;background:var(--dsw-alias-border-l3);cursor:pointer;transition:background .15s ease;flex:none}
.rc-switch[data-on="true"]{background:var(--dsw-alias-state-business-primary)}
.rc-switch[data-disabled="true"]{opacity:.5;cursor:not-allowed}
.rc-thumb{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-switch-thumb,var(--dsw-alias-bg-layer-1));transition:transform .15s ease}
.rc-switch[data-on="true"] .rc-thumb{transform:translateX(18px)}
.rc-qr{display:flex;flex-direction:column;align-items:center;gap:8px;margin-top:4px}
.rc-qr svg{width:180px;height:180px;background:#fff;padding:8px;border-radius:8px}
.rc-caption{font-size:12px;color:var(--dsw-alias-label-secondary)}
.rc-actions{display:flex;gap:8px;justify-content:center}
.rc-button{font-size:12px;line-height:16px;padding:6px 12px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}
.rc-button:hover{background:var(--dsw-alias-bg-layer-3)}
.rc-button[data-disabled="true"]{opacity:.5;cursor:not-allowed}
.rc-note{display:flex;gap:6px;align-items:flex-start;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.rc-devices{display:flex;flex-direction:column;gap:8px}
.rc-devices-head{display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:500}
.rc-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.28)}
.rc-dialog{display:flex;flex-direction:column;gap:12px;min-width:320px;padding:18px 20px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:0 18px 48px rgba(0,0,0,.24)}
.rc-dialog-title{font-size:13px;font-weight:500}
.rc-dialog-input{font-size:13px;padding:8px 10px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit}
.rc-dialog-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.rc-dialog-actions{display:flex;justify-content:flex-end;gap:8px}
.rc-button-primary{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:#fff}
.rc-device{display:flex;justify-content:space-between;align-items:center;gap:16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px 16px;background:var(--dsw-alias-bg-layer-1)}
.rc-device-main{display:flex;flex-direction:column;gap:4px;min-width:0}
.rc-device-name{display:flex;align-items:center;gap:8px;font-size:13px}
.rc-badge{font-size:11px;color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;padding:1px 6px}
.rc-device-sub{font-size:12px;color:var(--dsw-alias-label-secondary)}
.rc-device-right{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rc-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.rc-dot[data-status="offline"]{background:var(--dsw-alias-label-tertiary)}
.rc-menu{position:relative}
.rc-menu-list{position:absolute;right:0;top:22px;min-width:140px;display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-alias-elevation-2);z-index:20;overflow:hidden}
.rc-menu-item{font-size:12px;padding:8px 12px;text-align:left;border:none;background:none;color:var(--dsw-alias-label-primary);cursor:pointer}
.rc-menu-item:hover{background:var(--dsw-alias-bg-layer-3)}
.rc-menu-item[data-danger="true"]{color:var(--dsw-alias-state-error-primary)}
.rc-error{color:var(--dsw-alias-state-error-primary);font-size:12px}
.rc-field{display:flex;flex-direction:column;gap:6px}
.rc-input{font-size:12px;padding:6px 8px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);min-width:260px}
.rc-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.rc-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:20px;letter-spacing:.28em;padding:6px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.rc-muted{color:var(--dsw-alias-label-tertiary);font-size:12px}
`

    /** The plugin context, captured for the components rendered later. */
    let hostCtx

    /**
     * Call one Host endpoint over the exact Fetch route the host registers.
     * @param {string} endpoint
     * @param {Record<string, unknown>} [payload]
     * @returns {Promise<{ ok: boolean, value?: unknown, error?: unknown }>}
     */
    function call(endpoint, payload) {
      return fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: endpoint, payload: payload ?? {} }),
      }).then((response) => {
        // A fresh installation answers the SPA fallback until the host has
        // loaded the plugin, which happens on the next app start.
        if (response.status === 404 || response.status === 405) {
          throw new Error('restart-required')
        }
        return response.json()
      })
    }

    /**
     * The message of one failed RPC result.
     * @param {any} result
     * @param {string} fallback
     * @returns {string}
     */
    function messageOf(result, fallback) {
      const error = result?.error
      if (typeof error === 'string') return error
      if (typeof error?.message === 'string') return error.message
      return fallback
    }

    /**
     * Copy text to the clipboard.
     * @param {string} text
     * @returns {Promise<boolean>}
     */
    function copyText(text) {
      if (navigator.clipboard?.writeText === undefined) return Promise.resolve(false)
      return navigator.clipboard.writeText(text).then(() => true).catch(() => false)
    }

    /**
     * Format an ISO timestamp for the device list.
     *
     * @param {string | undefined} value
     * @returns {string}
     */
    function formatTime(value) {
      if (typeof value !== 'string' || value.length === 0) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '—'
      return date.toLocaleString()
    }

    /**
     * A switch that reports the next value.
     * @param {{checked: boolean, label: string, disabled?: boolean, onChange: (next: boolean) => void}} props
     */
    function Switch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked,
        'aria-label': props.label,
        className: 'rc-switch',
        'data-on': props.checked ? 'true' : 'false',
        'data-disabled': props.disabled === true ? 'true' : 'false',
        disabled: props.disabled === true,
        onClick: () => props.onChange(!props.checked),
      }, h('span', { className: 'rc-thumb' }))
    }

    /**
     * A small modal that asks for a name.
     *
     * `window.prompt` does not work in the desktop app — Electron does not
     * implement it — so the name is asked for in the page itself.
     *
     * @param {{title: string, initial: string, label: string, onSubmit: (value: string) => void, onCancel: () => void}} props
     */
    function NameDialog(props) {
      const [value, setValue] = React.useState(props.initial ?? '')
      const inputRef = React.useRef(null)
      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') props.onCancel()
          if (event.key === 'Enter') props.onSubmit(value)
        }
        window.addEventListener('keydown', onKey)
        inputRef.current?.focus()
        inputRef.current?.select()
        return () => window.removeEventListener('keydown', onKey)
      }, [])

      return h('div', { className: 'rc-overlay', onClick: props.onCancel },
        h('div', { className: 'rc-dialog', onClick: (event) => event.stopPropagation() },
          h('div', { className: 'rc-dialog-title' }, props.title),
          h('input', {
            ref: inputRef,
            className: 'rc-dialog-input',
            value: value,
            'aria-label': props.label,
            onChange: (event) => setValue(event.target.value),
            // Clicking into the field again replaces the name instead of
            // appending to it.
            onFocus: (event) => event.target.select(),
          }),
          h('div', { className: 'rc-dialog-actions' },
            h('button', { type: 'button', className: 'rc-button', onClick: props.onCancel }, props.cancel),
            h('button', {
              type: 'button',
              className: 'rc-button rc-button-primary',
              onClick: () => props.onSubmit(value),
            }, props.ok))))
    }

    /**
     * One row of "Remote device management".
     * @param {{device: Record<string, any>, t: Function, onRename: Function, onOffline: Function}} props
     */
    function DeviceRow(props) {
      const [open, setOpen] = React.useState(false)
      const device = props.device
      const status = device.status === 'online' ? props.t('online') : props.t('offline')
      return h('div', { className: 'rc-device' },
        h('div', { className: 'rc-device-main' },
          h('div', { className: 'rc-device-name' },
            h('span', null, device.alias),
            device.isThisComputer === true ? h('span', { className: 'rc-badge' }, props.t('thisComputer')) : null,
            device.revoked === true ? h('span', { className: 'rc-badge' }, props.t('revoked')) : null),
          h('div', { className: 'rc-device-sub' },
            `${device.platform} - dsh-desktop/${device.clientVersion}`)),
        h('div', { className: 'rc-device-right' },
          h('span', { className: 'rc-dot', 'data-status': device.status }),
          h('span', null, status),
          h('div', { className: 'rc-menu' },
            h('button', {
              type: 'button',
              className: 'rc-button',
              'aria-label': 'device actions',
              onClick: () => setOpen(!open),
            }, '⋯'),
            open === true
              ? h('div', { className: 'rc-menu-list' },
                h('button', {
                  type: 'button',
                  className: 'rc-menu-item',
                  onClick: () => { setOpen(false); props.onRename(device) },
                }, props.t('rename')),
                h('button', {
                  type: 'button',
                  className: 'rc-menu-item',
                  title: props.t('takeOfflineHint'),
                  onClick: () => { setOpen(false); props.onOffline(device) },
                }, props.t('takeOffline')),
                device.revoked === true
                  ? h('button', {
                    type: 'button',
                    className: 'rc-menu-item',
                    title: props.t('restoreHint'),
                    onClick: () => { setOpen(false); props.onRevoke(device, false) },
                  }, props.t('restore'))
                  : h('button', {
                    type: 'button',
                    className: 'rc-menu-item',
                    'data-danger': 'true',
                    title: props.t('revokeHint'),
                    onClick: () => { setOpen(false); props.onRevoke(device, true) },
                  }, props.t('revoke')))
              : null)))
    }

    /**
     * One phone that connected: its name, when it was last seen, the trust
     * switch, and a menu with the actions.
     *
     * @param {{phone: any, t: Function, busy: boolean, onTrust: (trusted: boolean) => void, onRename: (alias: string) => void, onRemove: () => void}} props
     */
    function PhoneRow(props) {
      const [open, setOpen] = React.useState(false)
      const phone = props.phone
      const t = props.t
      return h('div', { className: 'rc-device' },
        h('div', { className: 'rc-device-main' },
          h('div', { className: 'rc-device-name' },
            h('span', null, phone.label || phone.id),
            phone.trusted === true ? h('span', { className: 'rc-badge' }, t('phoneTrusted')) : null),
          h('div', { className: 'rc-device-sub' },
            `${t('phoneLastSeen')}: ${formatTime(phone.lastSeenAt)}`)),
        h('div', { className: 'rc-device-right' },
          h(Switch, {
            checked: phone.trusted === true,
            label: `${phone.label || phone.id} — ${t('phoneTrust')}`,
            disabled: props.busy === true,
            onChange: props.onTrust,
          }),
          h('div', { className: 'rc-menu' },
            h('button', {
              type: 'button',
              className: 'rc-button',
              'aria-label': t('removePhone'),
              onClick: () => setOpen(!open),
            }, '⋯'),
            open === true
              ? h('div', { className: 'rc-menu-list' },
                h('button', {
                  type: 'button',
                  className: 'rc-menu-item',
                  onClick: () => { setOpen(false); props.onRename(phone) },
                }, t('rename')),
                h('button', {
                  type: 'button',
                  className: 'rc-menu-item',
                  'data-danger': 'true',
                  onClick: () => { setOpen(false); props.onRemove() },
                }, t('removePhone')))
              : null)))
    }

    /**
     * The "Remote Control" settings page.
     * @param {{t: Function}} props
     */
    function RemoteControlSection(props) {
      const t = props.t
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [copied, setCopied] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [renaming, setRenaming] = React.useState(null)
      const [relayUrl, setRelayUrl] = React.useState('')
      const [publicAddress, setPublicAddress] = React.useState('')

      const refresh = React.useCallback(() => {
        call('status').then((result) => {
          if (result?.ok === true) {
            setStatus(result.value)
            setRelayUrl(result.value.relayUrl ?? '')
            setPublicAddress(result.value.publicAddress ?? '')
          } else {
            setError(messageOf(result, t('failed')))
          }
        }).catch((cause) => {
          setError(cause instanceof Error && cause.message === 'restart-required' ? t('restartRequired') : String(cause))
        })
      }, [t])

      React.useEffect(() => {
        refresh()
        const timer = window.setInterval(refresh, 3000)
        return () => window.clearInterval(timer)
      }, [refresh])

      const run = React.useCallback((endpoint, payload) => {
        setBusy(true)
        setError(null)
        return call(endpoint, payload).then((result) => {
          setBusy(false)
          if (result?.ok === true) {
            if (result.value?.devices !== undefined) setStatus(result.value)
            else refresh()
            return true
          }
          setError(messageOf(result, t('failed')))
          return false
        }).catch((cause) => {
          setBusy(false)
          setError(cause instanceof Error && cause.message === 'restart-required' ? t('restartRequired') : String(cause))
          return false
        })
      }, [refresh, t])

      const devices = status?.devices ?? []
      const publicUrl = status?.publicUrl

      return h('div', { className: 'rc-section' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h('div', { className: 'rc-card' },
          h('div', { className: 'rc-row' },
            h('div', null,
              h('div', { className: 'rc-headline' }, status?.enabled === true ? t('on') : t('off')),
              h('div', { className: 'rc-description' }, t('subtitle'))),
            h(Switch, {
              checked: status?.enabled === true,
              label: t('title'),
              disabled: busy === true,
              onChange: (next) => { run('setEnabled', { enabled: next }) },
            })),
          status?.enabled === true && publicUrl === undefined
            ? h('div', { className: 'rc-muted' }, t('connecting'))
            : null,
          status?.enabled === true && publicUrl !== undefined
            ? h('div', { className: 'rc-qr' },
              h('div', { dangerouslySetInnerHTML: { __html: status.qrSvg ?? '' } }),
              h('div', { className: 'rc-caption' }, t('qrCaption')),
              h('div', { className: 'rc-actions' },
                h('button', {
                  type: 'button',
                  className: 'rc-button',
                  onClick: () => {
                    copyText(publicUrl).then((ok) => {
                      if (!ok) return
                      setCopied(true)
                      window.setTimeout(() => setCopied(false), 1500)
                    })
                  },
                }, copied === true ? t('copied') : t('copyLink')),
                h('button', {
                  type: 'button',
                  className: 'rc-button',
                  onClick: () => window.open(publicUrl, '_blank', 'noopener,noreferrer'),
                }, t('openLink'))))
            : null,
          status?.passcode !== undefined
            ? h('div', { className: 'rc-field' },
              h('div', { className: 'rc-headline' }, t('passcode')),
              h('div', { className: 'rc-description' }, t('passcodeHint')),
              h('div', { className: 'rc-inline' },
                h('code', { className: 'rc-code' }, status.passcode),
                h('button', {
                  type: 'button',
                  className: 'rc-button',
                  onClick: () => {
                    copyText(status.passcode).then((ok) => {
                      if (!ok) return
                      setCopied(true)
                      window.setTimeout(() => setCopied(false), 1500)
                    })
                  },
                }, copied === true ? t('copied') : t('copyPasscode')),
                h('button', {
                  type: 'button',
                  className: 'rc-button',
                  disabled: busy === true,
                  onClick: () => {
                    run('rotatePasscode', {}).then((ok) => {
                      if (ok) setNotice(t('passcodeRotated'))
                    })
                  },
                }, t('rotatePasscode'))))
            : null,
          h('div', { className: 'rc-note' }, `ⓘ ${t('security')}`),
          error !== null ? h('div', { className: 'rc-error', role: 'alert' }, error) : null),

        h('div', { className: 'rc-devices' },
          h('div', { className: 'rc-devices-head' },
            h('span', null, t('devices')),
            h('button', { type: 'button', className: 'rc-button', onClick: refresh }, t('refresh'))),
          devices.map((device) => h(DeviceRow, {
            key: device.deviceId,
            device,
            t,
            onRename: (target) => setRenaming({ kind: 'device', id: target.deviceId, alias: target.alias ?? '' }),
            onOffline: (target) => {
              run('takeOffline', { deviceId: target.deviceId })
                .then((ok) => { if (ok) setNotice(t('takenOffline')) })
            },
          })),
          notice !== null ? h('div', { className: 'rc-muted' }, notice) : null,
        renaming !== null
          ? h(NameDialog, {
            title: t('rename'),
            label: t('rename'),
            initial: renaming.alias,
            ok: t('save'),
            cancel: t('cancel'),
            onCancel: () => setRenaming(null),
            onSubmit: (value) => {
              const alias = value.trim()
              const target = renaming
              setRenaming(null)
              if (alias.length === 0) return
              if (target.kind === 'device') {
                run('renameDevice', { deviceId: target.id, alias })
                  .then((ok) => { if (ok) setNotice(t('renamed')) })
                return
              }
              run('renamePhone', { phoneId: target.id, alias })
                .then((ok) => { if (ok) setNotice(t('renamed')) })
            },
          })
          : null),

        h('div', { className: 'rc-devices' },
          h('div', { className: 'rc-devices-head' },
            h('span', null, t('phones'))),
          h('div', { className: 'rc-description' }, t('phonesHint')),
          (status?.phones ?? []).length === 0
            ? h('div', { className: 'rc-muted' }, '—')
            : (status?.phones ?? []).map((phone) => h(PhoneRow, {
              key: phone.id,
              phone,
              t,
              busy,
              onTrust: (trusted) => { run('setPhoneTrust', { phoneId: phone.id, trusted }) },
              onRename: (target) => setRenaming({ kind: 'phone', id: target.id, alias: target.label ?? '' }),
              onRemove: () => {
                // Removing a device is destructive: it has to enter the access
                // code again, so ask first.
                if (!window.confirm(t('removePhoneConfirm'))) return
                run('removePhone', { phoneId: phone.id }).then((ok) => {
                  if (ok) setNotice(t('phoneRemoved'))
                })
              },
            }))),
        h('div', { className: 'rc-field' },
          h('div', { className: 'rc-headline' }, t('relayUrl')),
          h('div', { className: 'rc-description' }, t('relayUrlHint')),
          h('div', { className: 'rc-inline' },
            h('input', {
              className: 'rc-input',
              value: relayUrl,
              placeholder: t('relayUrlPlaceholder'),
              onChange: (event) => setRelayUrl(event.target.value),
            }),
            h('button', {
              type: 'button',
              className: 'rc-button',
              disabled: busy === true,
              onClick: () => run('setRelayUrl', { url: relayUrl }),
            }, t('applyRelay'))),
          h('div', { className: 'rc-field' },
            h('div', { className: 'rc-headline' }, t('publicAddress')),
            h('div', { className: 'rc-description' }, t('publicAddressHint')),
            h('div', { className: 'rc-inline' },
              h('input', {
                className: 'rc-input',
                value: publicAddress,
                placeholder: t('publicAddressPlaceholder'),
                onChange: (event) => setPublicAddress(event.target.value),
              }),
              h('button', {
                type: 'button',
                className: 'rc-button',
                disabled: busy === true,
                onClick: () => run('setPublicAddress', { url: publicAddress }),
              }, t('applyAddress')))),
          status?.fingerprint !== undefined
            ? h('div', { className: 'rc-muted' }, `${t('fingerprint')}: ${status.fingerprint}`)
            : null))
    }

    /** Below this width the shipped layout turns the sidebar into phone mode. */
    const NARROW_BREAKPOINT = 1024

    /**
     * The frame element the layout renders.
     *
     * It is the only element carrying an inline grid definition, and its
     * `data-sidebar-collapsed` flag is the layout's own collapsed state (the
     * sidebar column is width 0 on darwin when that flag is set).
     * @returns {HTMLElement | null}
     */
    function layoutFrame() {
      return document.querySelector('[style*="grid-template-columns"]')
    }

    /**
     * Whether the layout is in its narrow (phone) mode.
     * @returns {boolean}
     */
    function isNarrowViewport() {
      return window.innerWidth < NARROW_BREAKPOINT
    }

    /**
     * Collapse the sidebar when it is expanded on a phone.
     *
     * The shipped layout expands the sidebar through `narrowExpanded` and only
     * resets that flag when the viewport crosses the breakpoint, so a Session
     * opened from the sidebar leaves the conversation squeezed into a sliver.
     * Closing it once the navigation has settled gives back the full width.
     * @returns {void}
     */
    function collapseSidebarIfNeeded() {
      if (!isNarrowViewport()) return
      const frame = layoutFrame()
      if (frame === null) return
      if (frame.hasAttribute('data-sidebar-collapsed')) return
      // `ctx.layout` is a service this plugin does not inject, so read it the
      // optional way; a plain property access throws instead of returning
      // undefined when the service is outside the plugin's dependency set.
      const layout = hostCtx?.get?.('layout')
      if (typeof layout?.toggleSidebar !== 'function') return
      layout.toggleSidebar()
      console.debug('[remote-control] phone sidebar: collapsed after navigation')
    }

    /**
     * Attempt a collapse after the browser has painted the new layout.
     * @param {number} [delay]
     * @returns {void}
     */
    function scheduleCollapse(delay = 0) {
      window.setTimeout(() => {
        window.requestAnimationFrame(() => collapseSidebarIfNeeded())
      }, delay)
    }

    /**
     * Install the phone behaviour: a navigation closes the expanded sidebar.
     *
     * Two signals: the workspace service's session entry points, which are
     * precise, and the document title, which the layout derives from the
     * active panel and Session and therefore covers every other route.
     * @param {any} ctx
     * @returns {() => void}
     */
    function installMobileSidebar(ctx) {
      console.debug('[remote-control] phone sidebar: installed')
      const restores = []
      const workspace = ctx.get('uiWorkspace') ?? ctx.uiWorkspace
      for (const method of ['openSession', 'startSession', 'openWorkspace']) {
        const original = workspace?.[method]
        if (typeof original !== 'function') continue
        const wrapped = function patchedNavigation(...args) {
          const result = original.apply(this, args)
          scheduleCollapse(0)
          scheduleCollapse(260)
          return result
        }
        try {
          workspace[method] = wrapped
          const installed = workspace[method] === wrapped
          if (installed) {
            console.debug(`[remote-control] phone sidebar: wrapped uiWorkspace.${method}`)
            restores.push(() => {
              if (workspace[method] === wrapped) workspace[method] = original
            })
          } else {
            console.debug(`[remote-control] phone sidebar: could not wrap uiWorkspace.${method}`)
          }
        } catch (error) {
          // A frozen service: the title observer below still covers navigation.
          console.debug('[remote-control] phone sidebar: wrap failed', String(error))
        }
      }

      // Tapping inside the expanded menu dismisses it, the way a phone menu
      // behaves: the layout keeps the menu expanded over the conversation
      // until something inside it is used.
      //
      // The dismissal waits for the *click*, never for the press. A press is
      // the beginning of a gesture, and closing the drawer on it took the
      // pressed control out from under the finger before the browser
      // dispatched the click: on a phone the click then landed on the
      // conversation behind the drawer and the control never ran at all — a
      // session row had to be tapped twice to open, and the first tap looked
      // like it did nothing. By the time the click is dispatched the drawer is
      // still in place and the control has handled its own tap; the drawer
      // closes afterwards, on the next task.
      const onClick = (event) => {
        if (!isNarrowViewport()) return
        const frame = layoutFrame()
        if (frame === null || frame.hasAttribute('data-sidebar-collapsed')) return
        const target = event.target
        if (!(target instanceof Element)) return
        const column = frame.firstElementChild
        if (column === null || !column.contains(target)) return
        // The toggle itself must keep working as a toggle.
        const control = target.closest('button,[role="button"]')
        const label = control?.getAttribute('aria-label') ?? ''
        if (/^(open|close|collapse|hide|show|toggle)\s+sidebar$/i.test(label)) return
        if (/^(打开|收起|关闭|隐藏|显示)侧边栏$/.test(label)) return
        scheduleCollapse(0)
        scheduleCollapse(280)
      }
      document.addEventListener('click', onClick, true)
      restores.push(() => document.removeEventListener('click', onClick, true))

      const title = document.querySelector('title')
      if (title !== null) {
        const observer = new MutationObserver(() => scheduleCollapse(120))
        observer.observe(title, { childList: true, characterData: true, subtree: true })
        restores.push(() => observer.disconnect())
      }

      // Crossing the breakpoint resets the layout's own flag; a rotation or a
      // window resize inside phone width must not leave the menu expanded.
      const onResize = () => scheduleCollapse(120)
      window.addEventListener('resize', onResize)
      restores.push(() => window.removeEventListener('resize', onResize))

      return () => {
        for (const restore of restores) restore()
      }
    }

    return {
      inject: ['slots', 'locale', 'connection', 'layout', 'uiWorkspace'],
      apply(ctx) {
        hostCtx = ctx
        // The dictionary must live on the plugin's fiber: an unscoped
        // registration survives a reload and the next one throws "locale
        // namespace already has locale en", which fails the whole plugin.
        // A hot reload can apply this plugin twice in one page, so a second
        // registration is tolerated instead of fatal: the dictionaries of the
        // first one are still in place.
        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, DICTIONARY)
          } catch (error) {
            console.warn('[remote-control] the locale namespace is already registered', error)
            return () => {}
          }
        }, 'remote-control: dictionaries')
        // On a phone the shell's own open and collapse controls get a real
        // target. They are re-rendered by the shell, so the marks are
        // refreshed on a short tick - the same cadence the sidebar's own
        // anchor uses.
        ctx.effect(() => {
          let labels = null
          try {
            const sidebar = ctx.locale.bind('sidebar')
            labels = { collapse: sidebar('toggle.collapse'), open: sidebar('toggle.open') }
          } catch (error) {
            // The shell's namespace is not there yet; the tick tries again.
            labels = null
          }
          const mark = () => {
            if (labels === null) return
            markSidebarControls(labels.collapse, labels.open)
          }
          mark()
          const timer = setInterval(mark, 750)
          return () => clearInterval(timer)
        }, 'remote-control: sidebar controls')
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.slots.inject('settings.section', () => {
          try {
            return ctx.slots.register({
              name: 'settings.section',
              id: 'remote-control',
              order: 25,
              locale: NS,
              label: () => t('nav'),
            }, RemoteControlSection)
          } catch (error) {
            console.warn('[remote-control] the settings section is already registered', error)
            return () => {}
          }
        }), 'remote-control: settings section')
        ctx.effect(() => installMobileSidebar(ctx), 'remote-control: phone sidebar')
      },
    }
  },
})
