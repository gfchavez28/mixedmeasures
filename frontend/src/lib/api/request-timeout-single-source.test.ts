/**
 * #957 — "did the client stop waiting?" is asked in ONE place:
 * `lib/api/error-utils.ts::isRequestTimeout`.
 *
 * Before #957 there were FIVE hand-rolled copies — `download.ts`,
 * `media-constants.ts`, `dataset-import-formats.ts`, `project-export-error.ts`
 * and `DatasetView.tsx` — and they had already drifted: the download helper
 * required `instanceof DOMException` while the other four duck-typed the name.
 * The sixth would have been `IrrMatrix`, which needed exactly this question to
 * stop calling a timeout "unavailable for this project".
 *
 * The scan looks for the NAME the predicate keys on, `TimeoutError`, as it
 * would appear in any re-implementation — a string literal. Comments are
 * stripped first, so prose that names it (this file's siblings do) is not a
 * finding.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { stripComments } from '../strip-comments'
import { sourceFiles, srcRel, SOURCE_SCAN_TIMEOUT_MS } from '@/test-support/source-tree'

const HOME = 'lib/api/error-utils.ts'

/** A `TimeoutError` string literal, in any quote style. */
const HAND_ROLLED = /(['"`])TimeoutError\1/

const FILES = sourceFiles({ ext: 'both', floor: 300, sentinels: [HOME, 'pages/DatasetView.tsx'] })

function offenders(): string[] {
  return FILES
    .filter(f => srcRel(f) !== HOME)
    .filter(f => HAND_ROLLED.test(stripComments(readFileSync(f, 'utf8'), f)))
    .map(srcRel)
}

describe('#957 — one timeout predicate', () => {
  it('the predicate matches a hand-rolled copy and ignores prose', () => {
    // Falsifier: the scan's own predicate must fire on the shape it forbids —
    // the exact line five files carried — or "no offenders" proves nothing.
    const copy = "const name = (err as { name?: string }).name\nif (name === 'TimeoutError' || name === 'AbortError') {}"
    expect(HAND_ROLLED.test(stripComments(copy))).toBe(true)
    expect(HAND_ROLLED.test(stripComments('// a TimeoutError is not an ApiError\nconst x = 1'))).toBe(false)
  })

  it('can still see the one legitimate site', () => {
    // Population self-check: the home file is walked AND still matches after
    // stripping. If either fails, the offender list below is blind.
    const home = FILES.find(f => srcRel(f) === HOME)
    expect(home, `${HOME} was not walked`).toBeDefined()
    expect(HAND_ROLLED.test(stripComments(readFileSync(home!, 'utf8'), home!))).toBe(true)
  })

  it('no other source file asks the question itself', { timeout: SOURCE_SCAN_TIMEOUT_MS }, () => {
    expect(
      offenders(),
      'Import `isRequestTimeout` from `@/lib/api` instead of re-deriving it. A timeout is ' +
        'not an ApiError and carries no status, and every copy of this check has been a ' +
        'chance for the copies to disagree about what counts (#957).',
    ).toEqual([])
  })
})
