/**
 * #1528 (D87, D88, 1.5.9) — the analysis page's frequency files are wired to the screen's
 * selection.
 *
 * A SOURCE scan, stated as such: no unit test mounts `QualitativeAnalysisView` and presses its
 * export doors, and both defects were wiring — the Frequencies doors called a server file built
 * on another payload with the page's `filterParams` (absent = every source, #749's reading for
 * `/frequencies`), and the Source Data door omitted an unselected kind and sent
 * `exclude_facilitator` only when true. ⚠️ A scan cannot see what a branch renders — the live
 * drive is the other half (the review record's §10).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'
import { sourceFiles, SOURCE_SCAN_TIMEOUT_MS } from '@/test-support/source-tree'

const SRC = stripComments(readFileSync(join(__dirname, 'QualitativeAnalysisView.tsx'), 'utf8'))

describe('the Frequencies CSV doors (D87)', () => {
  it('both doors — the header Export CSV and Exports › Frequencies CSV — call the one handler', () => {
    expect(SRC.match(/onClick=\{handleFrequenciesExport\}/g)?.length).toBe(2)
    expect(SRC).not.toMatch(/exportApi\.codeFrequencies/)
  })

  it('the handler builds the summary table’s request from the selection and the EFFECTIVE coder scope', () => {
    const body = SRC.match(/const handleFrequenciesExport = useCallback\(\(\) => \{([\s\S]*?)\n {2}\}, \[/)?.[1] ?? ''
    expect(body).toMatch(/codeFrequenciesFileRequest\(qa\.selectedCodeIds, \{[\s\S]*?\}, qa\.source, \{/)
    expect(body).toMatch(/coder_ids: effectiveCoderInclude\.length \? effectiveCoderInclude : null/)
    expect(body).toMatch(/aggregation: categoryMode \? 'category' : undefined/)
    expect(body).toMatch(/scope: frequencyFileScope\(qa\.layerScope, coderNames, filterFileScope\)/)  // #1545: + the filter
    expect(body).toMatch(/exportCodeFrequenciesCsv\(pid,/)
    expect(body).not.toMatch(/filterParams/)
  })
})

describe('the Source Data CSV door (D88)', () => {
  it('sends the query sourceDataCsvParams builds — the selection exactly, exclude_facilitator always', () => {
    const body = SRC.match(/const handleDescriptivesExport = useCallback\(\(\) => \{([\s\S]*?)\n {2}\}, \[/)?.[1] ?? ''
    expect(body).toMatch(/exportApi\.sourceFrequenciesCsv\(pid, sourceDataCsvParams\(qa\.selectedCodeIds,/)
    expect(body).toMatch(/excludeFacilitator: qa\.excludeFacilitator/)
    expect(body).toMatch(/coderIdsCsv: effectiveCoderIncludeCsv/)
    expect(body).not.toMatch(/if \(qa\.excludeFacilitator\)/)
  })
})

describe('nothing asks for the deleted server file', () => {
  it('no source names `export/code-frequencies`', () => {
    // The floor and the sentinel are the walk's own population checks (#730); the sentinel is
    // the API module that held the old door.
    const files = sourceFiles({ ext: 'both', floor: 400, sentinels: ['lib/api/export.ts'] })
    const callers = files.filter(f => /export\/code-frequencies/.test(stripComments(readFileSync(f, 'utf8'))))
    expect(callers).toEqual([])
    // Predicate falsifier: the pattern does fire on the path the old door used.
    expect(/export\/code-frequencies/.test('`/projects/${p}/export/code-frequencies?x`')).toBe(true)
  }, SOURCE_SCAN_TIMEOUT_MS)
})
