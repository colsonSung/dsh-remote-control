/**
 * Client half of `@local/remote-control`: the Settings page named
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

(function () {

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
    '',
    '  /* The conversation header is the host\'s own: it folds the views it',
    '     cannot show into a More menu, and it knows which page it belongs to.',
    '     A phone only needs the touch targets to be big enough. */',
    '  header[data-window-drag] button {',
    '    min-width: 44px !important;',
    '    min-height: 44px !important;',
    '  }',
    '  [data-conversation-tabs] {',
    '    overflow-x: auto !important;',
    '    overscroll-behavior-x: contain !important;',
    '    scrollbar-width: none !important;',
    '  }',
    '  [data-conversation-tabs]::-webkit-scrollbar {',
    '    display: none !important;',
    '  }',
    '  [data-conversation-tabs] [role="tab"] {',
    '    flex: 0 0 auto !important;',
    '    min-width: 44px !important;',
    '    min-height: 44px !important;',
    '  }',
    '',
    '  /* The "open locally" control opens a file or a folder in an application',
    '     on the Host desktop - Finder, VS Code, Xcode, a terminal. On a phone',
    '     that points at a machine the user is not holding, so the button goes',
    '     away with the rest of the desktop-only chrome. The host marks the',
    '     split button with `data-open-target`, an attribute that survives a',
    '     release, so the rule keeps working after an update. */',
    '  [data-open-target] {',
    '    display: none !important;',
    '  }',
    '',
    '  [data-width-handle] {',
    '    display: none !important;',
    '  }',
    '',
    '  /* Pin the phone chrome. The rail and the conversation header are',
    '     ordinary flow content, so a focused field that makes the browser',
    '     scroll the page would take them off the screen with it. */',
    '  .sa-sidebar {',
    '    position: sticky !important;',
    '    top: 0 !important;',
    '    align-self: start !important;',
    '    height: 100dvh !important;',
    '    overflow-y: auto !important;',
    '    overscroll-behavior-y: contain !important;',
    '  }',
    '  header[data-window-drag] {',
    '    position: sticky !important;',
    '    top: 0 !important;',
    '    z-index: 4 !important;',
    '  }',
    '',
    '  /* iOS zooms the page when a focused control has a smaller font. Every',
    '     editable control on a phone therefore stays at 16px. */',
    '  input,',
    '  textarea,',
    '  select,',
    '  [contenteditable],',
    '  [contenteditable="true"] {',
    '    font-size: 16px !important;',
    '  }',
    '',
    '  /* A menu surface that does not depend on CSS anchor positioning. The',
    '     host paints it with an anchored element, which iOS Safari does not',
    '     implement yet: the menu would show the page straight through it. */',
    '  [data-menu-material] {',
    '    background: var(--dsw-alias-bg-layer-2) !important;',
    '    box-shadow: var(--dsw-elevation-prominent) !important;',
    '    max-width: calc(100vw - 24px) !important;',
    '    max-height: 70dvh !important;',
    '    overflow-y: auto !important;',
    '  }',
    '',
    '  /* A phone transcript uses the full column and scrolls only vertically. */',
    '  [data-conversation-content] {',
    '    --dsh-chat-user-width: 100% !important;',
    '    --dsh-composer-side-clearance: 12px !important;',
    '    min-width: 0 !important;',
    '  }',
    '  [data-conversation-scroll] {',
    '    min-width: 0 !important;',
    '    overflow-x: hidden !important;',
    '    overscroll-behavior-y: contain !important;',
    '  }',
    '  [data-conversation-scroll] pre {',
    '    max-width: 100% !important;',
    '    overflow-x: auto !important;',
    '  }',
    '  [data-conversation-scroll] table {',
    '    display: block !important;',
    '    max-width: 100% !important;',
    '    overflow-x: auto !important;',
    '  }',
    '  [data-conversation-scroll] :is(p, li, h1, h2, h3, h4, h5, h6) {',
    '    overflow-wrap: anywhere !important;',
    '    word-break: break-word !important;',
    '  }',
    '  [data-conversation-scroll] :is(p, li) code {',
    '    white-space: normal !important;',
    '    overflow-wrap: anywhere !important;',
    '  }',
    '  [data-conversation-scroll] img {',
    '    max-width: 100% !important;',
    '    height: auto !important;',
    '  }',
    '  [data-conversation-scroll] :is(video, canvas, svg) {',
    '    max-width: 100% !important;',
    '  }',
    '  [data-conversation-scroll] video {',
    '    height: auto !important;',
    '  }',
    '  [data-conversation-scroll] a {',
    '    overflow-wrap: anywhere !important;',
    '  }',
    '  [data-changes-review] [data-review-view] {',
    '    box-sizing: border-box !important;',
    '    min-width: 0 !important;',
    '    max-width: 100% !important;',
    '    overflow-x: auto !important;',
    '  }',
    '',
    '  /* Keep the resident composer thumb-friendly above the home indicator. */',
    '  [data-composer-seat] {',
    '    padding-bottom: calc(4px + env(safe-area-inset-bottom, 0px)) !important;',
    '    background: var(--dsw-alias-bg-base) !important;',
    '    transform: translateY(calc(-1 * var(--dsh-rc-keyboard-inset, 0px))) !important;',
    '    will-change: transform;',
    '  }',
    '  [data-composer-card] {',
    '    border-radius: var(--dsw-radius-panel) !important;',
    '    gap: 4px !important;',
    '  }',
    '  [data-input-scroll] {',
    '    max-height: min(32dvh, 180px) !important;',
    '  }',
    '  [data-composer-input] {',
    '    font-size: 16px !important;',
    '    min-height: 32px !important;',
    '  }',
    '  [data-composer-placeholder] {',
    '    font-size: 16px !important;',
    '  }',
    '  [data-composer-card] button {',
    '    min-height: 44px !important;',
    '  }',
    '  [data-composer-seat] :is(svg, img) {',
    '    flex: 0 0 auto !important;',
    '  }',
    '  [data-dsh-composer-primary] {',
    '    min-width: 44px !important;',
    '  }',
    '',
    '  /* Deliveries become readable rows instead of a two-column desktop grid. */',
    '  [data-presented-files-row] {',
    '    grid-template-columns: minmax(0, 1fr) !important;',
    '  }',
    '  [data-presented-file] {',
    '    min-height: 64px !important;',
    '    max-width: 100% !important;',
    '  }',
    '  [data-changed-files] {',
    '    max-width: 100% !important;',
    '  }',
    '  [data-changed-files] button {',
    '    min-height: 44px !important;',
    '  }',
    '  [data-changed-files] li {',
    '    min-width: 0 !important;',
    '  }',
    '  [data-changed-files] li button {',
    '    display: grid !important;',
    '    grid-template-columns: minmax(0, 1fr) auto !important;',
    '    min-width: 0 !important;',
    '  }',
    '  [data-changed-files] li button > span {',
    '    min-width: 0 !important;',
    '    overflow: hidden !important;',
    '    text-overflow: ellipsis !important;',
    '    white-space: nowrap !important;',
    '  }',
    '  [data-changes-review] {',
    '    box-sizing: border-box !important;',
    '    min-width: 0 !important;',
    '    max-width: 100% !important;',
    '  }',
    '  [data-review-file] {',
    '    min-width: 0 !important;',
    '    max-width: 100% !important;',
    '    overflow: hidden !important;',
    '    text-overflow: ellipsis !important;',
    '    white-space: nowrap !important;',
    '  }',
    '  [data-review-file] > span {',
    '    min-width: 0 !important;',
    '    overflow: hidden !important;',
    '    text-overflow: ellipsis !important;',
    '    white-space: nowrap !important;',
    '  }',
    '  [data-review-tool] {',
    '    flex: 0 0 auto !important;',
    '    min-width: 44px !important;',
    '    min-height: 44px !important;',
    '  }',
    '  [data-changes-hover-preview] {',
    '    box-sizing: border-box !important;',
    '    max-width: calc(100vw - 24px) !important;',
    '    overflow: auto !important;',
    '  }',
    '',
    '  /* The Settings panel is a fixed 800px two-column dialog. On a phone it',
    '     stacks: the section rail becomes a scrolling chip row above a',
    '     full-width content column. */',
    '  [data-shortcut-modal="settings"] {',
    '    flex-direction: column !important;',
    '    width: auto !important;',
    '    max-width: calc(100vw - 16px) !important;',
    '    height: auto !important;',
    '    max-height: calc(100dvh - 24px) !important;',
    '  }',
    '  [data-shortcut-modal="settings"] > nav {',
    '    width: 100% !important;',
    '    flex: none !important;',
    '    flex-direction: row !important;',
    '    align-items: center !important;',
    '    gap: 8px !important;',
    '    padding: 12px 8px 8px !important;',
    '  }',
    '  [data-shortcut-modal="settings"] > nav > div:has(button) {',
    '    flex-direction: row !important;',
    '    flex: 1 1 auto !important;',
    '    min-width: 0 !important;',
    '    gap: 6px !important;',
    '    overflow-x: auto !important;',
    '    overflow-y: hidden !important;',
    '    overscroll-behavior-x: contain !important;',
    '    scrollbar-width: none !important;',
    '  }',
    '  [data-shortcut-modal="settings"] > nav > div:has(button)::-webkit-scrollbar {',
    '    display: none !important;',
    '  }',
    '  [data-shortcut-modal="settings"] > nav button {',
    '    flex: 0 0 auto !important;',
    '    height: 40px !important;',
    '    min-height: 40px !important;',
    '    white-space: nowrap !important;',
    '  }',
    '  [data-shortcut-modal="settings"] > div:has(button) {',
    '    flex: 1 1 auto !important;',
    '    min-width: 0 !important;',
    '    min-height: 0 !important;',
    '    overflow-y: auto !important;',
    '    overscroll-behavior-y: contain !important;',
    '  }',
    '  [data-shortcut-modal="settings"] :is(button, a, [role="button"]) {',
    '    touch-action: manipulation !important;',
    '  }',
    '',
    '  /* A phone never zooms because a control took focus or was tapped twice. */',
    '  html {',
    '    -webkit-text-size-adjust: 100% !important;',
    '  }',
    '  input, textarea, select {',
    '    font-size: 16px !important;',
    '  }',
    '  button, [role="button"], a {',
    '    touch-action: manipulation !important;',
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

