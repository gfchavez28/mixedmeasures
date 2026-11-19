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
const DOOR = /(?<!function )\b(exportApi\.[A-Za-z]+|textCodingApi\.exportCoded|textAnalysisApi\.(?:exportCrossAnalysis|filteredFrequencies|crossTabulation|codeDensity)|excerptsApi\.listQuoted|codeAnalysisApi\.(?:segmentsWithContext|textsWithContext|demographicFilters|sourceFrequencies|demographicComparison)|exportCodeFrequenciesCsv|metricsApi\.rowMatrix[A-Za-z]*|datasetsApi\.(?:getData|getDomainScores)|participantsApi\.getDetail|textCodingApi\.recordContext|metricsApi\.list|jointDisplayApi\.(?:compute|passages|pinFacts|cases)|metricsApi\.(?:quickCompute|crossTabulation|analysisColumns)|comparisonsApi\.groupComparison(?:Csv)?|correlationsApi\.(?:correlationMatrix|scatterMatrix|correlationMatrixCsv|scatterDataCsv)|dataQualityApi\.(?:summary|patterns|mcarTest|summaryCsv)|statisticalTestsApi\.(?:list|compute)|recodeApi\.getFrequencies|datasetsApi\.previewComputedColumn)\(/g

type Decision =
  | 'withholding: the viewer alone'        // D95/D98/D99/D102 — follows `withholding`
  | 'the page’s effective scope (#499)'   // already sent the blind-forced scope before 1.5.9
  | 'every coder by design (#454)'        // codebook usage counts
  | 'not a coding view (D95)'             // no coding layer in the file
  | 'names only — no values (#1615)'      // the variable list read to NAME a saved result; marks unread
  // D297: a saved qualitative chart replays its SAVED coder scope (`inline-chart-params.ts`'s
  // recorded rule) and names the VIEWER apart (`ratings_viewer_id`) for the grouping gate alone.
  | 'the figure’s saved scope; the viewer for ratings (#1615)'
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
    // #1608: the participant table's rating columns roll up every coder's ratings — a door
    // is a coding door when its VALUES derive from coding, whatever the view is called.
    'exportApi.datasetsExcel': 'withholding: the viewer alone',
    // #1608 (R3-3) left it UNDECIDED; #1615: a metric over a rating score is a colleague's
    // judgement, so the matrix follows the dataset workbook.
    'metricsApi.rowMatrix': 'withholding: the viewer alone',
  },
  // #1608 — the grid and the profile read the participant table's rating columns.
  'pages/DatasetView.tsx': {
    'datasetsApi.getData': 'withholding: the viewer alone',
    // #1675 D358: the variable-group score columns — a group holding a score averages every
    // coder's ratings (the audit's R6: Ben's group score less his Age was Bob's rating).
    'datasetsApi.getDomainScores': 'withholding: the viewer alone',
  },
  // #1675 D359: a participant-table record's context shows its rating columns.
  'components/ByRecordPanel.tsx': {
    'textCodingApi.recordContext': 'withholding: the viewer alone',
  },
  'components/ByTextTable.tsx': {
    'textCodingApi.recordContext': 'withholding: the viewer alone',
  },
  // #1675 D358: the metric list's counts over a rating score (#1615's `total_valid_n`).
  'pages/CrosswalkView.tsx': {
    'metricsApi.list': 'withholding: the viewer alone',
  },
  'components/crosswalk/useCrosswalkMutations.ts': {
    'metricsApi.list': 'withholding: the viewer alone',
  },
  'pages/ParticipantsPage.tsx': {
    'participantsApi.getDetail': 'withholding: the viewer alone',
  },
  'pages/QualitativeAnalysisView.tsx': {
    exportCodeFrequenciesCsv: 'the page’s effective scope (#499)',
    'exportApi.sourceFrequenciesCsv': 'the page’s effective scope (#499)',
    'exportApi.demographicComparisonCsv': 'the page’s effective scope (#499)',
    'exportApi.codeCooccurrence': 'the page’s effective scope (#499)',
    // D98: the door's api now forwards the `coder_ids` its `filterParams` always carried.
    'exportApi.codedSegments': 'the page’s effective scope (#499)',
    'excerptsApi.listQuoted': 'withholding: the viewer alone',
    // #1615 (r3-6): a demographic subtype holding a rating-derived column is left out of the
    // filter options while blind (its values → participant ids would sort people by a score).
    'codeAnalysisApi.demographicFilters': 'withholding: the viewer alone',
    // #1615 (D273): the two reads that can GROUP people send `ratings_follow_coder_ids` while
    // withholding — `coder_ids` is also a lead's coder filter here (#499).
    'codeAnalysisApi.sourceFrequencies': 'the page’s effective scope (#499)',
    'codeAnalysisApi.demographicComparison': 'the page’s effective scope (#499)',
  },
  // The Frequencies CSV's read (#1528): it FORWARDS its caller's request, which never groups
  // (`codeFrequenciesFileRequest` takes no `group_by_subtype`), so no score can form its groups.
  // Its two callers are decided as `exportCodeFrequenciesCsv`: the page (its effective scope) and
  // the Export dialog (the viewer alone while withholding).
  'lib/code-frequencies-export.ts': {
    'codeAnalysisApi.sourceFrequencies': 'the page’s effective scope (#499)',
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
  // #1615 — the filters, the cross-tab variable and the density grouping read a column the
  // researcher picks: while withholding each sends `ratings_follow_coder_ids`, and a variable
  // worked out from participant scores is refused (D273's flag — `coder_ids` is also a lead's
  // filter here). The response length reads the focal texts only, so it is not a door.
  'components/CrossAnalysisPanel.tsx': {
    'textAnalysisApi.exportCrossAnalysis': 'withholding: the viewer alone',
    'textAnalysisApi.filteredFrequencies': 'withholding: the viewer alone',
    'textAnalysisApi.crossTabulation': 'withholding: the viewer alone',
    'textAnalysisApi.codeDensity': 'withholding: the viewer alone',
  },
  'pages/TextCodingView.tsx': {
    'textCodingApi.exportCoded': 'withholding: the viewer alone',
  },
  // #1615 — every read over a variable that can be a rating score (`lib/analysis-scope.ts`,
  // `hooks/useAnalysisScope.ts`): the viewer alone while withholding; the server leaves the
  // scores out and says so. The list MARKS them (C4) so a picker can hide them.
  'pages/AnalysisView.tsx': {
    'metricsApi.rowMatrix': 'withholding: the viewer alone',   // #1608 R3-3 → #1615
    'metricsApi.analysisColumns': 'withholding: the viewer alone',
    'metricsApi.crossTabulation': 'withholding: the viewer alone',
    'comparisonsApi.groupComparison': 'withholding: the viewer alone',
    'correlationsApi.correlationMatrix': 'withholding: the viewer alone',
    'correlationsApi.scatterMatrix': 'withholding: the viewer alone',
    'dataQualityApi.summary': 'withholding: the viewer alone',
    'dataQualityApi.patterns': 'withholding: the viewer alone',
    'dataQualityApi.mcarTest': 'withholding: the viewer alone',
    'statisticalTestsApi.list': 'withholding: the viewer alone',
    'statisticalTestsApi.compute': 'withholding: the viewer alone',
    'metricsApi.list': 'withholding: the viewer alone',   // #1675 D358
  },
  'hooks/useQuickCompute.ts': {
    'metricsApi.quickCompute': 'withholding: the viewer alone',   // the scope rides `params.coderIds`
  },
  'components/ColumnPicker.tsx': {
    'metricsApi.analysisColumns': 'withholding: the viewer alone',   // hides the marked scores
  },
  'components/analysis/CorrelationsComparisonsContent.tsx': {
    'correlationsApi.correlationMatrixCsv': 'withholding: the viewer alone',
    'correlationsApi.scatterDataCsv': 'withholding: the viewer alone',
    'comparisonsApi.groupComparisonCsv': 'withholding: the viewer alone',
  },
  'components/analysis/DataQualityTab.tsx': {
    'dataQualityApi.summaryCsv': 'withholding: the viewer alone',
  },
  'components/canvas/InlineChartRenderer.tsx': {
    'metricsApi.quickCompute': 'withholding: the viewer alone',
    'metricsApi.crossTabulation': 'withholding: the viewer alone',
    'comparisonsApi.groupComparison': 'withholding: the viewer alone',
    'codeAnalysisApi.sourceFrequencies': 'the figure’s saved scope; the viewer for ratings (#1615)',
    'codeAnalysisApi.demographicComparison': 'the figure’s saved scope; the viewer for ratings (#1615)',
  },
  // The embed reads the list for its TITLE (a column's name), never a value.
  'components/canvas/extensions/ChartEmbedView.tsx': {
    'metricsApi.analysisColumns': 'names only — no values (#1615)',
  },
  // #1615 D279 (built): the builder offers variables to PICK — the viewer's list while
  // withholding, so a menu greys a score out and the survey list hides and counts it.
  // `useDisplayResults` names saved results only.
  'components/canvas/joint-display/JointDisplayBuilder.tsx': {
    'metricsApi.analysisColumns': 'withholding: the viewer alone',
  },
  'components/canvas/joint-display/useDisplayResults.ts': {
    'metricsApi.analysisColumns': 'names only — no values (#1615)',
  },
  // Found by this scan at build session B (2026-11-05c): the Codebook page's peek showed the TEXT of
  // up to three passages coded with the selected code, by any coder. #454 decided the codebook's
  // COUNTS; passages are not counts — decided by the developer the same day ("the codebook sample
  // passages should follow blind mode") and built.
  'components/codebook/CodebookPeekPanel.tsx': {
    'codeAnalysisApi.segmentsWithContext': 'withholding: the viewer alone',
  },
  // Joint display session B (D175): the display's counts and rated cells (D197 — the rollup takes
  // the same `coder_ids`) and a pin's suggested passages, whose chips follow the scope (D102).
  'components/canvas/extensions/JointDisplayView.tsx': {
    'jointDisplayApi.compute': 'withholding: the viewer alone',
    // #1615 (r3-5): a rating-derived attribution column's value is left out while blind.
    'jointDisplayApi.pinFacts': 'withholding: the viewer alone',
  },
  'components/canvas/joint-display/PinPicker.tsx': {
    'jointDisplayApi.passages': 'withholding: the viewer alone',
  },
  // Joint display slice 2, round 2 (r5): the case view's page and the count-only read of each
  // row's misfit (the open construct, the Report view) — per-person coding under the compute's
  // own scope (D175); a rule over a rating score is not run while blind (r3-3).
  'components/canvas/joint-display/CaseView.tsx': {
    'jointDisplayApi.cases': 'withholding: the viewer alone',
  },
  'components/canvas/joint-display/useMisfitReads.ts': {
    'jointDisplayApi.cases': 'withholding: the viewer alone',
  },
  // Joint display session C (D174): the canvas export reads each display's numbers itself, under
  // the export lens — whose `blind` is `useBlindMode`'s `withholding` (`CanvasView`, pinned by
  // `machine-coverage-wiring.test.ts`) — so the file holds what the Report view shows.
  'lib/canvas-export.ts': {
    'jointDisplayApi.compute': 'withholding: the viewer alone',
    'jointDisplayApi.pinFacts': 'withholding: the viewer alone',   // #1615, the Compact view's scope
    // r5-8: the misfit note's count-only read, under the export lens as the numbers are.
    'jointDisplayApi.cases': 'withholding: the viewer alone',
    // #1615: the chart tables (Markdown, the Word fallback) under the export lens.
    'metricsApi.quickCompute': 'withholding: the viewer alone',
    'metricsApi.crossTabulation': 'withholding: the viewer alone',
    'comparisonsApi.groupComparison': 'withholding: the viewer alone',
    'metricsApi.analysisColumns': 'names only — no values (#1615)',
    'codeAnalysisApi.sourceFrequencies': 'the figure’s saved scope; the viewer for ratings (#1615)',
    'codeAnalysisApi.demographicComparison': 'the figure’s saved scope; the viewer for ratings (#1615)',
  },
  // #1615 (r4-1, r4-2): a score's observed values and a computed preview over one SHOW its values.
  'pages/RecodeWorkbench.tsx': {
    'recodeApi.getFrequencies': 'withholding: the viewer alone',
  },
  'components/ColumnFormDialog.tsx': {
    'datasetsApi.previewComputedColumn': 'withholding: the viewer alone',
  },
  // Text Coding's Cross-analysis subgroup filter lists a column's values to filter by (#1615).
  'components/SubgroupFilterPanel.tsx': {
    'recodeApi.getFrequencies': 'withholding: the viewer alone',
  },
  // Renders only when `variableRulesRefusal` is null — never on a managed or computed column.
  'components/ColumnDictionaryEditor.tsx': {
    'recodeApi.getFrequencies': 'not a coding view (D95)',
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
    // #1615: the scan sees the quantitative doors, and `computeAll` (counts only) is not one.
    expect(FOUND['hooks/useQuickCompute.ts']?.has('metricsApi.quickCompute')).toBe(true)
    expect(FOUND['pages/AnalysisView.tsx']?.has('dataQualityApi.mcarTest')).toBe(true)
    expect([...'statisticalTestsApi.computeAll(pid, x)'.matchAll(DOOR)]).toEqual([])
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

  it('#1608: the grid, the profile and the datasets workbook send the viewer’s scope and wait to settle', () => {
    // The rule (settled · withholding · a self id, fail closed) has one home.
    const hook = read('hooks/useBlindScope.ts')
    expect(hook).toMatch(/coderScope: withholding && self != null \? String\(self\) : undefined/)
    expect(hook).toMatch(/scopeReady: settled && !\(withholding && self == null\)/)
    const grid = read('pages/DatasetView.tsx')
    expect(grid).toMatch(/const \{ coderScope, scopeReady \} = useBlindScope\(pid\)/)
    expect(grid).toMatch(/queryFn: \(\) => datasetsApi\.getData\(pid, iid, \{ offset: pageOffset \}, coderScope\)/)
    expect(grid).toMatch(/enabled: !!pid && !!iid && scopeReady/)
    // Both spellings — the patches' `dataPageKey` and the query's literal key — carry the scope.
    expect(grid).toMatch(/\(\) => \['dataset-data', pid, iid, pageOffset, coderScope \?\? 'every-coder'\] as const,/)
    expect(grid).toMatch(/queryKey: \['dataset-data', pid, iid, pageOffset, coderScope \?\? 'every-coder'\],/)
    const profile = read('pages/ParticipantsPage.tsx')
    expect(profile).toMatch(/const \{ coderScope, scopeReady \} = useBlindScope\(projectId\)/)
    expect(profile).toMatch(/queryKey: \['participant-detail', participantId, coderScope \?\? 'every-coder'\],\n\s*enabled: scopeReady,\n\s*queryFn: \(\) => participantsApi\.getDetail\(projectId, participantId, coderScope\)/)
    expect(read('components/ExportDialog.tsx')).toMatch(/exportApi\.datasetsExcel\(projectId, coderScope\)/)
  })

  it('the Codebook peek: its sample passages are the viewer’s own while withholding, and wait to settle', () => {
    const src = read('components/codebook/CodebookPeekPanel.tsx')
    expect(src).toMatch(/const sampleScope = withholding && self != null \? String\(self\) : undefined/)
    expect(src).toMatch(/queryKey: \['code-sample-segments', projectId, entityId, sampleScope \?\? ''\]/)
    expect(src).toMatch(/&& blindSettled && !\(withholding && self == null\)/)
  })

  it('joint display slice 2, round 2 (r5): every case read asks with the compute’s scope, keyed by its request, never with no viewer', () => {
    // The ONE request builder starts from `computeRequest`, so it carries the compute's coder ids.
    const model = read('lib/joint-display-cases.ts')
    expect(model).toMatch(/const base = computeRequest\(display, scope\)/)
    expect(model).toMatch(/coder_ids: base\.coder_ids,\s*layer_scope: base\.layer_scope,/)
    // The view hands the dialog and the count read the compute's own `scope`, and D96's case.
    const view = read('components/canvas/extensions/JointDisplayView.tsx')
    expect(view).toMatch(/const noViewer = withholding && self == null/)
    // #1703 (b) (D372): no `groupBy` rides the request any more — a rule's group clause reads by
    // its group alone; the scope and D96's case are what this door hands on.
    expect(view).toMatch(/kind: 'cases', displayKey, display, rowKey: row\.key, scope, noViewer,/)
    const dialog = read('components/canvas/joint-display/CaseView.tsx')
    expect(dialog).toMatch(/queryKey: \['joint-display-cases', projectId, request\],/)
    expect(dialog).toMatch(/enabled: request != null && !noViewer,/)
    const counts = read('components/canvas/joint-display/useMisfitReads.ts')
    expect(counts).toMatch(/queryKey: \['joint-display-cases', projectId, request\],/)
    expect(counts).toMatch(/enabled: enabled && !noViewer && request != null,/)
    const exporter = read('lib/canvas-export.ts')
    // D96 rides the compute's own gate: a case read only once the numbers were read.
    expect(exporter).toMatch(/if \(data\) \{\s*await Promise\.all\(display\.rows\.filter\(hasMisfit\)/)
  })

  it('the joint display: the viewer alone while withholding, in the key, and nothing before it settles', () => {
    const scope = read('lib/joint-display.ts')
    // #1675 D361: no viewer while withholding is NO scope (null), never `coder_ids: []` — the
    // server reads an empty list as every coder — and every request builder answers null for it.
    expect(scope).toMatch(/if \(withholding\) return self != null \? \{ coderIds: \[self\], layerScope: 'human', chipsFollow: true \} : null/)
    expect(scope).not.toMatch(/coderIds: self != null \? \[self\] : \[\]/)
    expect(scope).toMatch(/if \(display\.group_by_column_id == null \|\| scope == null\) return null/)
    const view = read('components/canvas/extensions/JointDisplayView.tsx')
    expect(view).toMatch(/displayCoderScope\(withholding, self\)/)
    expect(view).toMatch(/const scopeReady = settled && !\(withholding && self == null\)/)
    expect(view).toMatch(/queryKey: \['joint-display', pid, request\],/)
    expect(view).toMatch(/enabled: request != null && scopeReady,/)
    const picker = read('components/canvas/joint-display/PinPicker.tsx')
    // Joint display slice 2 (r4-1, R9): the picker's request is built by the model's one
    // `pinPassagesRequest` (it carries the pin's strand's sources), so the scope line lives
    // there now — and the picker must hand it the view's scope.
    expect(scope).toMatch(/chips_follow_coder_ids: scope\.chipsFollow,/)
    expect(picker).toMatch(/pinPassagesRequest\(display, strandKey, group, codeId, scope\)/)
    expect(picker).toMatch(/queryKey: \['joint-display-passages', projectId, request\],/)
    // Session C: the export asks with the SAME scope function, from the export lens, and never
    // reads while withholding with no viewer to scope to (D96).
    const exporter = read('lib/canvas-export.ts')
    expect(exporter).toMatch(/const scope = displayCoderScope\(timelineLens\.blind, timelineLens\.self\)/)
    expect(exporter).toMatch(/if \(scope == null\) \{\s*unavailable = 'The joint display was not computed/)
    expect(exporter).toMatch(/withholding: timelineLens\.blind, self: timelineLens\.self/)
  })

  it('#1615: every quantitative read sends the viewer’s scope, keys on it, and waits for it', () => {
    // One rule (`lib/analysis-scope.ts`), in both spellings, fail closed with no self id.
    const rule = read('lib/analysis-scope.ts')
    expect(rule).toMatch(/if \(!withholding\) return \{ coderIds: null, coderScope: undefined, scopeKey: 'every-coder' \}/)
    expect(rule).toMatch(/if \(self == null\) return null/)
    expect(rule).toMatch(/return coderIds \? \{ coder_ids: coderIds \} : \{\}/)
    expect(read('hooks/useAnalysisScope.ts')).toMatch(/const scope = settled \? analysisScope\(withholding, self\) : null/)
    const page = read('pages/AnalysisView.tsx')
    expect(page).toMatch(/const \{ coderIds, coderScope, scopeKey, scopeReady \} = useAnalysisScope\(pid\)/)
    for (const root of ['correlation-matrix', 'scatter-matrix', 'group-comparison', 'analysis-columns', 'statistical-tests', 'dq-summary', 'dq-patterns', 'analysis-cross-tab']) {
      expect(page, root).toMatch(new RegExp(`queryKey: \\['${root}', pid[^\\]]*, scopeKey\\]`))
    }
    expect(page.match(/&& scopeReady,/g)?.length ?? 0).toBeGreaterThanOrEqual(7)
    expect(page.match(/\.\.\.coderIdsField\(coderIds\),/g)?.length).toBe(7)   // corr · scatter · comparison · dq ×3 · cross-tab
    expect(page).toMatch(/if \(!scopeReady\) return\s*\n\s*const columnIds/)   // quick compute never fires unscoped
    expect(page).toMatch(/metricsApi\.rowMatrix\(Number\(pid\), ids, 'csv', coderScope\)/)
    const picker = read('components/ColumnPicker.tsx')
    expect(picker).toMatch(/queryKey: \['analysis-columns', projectId, scopeKey\],\n\s*queryFn: \(\) => metricsApi\.analysisColumns\(projectId, coderScope\),\n\s*enabled: scopeReady,/)
    expect(picker).toMatch(/visibleAnalysisColumns\(columnsQuery\.data\)/)
    // D279: the joint display builder reads the same list the same way (its behaviour:
    // `JointDisplayBuilder.test.tsx`).
    const builder = read('components/canvas/joint-display/JointDisplayBuilder.tsx')
    expect(builder).toMatch(/queryKey: \['analysis-columns', projectId, scopeKey\],\n\s*queryFn: \(\) => metricsApi\.analysisColumns\(projectId, coderScope\),\n\s*enabled: scopeReady,/)
    const embed = read('components/canvas/InlineChartRenderer.tsx')
    expect(embed.match(/, scopeKey\],/g)?.length).toBe(5)   // three quantitative + two qualitative grouping reads
    expect(embed.match(/!= null && scopeReady,/g)?.length).toBe(4)   // all three wait for the scope (+ the comparison)
    expect(embed.match(/\.\.\.coderIdsField\(coderIds\) \}/g)?.length).toBe(3)
    // #1615 (D297's Canvas path): the qualitative grouping reads name the VIEWER for the ratings
    // question beside the figure's saved scope — never as `coder_ids` — and wait for it.
    expect(embed).toMatch(/codeAnalysisApi\.sourceFrequencies\(projectId, \{ \.\.\.qualParams\.request, \.\.\.ratingsViewerField\(coderIds\) \}\)/)
    expect(embed).toMatch(/codeAnalysisApi\.demographicComparison\(projectId, \{ \.\.\.comparisonRequest!, \.\.\.ratingsViewerField\(coderIds\) \}\)/)
    expect(embed).toMatch(/enabled: qualEnabled && isSourceFrequencyChart && scopeReady,/)
    expect(rule).toMatch(/return coderIds \? \{ ratings_viewer_id: coderIds\[0\] \} : \{\}/)
    const exporter = read('lib/canvas-export.ts')
    expect(exporter).toMatch(/const scope = analysisScope\(timelineLens\.blind, timelineLens\.self\)/)
    expect(exporter.match(/\.\.\.coderIdsField\(coderIds\) \}/g)?.length).toBe(3)
    expect(exporter).toMatch(/const viewer = analysisScope\(timelineLens\.blind, timelineLens\.self\)/)
    expect(exporter.match(/\{ \.\.\.(?:params\.request|request), \.\.\.viewer \}/g)?.length).toBe(2)
    expect(read('components/ExportDialog.tsx')).toMatch(/metricsApi\.rowMatrix\(projectId, undefined, 'csv', coderScope\)/)
  })

  it('the Text Coding export: the viewer alone while withholding, and nothing before the state settles', () => {
    const src = read('pages/TextCodingView.tsx')
    const door = src.match(/onClick=\{\(\) => \{\s*if \(!blindSettled\) return\s*void textCodingApi\.exportCoded\(projectId, \{([\s\S]*?)\}\)/)?.[1] ?? ''
    expect(door).toMatch(/coder_ids: withholding && self != null \? String\(self\) : undefined/)
  })
})
