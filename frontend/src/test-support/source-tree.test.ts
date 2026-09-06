import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { stripComments } from '@/lib/strip-comments'
import { SOURCE_SCAN_TIMEOUT_MS, SRC_DIR, sourceFiles, srcRel } from './source-tree'

/**
 * The guard that makes `sourceFiles()` unavoidable — and the self-checks that
 * prove the walker's own floor can fire.
 *
 * 🔴 Why a POPULATION guard and not documentation. #729's finding was that a
 * technique learned writing guard N reaches guard N+1 only through the author's
 * memory: the population floor (#730) existed on 3 of ~19 scanners when it was
 * dossiered, on 10 after a deliberate pass, and on 17 of 19 when this shipped —
 * with two of the newest still lacking one. The stripper went the same way until
 * `strip-comments.test.ts` started failing the suite on a second implementation
 * (#838), after which the count stayed at one. This test applies the same
 * mechanism to the walk: a hand-rolled `readdirSync` outside `test-support/` is
 * a scan that chose to carry neither the floor nor the tree-identity check, and
 * the suite says so.
 *
 * ⚠️ This is NOT the "meta-guard over the guard set" #730 refused. That refusal
 * was of a guard asserting every guard HAS a population check — a property no
 * scan can read. This asserts a single source for one operation, which a scan
 * can read exactly, and which is the substrate-debt remedy the Phase 4
 * synthesis names.
 */

describe('every source scan walks the tree through sourceFiles()', () => {
  // A NAME, not a use: a stripped source that still contains the identifier is
  // calling or importing it. Prose in comments is stripped first (#772).
  const HAND_ROLLED_WALK = /\breaddirSync\b/

  it('no file outside test-support walks src/ itself', { timeout: SOURCE_SCAN_TIMEOUT_MS }, () => {
    const files = sourceFiles({ ext: 'both', floor: 400, includeTests: true })
    const offenders: string[] = []
    for (const abs of files) {
      const rel = srcRel(abs)
      if (rel.startsWith('test-support/')) continue
      if (HAND_ROLLED_WALK.test(stripComments(readFileSync(abs, 'utf8'), abs))) offenders.push(rel)
    }
    expect(
      offenders,
      'Walk through `sourceFiles()` from `@/test-support/source-tree`. It carries the population '
        + 'floor (#730), proves the tree is src/, excludes test-support by construction and states '
        + 'its own failure frame; a hand-rolled readdirSync carries none of those, which is how two '
        + 'of nineteen scanners shipped with no floor at all (#729).',
    ).toEqual([])
  })

  it('the detector fires on a real walk and not on prose about one', () => {
    // PREDICATE falsifier: the regex the scan uses, exercised directly.
    expect(HAND_ROLLED_WALK.test("for (const entry of readdirSync(dir)) {")).toBe(true)
    expect(HAND_ROLLED_WALK.test("import { readdirSync } from 'node:fs'")).toBe(true)
    // A comment naming it must NOT count — the scan strips first.
    const prose = '// callers used to readdirSync the tree themselves\nconst x = 1\n'
    expect(HAND_ROLLED_WALK.test(stripComments(prose))).toBe(false)
  })
})

describe('sourceFiles() — the self-checks a walker owes its consumers', () => {
  it('the floor fires on a valid-but-narrower root', () => {
    // `src/lib/api` is real and holds a few dozen files; a floor sized for all
    // of src/ must refuse it. This is the failure `readdirSync` never reports.
    expect(() => sourceFiles({ root: 'lib/api', ext: 'both', floor: 400 })).toThrow(/below the floor/)
  })

  it('the floor fires on a filter that admits nothing', () => {
    // `lib/api` holds no JSX; asking for `.tsx` there is a filter mistake the
    // count exposes.
    expect(() => sourceFiles({ root: 'lib/api', ext: 'tsx', floor: 1 })).toThrow(/below the floor/)
  })

  it('a sentinel the walk cannot see fails even when the count is fine', () => {
    expect(() => sourceFiles({ ext: 'both', floor: 1, sentinels: ['lib/does-not-exist.ts'] }))
      .toThrow(/cannot see lib\/does-not-exist\.ts/)
  })

  it('the failure frame states what was walked, the count and the remedy', () => {
    let message = ''
    try {
      sourceFiles({ root: 'lib/api', ext: 'ts', floor: 10_000 })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toMatch(/walked \d+ file\(s\) under src\/lib\/api/)
    expect(message).toMatch(/ext=ts/)
    expect(message).toMatch(/floor of 10000/)
    expect(message).toMatch(/do NOT lower the floor/)
  })

  it('excludes test files and test-support by default, and admits both on request', () => {
    const app = sourceFiles({ ext: 'both', floor: 400 }).map(srcRel)
    expect(app.some(r => /\.test\.tsx?$/.test(r))).toBe(false)
    expect(app.some(r => r.startsWith('test-support/'))).toBe(false)

    const all = sourceFiles({ ext: 'both', floor: 400, includeTests: true }).map(srcRel)
    expect(all).toContain('test-support/source-tree.ts')
    expect(all).toContain('test-support/source-tree.test.ts')
    expect(all.length).toBeGreaterThan(app.length)
  })

  it('honours the extension filter exactly — never widening .tsx to .tsx?', () => {
    // The 2026-08-09 refusal: `accessible-names` scans `.tsx` only because JSX
    // parses only there. A helper that quietly admitted `.ts` would change what
    // that guard means.
    const tsxOnly = sourceFiles({ ext: 'tsx', floor: 150 })
    expect(tsxOnly.every(f => f.endsWith('.tsx'))).toBe(true)
    const tsOnly = sourceFiles({ ext: 'ts', floor: 100 })
    expect(tsOnly.every(f => f.endsWith('.ts') && !f.endsWith('.tsx'))).toBe(true)
  })

  it('a non-recursive walk lists one directory only', () => {
    const pages = sourceFiles({ root: 'pages', ext: 'tsx', floor: 10, recursive: false }).map(srcRel)
    expect(pages.every(r => r.split('/').length === 2)).toBe(true)
  })

  it('returns absolute paths, sorted, under SRC_DIR', () => {
    const files = sourceFiles({ ext: 'both', floor: 400 })
    expect(files.every(f => f.startsWith(SRC_DIR))).toBe(true)
    expect([...files].sort()).toEqual(files)
  })
})
