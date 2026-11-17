/**
 * #1626 (D243/D244): participants with material and NO coding in scope.
 *
 * The code-by-group comparison and the joint display count a participant who has
 * material in the sources compared but no coding there as "did not use" every code —
 * true only once their material has been coded. While coding is in progress that makes
 * every share too low, and a group coded less far reads as using codes less. The
 * denominator and the test stay #1323's D5; the result SAYS how many there are per group
 * (`group_totals[g].without_coding`, the joint display's `groups[i].without_coding`) and
 * whose coding it is about (`scope.no_coding_scope`, stated by the server — never
 * inferred here from a request this module does not see).
 *
 * ⚠️ Never "not yet coded" alone: under deductive coding "no coding" can be a true
 * negative, so the note states both readings.
 *
 * The server's CSV writes the SAME sentence (`services/comparison_basis.py`), held equal
 * to these strings by `backend/tests/test_without_coding_1626.py`, which reads this file —
 * keep each string on ONE line.
 */

/** `comparison_basis.NO_CODING_SCOPE_*` — whose coding "no coding" is about. */
export type NoCodingScope = 'every' | 'coders' | 'consensus' | 'machine'

export const NO_CODING_PHRASES = {
  every: 'no coding',
  coders: 'no coding by the coders shown',
  consensus: 'no consensus coding',
  machine: 'no coding by the model',
} as const satisfies Record<NoCodingScope, string>

export const NO_CODING_NOTE_TAIL = 'They count as not using any code. If their material has not been coded yet, these shares are too low, and a group coded less far will look as if it uses codes less.'

/** An unknown or absent scope (a payload from an older server) reads as every coder. */
export function noCodingScope(raw: string | null | undefined): NoCodingScope {
  // Own keys only — `in` would also accept an inherited name such as `toString`.
  return raw != null && Object.prototype.hasOwnProperty.call(NO_CODING_PHRASES, raw)
    ? (raw as NoCodingScope)
    : 'every'
}

/**
 * The note below a comparison or a joint display, or `null` when no group has such a
 * participant. `counts` are [group, participants with no coding] in the result's group
 * order; every group is listed, a 0 included, so the reader sees where they are not.
 */
export function noCodingNote(
  counts: ReadonlyArray<readonly [string, number]>,
  scope: NoCodingScope,
): string | null {
  if (!counts.some(([, k]) => k > 0)) return null
  // Grouped digits: on the scale corpus a group held 74,611 such participants.
  const listed = counts.map(([g, k]) => `${g}: ${k.toLocaleString('en-US')}`).join(', ')
  return `Some participants have ${NO_CODING_PHRASES[scope]} here (${listed}). ${NO_CODING_NOTE_TAIL}`
}

/** A group header's addition — `2 with no coding` — or `null` at 0 (absence makes no claim). */
export function withNoCodingLabel(k: number | null | undefined): string | null {
  return k != null && k > 0 ? `${k.toLocaleString('en-US')} with no coding` : null
}
