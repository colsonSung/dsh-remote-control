/**
 * What the guest's browser is told about the bytes it is handed.
 *
 * A file of a share leaves the Host as bytes: the guest page shows a document,
 * a picture, a recording or a download, and the browser needs to know which of
 * them it is. The media type, the name the browser saves it under and the byte
 * range a viewer asks for are decided here, away from the routes, so the tests
 * can read them without a server.
 */

/** The media type of every extension the guest surface serves as bytes. */
const MEDIA_TYPES = {
  // Pictures.
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  // Documents the browser reads itself.
  pdf: 'application/pdf',
  // Office documents: served as the file they are, rendered as a PDF by the
  // route beside this one.
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  // Recordings the browser plays.
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  aiff: 'audio/aiff',
  // Archives and everything else: a download.
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  // Text the browser shows as text.
  txt: 'text/plain; charset=utf-8',
  text: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  markdown: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
}

/**
 * The extension of one path, lower case, without the dot.
 *
 * @param {string} path
 * @returns {string}
 */
export function extensionOf(path) {
  const name = String(path ?? '').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * The media type of one file.
 *
 * An extension the table does not know is served as a download of unknown
 * bytes: the browser guesses nothing, and the page offers the file instead of
 * painting it.
 *
 * @param {string} path
 * @returns {string}
 */
export function contentTypeOf(path) {
  return MEDIA_TYPES[extensionOf(path)] ?? 'application/octet-stream'
}

/**
 * The Office extension the Host can convert, or the empty string.
 *
 * The conversion kit reads exactly six formats; the rest of the Office family
 * (and every other document) stays a download.
 *
 * @param {string} path
 * @returns {'doc' | 'docx' | 'xls' | 'xlsx' | 'ppt' | 'pptx' | ''}
 */
export function officeExtensionOf(path) {
  const extension = extensionOf(path)
  return ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(extension)
    ? /** @type {any} */ (extension)
    : ''
}

/**
 * Whether the bytes of one file are worth showing inside the page.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isPlainTextPath(path) {
  const type = contentTypeOf(path)
  return type.startsWith('text/') || type.startsWith('application/json') || type.startsWith('application/xml')
}

/**
 * The name the browser saves one file under.
 *
 * The plain name carries only ASCII, so an old client reads something; the
 * UTF-8 form carries the real one, so a Chinese name survives the save.
 *
 * @param {string} path
 * @returns {string}
 */
export function downloadNameOf(path) {
  const name = String(path ?? '').split('/').pop() ?? ''
  // Control characters would break the header, and a quote or a backslash
  // would break the quoted form of it.
  return name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120)
}

/**
 * The Content-Disposition of one file.
 *
 * @param {string} path
 * @param {boolean} inline whether the browser may show it in place
 * @returns {string}
 */
export function contentDispositionOf(path, inline) {
  const name = downloadNameOf(path)
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(/['()*!~]/g, (character) =>
    '%' + character.charCodeAt(0).toString(16).toUpperCase())
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/**
 * The window of bytes one request asks for.
 *
 * `undefined` means the request asked for no range and takes the whole file.
 * `null` means the range cannot be answered: the file is smaller than the
 * offset, and HTTP answers 416. Several ranges in one header are read as no
 * range at all, because the route carries one window.
 *
 * @param {string | string[] | undefined} header the Range header
 * @param {number} size how many bytes the file holds
 * @returns {{ start: number, end: number } | null | undefined}
 */
export function parseByteRange(header, size) {
  const value = Array.isArray(header) ? header[0] : header
  if (typeof value !== 'string' || value.length === 0) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (match === null) return undefined
  const startText = match[1]
  const endText = match[2]
  if (startText.length === 0 && endText.length === 0) return undefined
  if (!Number.isFinite(size) || size <= 0) return null
  if (startText.length === 0) {
    // `bytes=-N`: the last N bytes.
    const wanted = Number(endText)
    if (!Number.isFinite(wanted) || wanted <= 0) return undefined
    const start = Math.max(0, size - wanted)
    return { start, end: size - 1 }
  }
  const start = Number(startText)
  if (!Number.isFinite(start) || start >= size) return null
  const end = endText.length === 0 ? size - 1 : Math.min(Number(endText), size - 1)
  if (!Number.isFinite(end) || end < start) return null
  return { start, end }
}
