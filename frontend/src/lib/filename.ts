/**
 * The client-side download-filename policy — one rule, written down (#734).
 *
 * There were two of these, disagreeing, and neither was documented:
 *
 * - `canvas-export.ts` stripped only Windows-illegal punctuation and KEPT
 *   non-ASCII. Correct.
 * - `chart-export.tsx` applied an ASCII-only allow-list, `[^a-zA-Z0-9_-]` → ''.
 *   That is the SERVER's constraint — `Content-Disposition` header values are
 *   encoded latin-1, which is why `sanitize_csv_filename` exists (#408/L4) —
 *   copied onto a client that never had it. `a.download` is a DOM string and a
 *   zip entry name is UTF-8; neither is an HTTP header.
 *
 * Measured against the old chart rule, all names a researcher would plausibly
 * type:
 *
 *   "教育プログラム評価"    → ""                  (empty ⇒ `.png`, a nameless dotfile)
 *   "Αξιολόγηση"           → ""                  (empty)
 *   "Оценка программы"     → "_"                 (the space survived; nothing else)
 *   "Évaluation Française" → "valuation_Franaise" (silently mangled)
 *
 * The accented-Latin case is the important one: not exotic, and it fails
 * quietly — the file downloads, just under a corrupted name.
 *
 * Keep this as the ONLY client filename rule. The server has its own, for a
 * real reason that does not apply here; do not copy it back.
 */

export interface SafeFilenameOptions {
  /** Returned when sanitizing leaves nothing. Never let a name be empty. */
  fallback?: string
  /**
   * `'underscore'` (default) suits the chart/ZIP exports, whose names are
   * already snake-ish; `'keep'` suits prose-y canvas titles, where spaces read
   * better and are perfectly legal in a filename.
   */
  spaces?: 'underscore' | 'keep'
  /** Truncation limit, in code units. */
  maxLength?: number
}

/** Characters a filesystem actually refuses (union of Windows and POSIX). */
const ILLEGAL = /[/\\?%*:|"<>]/g
/**
 * Drop C0 control characters and DEL.
 *
 * A code-point filter rather than a character class, because a regex containing
 * control characters trips `no-control-regex` — and that rule reads correctly in
 * general: a control character inside a pattern is nearly always a typo. Here it
 * is the entire point, so this states the intent in a form that needs no
 * suppression to quiet, and leaves no disable directive behind to rot.
 */
function stripControlChars(value: string): string {
  return Array.from(value)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0
      return code > 0x1f && code !== 0x7f
    })
    .join('')
}

export function safeFilename(name: string, options: SafeFilenameOptions = {}): string {
  const { fallback = 'export', spaces = 'underscore', maxLength = 80 } = options

  const collapsed = spaces === 'underscore'
    ? name.replace(/\s+/g, '_')
    : name.replace(/\s+/g, ' ')

  const cleaned = stripControlChars(collapsed)
    .replace(ILLEGAL, '_')
    .slice(0, maxLength)
    // A leading dot makes a hidden file on POSIX; Windows rejects a trailing
    // dot or space. Both are applied AFTER truncation, since truncation can
    // create either one.
    .replace(/^\.+/, '')
    .replace(/[.\s]+$/, '')
    .trim()

  return cleaned || fallback
}
