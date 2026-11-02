/**
 * Colouring the files a guest reads.
 *
 * The guest page carries no bundle and no build step, so the highlighter
 * travels with the page as its own source. That is why it is a plain function
 * without a closure: the page injects `highlightCode.toString()` into the
 * browser, and the tests run it here.
 */

/**
 * The language of one file, by its extension.
 *
 * @param {string} path
 * @returns {string} the family the highlighter knows
 */
export function languageOf(path) {
  const name = String(path ?? '').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot < 0) return 'plain'
  const extension = name.slice(dot + 1).toLowerCase()
  const known = {
    js: 'clike', mjs: 'clike', cjs: 'clike', jsx: 'clike', ts: 'clike', tsx: 'clike', mts: 'clike', cts: 'clike',
    py: 'hash', rb: 'hash', sh: 'hash', bash: 'hash', zsh: 'hash', yml: 'hash', yaml: 'hash', toml: 'hash',
    json: 'json', jsonc: 'json',
    md: 'md', markdown: 'md',
    html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', svelte: 'markup',
    css: 'css', scss: 'css', less: 'css',
    go: 'clike', rs: 'clike', java: 'clike', c: 'clike', h: 'clike', cpp: 'clike', cs: 'clike',
    kt: 'clike', swift: 'clike', php: 'clike', scala: 'clike', dart: 'clike',
  }
  return known[extension] ?? 'plain'
}

/**
 * Colour one block of source.
 *
 * The text is escaped first, and the scan replaces what it finds with spans,
 * so the result is safe to write into the page: a file that carries markup
 * shows it as text.
 *
 * @param {string} code
 * @param {string} language
 * @returns {string} the highlighted HTML
 */
export function highlightCode(code, language) {
  const text = String(code === undefined || code === null ? '' : code)
  const kind = String(language ?? 'plain').toLowerCase()

  const escape = (value) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  const span = (name) => (all) => '<span class="' + name + '">' + all + '</span>'
  const key = span('tok-key')
  const str = span('tok-str')
  const num = span('tok-num')
  const com = span('tok-com')
  const tag = span('tok-tag')

  const clikeWords = 'as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield'
  const hashWords = 'and as assert async await break by class def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield None True False self'

  const number = { pattern: /\b\d+(?:\.\d+)?\b/, wrap: num }
  const families = {
    clike: [
      { pattern: /\/\*[\s\S]*?\*\//, wrap: com },
      { pattern: /\/\/[^\n]*/, wrap: com },
      { pattern: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/, wrap: str },
      { pattern: new RegExp('\\b(?:' + clikeWords.split(' ').join('|') + ')\\b'), wrap: key },
      number,
    ],
    hash: [
      { pattern: /#[^\n]*/, wrap: com },
      { pattern: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/, wrap: str },
      { pattern: new RegExp('\\b(?:' + hashWords.split(' ').join('|') + ')\\b'), wrap: key },
      number,
    ],
    json: [
      { pattern: /"(?:\\.|[^"\\])*"/, wrap: str },
      { pattern: /\b(?:true|false|null)\b/, wrap: key },
      number,
    ],
    markup: [
      { pattern: /<!--[\s\S]*?-->/, wrap: com },
      { pattern: /&lt;\/?[A-Za-z][^&]*?&gt;/, wrap: tag },
      { pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/, wrap: str },
    ],
    css: [
      { pattern: /\/\*[\s\S]*?\*\//, wrap: com },
      { pattern: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/, wrap: str },
      { pattern: /\b(?:important|media|import|keyframes|from|to|and|not|only)\b/, wrap: key },
      number,
    ],
  }

  const family = families[kind]
  if (family !== undefined) {
    // One pass: the alternatives are ordered, so a comment wins over a string
    // inside it, and a string wins over a keyword inside it.
    const pattern = new RegExp(family.map((rule) => '(' + rule.pattern.source + ')').join('|'), 'g')
    return escape(text).replace(pattern, (all, ...groups) => {
      // The first capture group belongs to the first rule, so the group of a
      // rule sits at its own index.
      for (let index = 0; index < family.length; index++) {
        if (groups[index] === undefined) continue
        return family[index].wrap(all)
      }
      return all
    })
  }

  if (kind !== 'md') return escape(text)

  // Markdown is read line by line: a fenced block keeps its own colour until
  // the fence closes.
  const lines = text.split('\n')
  let fence = false
  const out = lines.map((line) => {
    if (/^\s*```/.test(line)) {
      fence = !fence
      return com(escape(line))
    }
    if (fence) return com(escape(line))
    return escape(line).replace(
      /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]*\]\([^)]*\))|(^#{1,6}\s.*$)/gm,
      (all, inline, bold, link, heading) => {
        if (inline !== undefined) return str(inline)
        if (bold !== undefined) return key(bold)
        if (link !== undefined) return span('tok-link')(link)
        if (heading !== undefined) return span('tok-head')(heading)
        return all
      },
    )
  })
  return out.join('\n')
}
