/**
 * #820 — no project-scale export inherits the API client's 30-second default.
 *
 * **Measured, and the reason this is a guard rather than a one-line fix.** On a
 * real 75,699 x 41 survey `GET /export/r-data` answered **HTTP 200 after
 * 85.6 s** and `GET /export/datasets-excel` after **212.7 s**. `exportApi.rData`
 * was the one export that called `api.get` directly, so it inherited
 * `client.ts`'s 30 s default and aborted work that had succeeded — reported to
 * the researcher as `alert("R Data Export failed.")`, a native dialog with no
 * reason, no size hint and no next step. Every other export already went
 * through `downloadFromApi`, which is exactly why nobody noticed: the defect
 * was one call site's shape, not a missing feature.
 *
 * The durable property is therefore structural — *every export goes through the
 * one helper that owns the budget* — asserted as a POPULATION over
 * `export.ts`'s own entries rather than as a list of the calls that were wrong.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { stripComments } from '../strip-comments'
import { join } from 'node:path'
import { EXPORT_TIMEOUT_MS } from './download'

const src = readFileSync(join(__dirname, 'export.ts'), 'utf8')

/** Every `name: …` entry of the `exportApi` object, with its body. */
function entries(): { name: string; body: string }[] {
  const body = src.slice(src.indexOf('export const exportApi = {'))
  const found: { name: string; body: string }[] = []
  const re = /^ {2}(\w+): /gm
  const starts: { name: string; at: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) starts.push({ name: m[1], at: m.index })
  starts.forEach((s, i) => {
    found.push({ name: s.name, body: body.slice(s.at, starts[i + 1]?.at ?? body.length) })
  })
  return found
}

describe('#820 — an export is never bounded by the 30s default', () => {
  it('reads a real set of export functions', () => {
    // Self-check: the slice and the entry regex both depend on source shape a
    // refactor can move, and an empty set would make the assertions below pass
    // by finding nothing.
    const names = entries().map(e => e.name)
    expect(names.length).toBeGreaterThanOrEqual(8)
    expect(names).toContain('rData')
    expect(names).toContain('datasetsExcel')
  })

  it('routes every download through the helper that owns the budget', () => {
    // `codebook` is the deliberate exception: it is a small JSON response
    // rendered by the caller, not a file download, and it does not go through
    // the blob path at all.
    const offenders = entries()
      .filter(e => e.name !== 'codebook')
      .filter(e => !e.body.includes('downloadFromApi'))
      .map(e => e.name)
    expect(
      offenders,
      'A hand-rolled api.get inherits the 30s client default and a hand-rolled ' +
        'anchor invents a filename the server already sent (#743/#820).',
    ).toEqual([])
  })

  it('gives the whole-project exports a budget past the measured worst case', () => {
    // 212.7 s measured for datasets Excel; the cell cap allows a bigger single
    // dataset than that, and a project may hold several.
    expect(EXPORT_TIMEOUT_MS).toBeGreaterThan(4 * 213_000)
  })

  it('nobody re-opens the alert path', () => {
    // The second half of #820: the failure must reach the app's toast system,
    // not a native `window.alert` with no reason and no next step.
    //
    // ⚠️ Comments are stripped FIRST. This assertion's first run failed on the
    // sentence in `ExportDialog.tsx` explaining that the `alert()` is gone —
    // #772's phantom, in the guard written to prevent its own defect.
    const dialog = stripComments(
      readFileSync(join(__dirname, '..', '..', 'components', 'ExportDialog.tsx'), 'utf8'),
    )
    expect(dialog).not.toMatch(/\balert\(/)
    // The self-check: prove the scan is reading real source, not an empty string.
    expect(dialog).toMatch(/exportApi\.rData/)
  })
})
