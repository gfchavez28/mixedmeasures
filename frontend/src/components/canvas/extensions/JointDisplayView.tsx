/**
 * The joint display's node view — the COMPACT view (D176; mockup `3-layout-c-compact.html`):
 * a table you can scan, and a construct that opens for the writing — and its REPORT view
 * (`../joint-display/ReportView.tsx`, mockup `8-report-view.html`): layout A's shape, read only,
 * rendered from the export's own table.
 *
 * Closed, each construct is its name and fit plus one line per measure with its n; opened
 * (its name is a disclosure button) it holds the differences, quotes, fit, meta-inference and
 * implication (`../joint-display/ConstructDetail.tsx`). The numbers are LIVE
 * (`POST …/joint-display/compute`, D168) and every cell is printed by `lib/joint-display.ts`'s
 * formatters — the same ones the drift baseline projects, so what moved is what is drawn.
 *
 * What it keeps from its neighbours (this directory's the internal design notes):
 * - **#893 — read-only means no mutation control, in either door.** `editor.isEditable` (the
 *   EDITABLE fallback) gates Edit, Remove, the pin buttons and every input.
 * - **D175 — blind mode as the comparison does it**: the scope from `withholding` (fails
 *   closed, #964), in the query KEY (#454), the query waiting for `settled`.
 * - **The export's wait** (`canvas-export.ts::waitForChartsReady`): the loading line is
 *   `LoadingNotice`, whose spinner holds a capture; a failure carries no spinner.
 * - **No Retry on a canvas failure** (`list-load-state.md` §7) — the display redraws when the
 *   page is revisited; it says why it failed instead.
 * - **D176.3 — the Compact | Report choice is per person, never in the document**: kept in the
 *   browser by `displayKey` (and in `display-store` so a re-created view keeps it); switching
 *   writes nothing to the node, so it makes no undo entry and no snapshot change.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/core'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Pencil, Trash2 } from 'lucide-react'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { useAuth } from '@/lib/auth-context'
import { useBlindMode } from '@/hooks/useBlindMode'
import { useCoders, useMachineCoderIds } from '@/hooks/useCoders'
import { ScrollableTable } from '@/components/ui/ScrollableTable'
import { LoadingNotice } from '@/components/LoadStatus'
import { jointDisplayApi } from '@/lib/api'
import type {
  JointDisplayCodeStrand, JointDisplayComputeResponse, JointDisplayPinFact, JointDisplayRowResult,
  JointDisplayStrandResult, JointDisplayVariableStrand,
} from '@/lib/api'
import { NO_VALUE } from '@/lib/stat-format'
import { SELECTED_TEXT, SELECTED_TINT } from '@/lib/selection'
import {
  codeCellNote, computeRequest, displayCoderScope, formatObservationCode, formatStrandCodeCell, formatRatingCell, formatVariableCell,
  primaryFit,
  ratingCellNote, readDisplay, rowDrift, unresolvedReferenceCount, variableCellNote,
  type JointDisplay as JointDisplayModel, type JointDisplayRow,
} from '@/lib/joint-display'
import {
  CODED_COUNT_BASIS_TEXT, NOT_SUMMARISABLE_TEXT, OBSERVATION_BASIS_TEXT, OBSERVATION_LINE_TEXT, SURVEY_CELL_BASIS_TEXT, TEXT_CODES_BASIS_TEXT, RATING_BASIS_TEXT, RATING_WITHHELD_TEXT, RATED_LINE_TAG, SERVER_VOCABULARY as V, fitTerm, fitVocabulary,
  attributionUnusableNote, inactiveCodeText, notMeasuredText, otherDatasetVariablesText,
} from '@/lib/joint-display-vocabulary'
import {
  codeStrandNoCoding, groupCodingCounts, isImplicitPair, rowRatedCodes, rowStrands, type ResolvedStrand,
} from '@/lib/joint-display-strands'
import {
  buildJointDisplayReport, computeFailureText, fitText, NO_GROUPING_TEXT, unavailableGroupsText,
} from '@/lib/joint-display-report'
import { boundResultIds } from '@/lib/joint-display-results'
import ConstructDetail, { type FactsState } from '../joint-display/ConstructDetail'
import ReportView from '../joint-display/ReportView'
import { formatWrittenDate, todayIso } from '../joint-display/display-helpers'
import { registerDisplayApplier, useDisplayDialogs, useKeptState } from '../joint-display/display-store'
import { useDisplayResults, type DisplayResultsState } from '../joint-display/useDisplayResults'
import { useMisfitReads, type MisfitRead } from '../joint-display/useMisfitReads'
import { misfitReportFacts } from '@/lib/joint-display-cases'
import { useReportBreakout } from '../joint-display/useReportBreakout'
import { noCodingNote, noCodingScope, withNoCodingLabel } from '@/lib/coding-completeness'
import { withheldAttributionColumn, withheldAttributionNote } from '@/lib/blind-rating-columns'

type DisplayView = 'compact' | 'report'

/** D176.3 — remembered in the browser, keyed by the display; per viewer, never in the document. */
const viewStorageKey = (displayKey: string) => `mm-joint-display-view:${displayKey}`

