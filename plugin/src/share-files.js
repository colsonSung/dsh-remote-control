/**
 * The look of the files a guest browses.
 *
 * The kinds and the glyphs live here, away from the page, so the page stays a
 * shell and the tests can check the kinds without a browser. The glyphs are
 * inline SVG — the guest page loads no asset.
 */

/**
 * The kind of one file, by its extension.
 *
 * @param {string} path
 * @returns {string} one of markdown, html, image, code, data, text, binary
 */
export function fileKindOf(path) {
  const name = String(path ?? '').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot < 0) return 'text'
  const extension = name.slice(dot + 1).toLowerCase()
  if (extension === 'md' || extension === 'markdown' || extension === 'mdx') return 'markdown'
  if (extension === 'html' || extension === 'htm' || extension === 'xhtml') return 'html'
  if (extension === 'svg') return 'image'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp'].includes(extension)) return 'image'
  if (['json', 'jsonc', 'yml', 'yaml', 'toml', 'ini', 'lock'].includes(extension)) return 'data'
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'py', 'rb', 'sh', 'bash', 'zsh', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'scala', 'dart', 'sql', 'lua', 'r', 'pl', 'vim', 'el'].includes(extension)) return 'code'
  if (['txt', 'log', 'text', 'csv', 'tsv', 'env', 'gitignore', 'editorconfig'].includes(extension)) return 'text'
  if (['pdf', 'zip', 'gz', 'tar', 'tgz', '7z', 'rar', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov', 'wasm', 'bin', 'dylib', 'so', 'dll', 'exe', 'jar', 'class', 'pyc'].includes(extension)) return 'binary'
  return 'text'
}

/**
 * The glyph of one file or folder.
 *
 * @param {string} kind the kind of the entry
 * @param {{ open?: boolean }} [options] whether a folder is open
 * @returns {string} the SVG markup
 */
export function fileIconSvg(kind, options = {}) {
  const stroke = 'currentColor'
  const open = options.open === true
  const box = (body) => '<svg class="tree-svg" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">' + body + '</svg>'
  if (kind === 'directory') {
    return box(open
      ? '<path d="M1.8 4.6a1 1 0 0 1 1-1h3.1l1.2 1.4h5.1a1 1 0 0 1 1 1v5.4a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1V4.6Z" fill="' + stroke + '" fill-opacity=".18" stroke="' + stroke + '" stroke-width="1.1" stroke-linejoin="round"/><path d="M2 6.6h12l-1.3 5.2a1 1 0 0 1-1 .8H4.3a1 1 0 0 1-1-.8L2 6.6Z" fill="' + stroke + '" fill-opacity=".3" stroke="' + stroke + '" stroke-width="1.1" stroke-linejoin="round"/>'
      : '<path d="M1.8 4.6a1 1 0 0 1 1-1h3.1l1.2 1.4h5.1a1 1 0 0 1 1 1v5.4a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1V4.6Z" fill="' + stroke + '" fill-opacity=".18" stroke="' + stroke + '" stroke-width="1.1" stroke-linejoin="round"/>')
  }
  if (kind === 'markdown') {
    return box('<path d="M2.4 2.6h11.2v10.8H2.4z" stroke="' + stroke + '" stroke-width="1.1" stroke-linejoin="round"/><path d="M4.6 10.2V6.2l2 2.4 2-2.4v4" stroke="' + stroke + '" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.2 6.4v3.4h1.4" stroke="' + stroke + '" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>')
  }
  if (kind === 'html') {
    return box('<path d="M4 2.4 2.6 4 4 5.6M12 2.4 13.4 4 12 5.6" stroke="' + stroke + '" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.4 2.4H7.6L6.2 13.6h.8" stroke="' + stroke + '" stroke-width="1.1" stroke-linecap="round"/>')
  }
  if (kind === 'image') {
    return box('<rect x="2.2" y="3" width="11.6" height="10" rx="1.2" stroke="' + stroke + '" stroke-width="1.1"/><circle cx="6" cy="6.4" r="1.1" fill="' + stroke + '" fill-opacity=".55"/><path d="m2.8 11.4 3-2.8 2.2 2 1.8-1.6 3.2 2.8" stroke="' + stroke + '" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>')
  }
  if (kind === 'data') {
    return box('<rect x="2.4" y="3.2" width="11.2" height="9.6" rx="1.2" stroke="' + stroke + '" stroke-width="1.1"/><path d="M5.4 6.2h5.2M5.4 8.2h5.2M5.4 10.2h3" stroke="' + stroke + '" stroke-width="1.1" stroke-linecap="round"/>')
  }
  if (kind === 'binary') {
    return box('<rect x="2.4" y="3.2" width="11.2" height="9.6" rx="1.2" stroke="' + stroke + '" stroke-width="1.1"/><path d="M6.2 6.4v3.2M9.8 6.4v3.2" stroke="' + stroke + '" stroke-width="1.1" stroke-linecap="round"/>')
  }
  if (kind === 'code') {
    return box('<path d="M5.8 4.4 2.8 8l3 3.6M10.2 4.4 13.2 8l-3 3.6" stroke="' + stroke + '" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>')
  }
  return box('<path d="M4 2.6h8a1 1 0 0 1 1 1v8.8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1Z" stroke="' + stroke + '" stroke-width="1.1"/><path d="M5.4 6.2h5.2M5.4 8.4h5.2M5.4 10.6h3" stroke="' + stroke + '" stroke-width="1" stroke-linecap="round" stroke-opacity=".6"/>')
}

/**
 * The size of one entry, as the tree shows it.
 *
 * @param {number | undefined} size in bytes
 * @returns {string}
 */
export function fileSizeLabel(size) {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return size + ' B'
  if (size < 1024 * 1024) return (size / 1024).toFixed(size < 10 * 1024 ? 1 : 0) + ' KB'
  return (size / (1024 * 1024)).toFixed(1) + ' MB'
}