/**
 * The room an iOS input method's own toolbar takes above the keyboard.
 *
 * That toolbar is drawn over the page rather than inside the keyboard, so it
 * never shows up in the visual viewport. Without this room the composer sits
 * exactly where the toolbar is drawn and the lower half of it is covered.
 */
const IME_TOOLBAR_CLEARANCE_PX = 44

/** Where the composer control marker is published, so a test can drive it. */
const COMPOSER_CONTROL_MARKER = Symbol.for('dsh.remote-control.mark-composer-controls')

/**
 * Mark only the composer's primary send/stop actions on a phone.
 *
 * The labels come from the Conversation locale, so the rule does not depend
 * on a hashed class, button position, or one language. Other controls keep
 * their original width and cannot push the primary action out of the row.
 *
 * @param {string[]} labels localized send, stop, queue and steer labels
 * @returns {void}
 */
function markComposerControls(labels) {
  if (typeof document === 'undefined') return
  const narrow = window.matchMedia('(max-width: 1023px)').matches
  const primary = new Set(labels)
  for (const element of document.querySelectorAll('[data-composer-card] button[aria-label]')) {
    const label = element.getAttribute('aria-label') ?? ''
    if (narrow && primary.has(label)) element.setAttribute('data-dsh-composer-primary', '')
    else element.removeAttribute('data-dsh-composer-primary')
  }
  if (!narrow) {
    for (const element of document.querySelectorAll('[data-dsh-composer-primary]')) {
      element.removeAttribute('data-dsh-composer-primary')
    }
  }
}

window[COMPOSER_CONTROL_MARKER] = markComposerControls

/** Where the keyboard-inset installer is published, so a test can drive it. */
const KEYBOARD_INSET_MARKER = Symbol.for('dsh.remote-control.install-keyboard-inset')

/**
 * Keep the composer above the phone keyboard.
 *
 * A phone keyboard shrinks the visual viewport while the layout viewport
 * keeps its height, so a composer pinned to the bottom of its scroller ends
 * up behind the keyboard. The visible bottom of the page is known, and the
 * composer knows where it ends, so the hidden distance is measured instead of
 * guessed; the composer is then lifted by exactly that distance.
 *
 * @returns {() => void} the disposer removing the listeners and the variable.
 */
function installKeyboardInset() {
  if (typeof document === 'undefined') return () => {}
  const root = document.documentElement
  const viewport = window.visualViewport
  if (root === null || root === undefined || viewport === undefined) return () => {}
  const agent = window.navigator ?? {}
  // The Chinese input method on iOS draws its own toolbar above the keyboard.
  // It is drawn over the page and never changes the visual viewport, so the
  // composer needs that room as well or the toolbar covers its lower half.
  const ios = /iPad|iPhone|iPod/.test(String(agent.userAgent ?? ''))
    || (String(agent.platform ?? '') === 'MacIntel' && Number(agent.maxTouchPoints ?? 0) > 1)
  // Whether the composer holds the focus is the reliable signal that the
  // keyboard is up. The numbers are not: Safari scrolls the page to reveal the
  // field, and then nothing of the composer sits below the visible area any
  // more, while the keyboard and its toolbar still cover the screen.
  let focused = false
  let frame = 0
  const measure = () => {
    frame = 0
    const visibleBottom = viewport.offsetTop + viewport.height
    const seat = document.querySelector('[data-composer-seat]')
    const rect = seat?.getBoundingClientRect?.()
    // The measured composer wins: it knows what the keyboard actually covers.
    // Without a composer the layout distance is the only available estimate.
    const hidden = rect === undefined
      ? Math.max(0, Math.round(window.innerHeight - visibleBottom))
      : Math.max(0, Math.round(rect.bottom - visibleBottom))
    const keyboardOpen = window.innerHeight - viewport.height > 1
    const toolbar = ios && (focused || keyboardOpen) ? IME_TOOLBAR_CLEARANCE_PX : 0
    root.style.setProperty('--dsh-rc-keyboard-inset', `${hidden + toolbar}px`)
  }
  const onFocusIn = (event) => {
    const seat = document.querySelector('[data-composer-seat]')
    const target = event?.target
    let inside = false
    try {
      inside = Boolean(seat && target && seat.contains(target))
    } catch {
      inside = false
    }
    focused = inside
    schedule()
  }
  const onFocusOut = () => {
    focused = false
    schedule()
  }
  const schedule = () => {
    if (frame !== 0) return
    const request = window.requestAnimationFrame
    if (typeof request !== 'function') {
      measure()
      return
    }
    frame = request(measure)
  }
  viewport.addEventListener('resize', schedule)
  viewport.addEventListener('scroll', schedule)
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('focusout', onFocusOut, true)
  measure()
  return () => {
    viewport.removeEventListener('resize', schedule)
    viewport.removeEventListener('scroll', schedule)
    document.removeEventListener('focusin', onFocusIn, true)
    document.removeEventListener('focusout', onFocusOut, true)
    root.style.removeProperty('--dsh-rc-keyboard-inset')
  }
}

window[KEYBOARD_INSET_MARKER] = installKeyboardInset

/* ----------------------------------------------------------------- qr code */

/**
 * The QR code of one text, drawn by the browser half itself.
 *
 * The plugin depends on the `qrcode` package, but that dependency belongs to
 * the Host: the browser half is served exactly as it is written and the
 * browser module table has no `qrcode` entry, so `require('qrcode')` would
 * throw in the page. The encoder below is therefore self-contained - it
 * follows ISO/IEC 18004 and covers the versions 1 to 10, which hold every
 * share link this plugin produces.
 *
 * The Host still draws the QR code of the Remote Control access link; this one
 * is only about the link a shared conversation carries.
 */

/** Where the QR encoder is published, so a test can drive it. */
const QR_MARKER = Symbol.for('dsh.remote-control.qr-matrix')

/**
 * The bytes one UTF-8 string is made of.
 *
 * @param {string} text
 * @returns {number[]}
 */
function qrUtf8(text) {
  const bytes = []
  for (const character of String(text)) {
    const code = character.codePointAt(0)
    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    }
  }
  return bytes
}

/**
 * The Galois field the Reed-Solomon code of a QR block works in.
 *
 * @returns {{exp: Uint8Array, log: Uint8Array}}
 */
function qrGalois() {
  const exp = new Uint8Array(512)
  const log = new Uint8Array(256)
  let value = 1
  for (let i = 0; i < 255; i++) {
    exp[i] = value
    log[value] = i
    value <<= 1
    if ((value & 0x100) !== 0) value ^= 0x11d
  }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255]
  return { exp, log }
}

/**
 * The error correction blocks of every supported version, level M.
 *
 * One row per version: the total number of codewords, the number of error
 * correction codewords per block, and the groups of blocks - a group is a
 * number of blocks and the number of data codewords in each of them.
 *
 * @returns {Record<number, {total: number, ec: number, groups: number[][]}>}
 */
function qrBlockTable() {
  return {
    1: { total: 26, ec: 10, groups: [[1, 16]] },
    2: { total: 44, ec: 16, groups: [[1, 28]] },
    3: { total: 70, ec: 26, groups: [[1, 44]] },
    4: { total: 100, ec: 18, groups: [[2, 32]] },
    5: { total: 134, ec: 24, groups: [[2, 43]] },
    6: { total: 172, ec: 16, groups: [[4, 27]] },
    7: { total: 196, ec: 18, groups: [[4, 31]] },
    8: { total: 242, ec: 22, groups: [[2, 38], [2, 39]] },
    9: { total: 292, ec: 22, groups: [[3, 36], [2, 37]] },
    10: { total: 346, ec: 26, groups: [[4, 43], [1, 44]] },
  }
}

/**
 * The alignment pattern centres of one version.
 *
 * @param {number} version
 * @param {number} size
 * @returns {number[]}
 */
function qrAlignmentPositions(version, size) {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2
  const positions = [6]
  let position = size - 7
  while (positions.length < count) {
    positions.unshift(position)
    position -= step
  }
  return positions
}

/**
 * The bit of one number.
 *
 * @param {number} value
 * @param {number} index
 * @returns {boolean}
 */
function qrBit(value, index) {
  return ((value >>> index) & 1) === 1
}

/**
 * The module matrix of one QR code.
 *
 * @param {string} text
 * @returns {{version: number, size: number, modules: boolean[][], isFunction: boolean[][], mask: number} | null}
 */
