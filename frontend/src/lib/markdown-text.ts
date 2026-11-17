/**
 * #1422 — the ONE place text enters the Canvas Markdown export (and the joint display's
 * Markdown rendering, D174). The rule: every PLAIN-TEXT string — a researcher's words, a
 * participant's quote, a name, a label, a table cell, a note the exporter composed — is escaped
 * ONCE, here, as it enters the Markdown; the exporter's own MARKUP (`**`, `> `, `- `, `|`,
 * `[…](…)`) is added AFTER and is never escaped.
 *
 * Escaped only where CommonMark / GFM would READ the character — measured by rendering with
 * markdown-it (CommonMark + GFM tables and strikethrough), so a raw `.md` stays readable:
 * - always: `\` `` ` `` `*` `~` `|`;
 * - `[` `]` always in a text node; in a WHOLE string (`mdLine`, `mdBlock`) only a `]` before
 *   `(`, `[` or `:` (a link, a reference, a definition) — a CI's `[17.0, 82.3]` stays as printed;
 * - `_` unless it sits between two letters or digits (`apollo11_interview` is never emphasis);
 * - `<` only before a letter, `/`, `!` or `?` (a tag or an autolink; `p < .001` stays);
 * - `&` only before an entity name (`&copy;` would print ©; `AT&T` stays);
 * - at the start of a LINE (`mdLines`): `#`, `-`, `+`, `*`, `>`, `=`, `1.`/`1)` and leading
 *   spaces (four of them make a code block); and a heading's closing `#` (`mdHeading`).
 *
 * ⚠️ A string that is MEANT as markup must not pass through `mdText`: it will print literally.
 */

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u
const ENTITY_AHEAD = /^&#?[A-Za-z0-9]+;/

/**
 * `whole`: the string is everything between two pieces of the exporter's markup (a cell, a name,
 * a quote), so a `[…]` can only become a link where `](`, `][` or `]:` sits INSIDE it — only that
 * `]` is escaped and `[17.0, 82.3]` or `[laughs]` stay as typed. A text NODE is not whole (the
 * next node may begin `(`), so it escapes every bracket.
 */
function escapeMd(str: string, whole: boolean): string {
  return str.replace(/[\\`*[\]~|_<&]/g, (c, i: number) => {
    if (c === '_') return LETTER_OR_DIGIT.test(str[i - 1] ?? '') && LETTER_OR_DIGIT.test(str[i + 1] ?? '') ? c : '\\_'
    if (c === '<') return /[A-Za-z/!?]/.test(str[i + 1] ?? '') ? '\\<' : c
    if (c === '&') return ENTITY_AHEAD.test(str.slice(i)) ? '\\&' : c
    if (whole && c === '[') return c
    if (whole && c === ']') return /[([:]/.test(str[i + 1] ?? '') ? '\\]' : c
    return `\\${c}`
  })
}

/** A piece of running text (a text node, a mention): escaped. Newlines pass through: the block decides. */
export function mdText(s: unknown): string {
  return escapeMd(String(s ?? ''), false)
}

/** One-line text — a table cell, a name, a label: escaped, every line break a single space. */
export function mdLine(s: unknown): string {
  return escapeMd(String(s ?? '').replace(/[ \t]*(?:\r\n?|\n)+[ \t]*/g, ' '), true)
}

/** A line-start character CommonMark would read as a block (heading, list, quote, rule, setext). */
function guardLineStart(line: string): string {
  const l = line.replace(/^[ \t]+/, '')
  // `[ ]` / `[x]` + space is a GFM task box at a list item's start (a link's `[ ](` is not).
  if (/^(?:#{1,6}|[-+*]|\[[ xX]\])(?=[ \t]|$)/.test(l) || /^(?:=+|-+)[ \t]*$/.test(l) || l.startsWith('>')) return `\\${l}`
  return l.replace(/^(\d{1,9})([.)])(?=[ \t]|$)/, '$1\\$2')
}

/**
 * #1457 — already-rendered INLINE Markdown (escaped text plus the exporter's marks) whose `\n`s
 * are line breaks (Shift+Enter, or a newline in the text) → one block: every line's start
 * guarded, each break a CommonMark hard break (`\` + newline — two trailing spaces are invisible,
 * an editor strips them, and a whitespace-only line ENDS the paragraph). Empty lines at either end
 * are dropped: a hard break that ends a block prints a literal `\`.
 */
export function mdLines(inline: string): string {
  const lines = inline.split(/\r\n?|\n/).map(guardLineStart)
  let a = 0
  let b = lines.length
  while (a < b && lines[a] === '') a++
  while (b > a && lines[b - 1] === '') b--
  return lines.slice(a, b).join('\\\n')
}

/** Multi-line plain text (a quote, a memo preview, a note) → paragraphs at its blank lines. */
export function mdBlock(s: unknown): string {
  return String(s ?? '')
    .split(/(?:\r\n?|\n)[ \t]*(?:\r\n?|\n)/)
    .map(p => mdLines(escapeMd(p, true)))
    .filter(p => p !== '')
    .join('\n\n')
}

/**
 * Emphasis around inline Markdown, with its edge whitespace moved OUTSIDE the delimiters:
 * `**bold **next` prints its asterisks (a closing `**` after a space closes nothing). Empty or
 * whitespace-only text gets no delimiters (`****` alone on a line is a rule).
 */
export function mdWrap(delim: string, inline: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inline)!
  return m[2] ? `${m[1]}${delim}${m[2]}${delim}${m[3]}` : inline
}

/** Inline Markdown as an ATX heading's text: one line, and a trailing ` #` is not its closing. */
export function mdHeading(inline: string): string {
  return inline.replace(/\s*(?:\r\n?|\n)+\s*/g, ' ').replace(/(^|[ \t])(#+)([ \t]*)$/, '$1\\$2$3')
}

/**
 * #1422 (2026-10-29 addendum) — a link DESTINATION in pointy brackets, so a `)` or a space in the
 * href cannot end it: `https://x.example/) [evil](javascript:alert(1)` stays ONE https link, the
 * href the HTML export writes. Tab/LF/CR are dropped (a browser's URL parser drops them too).
 * The caller has already passed it through `exportableHref` (#1339).
 */
export function mdDestination(href: string): string {
  return `<${href.replace(/[\t\n\r]/g, '').replace(/[\\<>]/g, '\\$&')}>`
}
