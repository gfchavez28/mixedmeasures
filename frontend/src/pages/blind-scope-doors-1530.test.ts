/**
 * #1530 / #1531 (1.5.9, D95–D102) — every client door that downloads coding, or reads a list of
 * passages with bare code ids, has DECIDED what a blind coder gets.
 *
 * Blind mode is client state, so the server narrows only what a request asks for. The review's
 * door table missed one door (the analysis page's Segments CSV, found by re-deriving the
 * population at its close-out) and session A's pickup found a second kind of door (the passage
 * chips, D102). So this guard RE-DERIVES the population from the source — every call of a
 * coding download or a passage read — and requires it to EQUAL the table below, both ways: a new
 * door fails the suite until someone decides it.
 *
 * A SOURCE scan, stated as such: no unit test mounts the analysis page or the Text Coding page
 * and presses their doors. Behaviour lives in `ExportDialog.test.tsx`,
 * `CrossAnalysisPanel.blind-1531.test.tsx`, `lib/api/export-coder-scope-1530.test.ts` and the
 * live drive (the review record's §9). ⚠️ A scan cannot see what a branch renders.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { stripComments } from '@/lib/strip-comments'
import { sourceFiles, srcRel, SOURCE_SCAN_TIMEOUT_MS } from '@/test-support/source-tree'

/** A call of a coding download or a passage read (a declaration is not a call). */
const DOOR = /(?<!function )\b(exportApi\.[A-Za-z]+|textCodingApi\.exportCoded|textAnalysisApi\.exportCrossAnalysis|excerptsApi\.listQuoted|codeAnalysisApi\.(?:segmentsWithContext|textsWithContext)|exportCodeFrequenciesCsv|metricsApi\.rowMatrix[A-Za-z]*)\(/g

type Decision =
  | 'withholding: the viewer alone'        // D95/D98/D99/D102 — follows `withholding`
  | 'the page’s effective scope (#499)'   // already sent the blind-forced scope before 1.5.9
  | 'every coder by design (#454)'        // codebook usage counts
  | 'not a coding view (D95)'             // no coding layer in the file
  | 'UNDECIDED — every coder today'       // a door found and measured, awaiting the developer's decision (none today)

/** `file → door → decision`. A door called twice in one file is one decision. */
const DOORS: Record<string, Record<string, Decision>> = {
  'components/ExportDialog.tsx': {
    'exportApi.excelWithOptions': 'withholding: the viewer alone',
    'exportApi.csv': 'withholding: the viewer alone',
    'exportApi.codedSegments': 'withholding: the viewer alone',
    'exportApi.codeCooccurrence': 'withholding: the viewer alone',
    'exportApi.rData': 'withholding: the viewer alone',
    exportCodeFrequenciesCsv: 'withholding: the viewer alone',
    'exportApi.codebook': 'every coder by design (#454)',
    'exportApi.datasetsExcel': 'not a coding view (D95)',
    'metricsApi.rowMatrix': 'not a coding view (D95)',
  },
  'pages/QualitativeAnalysisView.tsx': {
    exportCodeFrequenciesCsv: 'the page’s effective scope (#499)',
    'exportApi.sourceFrequenciesCsv': 'the page’s effective scope (#499)',
    'exportApi.demographicComparisonCsv': 'the page’s effective scope (#499)',
    'exportApi.codeCooccurrence': 'the page’s effective scope (#499)',
    // D98: the door's api now forwards the `coder_ids` its `filterParams` always carried.
    'exportApi.codedSegments': 'the page’s effective scope (#499)',
    'excerptsApi.listQuoted': 'withholding: the viewer alone',
  },
  'components/qualitative-analysis/RelationshipsPanel.tsx': {
    'exportApi.demographicComparisonCsv': 'the page’s effective scope (#499)',
  },
  'components/qualitative-analysis/ContentByCode.tsx': {
    'codeAnalysisApi.segmentsWithContext': 'withholding: the viewer alone',
    'codeAnalysisApi.textsWithContext': 'withholding: the viewer alone',
  },
  'components/qualitative-analysis/QuoteBoardView.tsx': {
    'excerptsApi.listQuoted': 'withholding: the viewer alone',
  },
  'components/CrossAnalysisPanel.tsx': {
    'textAnalysisApi.exportCrossAnalysis': 'withholding: the viewer alone',
  },
  'pages/TextCodingView.tsx': {
    'textCodingApi.exportCoded': 'withholding: the viewer alone',
  },
  'pages/AnalysisView.tsx': {
    'metricsApi.rowMatrix': 'not a coding view (D95)',
  },
  // Found by this scan at build session B (2026-11-05c): the Codebook page's peek showed the TEXT of
  // up to three passages coded with the selected code, by any coder. #454 decided the codebook's
  // COUNTS; passages are not counts — decided by the developer the same day ("the codebook sample
  // passages should follow blind mode") and built.
  'components/codebook/CodebookPeekPanel.tsx': {
    'codeAnalysisApi.segmentsWithContext': 'withholding: the viewer alone',
  },
}

const FILES = sourceFiles({
  ext: 'both', floor: 400,
  sentinels: ['components/ExportDialog.tsx', 'pages/QualitativeAnalysisView.tsx', 'lib/api/export.ts'],
})
const FOUND: Record<string, Set<string>> = {}
for (const abs of FILES) {
  const rel = srcRel(abs)
  if (rel.startsWith('lib/api/')) continue   // the definitions, not the doors
  for (const m of stripComments(readFileSync(abs, 'utf8')).matchAll(DOOR)) {
    ;(FOUND[rel] ??= new Set()).add(m[1])
  }
}

function read(rel: string): string {
  return stripComments(readFileSync(FILES.find(f => srcRel(f) === rel)!, 'utf8'))
}

describe('the client doors a blind coder can reach (#1530/#1531)', () => {
  it('self-check: the scan sees the doors it is about, including both kinds', () => {
    expect(FOUND['components/ExportDialog.tsx']?.has('exportApi.rData')).toBe(true)
    expect(FOUND['components/qualitative-analysis/ContentByCode.tsx']?.has('codeAnalysisApi.textsWithContext')).toBe(true)
    // Predicate falsifier: a declaration is not a door, a call is.
    expect([...'export async function exportCodeFrequenciesCsv('.matchAll(DOOR)]).toEqual([])
    expect([...'void exportCodeFrequenciesCsv(pid, {'.matchAll(DOOR)].length).toBe(1)
  })

  it('every door is decided, and every decision names a door that exists', { timeout: SOURCE_SCAN_TIMEOUT_MS }, () => {
    const found = Object.fromEntries(Object.entries(FOUND).map(([f, s]) => [f, [...s].sort()]))
    const decided = Object.fromEntries(Object.entries(DOORS).map(([f, d]) => [f, Object.keys(d).sort()]))
    expect(found).toEqual(decided)
  })
})

describe('the wiring a scan can see', () => {
  it('the analysis page: the passage chips and the Quote Board follow the ACT, never the claim', () => {
    const src = read('pages/QualitativeAnalysisView.tsx')
    expect(src).toMatch(/chipsFollowCoderIds=\{withholding\}/)
    // The *By Source* view's chips (D102, client lens — its payloads name each code's coder).
    // #1541: the viewer's own allow-list while withholding, never the roster hide set.
    expect(src).toMatch(/coderLens=\{bySourceLens\}/)
    expect(src).toMatch(/\(\) => \(withholding \? onlyCoders\(self != null \? \[self\] : \[\]\) : null\)/)
    expect(src).not.toMatch(/coderLens=\{withholding \? blindLens : null\}/)
    expect(src).toMatch(/coder_ids: withholding && self != null \? String\(self\) : undefined,\n\s*\}\), \[qa\.participantIds, withholding, self\]\)/)
    // The lifted Quote Board read is server-scoped by the blind state: it waits, and its key names the scope.
    expect(src).toMatch(/queryKey: quotedExcerptsQueryKey\(pid, quoteFilterParams\)/)
    expect(src).toMatch(/enabled: !!pid && qa\.tab === 'quoteboard' && blindSettled/)
  })

  it('the Quote Board: its fallback read waits too, and a drag saves through the merge', () => {
    const src = read('components/qualitative-analysis/QuoteBoardView.tsx')
    expect(src).toMatch(/queryKey: quotedExcerptsQueryKey\(projectId, filterParams\)/)
    expect(src).toMatch(/enabled: !!projectId && !quoteDataProp && blindSettled/)
    const dragEnd = src.match(/const handleDragEnd = useCallback\(([\s\S]*?)\n {2}\}, \[/)?.[1] ?? ''
    expect(dragEnd).toMatch(/mergeVisibleOrder\(customOrders\[targetSection\.key\] \?\? \[\], newOrderIds\)/)
  })

  it('the Codebook peek: its sample passages are the viewer’s own while withholding, and wait to settle', () => {
    const src = read('components/codebook/CodebookPeekPanel.tsx')
    expect(src).toMatch(/const sampleScope = withholding && self != null \? String\(self\) : undefined/)
    expect(src).toMatch(/queryKey: \['code-sample-segments', projectId, entityId, sampleScope \?\? ''\]/)
    expect(src).toMatch(/&& blindSettled && !\(withholding && self == null\)/)
  })

  it('the Text Coding export: the viewer alone while withholding, and nothing before the state settles', () => {
    const src = read('pages/TextCodingView.tsx')
    const door = src.match(/onClick=\{\(\) => \{\s*if \(!blindSettled\) return\s*void textCodingApi\.exportCoded\(projectId, \{([\s\S]*?)\}\)/)?.[1] ?? ''
    expect(door).toMatch(/coder_ids: withholding && self != null \? String\(self\) : undefined/)
  })
})
