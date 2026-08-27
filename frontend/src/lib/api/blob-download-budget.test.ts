/**
 * #833 — every server download carries an export budget, not the 30 s default.
 *
 * **This is #820's guard with the population corrected.** `export-timeout.test.ts`
 * asserts that every entry of `export.ts` routes through `downloadFromApi`, which
 * is true and was the right assertion for that fix. But the DEFECT's population
 * is not "an entry of `export.ts`" — it is "a call that asks the server for a
 * blob". Six such calls lived in five other modules and every one of them
 * inherited `client.ts`'s `timeout = 30_000`:
 *
 *   · `correlations.ts` — the correlation-matrix and scatter-data CSVs
 *   · `comparisons.ts`  — the group-comparison CSV
 *   · `data-quality.ts` — the summary CSV (the #819 path, which classifies
 *                         every cell of every selected column)
 *   · `canvas.ts`       — `export-docx`, a POST carrying every chart PNG
 *   · `excerpts.ts`     — DELETED rather than fixed: it had zero call sites
 *
 * ⚠️ **The budget is APPLIED here, not re-derived.** `EXPORT_TIMEOUT_MS` was
 * measured for #820 (212.7 s for datasets Excel on a real 75,699 x 41 survey)
 * and is already the project's decided export budget. Which of these six
 * actually exceeds 30 s was NOT measured — that question governs choosing a NEW
 * number, and no new number is being chosen.
 *
 * ⚠️ Not every blob call can route through `downloadFromApi`: three return a
 * `namedBlob` for a caller that does its own `downloadBlob`, and `export-docx`
 * is a POST while the helper is GET-only. So the assertion is *the budget is
 * stated*, satisfied either way.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { stripComments } from '../strip-comments'
import { join } from 'node:path'

const API_DIR = __dirname

const SOURCES = readdirSync(API_DIR)
  .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  // `download.ts` DEFINES the budget and is where the one legitimate
  // `responseType: 'blob'` without a literal timeout lives (it passes
  // `config?.timeout ?? EXPORT_TIMEOUT_MS`).
  .filter(f => f !== 'download.ts')

/**
 * The options object literal enclosing `offset`, found by bracket matching.
 *
 * A fixed ±N-line window would let one entry's `timeout` satisfy its neighbour —
 * and `correlations.ts` has two blob entries within a few lines of each other,
 * so that weakness is reachable, not theoretical.
 */
function enclosingObject(src: string, offset: number): string | null {
  let depth = 0
  let open = -1
  for (let i = offset; i >= 0; i--) {
    const ch = src[i]
    if (ch === '}') depth++
    else if (ch === '{') {
      if (depth === 0) { open = i; break }
      depth--
    }
  }
  if (open === -1) return null
  let d = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++
    else if (src[i] === '}') {
      d--
      if (d === 0) return src.slice(open, i + 1)
    }
  }
  return null
}

interface BlobSite { file: string; object: string }

function blobSites(): BlobSite[] {
  const found: BlobSite[] = []
  for (const file of SOURCES) {
    const src = stripComments(readFileSync(join(API_DIR, file), 'utf8'))
    const re = /responseType:\s*['"]blob['"]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      found.push({ file, object: enclosingObject(src, m.index) ?? '' })
    }
  }
  return found
}

describe('#833 — a server download states its budget', () => {
  it('reads a real set of api modules and finds real blob call sites', () => {
    // Self-check 1: the directory walk. Without this every assertion below
    // passes by finding nothing.
    expect(SOURCES.length).toBeGreaterThanOrEqual(10)
    expect(SOURCES).toContain('correlations.ts')
    expect(SOURCES).toContain('canvas.ts')

    // Self-check 2: the `responseType` regex still matches the house style.
    const sites = blobSites()
    expect(sites.length).toBeGreaterThanOrEqual(7)
    expect(new Set(sites.map(s => s.file))).toContain('correlations.ts')
  })

  it('resolves an enclosing options object for every site', () => {
    // Self-check 3: the bracket matcher. An unresolved site would be reported
    // as an offender below, but a SILENTLY empty object would not — it contains
    // no `timeout`, so it would look like a real finding rather than a broken
    // scan. Assert the narrowing itself.
    const unresolved = blobSites().filter(s => s.object === '').map(s => s.file)
    expect(unresolved, 'the bracket matcher failed to find an options object').toEqual([])
  })

  it('gives every blob download an explicit budget', () => {
    const offenders = blobSites()
      .filter(s => !/timeout:/.test(s.object))
      .map(s => s.file)
    expect(
      offenders,
      'A blob request with no `timeout` inherits client.ts\'s 30s default and ' +
        'discards successful server work as a failure that did not happen (#820/#833). ' +
        'Route through `downloadFromApi`, or state `timeout: EXPORT_TIMEOUT_MS`.',
    ).toEqual([])
  })

  it('the dead excerpt export stayed deleted', () => {
    // It had zero call sites and three defects. Re-adding it with a timeout
    // would fix code nobody reaches and hide that nobody reaches it.
    const src = readFileSync(join(API_DIR, 'excerpts.ts'), 'utf8')
    expect(stripComments(src)).not.toMatch(/exportCsv/)
    // Self-check: prove the file was actually read.
    expect(src).toMatch(/excerptsApi/)
  })
})
