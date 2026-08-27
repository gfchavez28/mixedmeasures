/**
 * #703 — the word count states its own unit.
 *
 * `Segment.word_count` is `len(text.split())`: whitespace-delimited tokens.
 * Chinese, Japanese and Thai do not put spaces between words, so **every
 * segment in those scripts counts as one word regardless of length** (measured:
 * 37 Chinese characters → 1, 79 Thai characters → 1). That number feeds coding
 * density, per-source volume and the saturation denominator, so for a CJK
 * project those metrics are not wrong by a scale factor — they are counting
 * SEGMENTS.
 *
 * ## Why the unit is stated UNCONDITIONALLY rather than warned about on detection
 *
 * The #703 decision offered either. Stating it always is both cheaper and more
 * honest: a researcher working in a non-spaced script reads the qualifier at the
 * point they read the number, and a researcher working in English sees something
 * accurate that costs nothing. A detection-gated warning would need per-segment
 * script inspection — the same machinery the decision REFUSED for the count
 * itself, because a mixed-script corpus would end up with a denominator whose
 * unit changes per segment, making density silently incomparable within one
 * project.
 *
 * ⚠️ Single-sourced so the wording cannot drift across the four surfaces that
 * show a word figure. If a fifth appears, import from here.
 */

/** The unit, for use inline where a bare "words" would otherwise appear. */
export const WORD_COUNT_UNIT = 'words (whitespace-delimited)'

/** The full caveat, for tooltips and panel notes. */
export const WORD_COUNT_NOTE =
  'Words are whitespace-delimited. Scripts written without spaces between words '
  + '(e.g. Chinese, Japanese, Thai) will therefore count as one word per segment.'
