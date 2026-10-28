/**
 * #1337 — what a coding refreshes is a POPULATION: every query-key root in `src/` says
 * whether a coding moves it, and if it does, who invalidates it.
 *
 * #450 single-sourced the cross-surface keys in `invalidateDerivedCounts`, and the list
 * still went seven analysis roots and the Canvas's three short — because nothing asked,
 * of a NEW query, whether a coding changes it. This asks every observer in `src/`:
 *
 *  - `derived` — in the helper's list (`DERIVED_COUNT_ROOTS` / `DERIVED_METRIC_ROOTS`),
 *    so every coding door reaches it. Checked both ways: the table and the helper agree.
 *  - `local`   — a workbench's OWN active list, which the helper must not refetch on every
 *    chord there; each named host must invalidate it (checked in its source).
 *  - `gap`     — a coding moves it and nothing yet refreshes it from elsewhere: a KNOWN
 *    residual with its entry, never a silent one.
 *  - `not`     — a coding does not move it, with the reason.
 *
 * A root nobody classified fails, so a new query has to decide. ⚠️ What this cannot see:
 * a field that STARTS carrying coded counts on an already-classified root — reclassify it
 * in the same change that adds the field.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { SOURCE_SCAN_TIMEOUT_MS, sourceFiles, srcRel } from '@/test-support/source-tree'
import { DERIVED_COUNT_ROOTS, DERIVED_METRIC_ROOTS } from './coding-cache'
import { stripComments } from './strip-comments'

type Row =
  | { kind: 'derived' }
  | { kind: 'local'; hosts: string[]; gap?: string }
  | { kind: 'gap'; entry: string }
  | { kind: 'not'; why: string }

const D: Row = { kind: 'derived' }
const not = (why: string): Row => ({ kind: 'not', why })
const GAP_ELSEWHERE = 'counts on a list page or a workbench cache, stale for its 60 s window after coding ELSEWHERE — proposed 1.5.9 entry (mark stale with refetchType "none")'

const CLASSIFICATION: Record<string, Row> = {
  // ── derived: in invalidateDerivedCounts ──
  'search': D, 'project-summary': D, 'codebook-tree': D, 'consensus-status': D,
  'code-sample-segments': D, 'irr': D, 'reconciliation': D, 'machine-agreement': D,
  'coder-coverage': D, 'code-frequencies': D, 'qual-source-frequencies': D,
  'qual-saturation': D, 'qual-demographic-comparison': D, 'code-cooccurrence': D,
  'binned-kappa': D, 'unitizing-alpha': D, 'qual-text-columns': D,
  'code-segments-context': D, 'code-texts-context': D, 'excerpts-quoted': D,
  'conversation-segments-readonly': D, 'document-segments-readonly': D,
  'text-column-readonly': D, 'canvas-qual-chart': D, 'canvas-qual-saturation': D,
  'canvas-qual-comparison': D, 'rating-queue': D, 'text-filtered-freq': D,
  'text-crosstab': D, 'text-density': D, 'text-length': D,
  'metrics': D, 'canvas-chart': D,
  // ── local: a workbench's own active list ──
  'segments': { kind: 'local', hosts: ['pages/CodingWorkbench.tsx'], gap: GAP_ELSEWHERE },
  'document': { kind: 'local', hosts: ['pages/DocumentCodingWorkbench.tsx'], gap: GAP_ELSEWHERE },
  'observation-segments': { kind: 'local', hosts: ['pages/ObservationWorkbench.tsx', 'pages/QualitativeAnalysisView.tsx', 'components/qualitative-analysis/ReconciliationGrid.tsx'] },
  'observations': { kind: 'local', hosts: ['pages/ObservationWorkbench.tsx'] },
  'text-data': { kind: 'local', hosts: ['pages/TextCodingView.tsx'], gap: GAP_ELSEWHERE },
  'text-progress': { kind: 'local', hosts: ['pages/TextCodingView.tsx'], gap: GAP_ELSEWHERE },
  'codes': { kind: 'local', hosts: ['pages/CodingWorkbench.tsx', 'pages/DocumentCodingWorkbench.tsx', 'pages/ObservationWorkbench.tsx', 'pages/QualitativeAnalysisView.tsx', 'components/qualitative-analysis/ReconciliationGrid.tsx'], gap: '"N uses": TextCodingView does not invalidate it — proposed 1.5.9' },
  // ── gap: a coding moves it, nothing refreshes it from elsewhere ──
  'conversations': { kind: 'gap', entry: GAP_ELSEWHERE },
  'documents': { kind: 'gap', entry: GAP_ELSEWHERE },
  'projects': { kind: 'gap', entry: `coder_count on the Dashboard — ${GAP_ELSEWHERE}` },
  'project': { kind: 'gap', entry: `carries coder_count — ${GAP_ELSEWHERE}` },
  'text-columns': { kind: 'gap', entry: `coded_rows in the column picker — ${GAP_ELSEWHERE}` },
  // ── not: a coding does not move it ──
  'coders': not('the roster — RESET by what adds coders (#964)'),
  'backup-safety-copies': not('backup files'), 'backup-list': not('backup files'), 'backup-status': not('backup files'),
  'all-notes': not('notes'), 'notes': not('notes'), 'document-notes': not('notes'), 'observation-notes': not('notes'), 'text-notes': not('notes'),
  'memos': not('memos'), 'entity-memos': not('memos'), 'scratchpad': not('quick jots'),
  'excerpts': not('quotes and their text, no codes'), 'quote-board-config': not('card order'),
  'analysis-columns': not('dataset columns'), 'analysis-cross-tab': not('dataset values (qual-client.md §3: a separate class)'),
  'analysis-domains': not('dataset domains'), 'correlation-matrix': not('dataset values'), 'scatter-matrix': not('dataset values'),
  'group-comparison': not('dataset values'), 'dq-patterns': not('dataset values'), 'dq-summary': not('dataset values'),
  'canvas-comparison': not('dataset values'), 'canvas-cross-tab': not('dataset values'),
  'statistical-tests': not('saved dataset tests'), 'domain-scores': not('dataset domain scores'), 'domain-suggestions': not('dataset domains'),
  'dataset': not('dataset structure'), 'datasets': not('dataset list (its managed_stale is marked after a RATING by invalidateAfterRating, #1425)'),
  'dataset-columns': not('dataset structure'),
  // ⚠️ Not quite: its `dataset.managed_stale` (the participant table's "out of date") moves
  // with a coding too — an input class of the score; marked after a RATING (#1425), the
  // coding half is #1414's 60 s class.
  'dataset-data': not('cell values'), 'project-columns': not('dataset structure'),
  'column-frequencies': not('value frequencies'), 'recode-definitions': not('recodes'), 'rekey-plan': not('recodes'),
  'reverse-columns': not('recodes'), 'column-removal-plan': not('dataset structure'), 'dataset-removal-plan': not('dataset structure'),
  'equivalence-groups': not('crosswalk'), 'link-by-column-preview': not('participant linking'), 'linkable-rows': not('participant linking'),
  'participants': not('participant list'), 'participant-detail': not('participant links'), 'withdrawal-report': not('fetched fresh inside its dialog'),
  'demographic-filters': not('dataset values'), 'speakers': not('speakers'),
  'canvas': not('canvas content'), 'canvases': not('canvas list'), 'snapshots': not('canvas snapshots'), 'snapshot-detail': not('canvas snapshots'),
  'material-collections': not('materials'), 'material-collection-detail': not('materials'), 'materials-all': not('materials'),
  'categories': not('category names; counts are codes, not codings'), 'code-sets': not('set membership'),
  'conversation': not('its coded count is unread: the workbench gauge is client-side (J-A)'),
  'observation': not('the observation record'), 'document-original-txt': not('the source file'),
  'record-context': not("a record's demographics and other answers, no codes"),
  'text-config': not('Text Coding view state'), 'text-coding-columns': not('coding-import column list'),
  'project-storage': not('disk use'), 'project-export-ceiling': not('export limits'),
}

const OBSERVERS = new Set(['useQuery', 'useInfiniteQuery', 'useSuspenseQuery', 'useQueries', 'fetchQuery', 'prefetchQuery', 'ensureQueryData', 'queryOptions'])
/** Exported key constants the scan resolves by name (each pinned by a self-check). */
const KEY_CONSTANTS: Record<string, string> = {
  CODERS_QUERY_KEY: 'coders', ALL_CODERS_QUERY_KEY: 'coders', SAFETY_COPIES_QUERY_KEY: 'backup-safety-copies',
}