function storedView(displayKey: string): DisplayView {
  try {
    return displayKey && localStorage.getItem(viewStorageKey(displayKey)) === 'report' ? 'report' : 'compact'
  } catch {
    return 'compact'
  }
}

function storeView(displayKey: string, view: DisplayView) {
  try {
    if (!displayKey) return
    if (view === 'report') localStorage.setItem(viewStorageKey(displayKey), 'report')
    else localStorage.removeItem(viewStorageKey(displayKey))
  } catch { /* a blocked store keeps the choice for the page's life only */ }
}

export default function JointDisplayView({ node, updateAttributes, deleteNode, selected, editor }: NodeViewProps) {
  const { projectId } = useProjectLayout()
  const pid = Number(projectId)
  const isEditable = editor?.isEditable ?? true
  const { user } = useAuth()
  const self = user?.id ?? null
  const { blind, withholding, settled } = useBlindMode(pid)
  const { coderMap } = useCoders()
  const machineCoderIds = useMachineCoderIds()

  const rawDisplay = node.attrs.display
  const display = useMemo(() => readDisplay(rawDisplay), [rawDisplay])
  const scope = useMemo(() => displayCoderScope(withholding, self), [withholding, self])
  const request = useMemo(() => computeRequest(display, scope), [display, scope])
  // `useBlindScope`'s rule: wait for the blind state to settle, and while withholding with no
  // viewer id never read at all — a read with no one to scope to must not run (D96).
  const scopeReady = settled && !(withholding && self == null)

  // The key IS the request, which carries the effective coder scope (#454).
  const query = useQuery({
    queryKey: ['joint-display', pid, request],
    queryFn: () => jointDisplayApi.compute(pid, request!),
    enabled: request != null && scopeReady,
    staleTime: 60_000,
  })

  const pinIds = useMemo(
    () => [...new Set(display.rows.flatMap(r => r.pins.map(p => p.excerptId)).filter((x): x is number => x != null))].sort((a, b) => a - b),
    [display.rows],
  )
  const factsQuery = useQuery({
    // #1615: the display's blind scope in the key and the request (a rating-derived attribution
    // column's value is left out while blind), and no read before blind mode settles.
    queryKey: ['joint-display-pin-facts', pid, pinIds, display.attribution.column_id, scope.coderIds?.join(',') ?? 'every-coder'],
    queryFn: () => jointDisplayApi.pinFacts(pid, {
      excerpt_ids: pinIds, column_id: display.attribution.column_id, coder_ids: scope.coderIds,
    }),
    enabled: pinIds.length > 0 && scopeReady,
    staleTime: 60_000,
  })
  const facts = useMemo(() => new Map((factsQuery.data?.pins ?? []).map(f => [f.excerpt_id, f])), [factsQuery.data])
  // #1615 D286: the attribution column's value was left out while blind — the server says so,
  // with the column's name, and the display says it (here and in the report's note).
  const attributionWithheld = withheldAttributionColumn(factsQuery.data)
  // #1653 (D346): the *Also show* variable is gone or retyped — the server still answers every
  // pin's who and where (it 404'd, and every quote's attribution read "could not be read").
  const attributionUnusable = attributionUnusableNote(factsQuery.data)
  // 🔴 An unanswered facts list is not "this quote is gone" (`list-load-state.md` §1).
  const factsState: FactsState = pinIds.length === 0 || factsQuery.data !== undefined
    ? 'ready' : factsQuery.isError ? 'failed' : 'loading'

  // 🔴 ProseMirror RE-CREATES this view whenever a modal dialog opens on the Canvas
  // (`../joint-display/display-store.ts`), so what must survive that is kept outside it: the
  // open rows and the view here, the drafts in `ConstructDetail`, the dialogs in `DisplayDialogHost`.
  const displayKey: string = node.attrs.displayKey ?? ''
  const [open, setOpen] = useKeptState<Set<string>>(`jd-open:${displayKey}`, () => new Set())
  const [view, setViewKept] = useKeptState<DisplayView>(`jd-view:${displayKey}`, () => storedView(displayKey))
  const setView = useCallback((next: DisplayView) => { setViewKept(next); storeView(displayKey, next) }, [setViewKept, displayKey])
  const openDialog = useDisplayDialogs()

  const lens = useMemo(() => ({ blind: withholding, self, machineCoderIds }), [withholding, self, machineCoderIds])
  const anyOpenBindsResult = display.rows.some(r => open.has(r.key) && r.result_material_ids.some(id => id != null))
  const results = useDisplayResults(pid, display, lens, view === 'report' || anyOpenBindsResult)
  // Joint display slice 2, round 2 (r5-8): the Report view's note counts each row's cases that
  // don't fit — one count-only read per row with a misfit, under the compute's scope.
  const noViewer = withholding && self == null
  const misfitKeys = useMemo(() => display.rows.map(r => r.key), [display.rows])
  const misfitReads = useMisfitReads(pid, display, misfitKeys, scope, settled && view === 'report', noViewer)

  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const breakout = useReportBreakout(wrapperRef, view === 'report')

  /** One transaction on the node — the editor's history undoes it. */
  const commit = useCallback((next: JointDisplayModel) => updateAttributes({ display: next }), [updateAttributes])

  // The hosted dialogs write back through THIS view while it is the live one — never through a
  // `updateAttributes` captured by a view ProseMirror has since destroyed.
  const latestDisplay = useRef(rawDisplay)
  latestDisplay.current = rawDisplay
  useEffect(() => {
    if (!isEditable || !displayKey) return
    return registerDisplayApplier(displayKey, update =>
      updateAttributes({ display: update(readDisplay(latestDisplay.current)) }))
  }, [isEditable, displayKey, updateAttributes])
  const changeRow = useCallback((key: string, patch: Partial<JointDisplayRow>) => {
    commit({ ...display, rows: display.rows.map(r => (r.key === key ? { ...r, ...patch } : r)) })
  }, [commit, display])

  const data = query.data
  // #1626 (D244): every group listed, a 0 included; null when none has one or no code row.
  // R3: one sentence per code strand when there are two or more, each over ITS own groups.
  const noCodingSentence = data
    ? codeStrandNoCoding(display, data)
        .map(n => { const t = noCodingNote(n.counts, noCodingScope(n.scope)); return t && n.tag ? `${n.tag}: ${t}` : t })
        .filter(Boolean).join(' ') || null
    : null
  const resultByKey = useMemo(() => new Map((data?.rows ?? []).map(r => [r.key, r])), [data])
  const groups = data?.groups ?? []
  const vocabulary = fitVocabulary(display.settings.fit_vocabulary)
  const title = display.title.trim() || 'Joint display'
  const missingRefs = unresolvedReferenceCount(display)
  const toggle = (key: string) => setOpen(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const allOpen = display.rows.length > 0 && display.rows.every(r => open.has(r.key))
  // A dialog is offered only where one can be hosted and the node can be written (#893).
  const canOpenDialogs = isEditable && openDialog != null && displayKey !== ''
  const coderName = useCallback((id: number) => coderMap.get(id)?.username ?? null, [coderMap])

  /** D176.6 — a construct's link in Report: back to Compact, with that construct open. */
  const openInCompact = useCallback((rowKey: string) => {
    setOpen(prev => new Set(prev).add(rowKey))
    setView('compact')
    requestAnimationFrame(() => {
      wrapperRef.current?.querySelector<HTMLButtonElement>(`[data-construct-toggle="${CSS.escape(rowKey)}"]`)?.focus()
    })
  }, [setOpen, setView])

  return (
    <NodeViewWrapper
      ref={wrapperRef}
      className={`group/material relative my-3 ${selected ? 'ring-2 ring-mm-blue/30' : ''}`}
      style={breakout}
      data-type="joint-display"
      data-display-key={node.attrs.displayKey}
      role="figure"
      aria-label={`Joint display: ${title}`}
      contentEditable={false}
    >
      <div className="bg-white dark:bg-mm-surface shadow-sm rounded-md px-4 py-3 border-l-4 border-l-mm-teal">
        <div className="flex flex-wrap items-start gap-2 mb-2">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-mm-text">{title}</p>
            <p className="text-xs text-mm-text-muted">
              Joint display · {display.rows.length} {display.rows.length === 1 ? 'construct' : 'constructs'}
              {data ? ` · by ${data.group_by.name}` : ''} · live
            </p>
          </div>
          <div className="flex items-center gap-1" onMouseDown={e => e.stopPropagation()}>
            <ViewSwitch displayKey={displayKey} value={view} onChange={setView} />
            {view === 'compact' && display.rows.length > 0 && (
              <button type="button" className="text-xs text-mm-blue-text hover:underline px-1"
                onClick={() => setOpen(allOpen ? new Set() : new Set(display.rows.map(r => r.key)))}>
                {allOpen ? 'Close all' : 'Open all'}
              </button>
            )}
            {isEditable && (
              <>
                {canOpenDialogs && (
                  <button type="button" onClick={() => openDialog({ kind: 'edit', displayKey, display })} aria-label="Edit joint display"
                    className="p-1 rounded text-mm-text-muted hover:text-mm-text hover:bg-mm-bg">
                    <Pencil className="w-3.5 h-3.5" aria-hidden />
                  </button>
                )}
                <button type="button" onClick={deleteNode} aria-label="Remove from canvas" title="Remove from canvas"
                  className="p-1 rounded text-mm-text-faint hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30">
                  <Trash2 className="w-3.5 h-3.5" aria-hidden />
                </button>
              </>
            )}
          </div>
        </div>

        {blind && (
          <p className="mb-2 text-xs text-mm-text-secondary">
            Blind mode: coding counts are yours only. Colleagues’ names are hidden.
          </p>
        )}
        {missingRefs > 0 && (
          <p role="note" className="mb-2 text-xs text-mm-orange-text">
            {missingRefs} {missingRefs === 1 ? 'reference' : 'references'} in this display did not travel with the
            project and {missingRefs === 1 ? 'is' : 'are'} shown as missing.
          </p>
        )}
        {attributionWithheld && view === 'compact' && (
          <p className="mb-2 text-xs text-mm-text-secondary" data-testid="jd-attribution-withheld">
            {withheldAttributionNote(attributionWithheld)}
          </p>
        )}
        {attributionUnusable && view === 'compact' && (
          <p role="note" className="mb-2 text-xs text-mm-orange-text" data-testid="jd-attribution-unusable">
            {attributionUnusable}
          </p>
        )}

        {view === 'report' ? (
          <ReportBody
            display={display}
            request={request != null}
            settled={scopeReady}
            status={query.status}
            error={query.error}
            data={data}
            factsState={factsState}
            facts={facts}
            attributionWithheld={attributionWithheld}
            attributionUnusable={attributionUnusable}
            misfitReads={misfitReads}
            results={results}
            ctx={{ coderName, withholding, self, asOf: formatWrittenDate(todayIso()) }}
            isEditable={isEditable}
            onOpenConstruct={openInCompact}
          />
        ) : (
          <>
            <DisplayBody
              display={display}
              request={request != null}
              settled={scopeReady}
              status={query.status}
              isFetching={query.isFetching}
              error={query.error}
              data={data}
              resultByKey={resultByKey}
              results={results}
              open={open}
              onToggle={toggle}
              fitLabel={(row, result) => (isImplicitPair(display)
                ? fitTerm(vocabulary, primaryFit(row))?.label ?? null : fitText(display, row, result))}
              renderDetail={(row, result, id) => (
                <ConstructDetail
                  key={row.key}
                  id={id}
                  display={display}
                  row={row}
                  result={result}
                  groups={groups}
                  strandFacts={data?.strands}
                  isEditable={isEditable}
                  self={self}
                  withholding={withholding}
                  authorName={(uid) => coderMap.get(uid)?.username ?? null}
                  facts={facts}
                  factsState={factsState}
                  results={results}
                  draftKey={`jd-draft:${displayKey}:${row.key}`}
                  onChange={patch => changeRow(row.key, patch)}
                  cases={{ projectId: pid, scope, settled, noViewer, groupBy: data?.group_by.name ?? 'The group' }}
                  // r5-2: the case view is a dialog hosted by the page (D213), like the pin picker.
                  onCasesRequest={canOpenDialogs && request ? () => openDialog({
                    kind: 'cases', displayKey, display, rowKey: row.key,
                    groupBy: data?.group_by.name ?? 'The group', scope, noViewer,
                  }) : null}
                  onPinRequest={canOpenDialogs ? (group => openDialog({
                    kind: 'pin', displayKey, display, rowKey: row.key, construct: row.construct, group,
                    // Joint display slice 2 (r2-5): every code strand's codes, each with ITS strand —
                    // a quote is chosen from that strand's own sources.
                    // R9: a survey comments strand's codes too — its quotes are answers (r4-1).
                    codes: rowStrands(display, result).flatMap(rs => rs.result && (rs.strand.kind === 'codes' || rs.strand.kind === 'text_codes')
                      ? rs.result.codes.map(s => (isImplicitPair(display)
                          ? { id: s.code_id, name: s.name }   // a slice-1 display asks as it did
                          : { id: s.code_id, name: `${s.name} · ${rs.tag}`, strandKey: rs.strand.key }))
                      : []),
                    scope,
                    pinnedExcerptIds: row.pins.filter(p => p.group === group).map(p => p.excerptId).filter((x): x is number => x != null),
                  })) : null}
                />
              )}
            />

            {data && !data.unavailable_reason && (
              <p className="mt-2 text-[11px] leading-snug text-mm-text-muted">
                {/* r2-11 (r4's found-beside #4): the report note's own sentences, from the vocabulary. */}
                {CODED_COUNT_BASIS_TEXT} {SURVEY_CELL_BASIS_TEXT}
                {display.strands.some(s => s.kind === 'text_codes') ? ` ${TEXT_CODES_BASIS_TEXT}` : ''}
                {display.strands.some(s => s.kind === 'observation_codes') ? ` ${OBSERVATION_BASIS_TEXT}` : ''}
                {data.rating ? ` ${RATING_BASIS_TEXT}` : ''} Fit: {vocabulary.citation}
                {data.scope.participants_without_group > 0 &&
                  ` ${data.scope.participants_without_group} ${data.scope.participants_without_group === 1 ? 'participant has' : 'participants have'} no ${data.group_by.name} and ${data.scope.participants_without_group === 1 ? 'is' : 'are'} in no group.`}
                {/* #1626 (D244): who has no coding in scope, and what it does to a share. */}
                {noCodingSentence && ` ${noCodingSentence}`}
              </p>
            )}
          </>
        )}
      </div>

    </NodeViewWrapper>
  )
}

/**
 * Compact | Report (D176.1) — a radio group named "View" (D176's build note), not tabs: it
 * switches how ONE display is drawn, there is no tab panel. Native radios, so the arrow keys,
 * the group's single Tab stop and the checked state are the browser's.
 */
function ViewSwitch({ displayKey, value, onChange }: { displayKey: string; value: DisplayView; onChange: (v: DisplayView) => void }) {
  const name = `jd-view-${displayKey || 'display'}`
  return (
    <fieldset className="inline-flex rounded-md border border-mm-border-medium bg-mm-bg p-0.5 text-xs">
      <legend className="sr-only">View</legend>
      {(['compact', 'report'] as const).map(v => (
        <label
          key={v}
          className={`relative cursor-pointer rounded px-2 py-0.5 font-medium has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-mm-blue ${
            value === v ? `${SELECTED_TINT} ${SELECTED_TEXT}` : 'text-mm-text-muted hover:text-mm-text-secondary'
          }`}
        >
          <input type="radio" className="sr-only" name={name} value={v} checked={value === v} onChange={() => onChange(v)} />
          {v === 'compact' ? 'Compact' : 'Report'}
        </label>
      ))}
    </fieldset>
  )
}

/** The Report view's states: the compute's, then the pins' facts and the saved results'. */
function ReportBody({
  display, request, settled, status, error, data, factsState, facts, attributionWithheld, attributionUnusable, misfitReads, results, ctx, isEditable, onOpenConstruct,
}: {
  display: JointDisplayModel
  request: boolean
  settled: boolean
  status: 'pending' | 'error' | 'success'
  error: unknown
  data: JointDisplayComputeResponse | undefined
  factsState: FactsState
  facts: Map<number, JointDisplayPinFact>
  attributionWithheld: string | null
  attributionUnusable: string | null
  misfitReads: Map<string, MisfitRead>
  results: DisplayResultsState
  ctx: Parameters<typeof buildJointDisplayReport>[1]
  isEditable: boolean
  onOpenConstruct: (rowKey: string) => void
}) {
  const waiting = request && (!settled || (data === undefined && status !== 'error'))
  const tablesLoading = [...results.tables.values()].some(s => s === 'loading')
  const misfitsLoading = [...misfitReads.values()].some(r => r.status === 'loading' || r.status === 'idle')
  if (waiting || factsState === 'loading' || results.status === 'loading' || tablesLoading || misfitsLoading) {
    return <LoadingNotice label="Preparing the report…" size="panel" />
  }
  const unavailable = !request ? NO_GROUPING_TEXT
    : data === undefined ? computeFailureText(error) : null
  const report = buildJointDisplayReport({
    display,
    data: data ?? null,
    unavailable,
    facts: factsState === 'failed' ? null : facts,
    attributionWithheld: factsState === 'failed' ? null : attributionWithheld,
    attributionUnusable: factsState === 'failed' ? null : attributionUnusable,
    results: results.results,
    resultsUnread: results.status === 'failed',
    // r5-8: a failed or unmade count (D96) is 'unread' — the note says so, and guesses nothing.
    misfits: new Map([...misfitReads].map(([k, r]) => [k, r.status === 'ready'
      ? misfitReportFacts(r.data, (display.rows.find(x => x.key === k)?.misfit?.rule?.conditions.length ?? 0) > 0)
      : 'unread' as const])),
  }, ctx)
  const resultByKey = new Map((data?.rows ?? []).map(r => [r.key, r]))
  const drifted = display.rows
    .filter(r => { const res = resultByKey.get(r.key); return res != null && rowDrift(r.baseline, res).length > 0 })
    .map(r => r.construct.trim() || 'Untitled construct')
  return <ReportView report={report} drifted={drifted} isEditable={isEditable} onOpenConstruct={onOpenConstruct} />
}

function DisplayBody({
  display, request, settled, status, isFetching, error, data, resultByKey, results, open, onToggle, fitLabel, renderDetail,
}: {
  display: JointDisplayModel
  request: boolean
  settled: boolean
  status: 'pending' | 'error' | 'success'
  isFetching: boolean
  error: unknown
  data: JointDisplayComputeResponse | undefined
  resultByKey: Map<string, JointDisplayRowResult>
  results: DisplayResultsState
  open: Set<string>
  onToggle: (key: string) => void
  /** The Fit column: slice 1's label, or each pair's fit WITH its pair (`fitText`, the report's words). */
  fitLabel: (row: JointDisplayRow, result: JointDisplayRowResult | null) => string | null
  renderDetail: (row: JointDisplayRow, result: JointDisplayRowResult | null, id: string) => React.ReactNode
}) {
  if (!request) {
    return <p className="text-sm text-mm-text-muted">{NO_GROUPING_TEXT}</p>
  }
  // The disabled case first (`list-load-state.md` §1): waiting for blind mode to settle is a wait.
  if (!settled || (data === undefined && status !== 'error')) {
    return <LoadingNotice label="Computing the joint display…" size="panel" />
  }
  if (data === undefined) {
    return (
      <p role="alert" className="text-sm text-mm-text">{computeFailureText(error)}</p>
    )
  }
  if (data.unavailable_reason) {
    return <p className="text-sm text-mm-text-muted">{unavailableGroupsText(data)}</p>
  }
  const groups = data.groups
  const span = groups.length + 2
  // A tab stop of its own, so the arrow keys scroll a display wider than the column: its cells are
  // text, and the arrows scroll nothing from a focused construct button (driven 2026-11-12f).
  return (
    <ScrollableTable aria-busy={isFetching || undefined} tabIndex={0} role="region"
      aria-label={`Compact table: ${display.title.trim() || 'Joint display'}`}>
      <table className="w-full text-[12.5px] border-collapse">
        <caption className="sr-only">
          {display.title.trim() || 'Joint display'}: each construct’s measures by {data.group_by.name}, with the fit recorded for it
        </caption>
        <thead>
          <tr className="border-b border-mm-border-medium bg-mm-surface-hover text-left text-[11.5px] text-mm-text-secondary">
            <th scope="col" className="px-2.5 py-2 font-semibold">Construct · measure</th>
            {groups.map(g => (
              <th key={g.key} scope="col" className="px-2.5 py-2 font-semibold">
                {g.key} <span className="font-normal text-mm-text-muted">· {g.participants}{groupCodingCounts(display, data, g.key)
                  // R3 (r2's found-beside 2): each code strand's own "with no coding", named when there are two or more.
                  .map(c => (withNoCodingLabel(c.withoutCoding) ? ` · ${c.tag ? `${c.tag}: ` : ''}${withNoCodingLabel(c.withoutCoding)}` : '')).join('')}</span>
              </th>
            ))}
            <th scope="col" className="px-2.5 py-2 font-semibold">Fit</th>
          </tr>
        </thead>
        {display.rows.map(row => {
          const result = resultByKey.get(row.key) ?? null
          const isOpen = open.has(row.key)
          const detailId = `jd-${row.key}-detail`
          const moved = result != null && rowDrift(row.baseline, result).length > 0
          return (
            <tbody key={row.key} className="border-t border-mm-border-subtle first:border-t-0">
              <tr className={isOpen ? 'bg-mm-surface-hover' : undefined}>
                <th scope="row" colSpan={groups.length + 1} className="px-2.5 pt-2.5 pb-1 text-left font-semibold text-[13px] text-mm-text">
                  <button type="button" aria-expanded={isOpen} aria-controls={detailId} data-construct-toggle={row.key}
                    onClick={() => onToggle(row.key)} className="inline-flex items-center gap-1.5 hover:underline text-left">
                    {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-mm-text-muted" aria-hidden /> : <ChevronRight className="w-3.5 h-3.5 text-mm-text-muted" aria-hidden />}
                    {row.construct || 'Untitled construct'}
                  </button>
                  {moved && (
                    <span className="ml-2 inline-flex items-center gap-1 text-[11px] font-normal text-mm-orange-text">
                      <span aria-hidden className="inline-block w-1.5 h-1.5 rounded-full bg-mm-orange" />numbers moved
                    </span>
                  )}
                </th>
                <td className="px-2.5 pt-2.5 pb-1 text-mm-text">{fitLabel(row, result) ?? <span className="text-mm-text-muted">{NO_VALUE}</span>}</td>
              </tr>
              {result ? <MeasureRows display={display} row={row} result={result} strandFacts={data.strands} groups={groups.map(g => g.key)} results={results} /> : (
                <tr><td colSpan={span} className="px-2.5 pl-8 pb-2 text-mm-text-muted">Not computed yet.</td></tr>
              )}
              {isOpen && (
                <tr>
                  <td colSpan={span} className="px-3.5 pl-8 pb-3 bg-mm-surface-hover">
                    {renderDetail(row, result, detailId)}
                  </td>
                </tr>
              )}
            </tbody>
          )
        })}
      </table>
    </ScrollableTable>
  )
}

function Cell({ text, note }: { text: string; note: string | null }) {
  return (
    <td className="px-2.5 py-0.5 align-top text-mm-text" title={note ?? undefined}>
      {text}
      {note && <span className="sr-only"> — {note}</span>}
    </td>
  )
}

function StrandLabel({ kind, name, formed }: { kind: string; name: string; formed: string | null }) {
  return (
    <th scope="row" className="px-2.5 pl-8 py-0.5 text-left font-normal text-mm-text-secondary">
      <span className="mr-1 text-[10.5px] font-semibold uppercase tracking-wide text-mm-text-muted">{kind}</span>
      {name}
      {formed && (
        <span className="ml-1.5 rounded px-1 text-[10.5px] text-mm-orange-text ring-1 ring-inset ring-mm-orange/40 whitespace-nowrap">
          formed the groups
        </span>
      )}
    </th>
  )
}

/**
 * A construct's measure lines. Joint display slice 2 (r2-2, r2-6): each strand's lines in display
 * order, PER-GROUP strands first and then those BESIDE the groups (an observation strand — one
 * line across the group columns, never split by group, D165), then the saved results.
 */
function MeasureRows({ display, row, result, strandFacts, groups, results }: {
  display: JointDisplayModel; row: JointDisplayRow; result: JointDisplayRowResult
  strandFacts: JointDisplayStrandResult[] | undefined; groups: string[]; results: DisplayResultsState
}) {
  const span = groups.length + 1
  const rows: React.ReactNode[] = []
  const strands = rowStrands(display, result, strandFacts)
  const drawStrand = (rs: ResolvedStrand) => {
    const k = rs.strand.key
    if (rs.notMeasured) {
      // #1659: the server's reason — "no code bound" was printed for every case, above the line
      // naming the bound code that was deleted or merged away.
      rows.push(<tr key={`${k}-none`}><td colSpan={span + 1} className="px-2.5 pl-8 py-0.5 text-mm-text-muted">
        <span className="mr-1 text-[10.5px] font-semibold uppercase tracking-wide">{rs.tag}</span>{notMeasuredText(rs.notMeasuredReason, rs.strand.kind)}
      </td></tr>)
      return
    }
    const sr = rs.result
    if (!sr) return
    const kind = rs.strand.kind
    if (kind === 'variables') {
      for (const s of sr.variables) rows.push(<VariableLine key={`${k}-v${s.column_id}`} tag={rs.tag} strand={s} groups={groups} />)
    } else if (kind === 'codes' || kind === 'text_codes') {
      // r2-12: a survey comments cell carries its group's surveyed count (the strand's facts).
      const surveyed = (g: string) => rs.facts?.groups?.find(x => x.key === g)?.surveyed
      for (const s of sr.codes) rows.push(...codeLines(s, groups, rs.tag, k, kind, surveyed))
    } else {
      for (const c of sr.observation_codes) {
        rows.push(
          <tr key={`${k}-o${c.code_id}`}>
            <StrandLabel kind={rs.tag} name={c.name} formed={null} />
            <td colSpan={groups.length} className="px-2.5 py-0.5 align-top text-mm-text-secondary">
              {formatObservationCode(c)} · {OBSERVATION_LINE_TEXT}
            </td>
            <td />
          </tr>,
        )
      }
    }
  }
  for (const rs of strands.filter(x => x.placement === 'per_group')) drawStrand(rs)
  // #1645 — a rated code ONCE, after the per-group strands and under no strand's name: the score
  // is the person's, over every rated passage in the project, so the same under every strand.
  for (const s of rowRatedCodes(strands)) rows.push(ratedLine(s, groups))
  for (const rs of strands.filter(x => x.placement === 'beside')) drawStrand(rs)
  // D165 — a saved result at another unit: ONE line across the group columns, never per group.
  boundResultIds(row.result_material_ids).forEach((id, i) => {
    rows.push(<ResultLine key={`r${id ?? `gone-${i}`}`} id={id} groups={groups} results={results}
      formed={row.results_marked_formed} />)
  })
  const missing = result.missing_code_ids.length + result.missing_column_ids.length
  if (missing > 0) {
    rows.push(<tr key="missing"><td colSpan={span + 1} className="px-2.5 pl-8 py-0.5 text-mm-orange-text">
      {missing} bound {missing === 1 ? 'item is' : 'items are'} no longer in this project.
    </td></tr>)
  }
  // #1665 (D336): a variable of another dataset than its strand reads is IN the project — said
  // apart, never under "no longer in this project".
  const otherDataset = (result.other_dataset_column_ids ?? []).length
  if (otherDataset > 0) {
    rows.push(<tr key="other-dataset"><td colSpan={span + 1} className="px-2.5 pl-8 py-0.5 text-mm-orange-text">
      {otherDatasetVariablesText(otherDataset)}
    </td></tr>)
  }
  // #1639 follow-up (r1-8): a bound code the codebook made inactive — out of the numbers, said.
  for (const c of result.inactive_codes ?? []) {
    rows.push(<tr key={`inactive-${c.strand_key}-${c.code_id}`}><td colSpan={span + 1} className="px-2.5 pl-8 py-0.5 text-mm-orange-text">
      {inactiveCodeText(c)}
    </td></tr>)
  }
  return <>{rows}</>
}

function ResultLine({ id, groups, results, formed }: {
  id: number | null; groups: string[]; results: DisplayResultsState; formed: boolean
}) {
  const r = id != null ? results.results.get(id) : undefined
  let name = 'A saved result'
  let text: string
  if (id == null) text = 'did not travel with the project'
  else if (results.status === 'loading') text = 'loading…'
  else if (results.status === 'failed') text = 'could not be read just now'
  else if (!r) text = 'no longer in this project'
  else if (r.unit == null) { name = r.name; text = 'cannot stand beside a construct here' }
  else { name = r.name; text = `${r.unit} · drawn once across the groups, not split by group` }
  return (
    <tr>
      <StrandLabel kind="Other unit" name={name} formed={formed && r?.unit != null ? 'marked' : null} />
      <td colSpan={groups.length} className="px-2.5 py-0.5 align-top text-mm-text-secondary">{text}</td>
      <td />
    </tr>
  )
}

function VariableLine({ tag, strand, groups }: { tag: string; strand: JointDisplayVariableStrand; groups: string[] }) {
  const byGroup = new Map(strand.cells.map(c => [c.group, c]))
  if (strand.summary == null || strand.summary === V.VARIABLE_NOT_SUMMARISABLE) {
    // #1615: a rating-derived variable while blind says so, never "open text or an identifier".
    const why = strand.unavailable_reason === V.VARIABLE_RATING_WITHHELD ? RATING_WITHHELD_TEXT : NOT_SUMMARISABLE_TEXT
    return (
      <tr>
        <StrandLabel kind={tag} name={strand.name} formed={strand.formed_groups} />
        <td colSpan={groups.length + 1} className="px-2.5 py-0.5 text-mm-text-muted">{why}</td>
      </tr>
    )
  }
  return (
    <tr>
      <StrandLabel kind={tag} name={strand.name} formed={strand.formed_groups} />
      {groups.map(g => {
        const c = byGroup.get(g)
        return c ? <Cell key={g} text={formatVariableCell(strand, c)} note={variableCellNote(c)} /> : <Cell key={g} text={NO_VALUE} note={null} />
      })}
      <td />
    </tr>
  )
}

function codeLines(
  strand: JointDisplayCodeStrand, groups: string[], tag: string, strandKey: string,
  kind: 'codes' | 'text_codes' = 'codes', surveyed?: (group: string) => number | null | undefined,
): React.ReactNode[] {
  const byGroup = new Map(strand.cells.map(c => [c.group, c]))
  return [
    <tr key={`${strandKey}-c${strand.code_id}`}>
      <StrandLabel kind={tag} name={strand.name} formed={strand.formed_groups} />
      {groups.map(g => {
        const c = byGroup.get(g)
        return c ? <Cell key={g} text={formatStrandCodeCell(kind, c, surveyed?.(g))} note={codeCellNote(c)} /> : <Cell key={g} text={NO_VALUE} note={null} />
      })}
      <td />
    </tr>,
  ]
}

/** #1645 — a rated code's line, drawn once per construct (`rowRatedCodes`), named by no strand. */
function ratedLine(strand: JointDisplayCodeStrand, groups: string[]): React.ReactNode {
  const byGroup = new Map(strand.cells.map(c => [c.group, c]))
  return (
    <tr key={`rated-${strand.code_id}`}>
      <StrandLabel kind={RATED_LINE_TAG} name={strand.name} formed={null} />
      {groups.map(g => {
        const c = byGroup.get(g)
        return c ? <Cell key={g} text={formatRatingCell(c) ?? NO_VALUE} note={ratingCellNote(c)} /> : <Cell key={g} text={NO_VALUE} note={null} />
      })}
      <td />
    </tr>
  )
}
