import type { QuotedExcerptsParams } from '@/lib/api'

/**
 * #1531 D99 (1.5.9) — the Quote Board's read, keyed on the WHOLE params object.
 *
 * Both readers (the analysis page's lifted query and `QuoteBoardView`'s fallback) spread the
 * params' truthy VALUES into the key positionally, so once the blind coder scope joined the
 * params a participant filter "2" and a scope "2" (user 2) built ONE key and could serve each
 * other's answer — #454's cache rule needs the scope to be a NAMED part of the key. One function,
 * so the two readers cannot drift apart and stop sharing a request. Prefix invalidation on
 * `['excerpts-quoted', projectId]` is unchanged.
 *
 * Not in `lib/api`: a runtime export from the wire barrel forces every `vi.mock('@/lib/api')`
 * in the suite to stub it (the `isMachineCoder` precedent, `multicoder.md`).
 */
export function quotedExcerptsQueryKey(projectId: number, params: QuotedExcerptsParams) {
  return ['excerpts-quoted', projectId, params] as const
}
