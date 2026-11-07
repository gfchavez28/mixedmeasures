/**
 * #1527 (D83, D84, D86, 1.5.9) — the analysis page hands the co-occurrence figure, and its
 * CSV, the request that reads the selection exactly, and draws the matrix's own N.
 *
 * A SOURCE scan, stated as such: no unit test mounts `QualitativeAnalysisView` on its
 * Relationships tab, and the defect this pins was a wiring one — the page passed its
 * `filterParams` (absent = every source, which `/frequencies` needs for `hasCoding`, #749)
 * straight to the figure, so one selected interview counted every document and clip, and
 * summed `total_coded_segments + total_coded_texts` into an N that left them out.
 * `RelationshipsContent.cooccurrenceParams` is REQUIRED, so a mount cannot omit it; this
 * scan is what stops one passing `filterParams` into it. ⚠️ A scan cannot see what a
 * branch renders — the live drive is the other half (the review record's §9).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'

const SRC = stripComments(readFileSync(join(__dirname, 'QualitativeAnalysisView.tsx'), 'utf8'))
const PANEL = stripComments(readFileSync(
  join(__dirname, '..', 'components', 'qualitative-analysis', 'RelationshipsPanel.tsx'), 'utf8',
))

describe('the Relationships tab’s co-occurrence wiring', () => {
  it('builds the figure’s request with the one exact-selection builder', () => {
    expect(SRC).toMatch(/const cooccurrenceParams[^=]*=\s*useMemo\(\(\)\s*=>\s*cooccurrenceFilterParams\(filterParams,/)
  })

  it('hands that request — not filterParams — to the figure', () => {
    expect(SRC).toMatch(/cooccurrenceParams=\{cooccurrenceParams\}/)
    // …and the panel mounts the figure with it (the panel also holds `filterParams`).
    const mount = PANEL.match(/<QualCooccurrence\b[^>]*>/s)?.[0] ?? ''
    expect(mount).toMatch(/filterParams=\{cooccurrenceParams\}/)
  })

  it('the Exports list’s co-occurrence CSV sends that request and the level', () => {
    expect(SRC).toMatch(/exportApi\.codeCooccurrence\(pid,\s*\{\s*\.\.\.cooccurrenceParams,\s*level:\s*qa\.cooccurrenceLevel\s*\},\s*participantFilterLabel\)/)  // #1545: + the label
    // Positive control for the absence below: the call is found at all.
    expect(SRC.match(/exportApi\.codeCooccurrence\(/g)?.length).toBe(1)
    expect(SRC).not.toMatch(/exportApi\.codeCooccurrence\(pid,\s*filterParams\)/)
  })

  it('draws the N the matrix was counted over', () => {
    expect(SRC).toMatch(/setCooccurrenceN\(data\.n_units\)/)
    expect(SRC).not.toMatch(/total_coded_segments\s*\+|totalSegments\s*\+/)
  })
})