function qrMatrix(text) {
  const bytes = qrUtf8(text)
  const table = qrBlockTable()
  // The character count field is 8 bits up to version 9 and 16 bits from there.
  const countBits = (version) => (version < 10 ? 8 : 16)
  const dataCapacity = (version) => table[version].groups.reduce((sum, [count, size]) => sum + count * size, 0)
  let version = 0
  for (let candidate = 1; candidate <= 10; candidate++) {
    const needed = Math.ceil((4 + countBits(candidate) + bytes.length * 8) / 8)
    if (needed <= dataCapacity(candidate)) {
      version = candidate
      break
    }
  }
  // A text that does not fit into the supported versions has no code.
  if (version === 0) return null

  // The bit stream: the mode, the length, the text, the terminator and the
  // padding that fills the data codewords.
  const bits = []
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, countBits(version))
  for (const byte of bytes) push(byte, 8)
  const capacity = dataCapacity(version)
  const totalBits = capacity * 8
  for (let i = 0; i < 4 && bits.length < totalBits; i++) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)
  let padding = 0xec
  while (bits.length < totalBits) {
    push(padding, 8)
    padding ^= 0xec ^ 0x11
  }
  const codewords = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]
    codewords.push(byte)
  }

  // The data codewords are split into the blocks of the version, and every
  // block gets its own error correction codewords.
  const { ec } = table[version]
  const galois = qrGalois()
  const multiply = (left, right) => {
    if (left === 0 || right === 0) return 0
    return galois.exp[galois.log[left] + galois.log[right]]
  }
  // The generator polynomial of a block: (x + a^0)(x + a^1)...(x + a^(ec-1)),
  // with the leading coefficient first.
  const generator = [1]
  for (let i = 0; i < ec; i++) {
    const next = new Array(generator.length + 1).fill(0)
    for (let j = 0; j < generator.length; j++) {
      next[j] ^= generator[j]
      next[j + 1] ^= multiply(generator[j], galois.exp[i])
    }
    generator.splice(0, generator.length, ...next)
  }
  // The error correction codewords are the remainder of the data codewords
  // divided by that generator.
  const remainder = (block) => {
    const result = new Array(ec).fill(0)
    for (const byte of block) {
      const factor = byte ^ result[0]
      result.shift()
      result.push(0)
      for (let i = 0; i < result.length; i++) result[i] ^= multiply(generator[i + 1], factor)
    }
    return result
  }
  const blocks = []
  for (const [count, size] of table[version].groups) {
    for (let i = 0; i < count; i++) {
      const block = codewords.splice(0, size)
      blocks.push({ data: block, ec: remainder(block) })
    }
  }
  // The codewords of the blocks are interleaved: the data first, then the
  // error correction codewords.
  const interleaved = []
  const longest = Math.max(...blocks.map((block) => block.data.length))
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) {
      if (i < block.data.length) interleaved.push(block.data[i])
    }
  }
  for (let i = 0; i < ec; i++) {
    for (const block of blocks) interleaved.push(block.ec[i])
  }

  // The matrix itself: the function patterns first, the data afterwards.
  const size = 17 + 4 * version
  const modules = Array.from({ length: size }, () => new Array(size).fill(false))
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false))
  const setFunction = (x, y, dark) => {
    modules[y][x] = dark
    isFunction[y][x] = true
  }
  for (let i = 0; i < size; i++) {
    setFunction(6, i, i % 2 === 0)
    setFunction(i, 6, i % 2 === 0)
  }
  const finder = (x, y) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy))
        const xx = x + dx
        const yy = y + dy
        if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue
        setFunction(xx, yy, distance !== 2 && distance !== 4)
      }
    }
  }
  finder(3, 3)
  finder(size - 4, 3)
  finder(3, size - 4)
  const centres = qrAlignmentPositions(version, size)
  for (const cy of centres) {
    for (const cx of centres) {
      // The three corners belong to the finder patterns.
      const corner = (cx === 6 && cy === 6)
        || (cx === 6 && cy === size - 7)
        || (cx === size - 7 && cy === 6)
      if (corner) continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
        }
      }
    }
  }
  // The version information, from version 7 on.
  if (version >= 7) {
    let rest = version
    for (let i = 0; i < 12; i++) rest = (rest << 1) ^ ((rest >>> 11) * 0x1f25)
    const bits18 = (version << 12) | rest
    for (let i = 0; i < 18; i++) {
      const dark = qrBit(bits18, i)
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      setFunction(a, b, dark)
      setFunction(b, a, dark)
    }
  }
  // The format information carries the error correction level and the mask.
  // The mask is only known after the data is placed, so the places of the
  // format information are reserved first and written again at the end.
  const formatBitsOf = (value) => {
    const data = (0b00 << 3) | value
    let rest = data
    for (let i = 0; i < 10; i++) rest = (rest << 1) ^ ((rest >>> 9) * 0x537)
    return ((data << 10) | rest) ^ 0x5412
  }
  const writeFormat = (bits) => {
    for (let i = 0; i <= 5; i++) setFunction(8, i, qrBit(bits, i))
    setFunction(8, 7, qrBit(bits, 6))
    setFunction(8, 8, qrBit(bits, 7))
    setFunction(7, 8, qrBit(bits, 8))
    for (let i = 9; i < 15; i++) setFunction(14 - i, 8, qrBit(bits, i))
    for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, qrBit(bits, i))
    for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, qrBit(bits, i))
    // The module below the bottom left finder is always dark.
    setFunction(8, size - 8, true)
  }
  writeFormat(formatBitsOf(0))

  // The data codewords walk through the matrix in the two-column zigzag that
  // starts in the bottom right corner.
  let bit = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vertical = 0; vertical < size; vertical++) {
      for (let column = 0; column < 2; column++) {
        const x = right - column
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vertical : vertical
        if (isFunction[y][x]) continue
        if (bit < interleaved.length * 8) {
          modules[y][x] = qrBit(interleaved[bit >>> 3], 7 - (bit & 7))
          bit++
        }
      }
    }
  }

  // The eight masks, and the penalty that picks the least noisy one.
  const masks = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
    (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
  ]
  const applyMask = (mask) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (isFunction[y][x]) continue
        if (masks[mask](x, y)) modules[y][x] = !modules[y][x]
      }
    }
  }
  const penalty = () => {
    let score = 0
    // A run of five or more modules of the same color.
    const runs = (line) => {
      let total = 0
      let run = 1
      for (let i = 1; i < line.length; i++) {
        if (line[i] === line[i - 1]) {
          run++
          continue
        }
        if (run >= 5) total += 3 + (run - 5)
        run = 1
      }
      if (run >= 5) total += 3 + (run - 5)
      return total
    }
    for (let y = 0; y < size; y++) score += runs(modules[y])
    for (let x = 0; x < size; x++) {
      score += runs(modules.map((row) => row[x]))
    }
    // A square of one color.
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const color = modules[y][x]
        if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) score += 3
      }
    }
    // The finder pattern with four light modules on one side of it.
    const finderLike = [true, false, true, true, true, false, true, false, false, false, false]
    const finderLikeOther = [false, false, false, false, true, false, true, true, true, false, true]
    const matches = (line, start, pattern) => {
      for (let i = 0; i < pattern.length; i++) {
        if (line[start + i] !== pattern[i]) return false
      }
      return true
    }
    for (let y = 0; y < size; y++) {
      for (let x = 0; x + 11 <= size; x++) {
        if (matches(modules[y], x, finderLike) || matches(modules[y], x, finderLikeOther)) score += 40
      }
    }
    for (let x = 0; x < size; x++) {
      const column = modules.map((row) => row[x])
      for (let y = 0; y + 11 <= size; y++) {
        if (matches(column, y, finderLike) || matches(column, y, finderLikeOther)) score += 40
      }
    }
    // The balance of the dark modules.
    let dark = 0
    for (const row of modules) {
      for (const cell of row) {
        if (cell) dark++
      }
    }
    // The balance of the dark modules: the further the share of dark modules
    // is from half, the worse the code reads.
    const balance = Math.abs(Math.ceil(((dark * 100) / (size * size)) / 5) - 10)
    score += balance * 10
    return score
  }

  // The data is masked eight times; the mask with the smallest penalty wins.
  // Every candidate brings its own format information, because the format
  // bits are part of the code and count towards the penalty.
  let mask = 0
  let best = Infinity
  for (let candidate = 0; candidate < 8; candidate++) {
    writeFormat(formatBitsOf(candidate))
    applyMask(candidate)
    const score = penalty()
    if (score < best) {
      best = score
      mask = candidate
    }
    applyMask(candidate)
  }
  writeFormat(formatBitsOf(mask))
  applyMask(mask)

  return { version, size, modules, isFunction, mask }
}

/**
 * The QR code of one text, as an SVG the page can show.
 *
 * @param {string} text
 * @returns {string} the SVG markup, or an empty string when the text does not fit
 */
function qrSvg(text) {
  const code = qrMatrix(text)
  if (code === null) return ''
  const parts = []
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (code.modules[y][x]) parts.push(`M${x} ${y}h1v1h-1z`)
    }
  }
  const quiet = 4
  const side = code.size + quiet * 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-quiet} ${-quiet} ${side} ${side}" shape-rendering="crispEdges" width="${side * 8}" height="${side * 8}" role="img" aria-hidden="true" focusable="false"><rect x="${-quiet}" y="${-quiet}" width="${side}" height="${side}" fill="#ffffff"/><path d="${parts.join('')}" fill="#000000"/></svg>`
}

window[QR_MARKER] = qrMatrix

/**
 * Register this bundle's factory with the module loader.
 *
 * A hot reload can execute the bundle a second time in one page: the module
 * system then refuses the second factory under the same id. The factory from
 * the first run is still the live one, so the plugin works — the panel must
 * not report it as broken, and the new code simply waits for the next page
 * load, like every other replaced bundle.
 *
 * @param {{ id: string, factory: (require: (name: string) => any) => any }} registration
 * @returns {void}
 */
function registerBundle(registration) {
  try {
    window.__ModuleLoader__.load(registration)
  } catch (error) {
    const message = String(error?.message ?? error)
    if (!message.includes('duplicate factory registration')) throw error
  }
}

