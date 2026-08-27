import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { stripComments } from './strip-comments'
import { join } from 'node:path'
import { dataViewPath, variableViewPath } from './dataset-routes'

describe('dataset route helpers', () => {
  it('builds the Data view path', () => {
    expect(dataViewPath(1, 2)).toBe('/projects/1/datasets/2')
  })

  it('carries a focused record and column — the search deep link (#834)', () => {
    expect(dataViewPath(1, 2, { rowId: 88, columnId: 31 }))
      .toBe('/projects/1/datasets/2?row=88&column=31')
  })

  it('omits the query entirely when nothing is focused', () => {
    expect(dataViewPath(1, 2, {})).toBe('/projects/1/datasets/2')
    expect(dataViewPath(1, 2, { rowId: null, columnId: null })).toBe('/projects/1/datasets/2')
  })

  it('carries a record with no column — a hit whose column has since gone', () => {
    expect(dataViewPath(1, 2, { rowId: 88 })).toBe('/projects/1/datasets/2?row=88')
  })

  it('treats id 0 as an id, not as absent', () => {
    // Same falsy-zero shape the Variables view helper guards against below.
    expect(dataViewPath(1, 2, { rowId: 0, columnId: 0 }))
      .toBe('/projects/1/datasets/2?row=0&column=0')
  })

  it('builds the Variables view path', () => {
    expect(variableViewPath(1, 2)).toBe('/projects/1/datasets/2/variables')
  })

  it('carries the focused column, which is what every deep link into it wants', () => {
    expect(variableViewPath(1, 2, 31)).toBe('/projects/1/datasets/2/variables?column=31')
  })

  it('omits the query when no column is given — `null` and `undefined` alike', () => {
    // `columnId == null` on purpose: a bare falsy check would send column 0 —
    // a legal id nowhere, but the same falsy-zero shape that has bitten this
    // codebase repeatedly — down the no-column branch.
    expect(variableViewPath(1, 2, null)).toBe('/projects/1/datasets/2/variables')
    expect(variableViewPath(1, 2, undefined)).toBe('/projects/1/datasets/2/variables')
  })

  it('treats column 0 as a column, not as absent', () => {
    expect(variableViewPath(1, 2, 0)).toBe('/projects/1/datasets/2/variables?column=0')
  })

  it('accepts string ids — router params arrive as strings', () => {
    expect(variableViewPath('1', '2', '31')).toBe('/projects/1/datasets/2/variables?column=31')
  })
})

// ---------------------------------------------------------------------------
// Fail-closed population scan
// ---------------------------------------------------------------------------

const SRC = join(__dirname, '..')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

describe('nobody hand-rolls the Variables view path', () => {
  /**
   * The Variables view was reachable as `…/recode?column=N` from FIVE call
   * sites, each with its own template literal, so renaming the route meant
   * editing five strings correctly. Four of them are in files nobody working on
   * the dataset grid would think to open.
   *
   * ⚠️ The assertion is a POPULATION one (#730): `expect(offenders).toEqual([])`
   * passes just as happily when the walk finds nothing at all, so the count of
   * files actually scanned is asserted too.
   */
  const files = sourceFiles(SRC)

  it('scanned a real population of source files', () => {
    expect(files.length).toBeGreaterThan(200)
  })

  // ⚠️ Explicit timeout (#841): the scan strips every file it walks, and since
  // #838 that is a TypeScript parse per file — ~1.8 s cold, 3.9 s under
  // full-suite contention, past vitest's 5 s default. Same budget and same
  // reason as `strip-comments.test.ts`, which pays the identical cost.
  it('has no hand-rolled dataset sub-view path outside the helper module', { timeout: 60_000 }, () => {
    // A path literal ending in `/variables` or `/recode` built by interpolation.
    const HAND_ROLLED = /\$\{[^}]*\}\/(variables|recode)\b/
    const offenders = files
      .filter(f => !f.endsWith('lib/dataset-routes.ts'))
      .filter(f => HAND_ROLLED.test(stripComments(readFileSync(f, 'utf8'), f)))
      .map(f => f.slice(SRC.length + 1))
    expect(offenders).toEqual([])
  })
})
