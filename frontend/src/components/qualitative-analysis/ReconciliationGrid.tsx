import { memo, useCallback, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useNavigate } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { TriangleAlert, Check, RotateCw, Clock, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import SegmentedControl from '@/components/ui/segmented-control'
import { ScrollableTable } from '@/components/ui/ScrollableTable'
import CodeChip from './CodeChip'
import InlineCodeActions from './InlineCodeActions'
import ReconciliationSourcePicker from './ReconciliationSourcePicker'
import {
  sourceParams, sourceQueryKey, type ReconciliationSource,
} from '@/lib/reconciliation-source'
import { useCoderSwitch } from '@/hooks/useCoderSwitch'
import { codeAnalysisApi, type Code, type ReconciliationUnit, type ReconciliationCodeInfo } from '@/lib/api'
import { cn, formatTimecode } from '@/lib/utils'
import { formatMagnitude } from '@/lib/magnitude'

const RENDER_CAP = 200 // matches the backend limit; disagreements-first keeps the set small

/**
 * #35 — a unit needs review for EITHER fact: the coders applied different codes,
 * or they agreed on a code and rated it more than one step apart. The two ride
 * the payload separately so the row can say which; every "needs review" gate in
 * this grid (the filter's counterpart, j/k, the badge) reads THIS predicate.
 */
const needsReview = (u: ReconciliationUnit): boolean =>
  u.has_disagreement || !!u.has_rating_disagreement || !!u.has_merge_conflict

interface ReconciliationGridProps {
  projectId: number
  /** Full code list — InlineCodeActions needs whole Code objects for the own cell. */
  codes: Code[]
  /** Active coder id (the only editable column). */
  currentUserId: number | null
  /** Pending staleness markers (drives the "saved layer is behind" note). */
  staleCount: number
  setSrAnnouncement: (s: string) => void
}

export default function ReconciliationGrid({
  projectId, codes, currentUserId, staleCount, setSrAnnouncement,
}: ReconciliationGridProps) {
  const queryClient = useQueryClient()
  const [disagreementsOnly, setDisagreementsOnly] = useState(true)
  const [source, setSource] = useState<ReconciliationSource | null>(null)
  const [focus, setFocus] = useState<{ r: number; c: number }>({ r: 0, c: 0 })
  const gridRef = useRef<HTMLDivElement>(null)

  // Key and params come from ONE pure pair so they cannot drift: the slot held a
  // literal `null` while the endpoint had accepted source_type/source_id all
  // along, so narrowing would have served the previous source's page from cache.
  const { data, isLoading } = useQuery({
    queryKey: ['reconciliation', projectId, sourceQueryKey(source), disagreementsOnly],
    queryFn: () => codeAnalysisApi.reconciliation(projectId, {
      disagreements_only: disagreementsOnly,
      limit: RENDER_CAP,
      ...sourceParams(source),
    }),
    enabled: !!projectId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })

  const recomputeMutation = useMutation({
    mutationFn: () => codeAnalysisApi.recomputeConsensus(projectId),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['reconciliation', projectId] })
      queryClient.invalidateQueries({ queryKey: ['consensus-status', projectId] })
      toast(res.recomputed > 0 ? `Recomputed ${res.recomputed} consensus target${res.recomputed === 1 ? '' : 's'}` : 'Consensus already up to date')
    },
    onError: () => toast.error('Could not recompute consensus'),
  })

  const onCodeChange = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['reconciliation', projectId] })
    queryClient.invalidateQueries({ queryKey: ['consensus-status', projectId] })
  }, [queryClient, projectId])

  // #471(b): chips pivot to where the coding lives. The unit carries source_type/source_id
  // + unit_id, so we deep-link to the workbench with ?segment= (the established QuoteCard
  // pattern) — no backend change. Dataset-value units have no segment workbench to jump to.
  const navigate = useNavigate()
  const pendingNavRef = useRef<string | null>(null)
  const { requestSwitch, dialog: coderSwitchDialog } = useCoderSwitch({
    onSwitched: () => {
      const r = pendingNavRef.current
      pendingNavRef.current = null
      if (r) navigate(r)
    },
  })
  const routeForUnit = useCallback((unit: ReconciliationUnit): string | null => {
    if (unit.source_type === 'conversation') return `/projects/${projectId}/conversations/${unit.source_id}?segment=${unit.unit_id}`
    if (unit.source_type === 'document') return `/projects/${projectId}/documents/${unit.source_id}?segment=${unit.unit_id}`
    // The observation workbench's deep-link param is `?clip=`, NOT `?segment=`.
    // Without this arm a clip row's jump affordance is dead, and `fixColleague`
    // is worse than dead: it switches the active coder and then navigates nowhere.
    if (unit.source_type === 'observation') return `/projects/${projectId}/observations/${unit.source_id}?clip=${unit.unit_id}`
    return null
  }, [projectId])
  // Consensus / read-only jump: go straight to the source segment (no identity change).
  const jumpToUnit = useCallback((unit: ReconciliationUnit) => {
    const r = routeForUnit(unit)
    if (r) navigate(r)
  }, [routeForUnit, navigate])
  // #471(d) "edit-own + jump-out": to fix a colleague's coding, confirm-switch to them
  // first (preserves attribution — you then code AS them at the segment), then jump.
  const fixColleague = useCallback((coder: { id: number; name: string }, unit: ReconciliationUnit) => {
    pendingNavRef.current = routeForUnit(unit)
    requestSwitch({ id: coder.id, username: coder.name })
  }, [routeForUnit, requestSwitch])

  const codeMap = useMemo(() => new Map(codes.map(c => [c.id, c])), [codes])
  const legendMap = useMemo(
    () => new Map((data?.codes ?? []).map(c => [c.id, c])),
    [data?.codes],
  )
  const coders = useMemo(() => data?.coders ?? [], [data?.coders])
  const units = useMemo(() => data?.units ?? [], [data?.units])
  const totalCols = coders.length + 2 // rowheader + N coders + consensus

  // Clamp the roving focus to current bounds AT RENDER (no setState-in-effect) so a
  // shrinking unit set (disagreements toggle / refetch) can't strand the tabbable cell.
  const safeFocus = {
    r: units.length ? Math.min(focus.r, units.length - 1) : 0,
    c: Math.min(focus.c, totalCols - 1),
  }

  const focusCell = useCallback((r: number, c: number) => {
    setFocus({ r, c })
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`)
    el?.focus()
  }, [])

  // 2-D roving-tabindex keyboard layer (no shared helper exists — useListKeyboardNav is 1-D).
  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    // A Radix popover (the own-cell add-code) portals OUT of the grid; while it's
    // open, let it own the keyboard.
    if (document.querySelector('[data-radix-popper-content-wrapper]')) return
    const target = e.target as HTMLElement
    // Accept keys from the cell OR any control inside it. After the add-code popover
    // closes, Radix returns focus to the Add button (a cell descendant) — exact
    // 'data-cell' matching would strand arrow-nav until the user tabbed away (A11y-1).
    if (!target?.closest?.('[data-cell="true"]')) return
    const rows = units.length
    if (!rows) return
    const r = Math.min(focus.r, rows - 1)
    const c = Math.min(focus.c, totalCols - 1)
    let nr = r, nc = c
    switch (e.key) {
      case 'ArrowDown': nr = Math.min(r + 1, rows - 1); break
      case 'ArrowUp': nr = Math.max(r - 1, 0); break
      case 'ArrowRight': nc = Math.min(c + 1, totalCols - 1); break
      case 'ArrowLeft': nc = Math.max(c - 1, 0); break
      case 'Home': if (e.ctrlKey) { nr = 0 } nc = 0; break
      case 'End': if (e.ctrlKey) { nr = rows - 1 } nc = totalCols - 1; break
      case 'j': case 'J': {
        const next = units.findIndex((u, i) => i > r && needsReview(u))
        if (next >= 0) { nr = next; setSrAnnouncement('Next disagreement') }
        break
      }
      case 'k': case 'K': {
        for (let i = r - 1; i >= 0; i--) { if (needsReview(units[i])) { nr = i; setSrAnnouncement('Previous disagreement'); break } }
        break
      }
      case 'Enter': case ' ': {
        // Open the own-cell add-code popover — but ONLY when the cell itself is
        // focused. If a control inside the cell (the Add/Remove button) already has
        // focus, let its native activation run, to avoid a double-toggle (A11y-1).
        if (target.getAttribute('data-cell') === 'true') {
          const addBtn = gridRef.current?.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"] [aria-label="Add code"]`)
          if (addBtn) { e.preventDefault(); addBtn.click() }
        }
        return
      }
      default: return
    }
    e.preventDefault()
    focusCell(nr, nc)
  }, [focus, units, totalCols, focusCell, setSrAnnouncement])

  // Bounded tracks: the grid fills its container (w-full below) and `fr` distributes the
  // REAL free space. We must not size to max-content (`min-w-max`) — the Unit cell's
  // unwrapped text would set the scale and the fr ratio would inflate every coder column
  // to ~1000px of whitespace (#442).
  const cols = `minmax(240px, 2fr) repeat(${coders.length}, minmax(150px, 1fr)) minmax(160px, 1fr)`

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-mm-text-muted py-16 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
        <span>Loading reconciliation…</span>
      </div>
    )
  }

  if (!data?.available) {
    return (
      <div className="text-center py-16">
        <p className="text-mm-text-muted">{data?.reason || 'Reconciliation is unavailable for this project.'}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          options={[
            { value: 'dis', label: 'Needs review' },
            { value: 'all', label: 'All units' },
          ]}
          value={disagreementsOnly ? 'dis' : 'all'}
          onChange={(v) => { setDisagreementsOnly(v === 'dis'); setSrAnnouncement(v === 'dis' ? 'Showing units that need review' : 'Showing all units') }}
          ariaLabel="Which units to show"
          idPrefix="recon-filter"
        />
        <ReconciliationSourcePicker
          projectId={projectId}
          value={source}
          onChange={(s) => {
            setSource(s)
            setSrAnnouncement(s ? 'Narrowed to one source' : 'Showing all sources')
          }}
        />
        <div className="flex-1" />
        {staleCount > 0 && (
          <span className="inline-flex items-center gap-1 text-xs text-mm-text-muted" title="The saved Consensus layer used by the other Analysis tabs is behind the latest coding. The grid below is always live.">
            <Clock className="w-3.5 h-3.5" aria-hidden="true" />
            Saved consensus is {staleCount} update{staleCount === 1 ? '' : 's'} behind
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => recomputeMutation.mutate()}
          disabled={recomputeMutation.isPending}
          title="Sync the stored consensus layer (used by the other Analysis tabs) with the latest coding"
        >
          {recomputeMutation.isPending
            ? <Loader2 className="w-3 h-3 mr-1 animate-spin" aria-hidden="true" />
            : <RotateCw className="w-3 h-3 mr-1" aria-hidden="true" />}
          Recompute consensus
        </Button>
      </div>

      {units.length === 0 ? (
        <div className="text-center py-16">
          <Check className="w-8 h-8 mx-auto text-emerald-500 mb-2" aria-hidden="true" />
          <p className="text-mm-text-muted">
            {disagreementsOnly ? 'All units have consensus — nothing to review.' : 'No coded units to show.'}
          </p>
        </div>
      ) : (
        <>
          <ScrollableTable maxHeight="calc(100vh - 320px)" className="rounded-md border border-mm-surface-border bg-mm-surface">
            <div
              ref={gridRef}
              role="grid"
              aria-label="Coder reconciliation"
              aria-rowcount={units.length + 1}
              aria-colcount={totalCols}
              onKeyDown={onKeyDown}
              style={{ '--recon-cols': cols } as React.CSSProperties}
              className="w-full text-sm"
            >
              {/* Header row */}
              <div role="row" className="grid sticky top-0 z-20 bg-mm-surface border-b" style={{ gridTemplateColumns: cols }}>
                <div role="columnheader" className="sticky left-0 z-30 bg-mm-surface px-3 py-2 font-medium text-mm-text-muted border-r">Unit</div>
                {coders.map(c => {
                  const isOwnCol = currentUserId != null && c.id === currentUserId
                  return (
                    // #472: coder header cells need an OPAQUE bg of their own — they paint
                    // above the scrolling data cells (inside the z-20 header row) but, being
                    // transparent, let cell chips show through as you scroll (the Unit and
                    // Consensus headers already carry a bg).
                    // #471(c): mark the active coder's own (editable) column so it's obvious
                    // which column you edit. Keep the bg OPAQUE (no alpha tint — that would
                    // re-open the #472 bleed); signal via blue accent text + inset underline
                    // + a "(you)" label (dual-encoded, never colour alone).
                    <div
                      role="columnheader"
                      key={c.id}
                      className={cn(
                        'px-3 py-2 font-medium truncate border-r bg-mm-surface',
                        isOwnCol
                          ? 'text-mm-blue-text font-semibold shadow-[inset_0_-2px_0_0_hsl(var(--mm-blue))]'
                          : 'text-mm-text',
                      )}
                      title={isOwnCol ? `${c.name} (you) — your editable column` : c.name}
                    >
                      {c.name}{isOwnCol && <span className="ml-1 text-[10px] font-normal opacity-80">(you)</span>}
                    </div>
                  )
                })}
                <div role="columnheader" className="sticky right-0 z-30 bg-emerald-100 dark:bg-emerald-900 border-l-2 border-primary px-3 py-2 font-medium text-primary">Consensus</div>
              </div>

              {units.map((unit, rowIndex) => (
                <ReconciliationRow
                  key={`${unit.unit_type}:${unit.unit_id}`}
                  unit={unit}
                  rowIndex={rowIndex}
                  coders={coders}
                  currentUserId={currentUserId}
                  focusedCol={safeFocus.r === rowIndex ? safeFocus.c : null}
                  legendMap={legendMap}
                  codeMap={codeMap}
                  allCodes={codes}
                  projectId={projectId}
                  onCodeChange={onCodeChange}
                  onFocusCell={focusCell}
                  onJumpToUnit={jumpToUnit}
                  onFixColleague={fixColleague}
                />
              ))}
            </div>
          </ScrollableTable>

          <div className="flex flex-col gap-1 text-xs text-mm-text-faint">
            <p>
              {data.has_more
                ? `Showing the first ${units.length} of ${data.total} units — narrow by keeping “Needs review” on.`
                : `${units.length} unit${units.length === 1 ? '' : 's'}.`}
              {' '}Arrow keys move; Enter edits your own cell; j / k jump between flagged units.
            </p>
            <p>
              <span className="underline decoration-dotted decoration-mm-text-faint underline-offset-2">blank (reviewed)</span>
              {' '}= the coder coded this source but not this unit (a real disagreement);{' '}
              <span className="italic">— not reviewed</span> = the coder didn’t code this source (excluded from reliability).
            </p>
            {/* #35 — the rating half, said once. The consensus rating is a MEDIAN,
                not a vote, and the flag's rule is the researcher's own step. */}
            <p>
              A code with a declared rating scale shows each coder’s rating on its chip. The consensus
              rating is the median of the ratings given; <span className="italic">differ by</span> marks
              ratings more than one step of the scale apart — codes can agree while ratings do not.
            </p>
          </div>
        </>
      )}
      {coderSwitchDialog}
    </div>
  )
}

// ── Row ───────────────────────────────────────────────────────────────────────

interface ReconciliationRowProps {
  unit: ReconciliationUnit
  rowIndex: number
  coders: { id: number; name: string }[]
  currentUserId: number | null
  focusedCol: number | null
  legendMap: Map<number, ReconciliationCodeInfo>
  codeMap: Map<number, Code>
  allCodes: Code[]
  projectId: number
  onCodeChange: () => void
  onFocusCell: (r: number, c: number) => void
  onJumpToUnit: (unit: ReconciliationUnit) => void
  onFixColleague: (coder: { id: number; name: string }, unit: ReconciliationUnit) => void
}

const ReconciliationRow = memo(function ReconciliationRow({
  unit, rowIndex, coders, currentUserId, focusedCol, legendMap, codeMap, allCodes, projectId, onCodeChange, onFocusCell, onJumpToUnit, onFixColleague,
}: ReconciliationRowProps) {
  const consensusSet = useMemo(() => new Set(unit.consensus), [unit.consensus])
  const engaged = useMemo(() => new Set(unit.engaged), [unit.engaged])
  const cols = coders.length + 2

  // A clip's identity is its TIME RANGE: `text` holds only its label, which is
  // routinely empty, so the range is the primary line and the label secondary.
  const isClip = unit.source_type === 'observation'
  const timeRange = isClip && unit.start_time != null && unit.end_time != null
    ? `${formatTimecode(unit.start_time)} – ${formatTimecode(unit.end_time)}`
    : null
  const unitWord = isClip ? 'Clip' : unit.unit_type === 'segment' ? 'Segment' : 'Response'
  // #35 — "ratings differ" is a distinct state from "codes differ": the coders
  // agreed the code applies and disagreed on how much. It gets its own words
  // (badge AND spoken label) so the reviewer knows which conversation to have.
  const ratingsOnly = !unit.has_disagreement && !!unit.has_rating_disagreement
  // And a THIRD state (#35): a merge found a different rating in a coder's own
  // copy. The project's rating was kept; rating it again settles it.
  const mergeOnly = !unit.has_disagreement && !unit.has_rating_disagreement && !!unit.has_merge_conflict
  const reviewWord = unit.has_disagreement
    ? 'needs review'
    : ratingsOnly
      ? 'needs review, ratings differ'
      : mergeOnly
        ? 'needs review, a merge left a rating difference'
        : 'agreement'
  const rowheaderLabel = `${unitWord} · ${unit.source_label}: ${timeRange ?? unit.text.slice(0, 80)} · ${reviewWord}`

  return (
    <div role="row" className="grid border-b last:border-b-0 hover:bg-mm-surface-hover/40" style={{ gridTemplateColumns: 'var(--recon-cols)' }}>
      {/* Row header: the unit text + source + agree/disagree (dual-encoded). */}
      <div
        role="rowheader"
        data-cell="true"
        data-r={rowIndex}
        data-c={0}
        tabIndex={focusedCol === 0 ? 0 : -1}
        onFocus={() => onFocusCell(rowIndex, 0)}
        aria-label={rowheaderLabel}
        className="sticky left-0 z-10 bg-mm-surface px-3 py-2 border-r focus:outline-2 focus:outline-mm-accent"
      >
        <div className="flex items-center gap-1.5 mb-1">
          {unit.has_disagreement
            ? <span
                className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                title="Flagged for review: the coders who engaged this source applied different codes here — including a coder who coded elsewhere in this source but left this unit blank. The unit may still have a majority consensus."
              ><TriangleAlert className="w-3 h-3" aria-hidden="true" />Needs review</span>
            : ratingsOnly
              ? <span
                  className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                  title="Flagged for review: the coders agree on the codes, but their ratings on at least one of them differ by more than one step of its scale."
                ><TriangleAlert className="w-3 h-3" aria-hidden="true" />Ratings differ</span>
              : mergeOnly
                ? <span
                    className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                    title="Flagged for review: a merge found a different rating in a coder's own copy of this coding. This project's rating was kept; rating it again settles the difference."
                  ><TriangleAlert className="w-3 h-3" aria-hidden="true" />Merge difference</span>
                : <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"><Check className="w-3 h-3" aria-hidden="true" />Agree</span>}
          <span className="text-[10px] text-mm-text-faint truncate" title={unit.source_label}>{unit.source_label}</span>
        </div>
        {timeRange ? (
          <>
            <p className="text-xs font-mono tabular-nums text-mm-text-secondary">{timeRange}</p>
            {/* No "(no text)" fallback for a clip: an unlabelled clip is normal,
                not a defect, and the range above already identifies it. */}
            {unit.text && (
              <p className="text-xs text-mm-text-faint line-clamp-2 mt-0.5" title={unit.text}>{unit.text}</p>
            )}
          </>
        ) : (
          <p className="text-xs text-mm-text-secondary line-clamp-3" title={unit.text || undefined}>{unit.text || <span className="italic text-mm-text-faint">(no text)</span>}</p>
        )}
      </div>

      {/* One cell per coder. */}
      {coders.map((coder, i) => {
        const colIndex = i + 1
        const isOwn = currentUserId != null && coder.id === currentUserId
        const codeIds = unit.by_coder[String(coder.id)] ?? []
        return (
          <ReconciliationCell
            key={coder.id}
            rowIndex={rowIndex}
            colIndex={colIndex}
            tabbable={focusedCol === colIndex}
            onFocusCell={onFocusCell}
            kind={isOwn ? 'own' : 'coder'}
            coder={coder}
            coderName={coder.name}
            reviewed={engaged.has(coder.id)}
            codeIds={codeIds}
            ratings={unit.ratings_by_coder?.[String(coder.id)]}
            conflicts={unit.rating_conflicts_by_coder?.[String(coder.id)]}
            consensusSet={consensusSet}
            legendMap={legendMap}
            // own-cell editing:
            projectId={projectId}
            unit={unit}
            codeMap={codeMap}
            allCodes={allCodes}
            onCodeChange={onCodeChange}
            // #471(b) colleague-cell chip → switch + jump:
            onFixColleague={onFixColleague}
          />
        )
      })}

      {/* Consensus column. */}
      <ReconciliationCell
        rowIndex={rowIndex}
        colIndex={cols - 1}
        tabbable={focusedCol === cols - 1}
        onFocusCell={onFocusCell}
        kind="consensus"
        codeIds={unit.consensus}
        consensusSet={consensusSet}
        consensusContext={unit.consensus_context}
        legendMap={legendMap}
        // #471(b) consensus chip → jump to the source segment (read-only, no switch):
        unit={unit}
        onJumpToUnit={onJumpToUnit}
      />
    </div>
  )
})

// ── Cell ────────────────────────────────────────────────────────────────────

interface ReconciliationCellProps {
  rowIndex: number
  colIndex: number
  tabbable: boolean
  onFocusCell: (r: number, c: number) => void
  kind: 'own' | 'coder' | 'consensus'
  coder?: { id: number; name: string }
  coderName?: string
  reviewed?: boolean
  codeIds: number[]
  /** #35 — this coder's ratings here, `codeId → rating`; absent = no rating known. */
  ratings?: Record<string, number>
  /** #35 — `codeId → the rating a merged copy carried`; absent = no unresolved conflict. */
  conflicts?: Record<string, number>
  consensusSet: Set<number>
  consensusContext?: ReconciliationUnit['consensus_context']
  legendMap: Map<number, ReconciliationCodeInfo>
  // own-cell only:
  projectId?: number
  unit?: ReconciliationUnit
  codeMap?: Map<number, Code>
  allCodes?: Code[]
  onCodeChange?: () => void
  // #471(b) chip navigation:
  onJumpToUnit?: (unit: ReconciliationUnit) => void
  onFixColleague?: (coder: { id: number; name: string }, unit: ReconciliationUnit) => void
}

const ReconciliationCell = memo(function ReconciliationCell(props: ReconciliationCellProps) {
  const { rowIndex, colIndex, tabbable, onFocusCell, kind, coderName, reviewed, codeIds, ratings, conflicts, consensusSet, consensusContext, legendMap } = props

  const codeName = (id: number) => legendMap.get(id)?.name ?? `#${id}`
  // #35 — `!= null`, never truthiness: a rating of 0 is a rating.
  const ratingOf = (id: number): number | null => {
    const v = ratings?.[String(id)]
    return v != null ? v : null
  }
  const conflictOf = (id: number): number | null => {
    const v = conflicts?.[String(id)]
    return v != null ? v : null
  }
  const withRating = (id: number): string => {
    const v = ratingOf(id)
    const c = conflictOf(id)
    const base = v != null ? `${codeName(id)} rated ${formatMagnitude(v)}` : codeName(id)
    return c != null ? `${base}, a merged copy rated it ${formatMagnitude(c)}` : base
  }

  // #471(b): a chip jumps to where its coding lives. Consensus → read-only jump; a
  // colleague's cell → confirm-switch to them then jump (the #471(d) fix-a-colleague
  // path). Own-cell chips are inline-editable (InlineCodeActions), so they don't navigate.
  const chipClick =
    kind === 'consensus' && props.unit && props.onJumpToUnit
      ? () => props.onJumpToUnit!(props.unit!)
      : kind === 'coder' && props.coder && props.unit && props.onFixColleague
        ? () => props.onFixColleague!(props.coder!, props.unit!)
        : undefined

  let ariaLabel: string
  if (kind === 'consensus') {
    if (codeIds.length === 0) ariaLabel = 'Consensus: none'
    else ariaLabel = `Consensus: ${codeIds.map(id => {
      const ctx = consensusContext?.[String(id)]
      if (!ctx) return codeName(id)
      // #35 — the rating consensus rides the same sentence: the median, how
      // many rated, and whether they differ by more than a step.
      const m = ctx.magnitude
      const rating = m
        ? `, rated ${formatMagnitude(m.median)} by ${m.n_rated}${m.flag ? `, ratings differ by ${formatMagnitude(m.spread)}` : ''}`
        : ''
      return `${codeName(id)} (${ctx.rule}, ${ctx.agree} of ${ctx.voters}${rating})`
    }).join(', ')}`
  } else if (codeIds.length > 0) {
    const diverging = codeIds.some(id => !consensusSet.has(id))
    ariaLabel = `${coderName}: ${codeIds.map(withRating).join(', ')}${diverging ? ' · differs from consensus' : ''}`
  } else {
    ariaLabel = `${coderName}: ${reviewed ? 'blank (reviewed)' : 'not reviewed'}`
  }

  return (
    <div
      role="gridcell"
      data-cell="true"
      data-r={rowIndex}
      data-c={colIndex}
      tabIndex={tabbable ? 0 : -1}
      onFocus={() => onFocusCell(rowIndex, colIndex)}
      aria-label={ariaLabel}
      className={cn(
        'px-3 py-2 border-r last:border-r-0 focus:outline-2 focus:outline-mm-accent align-top min-w-0 overflow-hidden',
        // Consensus is the at-a-glance target — pinned to the right so it stays visible when
        // many coders force horizontal scroll (#442), and tinted mint (matching the merge
        // Review) when an agreed code exists, neutral when there's none — a dual-encoded
        // signal alongside the rule badge / "No consensus" text. Sticky cells need OPAQUE
        // backgrounds, so both mint and white are solid (no alpha bleed-through).
        kind === 'consensus' && cn(
          'sticky right-0 z-10 border-l-2 border-primary',
          codeIds.length > 0 ? 'bg-emerald-50 dark:bg-emerald-950' : 'bg-mm-surface',
        ),
      )}
    >
      {kind === 'own' && props.projectId != null && props.unit && props.codeMap && props.allCodes && props.onCodeChange ? (
        <InlineCodeActions
          projectId={props.projectId}
          itemType={props.unit.unit_type === 'segment' ? 'segment' : 'text'}
          itemId={props.unit.unit_id}
          appliedCodeIds={codeIds}
          // #35 — per-application details so the own cell's chips show YOUR
          // ratings. Bare ids take the "unknown, not unrated" branch, which
          // renders no rating UI at all — correct where ratings are unknown,
          // and wrong here, where the payload carries them.
          appliedCodeDetails={codeIds.map(id => ({
            code_id: id, user_id: props.coder?.id ?? null,
            magnitude: ratingOf(id), magnitude_conflict: conflictOf(id),
          }))}
          codeMap={props.codeMap}
          allCodes={props.allCodes}
          onCodeChange={props.onCodeChange}
          // #475: the grid's roving-tabindex focus churn would otherwise dismiss the
          // add-code popover the instant it opens (open→focus-outside→close loop).
          keepOpenOnFocusOutside
        />
      ) : codeIds.length > 0 ? (
        <div className="flex flex-col items-start gap-1 min-w-0">
          {codeIds.map(id => {
            const info = legendMap.get(id)
            if (!info) return null
            const diverging = kind !== 'consensus' && !consensusSet.has(id)
            const ctx = kind === 'consensus' ? consensusContext?.[String(id)] : undefined
            // #35 — the chip carries the rating against the code's declared
            // scale (the legend's, single-sourced on the wire): a coder's own in
            // a coder cell, the MEDIAN in the consensus cell. No scale, no
            // rating UI — a bare number is not a rating.
            const scale = info.scale ?? null
            const magnitude = kind === 'consensus' ? (ctx?.magnitude?.median ?? null) : ratingOf(id)
            return (
              <span
                key={id}
                className={cn('inline-flex items-center gap-0.5 rounded-full max-w-full min-w-0', diverging && 'ring-1 ring-amber-500/70')}
              >
                <CodeChip
                  code={info} size="xs" truncate onClick={chipClick}
                  magnitude={magnitude} scale={scale}
                  magnitudeConflict={kind === 'consensus' ? null : conflictOf(id)}
                />
                {ctx && (
                  <span
                    className="text-[9px] text-mm-text-faint shrink-0"
                    title={ctx.rule === 'unanimous' ? `All ${ctx.voters} coders agreed` : `${ctx.agree} of ${ctx.voters} coders (majority)`}
                  >
                    {ctx.rule === 'unanimous' ? '✓' : `${ctx.agree}/${ctx.voters}`}
                  </span>
                )}
                {ctx?.magnitude?.flag && (
                  // The spread in the scale's own units, dual-encoded (icon +
                  // words); the rule rides the title so the mark explains itself.
                  <span
                    className="inline-flex items-center gap-0.5 text-[9px] font-medium text-amber-600 dark:text-amber-400 shrink-0"
                    title={`Ratings differ by ${formatMagnitude(ctx.magnitude.spread)} — more than one step (${formatMagnitude(ctx.magnitude.step)}) of the scale. The consensus rating is the median of ${ctx.magnitude.n_rated}.`}
                  >
                    <TriangleAlert className="w-3 h-3" aria-hidden="true" />
                    differ by {formatMagnitude(ctx.magnitude.spread)}
                  </span>
                )}
              </span>
            )
          })}
        </div>
      ) : kind === 'consensus' ? (
        <span className="text-xs italic text-mm-text-faint">No consensus</span>
      ) : reviewed ? (
        // #477: "blank (reviewed)" = the coder coded elsewhere in this source but left
        // THIS unit blank — a deliberate non-code (a real 0 / genuine disagreement).
        // Dual-encoded (dotted underline + distinct label, never color alone) so it reads
        // apart from "not reviewed" at a glance.
        <span
          className="text-xs italic text-mm-text-muted underline decoration-dotted decoration-mm-text-faint underline-offset-2"
          title="Coded elsewhere in this source but left this unit blank — a deliberate non-code (counts as a real disagreement, and a 0 for reliability)."
        >
          blank (reviewed)
        </span>
      ) : (
        <span
          className="text-xs italic text-mm-text-faint"
          title="Did not code this source at all — not counted toward this unit's reliability."
        >
          — not reviewed
        </span>
      )}
    </div>
  )
})