registerBundle({
  id: '@local/remote-control',
  factory(require) {
    // The shim was installed while this bundle script ran, which is early
    // enough: the app opens its stream socket only after the client module
    // loader has loaded every plugin module. The call below keeps the
    // guarantee inside the factory as well; the guard makes it a no-op.
    window[Symbol.for('dsh.remote-control.compressed-stream-socket.install')]?.()

    const React = require('react')
    const ReactDOM = require('react-dom')
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
        shareButton: 'Share this conversation',
        shareButtonShort: 'Share',
        shareDialogTitle: 'Share this conversation',
        shareDialogSubtitle: 'One link, one passcode, one conversation.',
        shareScopeHint: 'Guests see only this conversation. File access stops at this session’s project folder.',
        shareModalClose: 'Close the share dialog',
        shareLinkReady: 'Your share is ready',
        shareEditNext: 'Adjust the next link',
        shareTitleLabel: 'Title',
        shareTitleHint: 'The name the people you share with see. The conversation keeps its own title.',
        sharePermissionLabel: 'Permission',
        sharePermissionRead: 'Read-only',
        sharePermissionWrite: 'Editable',
        sharePermissionReadHint: 'They can read the conversation but cannot type in it.',
        sharePermissionWriteHint: 'They can read the conversation and type in it.',
        shareGenerate: 'Create the link',
        shareGenerateAnother: 'Create another link',
        shareGenerating: 'Creating…',
        shareClose: 'Close',
        shareNoSession: 'Open a conversation before sharing it.',
        shareNoRelay: 'No relay is configured, so there is no public link. Set a relay in Remote Control first.',
        shareNoRelayShort: 'No public link',
        shareLinkLabel: 'Link',
        sharePasscodeLabel: 'Passcode',
        sharePasscodeHint: 'The visitor types this 8-digit passcode once, after opening the link.',
        shareQrCaption: 'Scan to open the shared conversation',
        shareCopied: 'Copied',
        shareCopyLink: 'Copy link',
        shareCopyPasscode: 'Copy passcode',
        shareOpenLink: 'Open link',
        shareAgainNote: 'Sharing again creates another record: a new link, a new passcode and the permission you pick now. The links you shared earlier keep working with the permission you gave them.',
        shareHistoryButton: 'History',
        shareHistoryTitle: 'The shares of this conversation',
        shareHistoryEmpty: 'This conversation has no share yet.',
        shareListTitle: 'Shared conversations',
        shareListHint: 'Every share is a record of its own, with its own link, its own 8-digit passcode and its own permission.',
        shareEmpty: 'No conversation is shared yet.',
        shareCreatedAt: 'Created',
        shareStatusActive: 'Active',
        shareStatusDisabled: 'Disabled',
        shareStatusRevoked: 'Revoked',
        shareDisable: 'Disable',
        shareDisableHint: 'The link stops working. The record stays in the list.',
        shareDelete: 'Delete',
        shareDeleteHint: 'Removes the record and its link for good.',
        shareDeleteConfirm: 'Delete this shared conversation? Its link and passcode stop working.',
        shareDisabled: 'The shared conversation was disabled.',
        shareDeleted: 'The shared conversation was deleted.',
        shareFailed: 'Sharing failed',
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
        shareButton: '分享此会话',
        shareButtonShort: '分享',
        shareDialogTitle: '分享此会话',
        shareDialogSubtitle: '一条链接，一个口令，只分享这一段对话。',
        shareScopeHint: '访客只能看到这个会话；文件访问范围不会超过该任务的工程目录。',
        shareModalClose: '关闭分享对话框',
        shareLinkReady: '分享已生成',
        shareEditNext: '调整下一条分享',
        shareTitleLabel: '标题',
        shareTitleHint: '被分享者看到的名称，会话本身的名字不变。',
        sharePermissionLabel: '权限',
        sharePermissionRead: '只读',
        sharePermissionWrite: '可编辑',
        sharePermissionReadHint: '对方可以阅读会话，但不能输入内容。',
        sharePermissionWriteHint: '对方可以阅读会话，也可以输入内容。',
        shareGenerate: '生成链接',
        shareGenerateAnother: '再生成一个链接',
        shareGenerating: '生成中…',
        shareClose: '关闭',
        shareNoSession: '请先打开一个会话，再分享它。',
        shareNoRelay: '未配置中继，无法生成公网链接。请先在远程控制中设置中继服务。',
        shareNoRelayShort: '无公网链接',
        shareLinkLabel: '链接',
        sharePasscodeLabel: '口令',
        sharePasscodeHint: '访问者打开链接后，需要输入这 8 位口令。',
        shareQrCaption: '扫码打开分享的会话',
        shareCopied: '已复制',
        shareCopyLink: '复制链接',
        shareCopyPasscode: '复制口令',
        shareOpenLink: '打开链接',
        shareAgainNote: '再次分享会新建一条记录：新的链接、新的口令，以及这次选择的权限；之前分享过的链接仍然可用，权限保持不变。',
        shareHistoryButton: '历史',
        shareHistoryTitle: '本次会话的分享记录',
        shareHistoryEmpty: '这次会话还没有分享过。',
        shareListTitle: '会话分享',
        shareListHint: '每次分享都是一条独立记录：独立的链接、独立的 8 位口令与独立的权限。',
        shareEmpty: '还没有分享过会话。',
        shareCreatedAt: '创建时间',
        shareStatusActive: '生效中',
        shareStatusDisabled: '已禁用',
        shareStatusRevoked: '已撤销',
        shareDisable: '禁用',
        shareDisableHint: '链接立即失效，记录仍保留在列表中。',
        shareDelete: '删除',
        shareDeleteHint: '永久删除该记录及其链接。',
        shareDeleteConfirm: '删除这条分享记录？它的链接和口令将立即失效。',
        shareDisabled: '该分享已被禁用。',
        shareDeleted: '该分享已被删除。',
        shareFailed: '分享失败',
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
.rc-button-danger{color:var(--dsw-alias-state-danger-primary,#d93025)}
.rc-button-danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-danger-primary,#d93025) 12%,transparent);border-color:var(--dsw-alias-state-danger-primary,#d93025)}
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

    /**
     * The styles of the shared conversation UI.
     *
     * They live on their own because the header button is rendered in the
     * conversation, far away from the settings page that carries the rest of
     * the plugin's styles.
     */
    const SHARE_CSS = `
.rc-share-anchor{display:inline-flex;align-items:center}
.rc-share-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 10px;border:1px solid transparent;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;white-space:nowrap;cursor:pointer;transition:background .1s ease,color .1s ease,border-color .1s ease}
.rc-share-button:hover{background:color-mix(in oklab,var(--dsw-alias-state-business-primary) 8%,transparent);border-color:color-mix(in oklab,var(--dsw-alias-state-business-primary) 18%,transparent);color:var(--dsw-alias-state-business-primary)}
.rc-share-button:active{transform:scale(.97)}
.rc-share-icon{display:inline-flex;align-items:center;justify-content:center;flex:none}
.rc-share-button:focus-visible,.rc-share-close:focus-visible,.rc-share-action:focus-visible,.rc-share-copy:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.rc-share-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgb(0 0 0/.46);backdrop-filter:blur(6px);animation:rc-share-fade .18s ease-out}
.rc-share-modal,.rc-share-row{
  --rc-surface-0:var(--dsw-alias-bg-base);
  --rc-surface-1:color-mix(in oklab,var(--dsw-alias-bg-base) 95%,var(--dsw-alias-label-primary) 5%);
  --rc-surface-2:color-mix(in oklab,var(--dsw-alias-bg-base) 90%,var(--dsw-alias-label-primary) 10%);
  --rc-line:color-mix(in oklab,var(--dsw-alias-label-primary) 11%,transparent);
  --rc-line-strong:color-mix(in oklab,var(--dsw-alias-label-primary) 18%,transparent);
  --rc-accent:var(--dsw-alias-state-business-primary);
  --rc-accent-soft:color-mix(in oklab,var(--dsw-alias-state-business-primary) 10%,transparent);
  --rc-shadow-card:0 1px 2px color-mix(in oklab,var(--dsw-alias-label-primary) 7%,transparent),0 4px 14px -6px color-mix(in oklab,var(--dsw-alias-label-primary) 10%,transparent);
  --rc-shadow-float:0 2px 6px color-mix(in oklab,var(--dsw-alias-label-primary) 10%,transparent),0 24px 64px -16px color-mix(in oklab,var(--dsw-alias-label-primary) 32%,transparent);
  --rc-edge:inset 0 1px 0 color-mix(in oklab,var(--dsw-alias-label-primary) 7%,transparent);
}
.rc-share-modal{display:flex;flex-direction:column;width:min(640px,100%);max-height:calc(100dvh - 48px);overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-overlay);border:1px solid var(--rc-line);border-radius:var(--dsw-radius-lg);box-shadow:var(--rc-shadow-float),var(--rc-edge);animation:rc-share-enter .22s cubic-bezier(.23,1,.32,1)}
.rc-share-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:20px 24px 16px;border-bottom:1px solid var(--rc-line)}
.rc-share-heading{display:flex;align-items:center;gap:12px;min-width:0}
.rc-share-mark{display:grid;place-items:center;width:36px;height:36px;flex:none;border-radius:var(--dsw-radius-md);background:var(--rc-accent-soft);color:var(--rc-accent)}
.rc-share-modal-title{margin:0;font-size:16px;line-height:1.35;font-weight:600}
.rc-share-subtitle{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.45}
.rc-share-close{display:grid;place-items:center;width:32px;height:32px;flex:none;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .1s ease,color .1s ease}
.rc-share-close:hover{background:var(--rc-surface-2);color:var(--dsw-alias-label-primary)}
.rc-share-head-tools{display:flex;align-items:center;gap:8px;flex:none}
.rc-share-history-button{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 10px;border:1px solid var(--rc-line);border-radius:var(--dsw-radius-sm);background:var(--rc-surface-1);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;cursor:pointer;transition:background .1s ease,color .1s ease,border-color .1s ease}
.rc-share-history-button:hover{background:var(--rc-surface-2);color:var(--dsw-alias-label-primary);border-color:var(--rc-line-strong)}
.rc-share-history-button[aria-expanded="true"]{background:var(--rc-accent-soft);color:var(--rc-accent);border-color:var(--rc-accent)}
.rc-share-history-icon{display:inline-flex;flex:none}
.rc-share-history{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--rc-line);border-radius:var(--dsw-radius-md);background:var(--rc-surface-1)}
.rc-share-history-head{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px;font-weight:600}
.rc-share-history-count{display:inline-grid;place-items:center;min-width:22px;height:22px;padding:0 7px;border-radius:999px;background:var(--rc-surface-2);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600}
.rc-share-history-row{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--rc-line);border-radius:var(--dsw-radius-sm);background:var(--rc-surface-0)}
.rc-share-history-row[data-rc-share-status="revoked"]{opacity:.72}
.rc-share-history-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rc-share-history-time{color:var(--dsw-alias-label-secondary);font-size:12px}
.rc-share-history-actions{display:flex;align-items:center;gap:8px;margin-top:2px}
.rc-share-modal-body{display:flex;flex-direction:column;gap:20px;min-height:0;padding:20px 24px;overflow-y:auto;overscroll-behavior:contain}
.rc-share-form{display:flex;flex-direction:column;gap:20px}
.rc-share-field{display:flex;flex-direction:column;gap:8px;min-width:0}
.rc-share-label{font-size:13px;line-height:1.4;font-weight:600}
.rc-share-input{width:100%;box-sizing:border-box;height:42px;padding:0 12px;border:1px solid var(--rc-line-strong);border-radius:var(--dsw-radius-sm);outline:none;background:var(--rc-surface-0);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;transition:border-color .1s ease,box-shadow .1s ease}
.rc-share-input:focus{border-color:var(--rc-accent);box-shadow:0 0 0 3px var(--rc-accent-soft)}
.rc-share-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}
.rc-share-choices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.rc-share-choice{position:relative;display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid var(--rc-line);border-radius:var(--dsw-radius-md);background:var(--rc-surface-1);cursor:pointer;transition:border-color .1s ease,background .1s ease,box-shadow .1s ease}
.rc-share-choice:hover{border-color:var(--rc-line-strong);background:var(--rc-surface-2)}
.rc-share-choice[data-selected="true"]{border-color:var(--rc-accent);background:var(--rc-accent-soft);box-shadow:inset 0 0 0 1px var(--rc-accent)}
.rc-share-choice:focus-within{outline:2px solid var(--rc-accent);outline-offset:2px}
.rc-share-choice input{position:absolute;opacity:0;pointer-events:none}
.rc-share-choice-icon{display:inline-flex;flex:none;margin-top:1px;color:var(--dsw-alias-label-secondary)}
.rc-share-choice[data-selected="true"] .rc-share-choice-icon{color:var(--rc-accent)}
.rc-share-choice-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.rc-share-choice-title{font-size:13px;line-height:1.4;font-weight:600}
.rc-share-choice-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.45}
.rc-share-scope{display:flex;align-items:flex-start;gap:8px;padding:12px;border-radius:var(--dsw-radius-sm);background:var(--rc-surface-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}
.rc-share-scope svg{flex:none;margin-top:1px;color:var(--rc-accent)}
.rc-share-result{display:flex;flex-direction:column;gap:16px}
.rc-share-next{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px dashed var(--rc-line-strong);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;text-align:left;transition:border-color .1s ease,color .1s ease,background .1s ease}
.rc-share-next:hover{border-color:var(--rc-accent);background:var(--rc-accent-soft);color:var(--rc-accent)}
.rc-share-next-summary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rc-share-next-action{flex:none;color:var(--rc-accent);font-weight:600}
.rc-share-created{display:flex;flex-direction:column;gap:16px;padding:16px;border:1px solid var(--rc-line);border-radius:var(--dsw-radius-md);background:var(--rc-surface-1);box-shadow:var(--rc-shadow-card),var(--rc-edge)}
.rc-share-created-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.rc-share-created-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;font-weight:600}
.rc-share-success{width:8px;height:8px;flex:none;border-radius:50%;background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 4px color-mix(in oklab,var(--dsw-alias-state-success-primary) 12%,transparent)}
.rc-share-created-grid{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:start}
.rc-share-credentials{display:flex;flex-direction:column;gap:12px;min-width:0}
.rc-share-value{display:flex;align-items:center;gap:8px;min-width:0}
.rc-share-value-text{flex:1;min-width:0;padding:10px 12px;border:1px solid var(--rc-line);border-radius:var(--dsw-radius-sm);background:var(--rc-surface-0);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rc-share-passcode{font-size:18px;font-weight:600;letter-spacing:.18em}
.rc-share-copy{display:inline-flex;align-items:center;justify-content:center;flex:none;min-height:36px;padding:0 10px;border:1px solid var(--rc-line);border-radius:var(--dsw-radius-sm);background:var(--rc-surface-0);color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500;cursor:pointer;transition:background .1s ease,border-color .1s ease}
.rc-share-copy:hover{background:var(--rc-surface-2);border-color:var(--rc-line-strong)}
.rc-share-qr-wrap{flex:none}
.rc-share-qr{width:132px;padding:8px;border:1px solid var(--rc-line);border-radius:var(--dsw-radius-sm);background:#fff}
.rc-share-qr svg{display:block;width:100%;height:auto}
.rc-share-qr-caption{margin-top:6px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.45}
.rc-share-modal-foot{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 24px;border-top:1px solid var(--rc-line);background:var(--rc-surface-1)}
.rc-share-foot-note{max-width:340px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.45}
.rc-share-actions{display:flex;align-items:center;gap:8px;flex:none}
.rc-share-action{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:0 14px;border:1px solid var(--rc-line);border-radius:var(--dsw-radius-sm);background:var(--rc-surface-0);color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;cursor:pointer;transition:background .1s ease,border-color .1s ease}
.rc-share-action:hover{background:var(--rc-surface-2);border-color:var(--rc-line-strong)}
.rc-share-action[data-primary="true"]{border-color:var(--rc-accent);background:var(--rc-accent);color:#fff}
.rc-share-action[data-primary="true"]:hover{filter:brightness(1.06)}
.rc-share-action:disabled{opacity:.5;cursor:not-allowed}
.rc-share-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5}
.rc-share-row{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:16px;border:1px solid var(--rc-line);border-radius:var(--dsw-radius-md);background:var(--rc-surface-1);box-shadow:var(--rc-shadow-card),var(--rc-edge)}
.rc-share-main{display:flex;flex-direction:column;gap:4px;min-width:0}
.rc-share-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;font-weight:600}
.rc-share-meta{display:flex;flex-direction:column;gap:2px;color:var(--dsw-alias-label-secondary);font-size:12px}
.rc-share-badge{display:inline-flex;align-items:center;padding:2px 7px;border:1px solid var(--rc-line);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.3}
.rc-share-badge[data-status="disabled"],.rc-share-badge[data-status="revoked"]{color:var(--dsw-alias-label-tertiary)}
.rc-share-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;word-break:break-all;color:var(--dsw-alias-label-primary)}
@keyframes rc-share-fade{from{opacity:0}to{opacity:1}}
@keyframes rc-share-enter{from{opacity:0;transform:translateY(12px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}
@media (max-width: 1023px) {
  .rc-share-overlay{align-items:flex-end;padding:0}
  .rc-share-modal{width:100%;max-height:calc(100dvh - 16px);border-bottom:0;border-radius:var(--dsw-radius-lg) var(--dsw-radius-lg) 0 0}
  .rc-share-modal-head{padding:16px}
  .rc-share-modal-body{padding:16px}
  .rc-share-modal-foot{flex-direction:column;align-items:stretch;padding:12px 16px}
  .rc-share-foot-note{max-width:none}
  .rc-share-actions{justify-content:flex-end}
  .rc-share-action{min-height:44px}
  .rc-share-choices{grid-template-columns:1fr}
  .rc-share-created-grid{grid-template-columns:1fr}
  .rc-share-qr-wrap{justify-self:center}
  .rc-share-row{flex-direction:column;align-items:stretch;gap:12px}
  .rc-share-actions{width:100%}
  /* The app's own share action shows its glyph and its name on a phone, so
     this one does too — only the name of the button is scoped here, the
     labels of the dialog keep their own. */
  .rc-share-button{min-height:44px;padding:6px 12px;gap:5px}
  .rc-share-button .rc-share-label{display:inline}
  .rc-share-input{min-height:44px}
  .rc-share-choice{min-height:44px;align-items:center}
  .rc-share-copy{min-height:44px}
}
@media (prefers-reduced-motion: reduce) {
  .rc-share-overlay,.rc-share-modal{animation:none}
  .rc-share-button,.rc-share-choice,.rc-share-action,.rc-share-copy{transition:none}
}
`

    /**
     * Install the share stylesheet once in the document head.
     *
     * The conversation header and the Settings page share it. A hot reload
     * must not append another copy, and a component render must never reparse
     * the sheet.
     *
     * @returns {() => void}
     */
    function installShareStyles() {
      const id = 'dsh-remote-control-share-styles'
      if (document.getElementById(id) !== null) return () => {}
      const style = document.createElement('style')
      style.id = id
      style.setAttribute('data-plugin', '@local/remote-control')
      style.textContent = SHARE_CSS
      document.head.appendChild(style)
      return () => style.remove()
    }

    /** The plugin context, captured for the components rendered later. */
    let hostCtx

    /**
     * The plugin's own locale binding.
     *
     * A slot component receives the binding of its own namespace; this
     * fallback keeps the components working when a slot hands over none.
     *
     * @param {string} key
     * @returns {string}
     */
    let translate = (key) => key

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
      // The host returns epoch milliseconds for a newly created share and an
      // ISO string for an older record; both are valid timestamps.
      const date = typeof value === 'number' && Number.isFinite(value)
        ? new Date(value)
        : (typeof value === 'string' && value.length > 0 ? new Date(value) : null)
      if (date === null || Number.isNaN(date.getTime())) return '—'
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
     * The title of the conversation a slot component belongs to.
     *
     * The session store keeps the durable title of a session and the title it
     * is shown with; the header shows the second one, so the share dialog
     * starts from the same name.
     *
     * @param {{sessionId?: string, useSessions?: Function}} props
     * @returns {string}
     */
    function sessionTitle(props) {
      const store = props.useSessions
      if (typeof store !== 'function') return ''
      return store((state) => {
        const summary = state?.byId?.[props.sessionId]
        return summary?.displayTitle ?? summary?.title ?? ''
      })
    }

    /**
     * The session a slot component belongs to.
     *
     * A session scoped slot carries the session id itself. When it does not,
     * the session store answers: the last session of the list is the one the
     * sidebar shows last.
     *
     * @param {{sessionId?: string, useSessions?: Function}} props
     * @returns {string}
     */
    function sessionIdOf(props) {
      const store = props.useSessions
      // The store is always asked, so the number of hooks stays the same
      // whether the slot carries a session or not.
      const fallback = typeof store === 'function'
        ? store((state) => {
          const ids = Array.isArray(state?.ids) ? state.ids : []
          if (ids.length === 0) return ''
          return ids[ids.length - 1]
        })
        : ''
      if (typeof props.sessionId === 'string' && props.sessionId.length > 0) return props.sessionId
      return fallback
    }

    /**
     * The name of one permission.
     *
     * @param {Function} t the locale binding
     * @param {unknown} permission
     * @returns {string}
     */
    function permissionLabel(t, permission) {
      return permission === 'write' ? t('sharePermissionWrite') : t('sharePermissionRead')
    }

    /**
     * The name of one share status.
     *
     * @param {Function} t the locale binding
     * @param {string} status
     * @returns {string}
     */
    function statusLabel(t, status) {
      if (status === 'disabled') return t('shareStatusDisabled')
      if (status === 'revoked') return t('shareStatusRevoked')
      return t('shareStatusActive')
    }

    /**
     * The link of one share, or the empty string when there is none.
     *
     * @param {any} share
     * @returns {string}
     */
    function shareLink(share) {
      return typeof share?.link === 'string' ? share.link : ''
    }

    /**
     * The passcode of one share, or the empty string when there is none.
     *
     * @param {any} share
     * @returns {string}
     */
    function sharePasscode(share) {
      return typeof share?.passcode === 'string' ? share.passcode : ''
    }

    /**
     * The small glyph of the share button.
     *
     * @returns {any}
     */
    function shareIcon() {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      h('path', { d: 'M6.4 9.6 9.6 6.4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      h('path', { d: 'M7.2 4.4 8.8 2.8a2.6 2.6 0 0 1 3.7 3.7L10.9 8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      h('path', { d: 'M8.8 11.6 7.2 13.2a2.6 2.6 0 0 1-3.7-3.7L5.1 8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }))
    }

    /**
     * The close glyph of the modal.
     * @returns {any}
     */
    function historyIcon() {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
      },
      h('path', {
        d: 'M8 3.2v4.9l3 1.8', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
      }),
      h('circle', { cx: 8, cy: 8, r: 5.6, stroke: 'currentColor', strokeWidth: 1.4 }))
    }

    function closeIcon() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': 'true', focusable: 'false',
      }, h('path', {
        d: 'm4 4 8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
      }))
    }

    /**
     * The shield that marks the guest's file boundary.
     * @returns {any}
     */
    function scopeIcon() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': 'true', focusable: 'false',
      },
      h('path', {
        d: 'M8 1.8 13 3.7v3.6c0 3.2-2.1 5.6-5 6.9-2.9-1.3-5-3.7-5-6.9V3.7L8 1.8Z',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
      }),
      h('path', {
        d: 'm5.7 7.8 1.5 1.5 3.1-3.1', stroke: 'currentColor', strokeWidth: 1.3,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    /**
     * The glyph of one permission option.
     * @param {'read' | 'write'} permission
     * @returns {any}
     */
    function permissionIcon(permission) {
      const common = {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': 'true', focusable: 'false',
      }
      if (permission === 'write') {
        return h('svg', common,
          h('path', {
            d: 'M3 3.2h10v7H7.8L4.4 12.8v-2.6H3V3.2Z',
            stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
          }),
          h('path', {
            d: 'M5.5 6.2h5M5.5 8h3.5', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
          }))
      }
      return h('svg', common,
        h('path', {
          d: 'M1.8 8s2.1-3.6 6.2-3.6S14.2 8 14.2 8 12.1 11.6 8 11.6 1.8 8 1.8 8Z',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
        }),
        h('circle', { cx: 8, cy: 8, r: 1.8, stroke: 'currentColor', strokeWidth: 1.3 }))
    }

    /**
     * The dialog that shares the current conversation.
     *
     * Every share is a record of its own: it carries its own link, its own
     * passcode and its own permission. Sharing the same conversation again
     * therefore adds a record instead of changing the old one.
     *
     * @param {{t: Function, sessionId: string, title: string, onClose: () => void}} props
     */
    function ShareDialog(props) {
      const t = props.t
      const [title, setTitle] = React.useState(props.title ?? '')
      const [permission, setPermission] = React.useState('read')
      const [busy, setBusy] = React.useState(false)
      const [created, setCreated] = React.useState([])
      const [setupOpen, setSetupOpen] = React.useState(true)
      const [error, setError] = React.useState(null)
      const [copied, setCopied] = React.useState(null)
      // The shares of this conversation: every link that was made for it, and
      // whether it still works.
      const [history, setHistory] = React.useState([])
      const [historyOpen, setHistoryOpen] = React.useState(false)
      const dialogRef = React.useRef(null)

      // A modal owns the viewport, not the conversation header that opened it.
      // Besides centering it, this locks the page behind it and gives Escape,
      // Tab and focus restoration their expected modal behaviour.
      // The history of this conversation: the shares of it, newest first.
      React.useEffect(() => {
        if (props.sessionId.length === 0) return
        call('shareList').then((result) => {
          const all = Array.isArray(result.value?.shares) ? result.value.shares : []
          setHistory(all.filter((share) => share.sessionId === props.sessionId))
        }).catch(() => setHistory([]))
      }, [props.sessionId])

      React.useEffect(() => {
        const previousOverflow = document.body.style.overflow
        const previousFocus = document.activeElement
        document.body.style.overflow = 'hidden'
        const timer = window.setTimeout(() => {
          const first = dialogRef.current?.querySelector('[data-rc-share-title],button,input')
          first?.focus?.()
          if (first?.getAttribute?.('data-rc-share-title') === 'true') first.select?.()
        }, 0)
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            props.onClose()
            return
          }
          if (event.key !== 'Tab' || dialogRef.current === null) return
          const controls = Array.from(dialogRef.current.querySelectorAll('button:not([disabled]),input:not([disabled]),[href]'))
          if (controls.length === 0) return
          const first = controls[0]
          const last = controls[controls.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        window.addEventListener('keydown', onKey, true)
        return () => {
          window.clearTimeout(timer)
          window.removeEventListener('keydown', onKey, true)
          document.body.style.overflow = previousOverflow
          previousFocus?.focus?.()
        }
      }, [])

      const generate = React.useCallback(() => {
        setBusy(true)
        setError(null)
        const payload = { sessionId: props.sessionId, permission }
        const name = title.trim()
        // An empty title would replace the name of the conversation, so it is
        // only sent when there is one.
        if (name.length > 0) payload.title = name
        call('shareCreate', payload).then((result) => {
          setBusy(false)
          if (result?.ok === true) {
            // Every share is a record of its own, so the new one joins the
            // ones this dialog has already made.
            setCreated((list) => [...list, result.value])
            // The result deserves the viewport: the next share's settings fold
            // into one row and can be opened again to change its permission.
            setSetupOpen(false)
            return
          }
          setError(messageOf(result, t('shareFailed')))
        }).catch((cause) => {
          setBusy(false)
          setError(cause instanceof Error && cause.message === 'restart-required' ? t('restartRequired') : String(cause))
        })
      }, [permission, props.sessionId, t, title])

      const copy = React.useCallback((what, value) => {
        copyText(value).then((ok) => {
          if (!ok) return
          setCopied(what)
          window.setTimeout(() => setCopied(null), 1500)
        })
      }, [])

      const choice = (value, label, hint) => h('label', {
        className: 'rc-share-choice',
        'data-selected': permission === value ? 'true' : 'false',
      },
      h('input', {
        type: 'radio',
        name: 'rc-share-permission',
        value,
        checked: permission === value,
        'data-rc-share-permission-choice': value,
        onChange: () => setPermission(value),
      }),
      h('span', { className: 'rc-share-choice-icon' }, permissionIcon(value)),
      h('span', { className: 'rc-share-choice-text' },
        h('span', { className: 'rc-share-choice-title' }, label),
        h('span', { className: 'rc-share-choice-desc' }, hint)))

      const setup = h('div', { className: 'rc-share-form' },
        h('div', { className: 'rc-share-field' },
          h('label', { className: 'rc-share-label', htmlFor: 'rc-share-title' }, t('shareTitleLabel')),
          h('input', {
            id: 'rc-share-title',
            className: 'rc-share-input',
            value: title,
            'data-rc-share-title': 'true',
            onChange: (event) => setTitle(event.target.value),
          }),
          h('div', { className: 'rc-share-hint' }, t('shareTitleHint'))),
        h('div', { className: 'rc-share-field' },
          h('div', { className: 'rc-share-label' }, t('sharePermissionLabel')),
          h('div', {
            className: 'rc-share-choices',
            role: 'radiogroup',
            'aria-label': t('sharePermissionLabel'),
          },
          choice('read', t('sharePermissionRead'), t('sharePermissionReadHint')),
          choice('write', t('sharePermissionWrite'), t('sharePermissionWriteHint')))),
        h('div', { className: 'rc-share-scope' }, scopeIcon(), h('span', null, t('shareScopeHint'))))

      const result = created.length === 0
        ? null
        : h('div', { className: 'rc-share-result', 'data-rc-share-result': 'true' },
          created.map((share) => {
            const link = shareLink(share)
            const passcode = sharePasscode(share)
            const code = link.length > 0 ? qrSvg(link) : ''
            const key = share.id ?? String(link)
            return h('article', { className: 'rc-share-created', key, 'data-rc-share-record': key },
              h('div', { className: 'rc-share-created-head' },
                h('div', { className: 'rc-share-created-title' },
                  h('span', { className: 'rc-share-success', 'aria-hidden': 'true' }),
                  h('span', null, t('shareLinkReady')),
                  h('span', { className: 'rc-share-badge', 'data-rc-share-permission': share.permission }, permissionLabel(t, share.permission))),
                h('span', { className: 'rc-share-hint' }, `${t('shareCreatedAt')}: ${formatTime(share.createdAt)}`)),
              h('div', { className: 'rc-share-created-grid' },
                h('div', { className: 'rc-share-credentials' },
                  link.length === 0
                    ? h('div', { className: 'rc-share-error', 'data-rc-share-no-relay': 'true' }, t('shareNoRelay'))
                    : h('div', { className: 'rc-share-field' },
                      h('div', { className: 'rc-share-label' }, t('shareLinkLabel')),
                      h('div', { className: 'rc-share-value' },
                        h('code', { className: 'rc-share-value-text', 'data-rc-share-link': 'true', title: link }, link),
                        h('button', {
                          type: 'button',
                          className: 'rc-share-copy',
                          'data-rc-share-copy-link': 'true',
                          onClick: () => copy(`${key}:link`, link),
                        }, copied === `${key}:link` ? t('shareCopied') : t('shareCopyLink')),
                        h('button', {
                          type: 'button',
                          className: 'rc-share-copy',
                          'data-rc-share-open-link': 'true',
                          onClick: () => window.open(link, '_blank', 'noopener,noreferrer'),
                        }, t('shareOpenLink')))),
                  h('div', { className: 'rc-share-field' },
                    h('div', { className: 'rc-share-label' }, t('sharePasscodeLabel')),
                    h('div', { className: 'rc-share-value' },
                      h('code', { className: 'rc-share-value-text rc-share-passcode', 'data-rc-share-passcode': 'true' }, passcode),
                      h('button', {
                        type: 'button',
                        className: 'rc-share-copy',
                        'data-rc-share-copy-passcode': 'true',
                        onClick: () => copy(`${key}:passcode`, passcode),
                      }, copied === `${key}:passcode` ? t('shareCopied') : t('shareCopyPasscode'))),
                    h('div', { className: 'rc-share-hint' }, t('sharePasscodeHint')))),
                code.length === 0
                  ? null
                  : h('div', { className: 'rc-share-qr-wrap' },
                    h('div', { className: 'rc-share-qr', dangerouslySetInnerHTML: { __html: code } }),
                    h('div', { className: 'rc-share-qr-caption' }, t('shareQrCaption')))))
          }))

      const nextEditor = setupOpen || created.length === 0
        ? setup
        : h('button', {
          type: 'button',
          className: 'rc-share-next',
          'data-rc-share-edit-next': 'true',
          onClick: () => setSetupOpen(true),
        },
        h('span', { className: 'rc-share-next-summary' }, `${title.trim() || t('shareDialogTitle')} · ${permissionLabel(t, permission)}`),
        h('span', { className: 'rc-share-next-action' }, t('shareEditNext')))

      return ReactDOM.createPortal(
        h('div', {
          className: 'rc-share-overlay',
          'data-rc-share-overlay': 'true',
          onClick: (event) => {
            if (event.target === event.currentTarget) props.onClose()
          },
        },
        h('section', {
          ref: dialogRef,
          className: 'rc-share-modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'rc-share-modal-title',
          onClick: (event) => event.stopPropagation(),
        },
        h('header', { className: 'rc-share-modal-head' },
          h('div', { className: 'rc-share-heading' },
            h('span', { className: 'rc-share-mark' }, shareIcon()),
            h('div', null,
              h('h2', { className: 'rc-share-modal-title', id: 'rc-share-modal-title' }, t('shareDialogTitle')),
              h('p', { className: 'rc-share-subtitle' }, t('shareDialogSubtitle')))),
          h('div', { className: 'rc-share-head-tools' },
            h('button', {
              type: 'button',
              className: 'rc-share-history-button',
              'data-rc-share-history': 'true',
              'aria-expanded': historyOpen ? 'true' : 'false',
              onClick: () => setHistoryOpen(!historyOpen),
            }, h('span', { className: 'rc-share-history-icon' }, historyIcon()), h('span', null, t('shareHistoryButton'))),
            h('button', {
              type: 'button',
              className: 'rc-share-close',
              'aria-label': t('shareModalClose'),
              onClick: props.onClose,
            }, closeIcon()))),
        h('div', { className: 'rc-share-modal-body' },
          historyOpen
            ? h('div', { className: 'rc-share-history', 'data-rc-share-history-panel': 'true' },
              h('div', { className: 'rc-share-history-head' },
                h('span', null, t('shareHistoryTitle')),
                h('span', { className: 'rc-share-history-count' }, String(history.length))),
              history.length === 0
                ? h('div', { className: 'rc-muted' }, t('shareHistoryEmpty'))
                : history.map((share) => {
                  const status = typeof share.status === 'string'
                    ? share.status
                    : (share.revokedAt === null || share.revokedAt === undefined ? 'active' : 'revoked')
                  const link = shareLink(share)
                  const passcode = sharePasscode(share)
                  return h('div', {
                    className: 'rc-share-history-row',
                    'data-rc-share-history-row': 'true',
                    'data-rc-share-status': status,
                  },
                  h('div', { className: 'rc-share-history-line' },
                    h('span', {
                      className: 'rc-share-badge',
                      'data-rc-share-permission': share.permission,
                    }, permissionLabel(t, share.permission)),
                    h('span', {
                      className: 'rc-share-badge',
                      'data-rc-share-status-badge': 'true',
                      'data-status': status,
                    }, statusLabel(t, status)),
                    h('span', { className: 'rc-share-history-time' }, `${t('shareCreatedAt')}: ${formatTime(share.createdAt)}`)),
                  h('div', { className: 'rc-share-history-line' },
                    h('code', { className: 'rc-share-code', 'data-rc-share-link': 'true' }, link.length > 0 ? link : t('shareNoRelayShort')),
                    h('code', { className: 'rc-share-code rc-share-passcode', 'data-rc-share-passcode': 'true' }, passcode.length > 0 ? passcode : '—')),
                  h('div', { className: 'rc-share-history-actions' },
                    h('button', {
                      type: 'button',
                      className: 'rc-button',
                      'data-rc-share-history-copy': 'true',
                      onClick: () => {
                        const value = shareLink(share)
                        if (value.length === 0) return
                        copyText(value).then((ok) => {
                          if (!ok) return
                          setCopied(`${share.id}:link`)
                          window.setTimeout(() => setCopied(null), 1500)
                        })
                      },
                    }, copied === `${share.id}:link` ? t('copied') : t('copyLink')),
                    status === 'active'
                      ? h('button', {
                        type: 'button',
                        className: 'rc-button',
                        'data-rc-share-history-disable': 'true',
                        onClick: () => {
                          call('shareDisable', { id: share.id }).then(() => {
                            setHistory((current) => current.map((entry) => (entry.id === share.id
                              ? Object.assign({}, entry, { revokedAt: Date.now(), status: 'revoked' })
                              : entry)))
                          })
                        },
                      }, t('disable'))
                      : null,
                    h('button', {
                      type: 'button',
                      className: 'rc-button rc-button-danger',
                      'data-rc-share-history-delete': 'true',
                      onClick: () => {
                        // A delete takes the link and the passcode away for
                        // good, and the link stops working at once, so ask
                        // first.
                        if (!window.confirm(t('shareDeleteConfirm'))) return
                        call('shareDelete', { id: share.id }).then((answer) => {
                          if (answer === undefined || answer.ok !== true) return
                          setHistory((current) => current.filter((entry) => entry.id !== share.id))
                        })
                      },
                    }, t('shareDelete'))))
                }))
          : null,
          nextEditor,
          result,
          props.sessionId.length === 0
            ? h('div', { className: 'rc-share-error' }, t('shareNoSession'))
            : null,
          error !== null ? h('div', { className: 'rc-share-error', role: 'alert' }, error) : null),
        h('footer', { className: 'rc-share-modal-foot' },
          h('div', { className: 'rc-share-foot-note' }, t('shareAgainNote')),
          h('div', { className: 'rc-share-actions' },
            h('button', {
              type: 'button',
              className: 'rc-share-action',
              'data-rc-share-close': 'true',
              onClick: props.onClose,
            }, t('shareClose')),
            h('button', {
              type: 'button',
              className: 'rc-share-action',
              'data-primary': 'true',
              'data-rc-share-generate': 'true',
              disabled: busy === true || props.sessionId.length === 0,
              onClick: created.length > 0 && !setupOpen ? () => setSetupOpen(true) : generate,
            }, busy === true
              ? t('shareGenerating')
              : (created.length === 0 ? t('shareGenerate') : t('shareGenerateAnother'))))))),
        document.body,
      )
    }

    /**
     * The share button in the conversation header.
     *
     * The slot it lives in is scoped to the session, so the session id is one
     * of its props.
     *
     * @param {{sessionId?: string, useSessions?: Function, t?: Function}} props
     */
    function ShareConversationAction(props) {
      const t = typeof props.t === 'function' ? props.t : translate
      const [open, setOpen] = React.useState(false)
      const sessionId = sessionIdOf(props)
      const title = sessionTitle(props)
      return h('div', { className: 'rc-share-anchor' },
        h('button', {
          type: 'button',
          className: 'rc-button rc-share-button',
          'data-rc-share-open': 'true',
          'aria-haspopup': 'dialog',
          'aria-expanded': open === true ? 'true' : 'false',
          'aria-label': t('shareButton'),
          title: t('shareButton'),
          onClick: () => setOpen(true),
        }, h('span', { className: 'rc-share-icon' }, shareIcon()), h('span', { className: 'rc-share-label' }, t('shareButtonShort'))),
        open === true
          ? h(ShareDialog, {
            t,
            sessionId,
            title,
            onClose: () => setOpen(false),
          })
          : null)
    }

    /**
     * One shared conversation in the settings list.
     *
     * @param {{share: any, t: Function, copied: string | null, onCopy: Function, onDisable: Function, onDelete: Function}} props
     */
    function ShareRow(props) {
      const t = props.t
      const share = props.share
      const status = typeof share.status === 'string'
        ? share.status
        : (share.revokedAt === null || share.revokedAt === undefined ? 'active' : 'revoked')
      const link = shareLink(share)
      const passcode = sharePasscode(share)
      const copied = props.copied
      return h('div', {
        className: 'rc-share-row',
        'data-rc-share-row': 'true',
        'data-rc-share-status': status,
      },
      h('div', { className: 'rc-share-main' },
        h('div', { className: 'rc-share-title' },
          h('span', null, share.title ?? '—'),
          h('span', {
            className: 'rc-share-badge',
            'data-rc-share-permission': share.permission,
          }, permissionLabel(t, share.permission)),
          h('span', {
            className: 'rc-share-badge',
            'data-rc-share-status-badge': 'true',
            'data-status': status,
          }, statusLabel(t, status))),
        h('div', { className: 'rc-share-meta' }, `${t('shareCreatedAt')}: ${formatTime(share.createdAt)}`),
        h('div', { className: 'rc-share-meta' },
          h('code', { className: 'rc-share-code', 'data-rc-share-link': 'true' }, link.length > 0 ? link : t('shareNoRelayShort'))),
        h('div', { className: 'rc-share-meta' },
          h('code', { className: 'rc-share-code rc-share-passcode', 'data-rc-share-passcode': 'true' }, passcode.length > 0 ? passcode : '—'))),
      h('div', { className: 'rc-share-actions' },
        h('button', {
          type: 'button',
          className: 'rc-button',
          'data-rc-share-copy-link': 'true',
          disabled: link.length === 0,
          onClick: () => props.onCopy(share, 'link'),
        }, copied === `${share.id}:link` ? t('shareCopied') : t('shareCopyLink')),
        h('button', {
          type: 'button',
          className: 'rc-button',
          'data-rc-share-copy-passcode': 'true',
          disabled: passcode.length === 0,
          onClick: () => props.onCopy(share, 'passcode'),
        }, copied === `${share.id}:passcode` ? t('shareCopied') : t('shareCopyPasscode')),
        status === 'active'
          ? h('button', {
            type: 'button',
            className: 'rc-button',
            'data-rc-share-disable': 'true',
            title: t('shareDisableHint'),
            onClick: () => props.onDisable(share),
          }, t('shareDisable'))
          : null,
        h('button', {
          type: 'button',
          className: 'rc-button',
          'data-danger': 'true',
          'data-rc-share-delete': 'true',
          title: t('shareDeleteHint'),
          onClick: () => props.onDelete(share),
        }, t('shareDelete'))))
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
      const [shares, setShares] = React.useState([])
      const [shareError, setShareError] = React.useState(null)
      const [shareNotice, setShareNotice] = React.useState(null)
      const [copiedShare, setCopiedShare] = React.useState(null)

      /**
       * The shared conversations of this computer.
       *
       * The list is read on its own, so a host that does not know the method
       * yet does not disturb the rest of the page.
       *
       * @returns {Promise<void>}
       */
      const refreshShares = React.useCallback(() => {
        return call('shareList').then((result) => {
          if (result?.ok === true) {
            setShares(Array.isArray(result.value?.shares) ? result.value.shares : [])
          }
        }).catch(() => {
          // The host may not know the method yet; the page keeps working.
        })
      }, [])

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
        refreshShares()
        const timer = window.setInterval(() => {
          refresh()
          refreshShares()
        }, 3000)
        return () => window.clearInterval(timer)
      }, [refresh, refreshShares])

      /**
       * Run one method of the shared conversation API.
       *
       * @param {string} endpoint
       * @param {Record<string, unknown>} payload
       * @returns {Promise<boolean>}
       */
      const runShare = React.useCallback((endpoint, payload) => {
        setShareError(null)
        return call(endpoint, payload).then((result) => {
          if (result?.ok === true) {
            refreshShares()
            return true
          }
          setShareError(messageOf(result, t('shareFailed')))
          return false
        }).catch((cause) => {
          setShareError(cause instanceof Error && cause.message === 'restart-required' ? t('restartRequired') : String(cause))
          return false
        })
      }, [refreshShares, t])

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
        h('div', { className: 'rc-devices', 'data-rc-share-list': 'true' },
          h('div', { className: 'rc-devices-head' },
            h('span', null, t('shareListTitle')),
            h('button', { type: 'button', className: 'rc-button', onClick: refreshShares }, t('refresh'))),
          h('div', { className: 'rc-description' }, t('shareListHint')),
          shares.length === 0
            ? h('div', { className: 'rc-muted' }, t('shareEmpty'))
            : shares.map((share) => h(ShareRow, {
              key: share.id,
              share,
              t,
              copied: copiedShare,
              onCopy: (target, what) => {
                const value = what === 'link' ? shareLink(target) : sharePasscode(target)
                if (value.length === 0) return
                copyText(value).then((ok) => {
                  if (!ok) return
                  setCopiedShare(`${target.id}:${what}`)
                  window.setTimeout(() => setCopiedShare(null), 1500)
                })
              },
              onDisable: (target) => {
                runShare('shareDisable', { id: target.id }).then((ok) => {
                  if (ok) setShareNotice(t('shareDisabled'))
                })
              },
              onDelete: (target) => {
                // A delete takes the link and the passcode away for good, so
                // ask first.
                if (!window.confirm(t('shareDeleteConfirm'))) return
                runShare('shareDelete', { id: target.id }).then((ok) => {
                  if (ok) setShareNotice(t('shareDeleted'))
                })
              },
            })),
          shareNotice !== null ? h('div', { className: 'rc-muted' }, shareNotice) : null,
          shareError !== null ? h('div', { className: 'rc-error', role: 'alert' }, shareError) : null),
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
        ctx.effect(installShareStyles, 'remote-control: share styles')
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
        // On a phone the shell's navigation and the composer's primary action
        // get real targets. They are re-rendered by the shell, so the marks are
        // refreshed on a short tick - the same cadence the sidebar's own
        // anchor uses.
        ctx.effect(() => {
          let labels = null
          let composerLabels = null
          try {
            const sidebar = ctx.locale.bind('sidebar')
            labels = { collapse: sidebar('toggle.collapse'), open: sidebar('toggle.open') }
          } catch (error) {
            // The shell's namespace is not there yet; the tick tries again.
            labels = null
          }
          try {
            const conversation = ctx.locale.bind('conversation')
            composerLabels = [
              conversation('input.send'),
              conversation('input.stop'),
              conversation('input.send.queue'),
              conversation('input.send.steer'),
            ]
          } catch (error) {
            composerLabels = null
          }
          const mark = () => {
            if (labels !== null) markSidebarControls(labels.collapse, labels.open)
            if (composerLabels !== null) markComposerControls(composerLabels)
          }
          mark()
          const timer = setInterval(mark, 750)
          const disposeKeyboard = installKeyboardInset()
          return () => {
            clearInterval(timer)
            disposeKeyboard()
          }
        }, 'remote-control: mobile controls')
        const t = ctx.locale.bind(NS)
        // The slot components of the conversation header get their own
        // binding of this namespace; the fallback covers a slot that has
        // none.
        translate = t
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
        // The share button of the conversation header. The slot is scoped to
        // the session, so the component receives the session id and the
        // session store.
        ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => {
          try {
            return ctx.slots.register({
              name: 'conversation.session.header.utilities',
              id: 'remote-control-share',
              order: 20,
              locale: NS,
              label: () => t('shareButton'),
            }, ShareConversationAction)
          } catch (error) {
            console.warn('[remote-control] the session header share action is already registered', error)
            return () => {}
          }
        }), 'remote-control: session header share')
        ctx.effect(() => installMobileSidebar(ctx), 'remote-control: phone sidebar')
      },
    }
  },
})
})()
