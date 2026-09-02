/**
 * Every caller of the texts endpoint asks for a PAGE — #844.
 *
 * ## Why a population scan and not two component tests
 *
 * `GET /text-coding/texts` was unbounded: 37.8 MB of JSON for one open-text
 * column on a 75,699-record survey, ~239 MB transient, on the screen the Text
 * Coding workspace opens on. It had **two** callers, and the entry's own
 * measurement had found only one of them — `ContentBySource` reaches the same
 * endpoint from the qualitative analysis tab and was fetching the whole column
 * to filter it in the browser.
 *
 * That is the shape this guard exists for: the defect was never "this call
 * site is wrong", it was "the set of call sites is larger than anyone counted"
 * (`feedback_entry_points_are_a_population`). A third caller added later would
 * reintroduce the payload silently — nothing throws, the screen just gets slow
 * and then, on a big enough corpus, stops answering.
 *
 * ⚠️ Scoped to a LITERAL `textCodingApi.list(` call in app source. A caller
 * that aliases the function first would slip through; matching those textually
 * produces phantoms, and a guard that reports phantoms is worse than one that
 * finds nothing (#772). This catches the shape that has actually shipped.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from './strip-comments'

const SRC = join(__dirname, '..')
const CALL = 'textCodingApi.list('

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full))
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/** The argument object of a `textCodingApi.list(...)` call, brace-matched. */
function callArgs(src: string, at: number): string {
  let depth = 0
  for (let i = at; i < src.length; i++) {
    const c = src[i]
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return src.slice(at, i + 1)
    }
  }
  return src.slice(at)
}

function scanCallSites(): { file: string; args: string }[] {
  const found: { file: string; args: string }[] = []
  for (const file of sourceFiles(SRC)) {
    // The API module DECLARES the function; it does not call it.
    if (file.endsWith(join('lib', 'api', 'text-coding.ts'))) continue
    const src = stripComments(readFileSync(file, 'utf8'))
    let idx = src.indexOf(CALL)
    while (idx !== -1) {
      found.push({
        file: file.replace(SRC + '/', ''),
        args: callArgs(src, idx + CALL.length - 1),
      })
      idx = src.indexOf(CALL, idx + 1)
    }
  }
  return found
}

/**
 * Scanned ONCE, at module scope.
 *
 * ⚠️ **This was a per-test call and the first one TIMED OUT at 5,463 ms against
 * vitest's 5,000 ms default** — but only inside the full suite, never when this
 * file ran alone. The walk parses every `.ts`/`.tsx` under `src/` through the
 * TypeScript compiler (`stripComments`), so three tests paid it three times
 * under load.
 *
 * 🔴 **And a timed-out SYNC test is reported by pointing at the `it()` line with
 * the assertion as context, so it reads exactly like an assertion failure** —
 * #867, whose whole lesson was that this shape is a timeout. Hoisting the scan
 * moves the cost to import time, where no test timeout applies, and is what the
 * neighbouring tree-walking guards already do (`variables-view-reachable.test.ts`
 * reads its source at module scope; `accessible-names.test.ts` pays it in the
 * first test behind an explicit 60 s timeout).
 */
const SITES = scanCallSites()
const callSites = () => SITES

describe('the texts endpoint is asked for a page (#844)', () => {
  it('finds the call sites at all', () => {
    // POPULATION self-check. Without it, a rename of `textCodingApi.list`
    // turns every assertion below into a vacuous pass over an empty list —
    // the failure mode #729 names, where a broken guard and a healthy
    // codebase produce identical green.
    const sites = callSites()

    expect(sites.length).toBeGreaterThanOrEqual(2)
    expect(new Set(sites.map(s => s.file)).size).toBeGreaterThanOrEqual(2)
  })

  it('every caller passes an explicit limit', () => {
    const offenders = callSites()
      .filter(s => !/\blimit\s*:/.test(s.args))
      .map(s => s.file)

    expect(offenders,
      'A caller of the texts endpoint omitted `limit`, so it asks for the ' +
      'server default and — more importantly — is not written to page. This ' +
      'endpoint returned 37.8 MB for ONE column on a real survey (#844). Use ' +
      'useInfiniteQuery with `limit: TEXT_PAGE_SIZE` and an `offset` page ' +
      'param, and read `has_more` for whether another page exists.',
    ).toEqual([])
  })

  it('every caller pages by offset rather than fetching once', () => {
    const offenders = callSites()
      .filter(s => !/\boffset\s*:/.test(s.args))
      .map(s => s.file)

    expect(offenders,
      'A caller passes `limit` but no `offset`, so it can only ever show the ' +
      'first page and the rest of the corpus is unreachable — worse than the ' +
      'unbounded read it replaced, because it looks complete.',
    ).toEqual([])
  })

  it('the scan can actually fail', () => {
    // PREDICATE falsifier. Proves the matcher fires on the shape it hunts,
    // so an `expect([]).toEqual([])` above is a real result and not the
    // regex having rotted.
    const unpaged = 'textCodingApi.list(projectId, { column_ids: ids })'
    const paged = 'textCodingApi.list(projectId, { column_ids: ids, limit: 200, offset: 0 })'

    expect(/\blimit\s*:/.test(callArgs(unpaged, CALL.length - 1))).toBe(false)
    expect(/\blimit\s*:/.test(callArgs(paged, CALL.length - 1))).toBe(true)

    // And the brace matcher must stop at the call's own closing paren rather
    // than running to the end of the file, which would let a `limit:` in an
    // unrelated later call mask an unpaged one.
    const twoCalls = paged + '; textCodingApi.list(pid, { column_ids: x })'
    expect(callArgs(twoCalls, CALL.length - 1)).not.toContain('column_ids: x')
  })
})
