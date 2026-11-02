/**
 * Rendering the Markdown a guest reads.
 *
 * The guest page has no build step and no module loader, so the renderer
 * travels with the page as its own source: it is a plain function without a
 * closure, the page injects `markdownToHtml.toString()` into the browser, and
 * the tests run it here.
 *
 * The renderer escapes the text of the document before it marks it up. A
 * Markdown file may carry raw HTML, and a guest's page holds the guest's own
 * session — so the markup of the file is shown, never run.
 */

/**
 * Render one Markdown document.
 *
 * @param {string} markdown
 * @param {{ resolve?: (source: string) => string }} [options] the resolver for a relative link or image
 * @returns {string} the HTML
 */
export function markdownToHtml(markdown, options = {}) {
  const text = String(markdown === undefined || markdown === null ? '' : markdown).replace(/\r\n/g, '\n')
  const resolve = typeof options.resolve === 'function' ? options.resolve : (source) => source

  const escape = (value) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

  const safeLink = (target) => {
    const trimmed = String(target ?? '').trim()
    if (trimmed.length === 0) return ''
    if (/^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i.test(trimmed)) return trimmed
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return ''
    return resolve(trimmed)
  }

  const inline = (value) => {
    let out = escape(value)
    // code first: its content is not markup
    const codes = []
    out = out.replace(/`([^`]+)`/g, (all, code) => {
      codes.push(code)
      return '\u0000' + (codes.length - 1) + '\u0000'
    })
    out = out
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (all, alt, source) => {
        const target = safeLink(source)
        if (target.length === 0) return all
        return '<img src="' + target + '" alt="' + alt + '" loading="lazy">'
      })
      .replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (all, label, target) => {
        const href = safeLink(target)
        if (href.length === 0) return label
        const external = /^https?:/i.test(href)
        return '<a href="' + href + '"' + (external ? ' target="_blank" rel="noopener noreferrer"' : '') + '>' + label + '</a>'
      })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    out = out.replace(/\u0000(\d+)\u0000/g, (all, index) => '<code>' + codes[Number(index)] + '</code>')
    // The mark of a hard break survived the escaping, so it becomes a break.
    return out.replace(/zzBRzz/g, '<br>')
  }

  const lines = text.split('\n')
  const out = []
  let index = 0

  const flushList = (items, ordered) => {
    const tag = ordered ? 'ol' : 'ul'
    out.push('<' + tag + '>')
    for (const item of items) out.push('<li>' + inline(item) + '</li>')
    out.push('</' + tag + '>')
  }

  while (index < lines.length) {
    const line = lines[index]

    // a fenced code block
    const fence = /^```\s*([A-Za-z0-9_+-]*)\s*$/.exec(line)
    if (fence !== null) {
      const language = fence[1]
      const body = []
      index++
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        body.push(lines[index])
        index++
      }
      index++
      const code = escape(body.join('\n'))
      out.push('<pre class="md-code"><code' + (language.length > 0 ? ' class="language-' + language + '"' : '') + '>' + code + '</code></pre>')
      continue
    }

    // a heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      const level = heading[1].length
      out.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>')
      index++
      continue
    }

    // a horizontal rule
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push('<hr>')
      index++
      continue
    }

    // a table
    if (index + 1 < lines.length && /\|/.test(line) && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[index + 1])) {
      const cells = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim())
      const head = cells(line)
      const align = cells(lines[index + 1]).map((cell) => {
        if (/^:.*:$/.test(cell)) return 'center'
        if (/:$/.test(cell)) return 'right'
        return 'left'
      })
      index += 2
      const rows = []
      while (index < lines.length && lines[index].includes('|') && lines[index].trim().length > 0) {
        rows.push(cells(lines[index]))
        index++
      }
      out.push('<table><thead><tr>')
      head.forEach((cell, column) => out.push('<th style="text-align:' + (align[column] ?? 'left') + '">' + inline(cell) + '</th>'))
      out.push('</tr></thead><tbody>')
      for (const row of rows) {
        out.push('<tr>')
        row.forEach((cell, column) => out.push('<td style="text-align:' + (align[column] ?? 'left') + '">' + inline(cell) + '</td>'))
        out.push('</tr>')
      }
      out.push('</tbody></table>')
      continue
    }

    // a blockquote
    if (/^\s*>\s?/.test(line)) {
      const body = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ''))
        index++
      }
      out.push('<blockquote>' + markdownToHtml(body.join('\n'), { resolve }) + '</blockquote>')
      continue
    }

    // a list
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const items = []
      while (index < lines.length) {
        const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index])
        if (item === null) {
          if (lines[index].trim().length === 0) {
            const next = lines[index + 1]
            if (next !== undefined && /^\s*([-*+]|\d+[.)])\s+/.test(next)) { index++; continue }
          }
          break
        }
        items.push(item[2])
        index++
      }
      flushList(items, ordered)
      continue
    }

    // a paragraph
    if (line.trim().length === 0) {
      index++
      continue
    }
    const paragraph = []
    while (index < lines.length && lines[index].trim().length > 0 && !/^(#{1,6}\s|```|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[index])) {
      paragraph.push(lines[index])
      index++
    }
    // A soft wrap is one line of the paragraph: the words keep their space.
    // Two trailing spaces ask for a break of their own.
    const marked = paragraph.join('\n').replace(/ {2,}\n/g, 'zzBRzz')
    out.push('<p>' + inline(marked.replace(/\n/g, ' ')) + '</p>')
  }

  return out.join('\n')
}