function parse(text: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

function calleeName(e: ts.Expression): string {
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return e.name.text
  return ''
}

/** The root of a key expression: `['x', …]`, `[...CONST, …]`, a local `const k = [...]`, a constant. */
function rootOf(expr: ts.Expression, sf: ts.SourceFile): string | null {
  if (ts.isArrayLiteralExpression(expr)) {
    const first = expr.elements[0]
    if (!first) return null
    if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text
    if (ts.isSpreadElement(first)) return rootOf(first.expression, sf)
    return null
  }
  if (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr)) return rootOf(expr.expression, sf)
  if (ts.isIdentifier(expr)) {
    if (KEY_CONSTANTS[expr.text]) return KEY_CONSTANTS[expr.text]
    let found: string | null = null
    const visit = (n: ts.Node) => {
      if (!found && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === expr.text && n.initializer) {
        found = rootOf(n.initializer, sf)
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    return found
  }
  return null
}

/** Every observer's key root in one file; `null` where the key could not be resolved. */
export function observerRoots(text: string, fileName: string): { root: string | null; line: number }[] {
  const sf = parse(text, fileName)
  const out: { root: string | null; line: number }[] = []
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && OBSERVERS.has(calleeName(n.expression))) {
      const objs: ts.ObjectLiteralExpression[] = []
      const find = (x: ts.Node) => {
        if (ts.isObjectLiteralExpression(x) && x.properties.some(p => p.name?.getText(sf) === 'queryKey')) objs.push(x)
        ts.forEachChild(x, find)
      }
      n.arguments.forEach(find)
      for (const o of objs) {
        const p = o.properties.find(q => q.name?.getText(sf) === 'queryKey')!
        const expr = ts.isPropertyAssignment(p) ? p.initializer
          : ts.isShorthandPropertyAssignment(p) ? p.name : null
        out.push({ root: expr ? rootOf(expr, sf) : null, line: sf.getLineAndCharacterOfPosition(o.getStart(sf)).line + 1 })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** Roots a file INVALIDATES by a literal key: `invalidateQueries({ queryKey: ['root', …] })`. */
function invalidatedRoots(text: string, fileName: string): Set<string> {
  const sf = parse(text, fileName)
  const out = new Set<string>()
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && calleeName(n.expression) === 'invalidateQueries') {
      const arg = n.arguments[0]
      if (arg && ts.isObjectLiteralExpression(arg)) {
        const p = arg.properties.find(q => q.name?.getText(sf) === 'queryKey')
        if (p && ts.isPropertyAssignment(p)) {
          const r = rootOf(p.initializer, sf)
          if (r) out.add(r)
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

const FILES = sourceFiles({
  ext: 'both', floor: 300,
  sentinels: ['pages/QualitativeAnalysisView.tsx', 'components/canvas/InlineChartRenderer.tsx', 'lib/coding-cache.ts'],
})
const FOUND = new Map<string, string[]>()   // root → file:line sites
const UNRESOLVED: string[] = []
for (const abs of FILES) {
  for (const { root, line } of observerRoots(readFileSync(abs, 'utf8'), abs)) {
    if (root === null) { UNRESOLVED.push(`${srcRel(abs)}:${line}`); continue }
    FOUND.set(root, [...(FOUND.get(root) ?? []), `${srcRel(abs)}:${line}`])
  }
}

describe('#1337 — every query-key root says whether a coding moves it', () => {
  it('self-check: the scan sees the population, including the roots #1337 was about', { timeout: SOURCE_SCAN_TIMEOUT_MS }, () => {
    expect(FOUND.size).toBeGreaterThanOrEqual(100)
    expect(FOUND.get('code-frequencies')?.some(s => s.startsWith('pages/QualitativeAnalysisView.tsx:'))).toBe(true)
    expect(FOUND.get('canvas-qual-chart')?.some(s => s.startsWith('components/canvas/InlineChartRenderer.tsx:'))).toBe(true)
    // The three resolution routes each found something real:
    expect(FOUND.get('coders')?.some(s => s.startsWith('hooks/useCoders.ts:'))).toBe(true)              // a constant
    expect(FOUND.get('backup-safety-copies')?.length).toBeGreaterThan(0)                                // a spread constant
    expect(FOUND.get('rating-queue')?.some(s => s.startsWith('pages/RatingSweep.tsx:'))).toBe(true)     // shorthand + local const
  })

  it('every key resolves to a root (an unreadable key fails rather than escaping the table)', () => {
    expect(UNRESOLVED).toEqual([])
  })

  it('🔴 every root is classified — a new query must decide whether a coding moves it', () => {
    expect([...FOUND.keys()].filter(r => !(r in CLASSIFICATION)).sort()).toEqual([])
  })

  it('no row outlives its query', () => {
    expect(Object.keys(CLASSIFICATION).filter(r => !FOUND.has(r)).sort()).toEqual([])
  })

  it('the derived rows ARE the helper’s list, both ways', () => {
    const helper = new Set<string>([...DERIVED_COUNT_ROOTS, ...DERIVED_METRIC_ROOTS])
    const table = Object.entries(CLASSIFICATION).filter(([, r]) => r.kind === 'derived').map(([k]) => k)
    expect(table.filter(r => !helper.has(r)).sort()).toEqual([])
    expect([...helper].filter(r => !table.includes(r)).sort()).toEqual([])
  })

  it('each local root is invalidated by every host the table names', { timeout: SOURCE_SCAN_TIMEOUT_MS }, () => {
    const missing: string[] = []
    for (const [root, row] of Object.entries(CLASSIFICATION)) {
      if (row.kind !== 'local') continue
      for (const host of row.hosts) {
        const abs = FILES.find(f => srcRel(f) === host)
        if (!abs) { missing.push(`${root}: host ${host} not found`); continue }
        if (!invalidatedRoots(readFileSync(abs, 'utf8'), abs).has(root)) missing.push(`${root}: ${host}`)
      }
    }
    expect(missing).toEqual([])
  })

  /**
   * The other half: every DOOR that writes a coding reaches the helper. A door is found by
   * what it CALLS (a coding-write API method) or MOUNTS (`<InlineCodeActions>`, whose
   * writes report through `onCodeChange`), never by page name — ReconciliationGrid's own
   * cell edit and its *Recompute consensus* named two keys and were missed that way.
   */
  const WRITE_CALL = /\b(codingApi\.(applyCode|removeCode|bulkCode|setMagnitude)|textCodingApi\.(applyCode|removeCode|bulkCode|bulkRemoveCode|setMagnitude)|codeSetsApi\.selectOn\w+|codeAnalysisApi\.recomputeConsensus|codingImportApi\.run)\(|<InlineCodeActions\b/
  const REACHES = /\b(invalidateDerivedCounts|invalidateAfterCodingImport)\(/
  /** Doors that hand the write to a caller — each must take `onCodeChange` as a prop. */
  const DELEGATES: Record<string, string> = {
    'components/qualitative-analysis/InlineCodeActions.tsx': 'reports every write through onCodeChange',
    'components/SegmentRow.tsx': 'passes the workbench’s onCodeChange through',
    'components/qualitative-analysis/QuoteCard.tsx': 'passes the page’s onCodeChange through',
    'components/qualitative-analysis/ContentByCode.tsx': 'passes the page’s onCodeChange through',
    'components/qualitative-analysis/ContentBySource.tsx': 'passes the page’s onCodeChange through',
  }
  /** Doors whose writes are not settled here, with the reason. */
  const NOT_HERE: Record<string, string> = {
    'lib/apply-undo.ts': 'the undo op table — the workbench that runs an op settles it (each importer is a door above)',
    'lib/rating-commit.ts': 'a RATING — it moves no count; the op RatingSweep runs, settled by invalidateAfterRating (the rating doors, below)',
  }

  it('🔴 every door that writes a coding reaches invalidateDerivedCounts (or says why not)', { timeout: SOURCE_SCAN_TIMEOUT_MS }, () => {
    const offenders: string[] = []
    let doors = 0
    for (const abs of FILES) {
      const rel = srcRel(abs)
      const raw = readFileSync(abs, 'utf8')
      if (!WRITE_CALL.test(raw)) continue   // cheap pre-filter: stripping every file timed out under load
      // Comments stripped (#838): a door named in a comment is not a door, nor a call to the helper.
      const text = stripComments(raw, abs)
      if (!WRITE_CALL.test(text) || rel.startsWith('lib/api/')) continue
      doors++
      if (REACHES.test(text) || rel in NOT_HERE) continue
      if (rel in DELEGATES) {
        if (!/onCodeChange\??:\s*\(\)\s*=>\s*void/.test(text)) offenders.push(`${rel}: listed as a delegate but takes no onCodeChange prop`)
        continue
      }
      offenders.push(rel)
    }
    expect(doors).toBeGreaterThanOrEqual(12)   // self-check: the scan sees the doors
    expect(offenders).toEqual([])
  })

  /**
   * #1425 — a RATING moves no count, so the door above can be satisfied by a file that
   * settles its APPLIES and leaves its ratings alone (every workbench did). A rating, or a
   * declared scale, moves the rating α, the grid, the consensus count, the queue and the
   * participant table's marker: `invalidateAfterRating`.
   */
  const RATING_WRITE = /\b(codingApi\.setMagnitude|textCodingApi\.setMagnitude|commitRating|codesApi\.setMagnitudeScale)\(/
  const RATING_REACHES = /\binvalidateAfterRating\(/
  const RATING_NOT_HERE: Record<string, string> = {
    'lib/apply-undo.ts': 'the undo of an APPLY re-rates; the host settles the op with invalidateDerivedCounts, whose roots hold every rating root but the dataset marker (#1414’s class)',
    'lib/rating-commit.ts': 'the op RatingSweep runs — RatingSweep is the door',
    'components/CodeSetStrip.tsx': 'its rating rides a code-set CHOICE, settled by invalidateDerivedCounts — every rating root but the dataset marker (#1414’s class)',
  }

  it('🔴 every door that writes a RATING or a scale reaches invalidateAfterRating (or says why not)', { timeout: SOURCE_SCAN_TIMEOUT_MS }, () => {
    const offenders: string[] = []
    let doors = 0
    for (const abs of FILES) {
      const rel = srcRel(abs)
      const raw = readFileSync(abs, 'utf8')
      if (!RATING_WRITE.test(raw) || rel.startsWith('lib/api/') || /\.test\.tsx?$/.test(rel)) continue
      const text = stripComments(raw, abs)
      if (!RATING_WRITE.test(text)) continue
      doors++
      if (RATING_REACHES.test(text) || rel in RATING_NOT_HERE) continue
      offenders.push(rel)
    }
    expect(doors).toBeGreaterThanOrEqual(9)   // four workbenches, the sweep, the scale dialog, the three above
    expect(offenders).toEqual([])
  })

  it('predicate falsifier: a new root in a plain, a shorthand and a spread key is seen', () => {
    const src = `
      const k = ['brand-new-shorthand', pid] as const
      function A() { useQuery({ queryKey: ['brand-new-root', pid], queryFn: f }) }
      function B() { const queryKey = k; useInfiniteQuery({ queryKey, queryFn: f }) }
      function C() { useQuery({ queryKey: [...CODERS_QUERY_KEY, 'x'], queryFn: f }) }
      function E() { useQuery({ queryKey: someFactory(pid), queryFn: f }) }`
    const roots = observerRoots(src, 'x.tsx').map(r => r.root)
    expect(roots).toEqual(['brand-new-root', 'brand-new-shorthand', 'coders', null])
  })
})
