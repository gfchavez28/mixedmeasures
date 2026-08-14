/**
 * The Observation workbench — segmentation AND coding surface (slabs 3–4).
 *
 * Segmentation (slab 3): the toolbar (picker, rename, undo/redo,
 * split-at-playhead + merge-selection, the freeze/unfreeze flow on the
 * single-sourced source-kind copy); the ClipTimeline (I/O/P marking, pointer
 * boundary drag, drag-create — its visual layer is aria-hidden, every gesture
 * keyboard-reachable); coalesced arrow nudges + the TimecodeField precise
 * path, announced via aria-live; and the clip list as the ACCESSIBLE surface —
 * the #436/#484 listbox pattern (module-scope Virtuoso components, container
 * tabIndex + aria-activedescendant, rows as options — NEVER roving tabindex).
 * Every clip mutation rides useHistory; annotated deletes confirm-first, OFF
 * the stack. D22: while frozen, clip-SET affordances disable (never hide) and
 * label edits stay live — annotation, not segmentation.
 *
 * Coding (slab 4): the w-80 rail (CodePanel / ObservationNotesPanel /
 * MemoPanel, whole-column collapsible) + chips on clip rows through the
 * blind-lens chokepoints (widget PRESENCE keys on VISIBLE rows — a raw
 * details.length gate would leak colleague activity); code chords (multi-clip
 * = ONE bulk_code call, D23); the D14/D27 Follow toggle (all clips under the
 * playhead select together, a gap honestly empties, chords freeze the follow
 * selection); D28 category lanes (membership through the same blind lens);
 * the ?clip= deep-link (D26).
 *
 * Coverage (slab 6a): the toolbar gauge is CLIENT-computed and freeze-branched
 * (OPEN = % of timeline covered by the union of visible-coded clips · FROZEN =
 * N-of-M, honest because the freeze fixed M before any coding), on
 * `effectiveHidden` and never `chipHidden` (#451 — a gauge counts an archived
 * coder's work, only chips hide it); `u` jumps to whatever that number says is
 * missing and announces it; the density strip lives in the ClipTimeline header.
 * The extent law (D34) is the ruler's chain MINUS its 60 s display floor —
 * a display floor in a denominator deflates coverage on short recordings.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { forwardRef, useImperativeHandle } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Virtuoso, type Components, type VirtuosoHandle } from 'react-virtuoso'
import { toast } from 'sonner'
import {
  Check, ChevronLeft, ChevronRight, Combine, LocateFixed, Lock, LockOpen,
  NotebookPen, PanelRightClose, PanelRightOpen, Pencil, Quote, Redo2, Scissors,
  Search, StickyNote, Tags, Trash2, Undo2, X,
} from 'lucide-react'

import {
  categoriesApi, codesApi, codingApi, excerptsApi, notesApi, observationsApi,
  type Code, type Observation, type ObservationNote, type ObservationSegment,
} from '@/lib/api'
import FloatingCreateCode from '@/components/FloatingCreateCode'
import FloatingCreateNote from '@/components/FloatingCreateNote'
import { coordsFromElement, selectionPrefill, type FloatingCoords } from '@/lib/floating-utils'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { useAuth } from '@/lib/auth-context'
import { usePlayback } from '@/hooks/usePlayback'
import {
  armMark, buildLanes, clampBoundary, commitMark, coveredSeconds, deepLinkSeekTarget,
  gapsInExtent, laneCodeIds, MAX_CLIP_FILL_BANDS, nextGapStart, pointMark, unionIntervals,
  type ArmedMark, type Interval,
} from '@/lib/clip-timeline'
import { findClipsAtTime, recordingEndsAtTimelineTime } from '@/lib/playback-utils'
import ClipTimeline, { type BoundaryPreview } from '@/components/observations/ClipTimeline'
import { useHistory } from '@/hooks/useHistory'
import { useSegmentSelection } from '@/hooks/useSegmentSelection'
import { useCodeChordShortcuts, type UseCodeChordShortcutsResult } from '@/hooks/useCodeChordShortcuts'
import { useCodeShortcutLabels } from '@/hooks/useCodeShortcutLabels'
import { useCollapsibleColumn } from '@/hooks/useCollapsibleColumn'
import { useCoders } from '@/hooks/useCoders'
import { useBlindMode } from '@/hooks/useBlindMode'
import { useCoderCoverage } from '@/hooks/useCoderCoverage'
import { invalidateDerivedCounts } from '@/lib/coding-cache'
import { optionPositionAria } from '@/lib/listbox-aria'
import { collectBulkOutcome, describeBulkFailure } from '@/lib/bulk-code-result'
import {
  computeCoverage, distinctVisibleCodeIds, isCodeAppliedByActiveCoder,
  isSegmentCodedVisible, visibleCodeChipRows,
} from '@/lib/coding-progress'
import { mergeArchivedIntoCoderMap, chipHiddenWithArchived } from '@/lib/coder-color'
import {
  FREEZE_BEFORE_YOU_DISTRIBUTE,
  FROZEN_CONSEQUENCES,
  UNFREEZE_CONSEQUENCES,
} from '@/lib/source-kind-copy'
import { NOW_PLAYING_ROW, SELECTED_ROW } from '@/lib/selection'
import { useScrollbarGutter } from '@/hooks/useScrollbarGutter'
import { clipContainsRange, isQuoteExcerpt, isWholeExcerpt } from '@/lib/excerpt-shape'
import { cn, formatTimecode, formatTimestamp, getCodeColor, parseTimecode } from '@/lib/utils'
import { MODE_DISABLED_CLASS, modeDisabledProps } from '@/lib/mode-disabled'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import CollapsiblePanel from '@/components/CollapsiblePanel'
import { PageErrorBoundary } from '@/components/PageErrorBoundary'
import CodePanel, { type CodePanelHandle } from '@/components/CodePanel'
import MemoPanel, { type MemoPanelHandle } from '@/components/MemoPanel'
import BlindModeToggle from '@/components/BlindModeToggle'
import CoderCountBadge from '@/components/CoderCountBadge'
import CoderFilterPopover from '@/components/CoderFilterPopover'
import InlineCodeActions from '@/components/qualitative-analysis/InlineCodeActions'
import VideoPane, { type VideoPaneHandle } from '@/components/VideoPane'

// ── The clip listbox (the #436/#484 pattern, verbatim) ──────────────────────
//
// Module-scope components: stable identity → Virtuoso never remounts them. The
// container carries the listbox role + tabIndex + aria-activedescendant (real
// focus stays on the never-unmounting container and survives row recycling);
// the active id is threaded via Virtuoso `context`. Rows are options; the Item
// wrapper is presentational and discards item/context so they don't leak onto
// the DOM.

interface ClipListContext {
  activeDescendantId?: string
}

/**
 * #754 — why the segmentation controls are off while the cut set is frozen.
 *
 * One string, completing a control's accessible name ("Split clip at playhead —
 * unavailable while the clip set is frozen") and serving as the sighted
 * tooltip, so the two cannot say different things. D22: a freeze locks the clip
 * SET; labelling and quoting stay legal, which is why this names three
 * operations and not "editing".
 */
const FROZEN_OPS_REASON = 'unavailable while the clip set is frozen'
const FROZEN_BADGE_LABEL =
  'Segmentation frozen — the team has agreed these clips. '
  + 'Splitting, merging and deleting clips are unavailable until it is unfrozen.'

const clipListComponents: Components<ObservationSegment, ClipListContext> = {
  List: forwardRef<HTMLDivElement, { style?: CSSProperties; children?: ReactNode; context?: ClipListContext }>(
    function ClipList({ style, children, context }, ref) {
      return (
        <div
          ref={ref}
          style={style}
          role="listbox"
          aria-multiselectable="true"
          aria-label="Clips"
          tabIndex={0}
          aria-activedescendant={context?.activeDescendantId}
        >
          {children}
        </div>
      )
    },
  ),
  Item: function ClipItem({ children, item: _item, context: _context, ...props }) {
    return <div {...props} role="presentation">{children}</div>
  },
}

/** The clip's time cell: range + duration, or a point-event marker (D7). */
function clipTimeLabel(clip: ObservationSegment): { range: string; duration: string } {
  if (clip.start_time === clip.end_time) {
    return { range: formatTimecode(clip.start_time), duration: 'point' }
  }
  return {
    range: `${formatTimecode(clip.start_time)}–${formatTimecode(clip.end_time)}`,
    duration: formatTimecode(clip.end_time - clip.start_time),
  }
}

/**
 * What a clip deletion costs, as a sentence (#619).
 *
 * Built as a CLAUSE LIST rather than the nested-ternary template it replaces:
 * that template assumed at least one of codes/notes was non-empty, so once
 * quotes joined the annotated gate a quote-only clip rendered the literal
 * string "Its . This can’t be undone." — the copy has to name whatever
 * actually made the clip annotated, in any combination.
 */
function describeClipDeletion(clip: ObservationSegment, quoted: boolean): string {
  const clauses: string[] = []
  if (clip.applied_code_details.length > 0) clauses.push('its codes are removed')
  if (quoted) clauses.push('its quote is deleted')
  if (clip.attached_notes.length > 0) clauses.push('its notes detach to the observation')
  if (clauses.length === 0) return 'This can’t be undone.'
  const list = clauses.length === 1
    ? clauses[0]
    : `${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1]}`
  return `${list.charAt(0).toUpperCase()}${list.slice(1)}. This can’t be undone.`
}

/**
 * One timecode text input (slab 3d): the precise, accessible boundary-editing
 * path (parseTimecode accepts 225 / 3:45 / 3:45.2 / 1:03:45.2). Reseeds from
 * the committed value via the render-time reset pattern; Escape reverts.
 */
function TimecodeField({ label, value, onCommit }: {
  label: string
  value: number
  onCommit: (v: number) => void
}) {
  const [text, setText] = useState(formatTimecode(value))
  const [seed, setSeed] = useState(value)
  if (seed !== value) {
    setSeed(value)
    setText(formatTimecode(value))
  }
  const commit = () => {
    const parsed = parseTimecode(text)
    if (parsed === null) {
      setText(formatTimecode(value)) // invalid entry reverts, never guesses
      return
    }
    onCommit(parsed)
  }
  return (
    <Input
      value={text}
      onChange={e => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur() }
        if (e.key === 'Escape') setText(formatTimecode(value))
      }}
      aria-label={label}
      className="h-6 w-24 text-xs tabular-nums"
    />
  )
}

export default function ObservationWorkbench() {
  const { projectId, openKeyboardHelp } = useProjectLayout()
  const { observationId: observationIdParam } = useParams()
  const observationId = Number(observationIdParam)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // ── Coder lens (Track J · J1/J2-5) — the TranscriptPanel/DocumentSegmentRow
  // threading, verbatim (slab 4d). Blind mode forces hidden = all-but-self;
  // archived-who-coded fold into the CHIP map + default-hidden (#451).
  const { coders, coderMap, multiCoder } = useCoders()
  const { user } = useAuth()
  const selfId = user?.id ?? null
  const [hiddenCoders, setHiddenCoders] = useState<Set<number>>(new Set())
  const [showArchivedCoders, setShowArchivedCoders] = useState(false)
  const { blind, blindHiddenSet, toggleReveal } = useBlindMode(projectId)
  const effectiveHidden = blind ? blindHiddenSet : hiddenCoders
  const coderCoverage = useCoderCoverage(
    projectId, { observationId }, { enabled: multiCoder, rosterCoderIds: coders.map(c => c.id) },
  )
  const archivedCoderIds = useMemo(
    () => new Set(coderCoverage.extraCoders.map(c => c.id)),
    [coderCoverage.extraCoders],
  )
  const chipCoderMap = useMemo(
    () => (multiCoder && coderMap ? mergeArchivedIntoCoderMap(coderMap, coderCoverage.extraCoders) : undefined),
    [multiCoder, coderMap, coderCoverage.extraCoders],
  )
  const chipHidden = useMemo(
    () => chipHiddenWithArchived(effectiveHidden, archivedCoderIds, showArchivedCoders),
    [effectiveHidden, archivedCoderIds, showArchivedCoders],
  )

  // The breadcrumb (ProjectLayout) reads EXACTLY this key to resolve the name.
  const { data: observation } = useQuery({
    queryKey: ['observation', projectId, observationId],
    queryFn: () => observationsApi.get(projectId, observationId),
    enabled: Number.isFinite(observationId),
  })

  const { data: clips = [] } = useQuery({
    queryKey: ['observation-segments', projectId, observationId],
    queryFn: () => observationsApi.listSegments(projectId, observationId),
    enabled: Number.isFinite(observationId),
  })

  // Prev/next across the project's observations (list order = the list page's).
  const { data: siblings = [] } = useQuery({
    queryKey: ['observations', projectId],
    queryFn: () => observationsApi.list(projectId),
  })

  const { data: codesData } = useQuery({
    queryKey: ['codes', projectId],
    queryFn: () => codesApi.list(projectId),
    enabled: Number.isFinite(projectId),
  })
  const codes = useMemo(() => codesData?.codes ?? [], [codesData?.codes])
  const codeMap = useMemo(() => {
    const map = new Map<number, Code>()
    codes.forEach(c => map.set(c.id, c))
    return map
  }, [codes])
  // The keystroke that fires each code, for the #654 menu — the same map
  // SegmentRow and the document workbench show, and single-sourced with the
  // chord resolver so a label and the key it advertises cannot disagree.
  const codeIdToShortcutLabel = useCodeShortcutLabels(codes)
  // Real categories, for the `c` dialog's picker. Distinct from
  // `chordCategories` below, which is a {id,name} projection off the CODES list
  // for CodePanel's chord header and carries no colour or display_order.
  const { data: categoriesData } = useQuery({
    queryKey: ['categories', projectId],
    queryFn: () => categoriesApi.list(projectId),
    enabled: Number.isFinite(projectId),
  })
  const categories = useMemo(() => categoriesData?.categories ?? [], [categoriesData?.categories])

  // Category list for CodePanel's chord-label header (doc-workbench pattern).
  const chordCategories = useMemo(() => {
    const catMap = new Map<number, { id: number; name: string; parent_id?: number | null }>()
    codes.forEach(c => {
      if (c.category_id && !catMap.has(c.category_id)) {
        catMap.set(c.category_id, { id: c.category_id, name: c.category_name ?? '', parent_id: null })
      }
    })
    return Array.from(catMap.values())
  }, [codes])

  // Observation notes (slab 4a wire): observation-level + clip-anchored.
  const { data: obsNotes = [] } = useQuery({
    queryKey: ['observation-notes', projectId, observationId],
    queryFn: () => notesApi.listForObservation(projectId, observationId),
    enabled: Number.isFinite(observationId),
  })

  // Whole-clip excerpt state (D24): the clip payload carries no excerpt info, so
  // the quoted indicator + the `s` toggle read the project excerpt list.
  const { data: excerptsData } = useQuery({
    queryKey: ['excerpts', projectId],
    queryFn: () => excerptsApi.list(projectId),
    enabled: Number.isFinite(projectId),
  })

  const [selectedClips, setSelectedClips] = useState<number[]>([])
  const [searchText, setSearchText] = useState('')
  const [editingClipId, setEditingClipId] = useState<number | null>(null)
  const [editingLabel, setEditingLabel] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameText, setRenameText] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<ObservationSegment | null>(null)
  const [createCodeDialog, setCreateCodeDialog] = useState<
    { position: FloatingCoords; clipIds: number[]; initialName?: string } | null
  >(null)
  const [createNoteDialog, setCreateNoteDialog] = useState<
    { position: FloatingCoords; clipId: number | undefined } | null
  >(null)
  const [createNotePending, setCreateNotePending] = useState(false)
  const [freezeDialogOpen, setFreezeDialogOpen] = useState(false)
  const [unfreezeDialogOpen, setUnfreezeDialogOpen] = useState(false)
  // Slab 5b/D30: the precise + accessible quote path. Entity-keyed open, the
  // deleteTarget pattern; the draft is separate state because TimecodeField
  // commits per-field and the CONTAINMENT rule spans both fields.
  const [quoteTarget, setQuoteTarget] = useState<ObservationSegment | null>(null)
  const [quoteDraft, setQuoteDraft] = useState<{ start: number; end: number }>({ start: 0, end: 0 })
  // ── Slab 3d: marking + boundary editing ──
  const [armedInTime, setArmedInTime] = useState<ArmedMark>(null)
  const [boundaryPreview, setBoundaryPreview] = useState<BoundaryPreview | null>(null)
  const [announceText, setAnnounceText] = useState('')
  const [elementDuration, setElementDuration] = useState<number | null>(null)
  // ── Slab 4e: Follow (D14/D27) — playback drives the selection, opt-in ──
  const [followOn, setFollowOn] = useState(false)
  // ── Slab 4d: the coding rail ──
  const rightColumn = useCollapsibleColumn('observation')
  const [panelStates, setPanelStates] = useState({
    codes: { collapsed: false },
    notes: { collapsed: true },
    memos: { collapsed: true },
  })
  const [focusedPanel, setFocusedPanel] = useState<'list' | 'codes' | 'notes' | 'memos'>('list')
  const [noteInput, setNoteInput] = useState('')
  const [createMemoForCode, setCreateMemoForCode] = useState<{ id: number; name: string } | null>(null)

  const history = useHistory()
  const mediaElementRef = useRef<HTMLMediaElement | null>(null)
  const videoPaneHandleRef = useRef<VideoPaneHandle | null>(null)
  const virtuosoRef = useRef<VirtuosoHandle | null>(null)
  // #741: the header sits outside the scroller, so it pads by the scrollbar's
  // real width or every trailing column drifts right of the column it names.
  const clipGutter = useScrollbarGutter()
  const codePanelRef = useRef<CodePanelHandle | null>(null)
  const memoPanelRef = useRef<MemoPanelHandle | null>(null)
  const notesPanelRef = useRef<ObservationNotesPanelHandle | null>(null)

  const filteredClips = useMemo(() => {
    const q = searchText.trim().toLowerCase()
    if (!q) return clips
    return clips.filter(c => c.text.toLowerCase().includes(q))
  }, [clips, searchText])

  const clipMap = useMemo(() => {
    const map = new Map<number, ObservationSegment>()
    clips.forEach(c => map.set(c.id, c))
    return map
  }, [clips])

  // TWO derived quote sets, deliberately (slab 5b, D30) — a single set cannot
  // answer both questions once sub-clip time ranges exist:
  //
  //   wholeQuoted — shape-EXACT. Drives the `s` toggle's state and, load-bearing,
  //                 which excerpt an unquote DELETES. A time excerpt must never
  //                 land here: before the shape helper this memo's bare
  //                 `start_offset === null` reported a sub-clip quote as THE
  //                 whole-clip quote, and the unquote path then deleted it.
  //   anyQuoted   — shape-AGNOSTIC (whole OR time). Drives the row's quoted
  //                 state and the #619 delete gate: a clip quoted only by a
  //                 sub-range IS quoted in the researcher's sense.
  //
  // Sets, not maps — the excerpt id was never read (both directions re-resolve
  // from a fresh list at run time, since ids change across delete/recreate).
  const { wholeQuoted, anyQuoted } = useMemo(() => {
    const whole = new Set<number>()
    const any = new Set<number>()
    for (const e of excerptsData?.excerpts ?? []) {
      if (e.segment_id == null || !clipMap.has(e.segment_id)) continue
      if (isWholeExcerpt(e)) whole.add(e.segment_id)
      if (isQuoteExcerpt(e)) any.add(e.segment_id)
    }
    return { wholeQuoted: whole, anyQuoted: any }
  }, [excerptsData, clipMap])

  /**
   * How many quotes sit on a set of clips (#621) — for the aria-live line the
   * time ops announce.
   *
   * Deliberately counts the INPUT rather than predicting the outcome: the
   * placement rule (whole → both halves · time-range → the containing half · a
   * straddling range → divided at the cut) lives in
   * `segment_operations._clip_excerpt_carry_plan` and must not be mirrored
   * here. A client copy of that arithmetic is the #578/#600 drift shape — the
   * two would agree right up until one of them changed.
   */
  const quoteCountOn = useCallback((clipIds: number[]) => {
    const ids = new Set(clipIds)
    return (excerptsData?.excerpts ?? []).filter(
      e => e.segment_id != null && ids.has(e.segment_id) && isQuoteExcerpt(e),
    ).length
  }, [excerptsData])

  // Tri-state per code for CodePanel — the ACTIVE coder's own layer (INV-6/#446).
  const selectedCodesMap = useMemo(() => {
    const map = new Map<number, 'all' | 'some' | 'none'>()
    if (selectedClips.length === 0) return map
    codes.forEach(code => {
      const statuses = selectedClips.map(clipId => {
        const clip = clipMap.get(clipId)
        return clip?.applied_code_details.some(
          d => d.code_id === code.id && (selfId == null || d.user_id === selfId),
        ) ?? false
      })
      const allHave = statuses.every(Boolean)
      const someHave = statuses.some(Boolean)
      map.set(code.id, allHave ? 'all' : someHave ? 'some' : 'none')
    })
    return map
  }, [selectedClips, clipMap, codes, selfId])

  const expandPanelIfCollapsed = useCallback((key: 'codes' | 'notes' | 'memos') => {
    setPanelStates(prev => prev[key].collapsed ? { ...prev, [key]: { collapsed: false } } : prev)
  }, [])

  const togglePanel = useCallback((key: 'codes' | 'notes' | 'memos') => {
    setPanelStates(prev => ({ ...prev, [key]: { collapsed: !prev[key].collapsed } }))
  }, [])

  const invalidateClips = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['observation-segments', projectId, observationId] })
    queryClient.invalidateQueries({ queryKey: ['observation', projectId, observationId] })
    queryClient.invalidateQueries({ queryKey: ['observations', projectId] })
    // #621: a clip op can move a quote to a DIFFERENT clip (split carries it to
    // the containing half, merge collapses several onto one), so the excerpt
    // cache is stale after every one of them — and it drives both the row quote
    // indicator and the `s`-verb duplicate guard. Delete/create already
    // invalidated these; the time ops did not, which is only harmless while
    // they silently drop quotes.
    queryClient.invalidateQueries({ queryKey: ['excerpts', projectId] })
    queryClient.invalidateQueries({ queryKey: ['excerpts-quoted', projectId] })
  }, [queryClient, projectId, observationId])

  // The playhead the marking keys read (I/O/P act at the CURRENT position).
  // Seeded from currentPlaybackTime after usePlayback below (a ref, so the
  // event-time readers always see the live position).
  const playheadRef = useRef(0)

  const frozen = observation?.segmentation_frozen_at != null
  const refuseFrozen = useCallback((): boolean => {
    // Interim honesty until 3e ships the proper disabled affordances + the
    // unfreeze flow: name the way out instead of a silent no-op.
    toast.error('This observation’s clips are frozen. Unfreeze the segmentation to change the clip set.')
    return true
  }, [])

  // ── Clip creation (I/O commit, P point, drag-create) — undoable ──────────
  const createClipWithHistory = useCallback(async (start: number, end: number) => {
    if (frozen) { refuseFrozen(); return }
    let clipId: number | null = null
    await history.execute({
      type: 'clip_create',
      description: 'Mark clip',
      redo: async () => {
        const created = await observationsApi.createClip(projectId, observationId, {
          start_time: start, end_time: end,
        })
        clipId = created.id
        setSelectedClips([created.id])
        invalidateClips()
      },
      undo: async () => {
        if (clipId !== null) {
          await observationsApi.deleteClip(projectId, observationId, clipId)
          setSelectedClips(prev => prev.filter(id => id !== clipId))
          invalidateClips()
        }
      },
    })
  }, [frozen, refuseFrozen, history, projectId, observationId, invalidateClips])

  // ── Boundary edits (drag commit · nudge flush · timecode entry) ──────────
  const commitBoundary = useCallback(async (
    clipId: number, edge: 'start' | 'end', value: number, base: number,
  ) => {
    if (value === base) return
    const field = edge === 'start' ? 'start_time' : 'end_time'
    await history.execute({
      type: 'clip_edit',
      description: 'Edit clip boundary',
      redo: async () => {
        await observationsApi.updateClip(projectId, observationId, clipId, { [field]: value })
        invalidateClips()
      },
      undo: async () => {
        await observationsApi.updateClip(projectId, observationId, clipId, { [field]: base })
        invalidateClips()
      },
    })
    // The a11y half of the visual drag/nudge: announce what was committed.
    setAnnounceText(`${edge === 'start' ? 'Start' : 'End'} ${formatTimecode(value)}`)
  }, [history, projectId, observationId, invalidateClips])

  // Keyboard nudges COALESCE: consecutive arrows within the window build ONE
  // history entry (else Ctrl+Z replays 0.1 s steps). The preview renders
  // immediately; the PATCH + entry commit after the burst settles.
  const nudgeRef = useRef<{
    clipId: number; edge: 'start' | 'end'; base: number; value: number; timer: number
  } | null>(null)

  const flushNudge = useCallback(() => {
    const pending = nudgeRef.current
    if (!pending) return
    nudgeRef.current = null
    window.clearTimeout(pending.timer)
    setBoundaryPreview(null)
    void commitBoundary(pending.clipId, pending.edge, pending.value, pending.base)
  }, [commitBoundary])

  const nudgeBoundary = useCallback((clipId: number, edge: 'start' | 'end', delta: number) => {
    if (frozen) { refuseFrozen(); return }
    const clip = clips.find(c => c.id === clipId)
    if (!clip) return
    const pending = nudgeRef.current
    if (pending && (pending.clipId !== clipId || pending.edge !== edge)) flushNudge()
    const prior = nudgeRef.current
    const base = prior?.base ?? (edge === 'start' ? clip.start_time : clip.end_time)
    const from = prior?.value ?? base
    // Millisecond rounding: 0.1-steps otherwise accumulate float dust into
    // the stored boundary (130.20000000000002).
    const value = Math.round(clampBoundary(edge, from + delta, clip) * 1000) / 1000
    if (prior) window.clearTimeout(prior.timer)
    const timer = window.setTimeout(flushNudge, 600)
    nudgeRef.current = { clipId, edge, base, value, timer }
    setBoundaryPreview({ clipId, edge, value })
  }, [frozen, refuseFrozen, clips, flushNudge])

  // ── Label editing (F2 / double-click) — annotation, legal while frozen ────
  const startLabelEdit = useCallback((clip: ObservationSegment) => {
    setEditingClipId(clip.id)
    setEditingLabel(clip.text)
  }, [])

  const commitLabelEdit = useCallback(async () => {
    const clipId = editingClipId
    if (clipId === null) return
    const clip = clips.find(c => c.id === clipId)
    setEditingClipId(null)
    if (!clip || clip.text === editingLabel) return
    const oldLabel = clip.text
    const newLabel = editingLabel
    await history.execute({
      type: 'clip_edit',
      description: 'Edit clip label',
      redo: async () => {
        await observationsApi.updateClip(projectId, observationId, clipId, { text: newLabel })
        invalidateClips()
      },
      undo: async () => {
        await observationsApi.updateClip(projectId, observationId, clipId, { text: oldLabel })
        invalidateClips()
      },
    })
  }, [editingClipId, editingLabel, clips, history, projectId, observationId, invalidateClips])

  // ── Delete (the list's only clip-SET mutation in 3c) ──────────────────────
  //
  // Annotated clips confirm first and run OFF the undo stack (recreate can't
  // restore what the cascade removed — the confirm names it); unannotated
  // deletes are undoable, recreate being lossless. The undo/redo closures
  // re-capture the SERVER id across recreates (the merge precedent).
  //
  // QUOTES COUNT AS ANNOTATION (#619). They are client-derived — the clip
  // payload carries no excerpt info — so the gate reads `anyQuoted`, the
  // shape-AGNOSTIC set: a clip quoted only by a sub-clip time range is just as
  // destroyed by the cascade as a whole-clip one. Before this, a quoted-but-
  // uncoded clip took the "undoable" branch and undo minted a NEW segment id
  // with no excerpt, so the quote vanished through what looked like a clean
  // undo — the comment above was false for exactly that case.
  const deleteClip = useCallback(async (clip: ObservationSegment) => {
    const annotated = clip.applied_code_details.length > 0
      || clip.attached_notes.length > 0
      || anyQuoted.has(clip.id)
    if (annotated) {
      setDeleteTarget(clip)
      return
    }
    let clipId = clip.id
    const { start_time, end_time, text } = clip
    await history.execute({
      type: 'clip_delete',
      description: 'Delete clip',
      redo: async () => {
        await observationsApi.deleteClip(projectId, observationId, clipId)
        setSelectedClips(prev => prev.filter(id => id !== clipId))
        invalidateClips()
      },
      undo: async () => {
        const recreated = await observationsApi.createClip(projectId, observationId, {
          start_time, end_time, text,
        })
        clipId = recreated.id
        invalidateClips()
      },
    })
  }, [anyQuoted, history, projectId, observationId, invalidateClips])

  const confirmAnnotatedDelete = useCallback(async () => {
    const clip = deleteTarget
    if (!clip) return
    setDeleteTarget(null)
    try {
      await observationsApi.deleteClip(projectId, observationId, clip.id)
      setSelectedClips(prev => prev.filter(id => id !== clip.id))
      invalidateClips()
      // Codes died with the clip — the cross-surface derived counts are stale.
      invalidateDerivedCounts(queryClient, projectId)
    } catch {
      toast.error('Could not delete the clip.')
    }
  }, [deleteTarget, projectId, observationId, invalidateClips, queryClient])

  // ── Slab 4d: coding (chords · CodePanel · chips) ──────────────────────────
  //
  // Optimistic patching mirrors CodingWorkbench's patchSegmentCodes against the
  // clip-list cache (#441/INV-6: patch applied_codes AND the active coder's own
  // applied_code_details entry — never a colleague's). No group fan-out: clips
  // have no segment groups. Multi-clip commits ride the D23-fixed bulk endpoint,
  // never an N-POST loop.

  const invalidateAfterCodeChange = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['observation-segments', projectId, observationId] })
    queryClient.invalidateQueries({ queryKey: ['observations', projectId] })
    queryClient.invalidateQueries({ queryKey: ['codes', projectId] })
    invalidateDerivedCounts(queryClient, projectId)  // #450: cross-surface counts
  }, [queryClient, projectId, observationId])

  // Settle for the optimistic path: true up the clip list + the list page's
  // coded count + cross-surface derived counts. invalidateDerivedCounts
  // deliberately does not know the clip-list keys (the #450 helper's contract).
  const settleAfterCodeChange = invalidateAfterCodeChange

  const patchClipCodes = useCallback(
    (clipIds: number[], codeId: number, action: 'apply' | 'remove') => {
      queryClient.setQueryData<ObservationSegment[]>(
        ['observation-segments', projectId, observationId],
        (old) => {
          if (!old) return old
          const targetIds = new Set(clipIds)
          const detail = {
            code_id: codeId,
            user_id: selfId,
            attribution: null,
            is_universal: codeMap.get(codeId)?.is_universal ?? false,
          }
          return old.map((c) => {
            if (!targetIds.has(c.id)) return c
            const hasMine = c.applied_code_details.some(d => d.code_id === codeId && d.user_id === selfId)
            if (action === 'apply' && !hasMine) return {
              ...c,
              applied_codes: [...c.applied_codes, codeId],
              applied_code_details: [...c.applied_code_details, detail],
            }
            if (action === 'remove' && hasMine) {
              const idx = c.applied_codes.indexOf(codeId)
              return {
                ...c,
                applied_codes: idx >= 0
                  ? [...c.applied_codes.slice(0, idx), ...c.applied_codes.slice(idx + 1)]
                  : c.applied_codes,
                applied_code_details: c.applied_code_details.filter(
                  d => !(d.code_id === codeId && d.user_id === selfId),
                ),
              }
            }
            return c
          })
        },
      )
    },
    [queryClient, projectId, observationId, selfId, codeMap],
  )

  // Optimistic patch + snapshot rollback around one server call. useHistory's
  // execute() does NOT roll back a thrown redo/undo — restore here and re-throw.
  const runOptimisticCode = useCallback(
    async (
      clipIds: number[],
      codeId: number,
      action: 'apply' | 'remove',
      serverCall: () => Promise<unknown>,
    ) => {
      const snapshot = queryClient.getQueryData(['observation-segments', projectId, observationId])
      patchClipCodes(clipIds, codeId, action)
      try {
        const result = await serverCall()
        settleAfterCodeChange()
        // #678: a partial failure arrives as a 200 body. `settleAfterCodeChange`
        // here IS the full invalidation (it is aliased to it above), so the clip
        // list self-corrects and no chip stays stuck — but the coder was still
        // told nothing. This surface is where the D23 regression landed, when a
        // two-parent scope defect made EVERY multi-clip chord come back
        // applied=False inside a 200 and nothing said so.
        const outcome = collectBulkOutcome(result as Parameters<typeof collectBulkOutcome>[0])
        if (outcome.hasFailures) toast.warning(describeBulkFailure(outcome, 'clip', action))
      } catch (e) {
        queryClient.setQueryData(['observation-segments', projectId, observationId], snapshot)
        throw e
      }
    },
    [queryClient, projectId, observationId, patchClipCodes, settleAfterCodeChange],
  )

  const handleCodeToggle = useCallback((code: Code) => {
    if (selectedClips.length === 0) return
    // INV-6 (#446): "do I have it?", not "does anyone?" — apply my own layer
    // when only a colleague coded the clip, instead of taking the remove branch.
    const allHaveCode = selectedClips.every((clipId) => {
      const clip = clipMap.get(clipId)
      if (!clip) return false
      return isCodeAppliedByActiveCoder(clip.applied_code_details, clip.applied_codes ?? [], code.id, selfId)
    })
    const clipIds = [...selectedClips]
    const codeId = code.id
    const codeName = code.name

    if (clipIds.length === 1) {
      const clipId = clipIds[0]
      if (allHaveCode) {
        history.execute({
          type: 'code_remove',
          description: `Remove code "${codeName}"`,
          redo: () => runOptimisticCode([clipId], codeId, 'remove', () => codingApi.removeCode(clipId, codeId)),
          undo: () => runOptimisticCode([clipId], codeId, 'apply', () => codingApi.applyCode(clipId, codeId)),
        })
      } else {
        history.execute({
          type: 'code_apply',
          description: `Apply code "${codeName}"`,
          redo: () => runOptimisticCode([clipId], codeId, 'apply', () => codingApi.applyCode(clipId, codeId)),
          undo: () => runOptimisticCode([clipId], codeId, 'remove', () => codingApi.removeCode(clipId, codeId)),
        })
      }
    } else {
      // D23: the multi-clip commit is ONE bulk call (atomic, audit-logged).
      const action = allHaveCode ? 'remove' : 'apply'
      const inverse = action === 'apply' ? 'remove' : 'apply'
      history.execute({
        type: allHaveCode ? 'code_remove' : 'code_apply',
        description: `${action === 'apply' ? 'Apply' : 'Remove'} code "${codeName}" on ${clipIds.length} clips`,
        redo: () => runOptimisticCode(clipIds, codeId, action, () => codingApi.bulkCode(clipIds, codeId, action)),
        undo: () => runOptimisticCode(clipIds, codeId, inverse, () => codingApi.bulkCode(clipIds, codeId, inverse)),
      })
    }
  }, [selectedClips, clipMap, selfId, history, runOptimisticCode])

  const handleMultiCodeToggle = useCallback((codesToToggle: Code[]) => {
    if (selectedClips.length === 0 || codesToToggle.length === 0) return
    const clipIds = [...selectedClips]
    const codeNames = codesToToggle.map(c => c.name).join(', ')
    const runBatch = async (action: 'apply' | 'remove') => {
      const snapshot = queryClient.getQueryData(['observation-segments', projectId, observationId])
      codesToToggle.forEach(code => patchClipCodes(clipIds, code.id, action))
      try {
        const results = await Promise.all(
          codesToToggle.map(code => codingApi.bulkCode(clipIds, code.id, action)),
        )
        settleAfterCodeChange()
        // #678: fold the N per-code responses so a clip skipped for every code is
        // reported once rather than N times.
        const outcome = collectBulkOutcome(results)
        if (outcome.hasFailures) toast.warning(describeBulkFailure(outcome, 'clip', action))
      } catch (e) {
        queryClient.setQueryData(['observation-segments', projectId, observationId], snapshot)
        throw e
      }
    }
    history.execute({
      type: 'code_apply',
      description: `Apply codes "${codeNames}" to ${clipIds.length} clip(s)`,
      redo: () => runBatch('apply'),
      undo: () => runBatch('remove'),
    })
  }, [selectedClips, history, queryClient, projectId, observationId, patchClipCodes, settleAfterCodeChange])

  const createCodeMutation = useMutation({
    mutationFn: (name: string) => codesApi.create(projectId, { name }),
    onSuccess: async (newCode) => {
      await queryClient.invalidateQueries({ queryKey: ['codes', projectId] })
      if (selectedClips.length > 0) codePanelRef.current?.focusCodeForApply(newCode.id)
    },
  })

  // Clicking an applied-code chip pivots to that code in the codes panel (#422a).
  const handleFocusCode = useCallback((codeId: number) => {
    rightColumn.expand()
    expandPanelIfCollapsed('codes')
    setFocusedPanel('codes')
    requestAnimationFrame(() => codePanelRef.current?.focusCode(codeId))
  }, [rightColumn, expandPanelIfCollapsed])

  // `n` and the #654 row menu share ONE note entry point: the note flow lives
  // in the rail, so a collapsed column silently swallowing the verb is the
  // failure mode `useCollapsibleColumn` exists to prevent — and two copies of
  // the expand/focus dance would drift the moment one of them grew a step.
  /**
   * Apply an EXISTING code to clips as one undoable step (#665).
   *
   * Split out of `handleCodeToggle` because the `c` flow needs the apply half
   * without the toggle half: a code created seconds ago is on nothing, so
   * asking "does everyone already have it?" can only answer no. Keeps the
   * single/bulk split — D23 requires the multi-clip commit to be ONE bulk call,
   * atomic and audit-logged — and rides `runOptimisticCode`, so the chips move
   * immediately and roll back together on failure.
   */
  const applyCodeToClips = useCallback((clipIds: number[], code: Code) => {
    if (clipIds.length === 0) return
    const ids = [...clipIds]
    const single = ids.length === 1
    const run = (action: 'apply' | 'remove') => () => runOptimisticCode(
      ids, code.id, action,
      () => single
        ? (action === 'apply' ? codingApi.applyCode(ids[0], code.id) : codingApi.removeCode(ids[0], code.id))
        : codingApi.bulkCode(ids, code.id, action),
    )
    history.execute({
      type: 'code_apply',
      description: single
        ? `Apply code "${code.name}"`
        : `Apply code "${code.name}" on ${ids.length} clips`,
      redo: run('apply'),
      undo: run('remove'),
    })
  }, [history, runOptimisticCode])

  /**
   * `c` — #665. This is the SIBLING WORKBENCHES' flow, verbatim in shape: open
   * `FloatingCreateCode` anchored to the selected row, CAPTURING the selection,
   * and on create apply the new code to every captured clip in one history
   * entry.
   *
   * ⚠️ #660 shipped a different thing — focus the rail's add box — and it left
   * the flow half-done: the code got created and then merely FOCUSED
   * (`createCodeMutation` calls `focusCodeForApply`), so it never landed on the
   * clip. "Create and apply" is one gesture in conversations and documents, and
   * it has to be one gesture here. The rail's add box remains its own path.
   */
  const openCreateCodeDialog = useCallback((clipIds: number[]) => {
    if (clipIds.length === 0) return
    setCreateCodeDialog({
      position: coordsFromElement(`clip-${clipIds[0]}`),
      clipIds: [...clipIds],
      // In-vivo (#526): a clip label the researcher highlighted becomes the
      // code name. Undefined when nothing is selected, so it costs nothing.
      initialName: selectionPrefill(),
    })
  }, [])

  /**
   * `n` / the row menu's Add Note — #671. Conversations and Documents both pop
   * `FloatingCreateNote` anchored at the row; Observations sent focus to the
   * rail instead, the same divergence that produced #665.
   *
   * ⚠️ It also changed WHAT the note attached to, silently: the rail path
   * anchors only when EXACTLY ONE clip is selected and otherwise files an
   * observation-level note, so `n` on a multi-selection produced a note on
   * nothing in particular. Conversations anchors to `sel[0]`; so does this now.
   * The rail's own composer keeps the observation-level path — that is its job,
   * and it is reachable by clicking into it.
   */
  /** Open an existing note in the notes panel (#740).
   *
   *  Mirrors `CodingWorkbench::handleNoteClick` step for step — expand the
   *  column, expand the panel, focus it, then ask the panel to reveal the note
   *  on the next frame (it may have mounted a tick ago). */
  const handleNoteClick = useCallback((noteId: number) => {
    rightColumn.expand()
    expandPanelIfCollapsed('notes')
    setFocusedPanel('notes')
    requestAnimationFrame(() => notesPanelRef.current?.focusNote(noteId))
  }, [rightColumn, expandPanelIfCollapsed])

  const openNoteDialog = useCallback((clipId: number | undefined) => {
    setCreateNoteDialog({
      position: coordsFromElement(clipId !== undefined ? `clip-${clipId}` : 'clip-list'),
      clipId,
    })
  }, [])


  // ── Slab 4d: whole-clip quotes (`s`, D24 — sub-clip time ranges are slab 5) ──
  //
  // Excerpt ids change across delete/recreate, so BOTH directions resolve the
  // whole-clip excerpt from a fresh list at run time (the id-recapture rule the
  // clip split/merge undo closures already follow) — a captured id would go
  // stale the first time undo/redo replays.
  const handleToggleQuote = useCallback(() => {
    if (selectedClips.length === 0) return
    const clipIds = [...selectedClips]
    const allQuoted = clipIds.every(id => wholeQuoted.has(id))
    const invalidateExcerpts = () => {
      queryClient.invalidateQueries({ queryKey: ['excerpts', projectId] })
    }
    const deleteWholeClipExcerpts = async () => {
      const fresh = await excerptsApi.list(projectId)
      for (const id of clipIds) {
        // isWholeExcerpt, NOT `start_offset === null` — the bare predicate also
        // matches a sub-clip time range, so unquoting a clip would delete the
        // researcher's sub-quote instead (and `.find` takes the first match, so
        // WHICH one died depended on list order).
        const whole = fresh.excerpts.find(e => e.segment_id === id && isWholeExcerpt(e))
        if (whole) await excerptsApi.delete(projectId, whole.id)
      }
      invalidateExcerpts()
    }
    const createWholeClipExcerpts = async () => {
      await excerptsApi.bulkCreate(projectId, clipIds.map(id => ({ segment_id: id })))
      invalidateExcerpts()
    }
    history.execute({
      type: allQuoted ? 'quote_delete' : 'quote_create',
      description: `${allQuoted ? 'Unquote' : 'Quote'} ${clipIds.length} clip${clipIds.length === 1 ? '' : 's'}`,
      redo: allQuoted ? deleteWholeClipExcerpts : createWholeClipExcerpts,
      undo: allQuoted ? createWholeClipExcerpts : deleteWholeClipExcerpts,
    })
  }, [selectedClips, wholeQuoted, history, projectId, queryClient])

  // ── Slab 5b: sub-clip time-range quotes (`s` while a mark is armed, D30) ───
  //
  // The fourth verb over the SAME armed number the I/O/P machine already owns —
  // no second mode, no extra slot. Attach rule, deterministic and in this order:
  // the SELECTED clip when it contains the range, else the UNIQUE containing
  // clip, else an honest toast naming the way out.
  //
  // Uses `create`, never `bulkCreate`: the two share the backend's shape
  // validation but bulk counts failures into `skipped_count` inside a 200, so a
  // refusal would return as success (§8j.6.3). Deliberately does NOT call
  // refuseFrozen() — a quote is annotation, legal on a frozen observation
  // (D22/D29), unlike its clip-SET siblings i/o/p.
  //
  // ⚠️ Every REACHABLE failure is named here, before the call, because
  // `useHistory.execute` swallows a thrown error and toasts a generic
  // "Action failed" — so a message raised from inside redo() cannot reach the
  // researcher intact. The two pre-checks use the same predicates the backend
  // validates with (`clipContainsRange` mirrors its containment arm), which
  // makes its 400s unreachable from this path rather than merely unlikely; the
  // backend stays the authority and still refuses. What's left for the generic
  // toast is genuinely exceptional (network, a race).
  // `explicitClip` bypasses the attach rule: the dialog already NAMED its clip,
  // and overlapping clips are legal (D6), so re-resolving could silently attach
  // the quote to a different clip than the one the dialog said it was quoting.
  const quoteRange = useCallback(async (
    range: { start: number; end: number },
    explicitClip?: ObservationSegment,
  ) => {
    let target = explicitClip
    if (!target) {
      const selected = selectedClips.length === 1 ? clipMap.get(selectedClips[0]) : undefined
      target = selected && clipContainsRange(selected, range) ? selected : undefined
      if (!target) {
        const containing = clips.filter(c => clipContainsRange(c, range))
        if (containing.length === 1) target = containing[0]
      }
    }
    if (!target) {
      toast.error('The marked range must sit inside one clip.')
      return
    }
    const clipId = target.id
    const duplicate = (excerptsData?.excerpts ?? []).some(e =>
      e.segment_id === clipId && e.start_time === range.start && e.end_time === range.end)
    if (duplicate) {
      toast.error('You’ve already quoted this range.')
      return
    }
    const invalidateExcerpts = () => {
      queryClient.invalidateQueries({ queryKey: ['excerpts', projectId] })
    }
    // Both directions re-resolve by (segment_id, times) — never a captured id,
    // which goes stale the first time undo/redo replays (the 4d rule).
    const createQuote = async () => {
      await excerptsApi.create(projectId, {
        segment_id: clipId, start_time: range.start, end_time: range.end,
      })
      invalidateExcerpts()
    }
    const deleteQuote = async () => {
      const fresh = await excerptsApi.list(projectId)
      const match = fresh.excerpts.find(e =>
        e.segment_id === clipId && e.start_time === range.start && e.end_time === range.end)
      if (match) await excerptsApi.delete(projectId, match.id)
      invalidateExcerpts()
    }
    await history.execute({
      type: 'quote_create',
      description: `Quote ${formatTimecode(range.start)}–${formatTimecode(range.end)}`,
      redo: createQuote,
      undo: deleteQuote,
    })
    setArmedInTime(null)
    setAnnounceText(`Quoted ${formatTimecode(range.start)} to ${formatTimecode(range.end)}`)
  }, [selectedClips, clipMap, clips, excerptsData, history, projectId, queryClient])

  // ── Slab 4d: observation notes (the 4a endpoints) ─────────────────────────
  const createNoteMutation = useMutation({
    mutationFn: (data: { content: string; segment_id?: number }) =>
      notesApi.createForObservation(projectId, observationId, data),
    onSuccess: () => {
      setNoteInput('')
      queryClient.invalidateQueries({ queryKey: ['observation-notes', projectId, observationId] })
      // Clip rows render attached_notes badges — the clip list is stale too.
      queryClient.invalidateQueries({ queryKey: ['observation-segments', projectId, observationId] })
    },
    onError: () => { toast.error('Could not create the note.') },
  })

  const handleCreateNote = useCallback(() => {
    const content = noteInput.trim()
    if (!content) return
    // Exactly one selected clip anchors the note to it; else observation-level.
    const segmentId = selectedClips.length === 1 ? selectedClips[0] : undefined
    createNoteMutation.mutate({ content, segment_id: segmentId })
  }, [noteInput, selectedClips, createNoteMutation])

  // ── Selection + the ONE window keyboard listener ──────────────────────────
  const selection = useSegmentSelection({
    items: filteredClips,
    getId: c => c.id,
    selectedIds: selectedClips,
    onSelectionChange: setSelectedClips,
    scrollToIndex: (index) => virtuosoRef.current?.scrollIntoView({ index, behavior: 'auto' }),
    enabled: editingClipId === null,
  })

  // ── Freeze / unfreeze (3e — D18's control lives HERE, not at import: D20) ──
  const confirmFreeze = useCallback(async () => {
    setFreezeDialogOpen(false)
    try {
      await observationsApi.freezeSegmentation(projectId, observationId)
      invalidateClips()
      // Freezing marks coded clips for the consensus sweep (#615) — the
      // consensus-status / IRR / reconciliation keys are about to change.
      invalidateDerivedCounts(queryClient, projectId)
      toast.success('Segmentation frozen — the team codes these clips.')
    } catch {
      toast.error('Could not freeze the segmentation.')
    }
  }, [projectId, observationId, invalidateClips, queryClient])

  const confirmUnfreeze = useCallback(async () => {
    setUnfreezeDialogOpen(false)
    try {
      await observationsApi.unfreezeSegmentation(projectId, observationId)
      invalidateClips()
      // Unfreezing DROPS the derived consensus layer server-side (#615).
      invalidateDerivedCounts(queryClient, projectId)
      toast.success('Segmentation re-opened.')
    } catch {
      toast.error('Could not unfreeze the segmentation.')
    }
  }, [projectId, observationId, invalidateClips, queryClient])

  // ── Split at playhead / merge selection (3e — the 3b time ops get their UI) ──
  //
  // canSplit/playheadInsideSelected moved BELOW usePlayback (they read the
  // playhead at render time, which is seeded there); the handlers stay here.
  const selectedClip = selectedClips.length === 1
    ? clips.find(c => c.id === selectedClips[0]) ?? null
    : null
  const canMerge = !frozen && selectedClips.length >= 2

  // `target` lets the #654 row menu split the clip it was opened on rather than
  // whatever `selectedClip` happens to hold: right-click-to-select lands a
  // render later, so a menu item reading the shared selection could act on the
  // PREVIOUS one. The toolbar button keeps passing nothing (selection-scoped).
  const splitAtPlayhead = useCallback(async (target?: ObservationSegment) => {
    const clip = target ?? selectedClip
    if (!clip) return
    const clipId = clip.id
    const at = playheadRef.current
    const quotes = quoteCountOn([clipId])
    let halfIds: number[] = []
    await history.execute({
      type: 'clip_split',
      description: 'Split clip',
      redo: async () => {
        const halves = await observationsApi.splitClip(projectId, observationId, clipId, at)
        halfIds = halves.map(h => h.id)
        setSelectedClips(halfIds)
        invalidateClips()
        // Splitting carries every coder's layer onto both halves, so the
        // cross-surface coded counts move (#450).
        invalidateDerivedCounts(queryClient, projectId)
        // The row icons show the new quote homes, but the EVENT is invisible —
        // say it once, in the region that already announces boundary commits.
        setAnnounceText(
          quotes > 0
            ? `Clip split. ${quotes} ${quotes === 1 ? 'quote' : 'quotes'} kept.`
            : 'Clip split.',
        )
      },
      undo: async () => {
        // Both half ids, captured above — never sibling discovery (§8h.3).
        await observationsApi.unsplitClip(projectId, observationId, halfIds)
        setSelectedClips([clipId])
        invalidateClips()
        invalidateDerivedCounts(queryClient, projectId)
      },
    })
  }, [selectedClip, history, projectId, observationId, invalidateClips, quoteCountOn, queryClient])

  /**
   * Merge a given set of clips. Parameterized for #670: Conversations offers
   * "Merge with Next / Previous" from a SINGLE selection and Observations only
   * had the ≥2-selected form, so the everyday "join this to the one after it"
   * cost a Shift-click first. The backend imposes no adjacency requirement — a
   * merged range deliberately spans gaps — so this was a missing affordance,
   * never a capability limit.
   */
  const mergeClipIds = useCallback(async (clipIds: number[]) => {
    const ids = [...clipIds]
    if (ids.length < 2) return
    const quotes = quoteCountOn(ids)
    let mergedId: number | null = null
    await history.execute({
      type: 'clip_merge',
      description: 'Merge clips',
      redo: async () => {
        const merged = await observationsApi.mergeClips(projectId, observationId, ids)
        mergedId = merged.id
        setSelectedClips([merged.id])
        invalidateClips()
        invalidateDerivedCounts(queryClient, projectId)
        // Whole-clip quotes COLLAPSE to one, so "N kept" would overstate it —
        // the honest line names what went in, not what came out.
        setAnnounceText(
          quotes > 0
            ? `${ids.length} clips merged. ${quotes} ${quotes === 1 ? 'quote' : 'quotes'} carried.`
            : `${ids.length} clips merged.`,
        )
      },
      undo: async () => {
        if (mergedId !== null) {
          await observationsApi.unmergeClip(projectId, observationId, mergedId)
          setSelectedClips(ids)
          invalidateClips()
          invalidateDerivedCounts(queryClient, projectId)
        }
      },
    })
  }, [history, projectId, observationId, invalidateClips, quoteCountOn, queryClient])

  const mergeSelection = useCallback(
    () => mergeClipIds(selectedClips),
    [mergeClipIds, selectedClips],
  )

  // Slab 4d/4e: real codes in the mounted hook (digits/chords live); the
  // return is CAPTURED — chordPrefix drives the HUD and the D14 follow-freeze
  // (`followOn && chordPrefix === null`), which is why this hook runs BEFORE
  // usePlayback: the freeze must flow into the SAME render's followPlayhead.
  // The transport extraKeys reach playback through `playbackRef` (the
  // CodingWorkbench pattern) — an explicitly-typed ref, because a direct
  // closure would make chord-options ⇄ usePlayback a TS inference cycle.
  // Still NO onJumpUncoded — that deliberately frees `j` for transport (D4;
  // the hook only claims `j` when the callback exists).
  const playbackRef = useRef<{
    hasPlayableMedia: boolean
    isPlaying: boolean
    togglePlayback: () => void
    cyclePlaybackSpeed: () => void
    seekWithoutPausing: (time: number) => void
    stepBy: (delta: number) => boolean
  } | null>(null)

  // `u` (6a/D35) reaches the coverage model the same way transport reaches
  // playback: through a ref reassigned every render, BELOW where the coverage
  // is derived. A direct closure here would capture bindings declared later in
  // the body (the gaps depend on usePlayback's own output), which is the TS
  // inference cycle §8i.7.1 records.
  const coverageJumpRef = useRef<(() => boolean) | null>(null)

  const { chordPrefix, pendingCategoryId }: UseCodeChordShortcutsResult = useCodeChordShortcuts({
    codes,
    selectionCount: selectedClips.length,
    isEditing: editingClipId !== null || renaming,
    arrowNavEnabled: focusedPanel === 'list',
    onToggleCode: handleCodeToggle,
    // `s` — whole-clip quote toggle (D24; sub-clip ranges are slab 5).
    onToggleQuote: handleToggleQuote,
    // `c` / `n` — both open an anchored dialog, as the siblings do. ⚠️ `onCreateCode` MUST
    // be passed even though CodePanel takes a same-named prop: the hook's `c`
    // arm runs `e.preventDefault()` BEFORE `o.onCreateCode?.()`, so omitting it
    // does not fall through to the browser — it swallows the key and the verb
    // silently does nothing (#660, live-reported).
    onCreateCode: () => openCreateCodeDialog(selectedClips),
    onCreateNote: () => openNoteDialog(selectedClips[0]),
    onEditOrRename: () => {
      if (selectedClips.length === 1) {
        const clip = clips.find(c => c.id === selectedClips[0])
        if (clip) startLabelEdit(clip)
      }
    },
    // Arrow nav is a MANUAL selection — it breaks Follow like a click (D14).
    onArrowNav: (direction, opts) => {
      setFollowOn(false)
      selection.handleArrowNav(direction, opts)
    },
    // Left/Right = boundary nudges on the single-selected clip (±0.1 s; Shift
    // ±1 s; Alt = the start edge). Multi/no selection falls through.
    onArrowHorizontal: (direction, mods) => {
      if (selectedClips.length !== 1) return false
      const magnitude = mods.shift ? 1 : 0.1
      nudgeBoundary(
        selectedClips[0],
        mods.alt ? 'start' : 'end',
        direction === 'left' ? -magnitude : magnitude,
      )
      return true
    },
    extraKeys: {
      // Marking + play/pause self-gate on LIST focus (the sibling workbenches'
      // Space pattern): a keystroke aimed at a rail panel must not cut a clip.
      // J-K-L + frame stepping stay global — transport is harmless from a
      // panel and reaching for the mouse to shuttle defeats the shuttle.
      ' ': () => {
        const p = playbackRef.current
        if (focusedPanel !== 'list' || !p?.hasPlayableMedia) return false
        p.togglePlayback()
        return true
      },
      // ── Marking (I/O/P — the reducer lives in lib/clip-timeline) ──
      i: () => {
        if (focusedPanel !== 'list') return false
        if (frozen) return refuseFrozen()
        setArmedInTime(armMark(playheadRef.current))
        return true
      },
      o: () => {
        if (focusedPanel !== 'list') return false
        const range = commitMark(armedInTime, playheadRef.current)
        if (range === null) return false // O alone is not a gesture
        if (frozen) return refuseFrozen()
        setArmedInTime(null)
        void createClipWithHistory(range.start, range.end)
        return true
      },
      p: () => {
        if (focusedPanel !== 'list') return false
        if (frozen) return refuseFrozen()
        const range = pointMark(playheadRef.current)
        void createClipWithHistory(range.start, range.end)
        return true
      },
      // `s` while a mark is ARMED = quote that range inside its clip (D30) —
      // the fourth verb over the same armed number. Returning FALSE when idle
      // lets the key fall through to the hook's own `s` (the whole-clip quote
      // toggle), which lives BELOW the selection gate — so idle-`s` behaviour is
      // untouched and this handler never needs a selection of its own.
      // Deliberately no refuseFrozen(): quotes are annotation (D22/D29).
      s: () => {
        if (focusedPanel !== 'list') return false
        const range = commitMark(armedInTime, playheadRef.current)
        if (range === null) return false // nothing armed → the whole-clip toggle
        void quoteRange(range)
        return true
      },
      // `u` — jump to the next thing the gauge says is missing (D35). Global
      // (not list-gated): it is navigation, the sibling of the conversation
      // workbench's `j`, which the hook leaves unclaimed here so J-K-L can
      // shuttle (D4). The branch (gap seek vs next uncoded clip) lives with the
      // coverage derivation, below.
      u: () => coverageJumpRef.current?.() ?? false,
      // ── J-K-L transport (D4) ──
      j: () => {
        const p = playbackRef.current
        if (!p?.hasPlayableMedia) return false
        p.seekWithoutPausing(Math.max(0, playheadRef.current - 5))
        return true
      },
      k: () => {
        const p = playbackRef.current
        if (!p?.hasPlayableMedia) return false
        p.togglePlayback()
        return true
      },
      l: () => {
        const p = playbackRef.current
        if (!p?.hasPlayableMedia) return false
        if (p.isPlaying) p.cyclePlaybackSpeed()
        else p.togglePlayback()
        return true
      },
      // Frame-ish stepping. '<'/'>' are what Shift+,/. PRODUCE on US layouts —
      // e.key carries the shifted character, so both spellings register.
      ',': (e) => playbackRef.current?.stepBy(e.shiftKey ? -1 : -0.04) ?? false,
      '.': (e) => playbackRef.current?.stepBy(e.shiftKey ? 1 : 0.04) ?? false,
      '<': () => playbackRef.current?.stepBy(-1) ?? false,
      '>': () => playbackRef.current?.stepBy(1) ?? false,
    },
    clearSelection: () => setSelectedClips([]),
    // Escape layer 1b: cancel the armed mark BEFORE the overlay layer — the
    // mark is the most recent thing armed, and cancelling it must not also
    // drop the researcher out of theater.
    onEscapeMode: () => {
      if (armedInTime === null) return false
      setArmedInTime(null)
      return true
    },
    onEscapeOverlay: () => videoPaneHandleRef.current?.exitOverlay() ?? false,
    // D27: Escape exits Follow — the post-overlay slot, so leaving theater and
    // leaving Follow stay two distinct presses in the right order (§8i.0.8).
    onEscapePostOverlay: () => {
      if (!followOn) return false
      setFollowOn(false)
      return true
    },
    // Rail panel focused → Escape collapses it and returns focus to the list
    // (the doc-workbench pattern; reached because arrowNavEnabled is false).
    onEscapeFallback: () => {
      if (focusedPanel !== 'list') {
        const key = focusedPanel
        setPanelStates(prev => ({ ...prev, [key]: { collapsed: true } }))
        setFocusedPanel('list')
      }
    },
    onUndo: () => { void history.undo() },
    onRedo: () => { void history.redo() },
  })

  const pendingCategoryName =
    pendingCategoryId !== null ? codes.find(c => c.category_id === pendingCategoryId)?.category_name : null

  // ── Playback + Follow (D14/D27) ───────────────────────────────────────────

  // All clips under the playhead follow-select together; a GAP selects nothing
  // (chords then no-op via the selection gate) — findClipsAtTime, never the
  // floor-single conversation finder.
  const followFinder = useCallback(
    (units: ObservationSegment[], t: number) => findClipsAtTime(units, t).map(c => c.id),
    [],
  )

  const {
    isPlaying,
    playbackSpeed,
    currentPlaybackTime,
    hasPlayableMedia,
    togglePlayback,
    cyclePlaybackSpeed,
    handleTimeSeek,
    seekToTime,
    seekWithoutPausing,
    isMediaReady,
    isBuffering,
    mediaError,
    isTranscriptOnly,
  } = usePlayback({
    segments: clips,
    selectedSegments: selectedClips,
    onSelectionChange: setSelectedClips,
    mediaRef: mediaElementRef,
    source: observation,
    // D14: playback drives the selection ONLY while Follow is on, and the
    // follow-selection FREEZES while a chord is armed — the researcher is
    // mid-keystroke naming what they just watched; the target must hold still.
    // The 1500 ms chord timeout un-freezes via the hook's own setState.
    followPlayhead: followOn && chordPrefix === null,
    findUnitsAtTime: followFinder,
  })

  if (currentPlaybackTime !== null) playheadRef.current = currentPlaybackTime

  // Render-time playhead reads live BELOW the seed above, or a seek would show
  // up one render late (the split test caught exactly that lag).
  const playheadInside = (clip: ObservationSegment) =>
    clip.start_time < playheadRef.current && playheadRef.current < clip.end_time
  const playheadInsideSelected = selectedClip !== null && playheadInside(selectedClip)
  const canSplit = !frozen && playheadInsideSelected

  // The ruler's extent fallback chain (§8h.4): server duration → the element's
  // own runtime measurement (display-only — never gates a capability) → the
  // farthest clip. #574's backfill covers old rows at release prep.
  const serverDuration = observation?.media_duration_seconds ?? null
  if (isMediaReady && elementDuration === null) {
    const d = mediaElementRef.current?.duration
    if (d !== undefined && Number.isFinite(d) && d > 0) setElementDuration(d)
  }
  const effectiveDuration = serverDuration ?? elementDuration
  const maxClipEnd = clips.length > 0 ? Math.max(...clips.map(c => c.end_time)) : 0
  const timelineExtent = Math.max(effectiveDuration ?? 0, maxClipEnd, 60)
  const recordingEnd = recordingEndsAtTimelineTime(effectiveDuration, 0)

  // ── Coverage (6a — D33/D34/D35) ───────────────────────────────────────────
  //
  // CLIENT-computed, like every workbench gauge: the clip payload is already
  // human-layer-only (`_clip_to_response` drops the consensus layer — the P-1
  // pin), so J2-B and the blind lens come FREE here. A backend read would need
  // a #517-style self-scope param and would still duplicate the lens. The
  // LIST's all-coder % is the backend's job — it loads no clip payloads.
  //
  // D34, ONE extent law: the ruler's own chain MINUS its 60 s display floor.
  // That floor exists so an empty ruler still renders; in a DENOMINATOR it
  // would silently deflate coverage on any recording shorter than a minute.
  const coverageExtent = Math.max(effectiveDuration ?? 0, maxClipEnd)

  // `effectiveHidden`, NEVER `chipHidden` (#451): a gauge counts an archived
  // coder's work as coded — only the CHIPS hide it.
  const codedIntervals = useMemo<Interval[]>(
    () => clips
      .filter(c => isSegmentCodedVisible(c.applied_code_details, effectiveHidden))
      .map(c => ({ start: c.start_time, end: c.end_time })),
    [clips, effectiveHidden],
  )
  const coverageUnion = useMemo(() => unionIntervals(codedIntervals), [codedIntervals])
  const coverageGaps = useMemo(
    () => gapsInExtent(coverageUnion, coverageExtent),
    [coverageUnion, coverageExtent],
  )
  const coveredTotal = coveredSeconds(coverageUnion, coverageExtent)
  const coveragePercent = coverageExtent > 0
    ? Math.round((coveredTotal / coverageExtent) * 100)
    : null
  // FROZEN: plain N-of-M, and NOT circular — M was fixed by the freeze, before
  // any coding (§8d's table). The conversation gauge's own helper, verbatim.
  const frozenCoverage = useMemo(
    () => computeCoverage(clips, c => c.applied_code_details, effectiveHidden),
    [clips, effectiveHidden],
  )
  const durationIsKnown = effectiveDuration != null

  // The gauge's accessible value. NULL = there is nothing to measure yet (no
  // clips and no readable duration ⇒ no extent, D34), and then the region
  // carries no progressbar semantics at all rather than announcing a fake 0%.
  // The denominator is NAMED: a percentage of "marked extent" is a different
  // claim from a percentage of the recording, and that fallback is reachable
  // today on every .mov/.webm uploaded before #574's backfill.
  const coverageProgress: { now: number; max: number; text: string } | null =
    frozen
      ? (clips.length > 0
          ? {
              now: frozenCoverage.codedVisible,
              max: frozenCoverage.total,
              text: `${frozenCoverage.codedVisible} of ${frozenCoverage.total} clips coded`,
            }
          : null)
      : (coveragePercent !== null
          ? {
              now: Math.round(coveredTotal),
              max: Math.round(coverageExtent),
              text: `${coveragePercent}% of ${durationIsKnown
                ? 'the recording'
                : 'marked extent — recording length unknown'} covered by coding`
                + (coverageGaps.length > 0
                  ? `, ${coverageGaps.length} gap${coverageGaps.length === 1 ? '' : 's'} remaining`
                  : ''),
            }
          : null)

  // `u` — branched exactly like the gauge, so the key always goes to whatever
  // the number says is missing. Assigned during render (the playbackRef
  // pattern) so the extraKeys closure registered above never reads a stale
  // coverage.
  coverageJumpRef.current = (): boolean => {
    if (frozen) {
      // The conversation `j` walk: anchor on the selection, wrap once, over the
      // DISPLAYED list so the scroll always lands.
      const pool = filteredClips
      if (pool.length === 0) return false
      const currentId = selectedClips.length > 0 ? selectedClips[0] : null
      const currentIdx = currentId != null ? pool.findIndex(c => c.id === currentId) : -1
      for (let offset = 1; offset <= pool.length; offset++) {
        const index = (currentIdx + offset) % pool.length
        const clip = pool[index]
        if (!isSegmentCodedVisible(clip.applied_code_details, effectiveHidden)) {
          setFollowOn(false) // a jump is a manual selection (D14)
          setSelectedClips([clip.id])
          virtuosoRef.current?.scrollIntoView({ index, behavior: 'auto' })
          setAnnounceText(`Uncoded clip at ${formatTimecode(clip.start_time)}`)
          return true
        }
      }
      setAnnounceText('Every clip is coded')
      return true
    }
    if (coverageExtent <= 0) {
      setAnnounceText('No recording length known — mark a clip to give the timeline an extent.')
      return true
    }
    const target = nextGapStart(coverageGaps, playheadRef.current)
    if (target === null) {
      setAnnounceText('Timeline fully covered')
      return true
    }
    const gap = coverageGaps.find(g => g.start === target)
    // PAUSED: a gap is a "go work here" destination, exactly like a ?clip=
    // arrival (the arrival-never-plays rule).
    seekToTime(target)
    setAnnounceText(
      gap
        ? `Gap ${formatTimecode(gap.start)}–${formatTimecode(gap.end)}`
        : `Gap at ${formatTimecode(target)}`,
    )
    return true
  }

  // Transport steps (,/. = a frame-ish 0.04 s, Shift = 1 s). Frame steps PAUSE
  // (you are scrutinizing a frame); J-K-L rides the NON-pausing seek.
  const stepBy = useCallback((delta: number): boolean => {
    if (!hasPlayableMedia) return false
    seekToTime(Math.max(0, playheadRef.current + delta))
    return true
  }, [hasPlayableMedia, seekToTime])

  // The transport snapshot the chord extraKeys read (reassigned every render —
  // the latest-value-ref pattern the playback hook itself uses).
  playbackRef.current = {
    hasPlayableMedia, isPlaying, togglePlayback, cyclePlaybackSpeed, seekWithoutPausing, stepBy,
  }

  // D14: pausing breaks Follow (the toggle turns OFF — playback and selection
  // decouple the moment the researcher stops the tape).
  const prevIsPlayingRef = useRef(false)
  useEffect(() => {
    if (prevIsPlayingRef.current && !isPlaying) setFollowOn(false)
    prevIsPlayingRef.current = isPlaying
  }, [isPlaying])

  // D27: the clips containing the playhead — the green "now playing" state on
  // list rows and timeline bars (NOT selection; lib/selection.ts's rule).
  const nowPlayingIds = useMemo(
    () => currentPlaybackTime === null
      ? new Set<number>()
      : new Set(findClipsAtTime(clips, currentPlaybackTime).map(c => c.id)),
    [clips, currentPlaybackTime],
  )

  // D28: category lanes through the BLIND lens — membership uses the same
  // distinctVisibleCodeIds set the chips use, or lane placement would leak "a
  // colleague coded this" through blind mode.
  const codeToCategoryId = useMemo(
    () => new Map(codes.map(c => [c.id, c.category_id])),
    [codes],
  )
  const timelineLanes = useMemo(
    () => buildLanes(
      clips,
      clip => distinctVisibleCodeIds(clip.applied_code_details, chipHidden),
      chordCategories,
      codeToCategoryId,
    ),
    [clips, chipHidden, chordCategories, codeToCategoryId],
  )

  // #656: a bar takes its CODE's colour. Computed here, not in ClipTimeline,
  // for the same reason lane membership is — this is where the blind lens
  // lives, and a colour read from raw applied_code_details would leak "a
  // colleague coded this" through a channel D28 already closed.
  //
  // The category itself carries no usable colour: `chordCategories` is derived
  // from the CODES list and keeps only {id, name}. `getCodeColor` resolves
  // code → category_color → default anyway, so keying on the code is both the
  // reachable answer and the finer-grained one.
  const clipFill = useCallback((clip: ObservationSegment, laneKey: string) => {
    const visible = distinctVisibleCodeIds(clip.applied_code_details, chipHidden)
    const inLane = laneCodeIds(visible, laneKey, codeToCategoryId)
    if (inLane.length === 0) return null
    // `codes` is in the backend's display_order, so a clip carrying several
    // codes from one category always takes the same one's colour.
    //
    // ⚠️ UNIVERSAL codes are excluded, and the live drive is what caught it:
    // the fixture codes were all non-universal, so nothing failed, but on real
    // data a clip marked "Unclear" took ITS colour and named it in the tooltip
    // ahead of the substantive code beside it. "Unclear"/"Unsubstantive" are
    // process markers — the project's own definition of coded is ≥1
    // NON-universal application (J-A, `isSegmentCoded`), so a universal-only
    // clip correctly gets no fill and keeps the neutral teal.
    const ordered = codes.filter(c => !c.is_universal && inLane.includes(c.id))
    if (ordered.length === 0) return null
    return {
      colors: ordered.slice(0, MAX_CLIP_FILL_BANDS).map(getCodeColor),
      codeNames: ordered.map(c => c.name),
      overflow: Math.max(0, ordered.length - MAX_CLIP_FILL_BANDS),
    }
  }, [codes, chipHidden, codeToCategoryId])

  // ── The ?clip= deep-link (D26) — search / Content / slab-5 cards land here ──
  const [searchParams, setSearchParams] = useSearchParams()
  const clipNavAppliedRef = useRef(false)
  const pendingDeepLinkSeekRef = useRef<number | null>(null)
  useEffect(() => {
    if (clipNavAppliedRef.current || clips.length === 0) return
    const clipParam = searchParams.get('clip')
    if (!clipParam) return
    // WAIT for the element before consuming the link (found live, slab 5c).
    // `seekToTime` gates its element seek on `hasPlayableMedia` and a mounted
    // ref, so firing as soon as the CLIPS arrive set the app clock while the
    // element never moved — and once it loaded, the position reverted. It
    // looked correct for the whole of slab 4e because `?clip=` always seeks to
    // the clip's START, which is exactly what the `&t=`-absent fallback
    // produces: the two values COINCIDED, so the broken seek was invisible
    // until `&t=` made them differ. An observation with no playable media must
    // still consume the link (select + clear), hence the `hasPlayableMedia`
    // arm rather than an unconditional wait.
    if (hasPlayableMedia && !isMediaReady) return
    clipNavAppliedRef.current = true
    const clipId = Number(clipParam)
    const clip = clips.find(c => c.id === clipId)
    if (clip) {
      setSelectedClips([clipId])
      const index = clips.findIndex(c => c.id === clipId)
      if (index >= 0) virtuosoRef.current?.scrollIntoView({ index, behavior: 'auto' })
      // Seek PAUSED — arriving from search must never start the tape (the
      // CodingWorkbench ?segment= posture). `&t=` (slab 5c) lands on a quote's
      // own moment; absent or unparseable, the clip's start.
      //
      // The clamp is EXPLICIT and against the CLIP. `clampMediaSeek` runs
      // inside seekMedia already, but it clamps to the RECORDING's duration —
      // it cannot keep a stale or hand-edited `t` inside the clip the link
      // named, which is the only containment that matters here.
      //
      // ⚠️ The seek is DEFERRED, not called here (found live, slab 5c).
      // Selecting a clip makes `usePlayback`'s selection effect seek to
      // `start − SEEK_LEAD_IN_SECONDS` on the NEXT commit, which silently
      // overwrote a seek issued synchronously alongside the selection — the
      // element landed on 58.5 for a clip starting at 60, no matter what `t`
      // said. Handing the target to an effect declared BELOW usePlayback's
      // makes the ordering explicit: selection seek first, ours last.
      pendingDeepLinkSeekRef.current = deepLinkSeekTarget(clip, searchParams.get('t'))
    }
    setSearchParams({}, { replace: true })
  }, [clips, searchParams, setSearchParams, hasPlayableMedia, isMediaReady])

  // Consumes the deferred deep-link seek. Declared AFTER usePlayback, so on the
  // commit where the selection lands, its selection-seek (start − lead-in) runs
  // first and this one has the last word — which is the whole point.
  useEffect(() => {
    const target = pendingDeepLinkSeekRef.current
    if (target === null || selectedClips.length === 0) return
    pendingDeepLinkSeekRef.current = null
    seekToTime(target)
  }, [selectedClips, seekToTime])

  // ── Rename (the toolbar pencil) ───────────────────────────────────────────
  const commitRename = useCallback(async () => {
    setRenaming(false)
    const name = renameText.trim()
    if (!observation || !name || name === observation.name) return
    try {
      await observationsApi.update(projectId, observationId, { name })
      queryClient.invalidateQueries({ queryKey: ['observation', projectId, observationId] })
      queryClient.invalidateQueries({ queryKey: ['observations', projectId] })
    } catch {
      toast.error('Could not rename the observation.')
    }
  }, [observation, renameText, projectId, observationId, queryClient])

  const siblingIndex = siblings.findIndex(o => o.id === observationId)
  const goToSibling = (offset: number) => {
    const target: Observation | undefined = siblings[siblingIndex + offset]
    if (target) navigate(`/projects/${projectId}/observations/${target.id}`)
  }

  const activeDescendantId =
    selectedClips.length > 0 ? `clip-${selectedClips[selectedClips.length - 1]}` : undefined

  const isVideo = observation?.media_type === 'video'
  const clipListContext: ClipListContext = { activeDescendantId }

  if (!Number.isFinite(observationId)) return null

  return (
    <div className="h-full flex flex-col bg-mm-bg">
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2 px-3.5 py-1.5 border-b border-mm-border-subtle bg-mm-surface flex-wrap">
        <Button
          variant="ghost" size="icon" className="h-7 w-7"
          aria-label={siblings[siblingIndex - 1] ? `Previous observation: ${siblings[siblingIndex - 1].name}` : 'Previous observation'}
          disabled={siblingIndex <= 0}
          onClick={() => goToSibling(-1)}
        >
          <ChevronLeft aria-hidden className="h-4 w-4" />
        </Button>
        {renaming ? (
          <span className="flex items-center gap-1">
            <Input
              autoFocus
              value={renameText}
              onChange={e => setRenameText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') void commitRename()
                if (e.key === 'Escape') setRenaming(false)
              }}
              className="h-7 w-56 text-sm"
              aria-label="Observation name"
            />
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Save name" onClick={() => void commitRename()}>
              <Check aria-hidden className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Cancel rename" onClick={() => setRenaming(false)}>
              <X aria-hidden className="h-4 w-4" />
            </Button>
          </span>
        ) : (
          <span className="flex items-center gap-1 min-w-0">
            <span className="font-medium text-sm truncate max-w-[18rem]">{observation?.name ?? '…'}</span>
            <Button
              variant="ghost" size="icon" className="h-7 w-7" aria-label="Rename observation"
              onClick={() => { setRenameText(observation?.name ?? ''); setRenaming(true) }}
            >
              <Pencil aria-hidden className="h-3.5 w-3.5" />
            </Button>
          </span>
        )}
        <Button
          variant="ghost" size="icon" className="h-7 w-7"
          aria-label={siblings[siblingIndex + 1] ? `Next observation: ${siblings[siblingIndex + 1].name}` : 'Next observation'}
          disabled={siblingIndex < 0 || siblingIndex >= siblings.length - 1}
          onClick={() => goToSibling(1)}
        >
          <ChevronRight aria-hidden className="h-4 w-4" />
        </Button>

        <span className="w-px self-stretch bg-mm-border-subtle mx-1" aria-hidden />

        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Undo" disabled={!history.canUndo} onClick={() => void history.undo()}>
          <Undo2 aria-hidden className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Redo" disabled={!history.canRedo} onClick={() => void history.redo()}>
          <Redo2 aria-hidden className="h-4 w-4" />
        </Button>

        <span className="w-px self-stretch bg-mm-border-subtle mx-1" aria-hidden />

        {/* #754: on a FROZEN observation these two used to vanish from the tab
          * order — native `disabled` removes a control from the accessibility
          * tree's reachable set, so a keyboard user never learned that splitting
          * and merging exist, nor that the reason is the agreed cut set. They
          * stay reachable and say why; the transient reasons (no playhead inside
          * a clip, fewer than two clips selected) stay natively disabled, since
          * those resolve the moment the researcher does the obvious thing. */}
        <Button
          variant="ghost" size="icon" className={cn('h-7 w-7', MODE_DISABLED_CLASS)}
          title={frozen ? FROZEN_OPS_REASON : undefined}
          {...modeDisabledProps({
            label: 'Split clip at playhead',
            blockedReason: frozen ? FROZEN_OPS_REASON : null,
            unavailable: !canSplit,
            onActivate: () => void splitAtPlayhead(),
          })}
        >
          <Scissors aria-hidden className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost" size="icon" className={cn('h-7 w-7', MODE_DISABLED_CLASS)}
          title={frozen ? FROZEN_OPS_REASON : undefined}
          {...modeDisabledProps({
            label: 'Merge selected clips',
            blockedReason: frozen ? FROZEN_OPS_REASON : null,
            unavailable: !canMerge,
            onActivate: () => void mergeSelection(),
          })}
        >
          <Combine aria-hidden className="h-4 w-4" />
        </Button>
        {/* D30's precise/keyboard path for a sub-clip quote — the TOOLBAR home
          * is deliberate: it is the surface a keyboard user reaches by Tab.
          *
          * ⚠️ This comment used to argue the clip rows should have NO context
          * menu, because they are role="option" with no tab stop so a row menu
          * would be mouse-only. That reasoning was wrong and #654 corrected it:
          * `components/SegmentRow.tsx` is also role="option" inside an
          * aria-activedescendant listbox and hosts the richest context menu in
          * the app. The real rule is that a menu must never be the ONLY path to
          * an action — conversations satisfies it with keyboard equivalents,
          * not by refusing the menu. The clip rows now carry one too, and every
          * item on it is redundant with this toolbar, the code rail, or a
          * documented key. Enabled while frozen: a quote is annotation, not
          * segmentation (D22). */}
        <Button
          variant="ghost" size="icon" className="h-7 w-7"
          aria-label="Quote a portion of the selected clip"
          disabled={selectedClip === null}
          onClick={() => {
            if (!selectedClip) return
            setQuoteDraft({ start: selectedClip.start_time, end: selectedClip.end_time })
            setQuoteTarget(selectedClip)
          }}
        >
          <Quote aria-hidden className="h-4 w-4" />
        </Button>

        <span className="w-px self-stretch bg-mm-border-subtle mx-1" aria-hidden />

        {/* D14/D27: Follow — playback drives the clip selection (all clips
          * under the playhead; chords code what is playing). Manual click,
          * arrow nav, pause, or Escape breaks it. */}
        <Button
          variant="ghost" size="sm"
          className={cn('h-6 px-2 text-xs', followOn && 'bg-[hsl(var(--mm-green)/0.15)] text-mm-green-text')}
          aria-pressed={followOn}
          aria-label="Follow playhead"
          title="Follow: playback selects the clips under the playhead, so chords code what is playing. Click, pause, or Escape stops following."
          disabled={!hasPlayableMedia}
          onClick={() => setFollowOn(v => !v)}
        >
          <LocateFixed aria-hidden className="h-3.5 w-3.5 mr-1" /> Follow
        </Button>

        {multiCoder && (
          <>
            <span className="w-px self-stretch bg-mm-border-subtle mx-1" aria-hidden />
            <BlindModeToggle blind={blind} onToggle={toggleReveal} surface="observation_workbench" />
            <CoderCountBadge projectId={projectId} observationId={observationId} enabled={multiCoder} />
          </>
        )}

        <span className="ml-auto flex items-center gap-3 text-xs text-mm-text-secondary tabular-nums">
          {frozen ? (
            <span className="flex items-center gap-1.5">
              <span
                role="img"
                aria-label={FROZEN_BADGE_LABEL}
                className="flex items-center gap-1 rounded-full bg-mm-blue-cell px-2 py-0.5 text-[11px] font-medium text-mm-blue-text"
              >
                <Lock aria-hidden className="h-3 w-3" /> Frozen
              </span>
              <Button
                variant="outline" size="sm" className="h-6 px-2 text-xs"
                onClick={() => setUnfreezeDialogOpen(true)}
              >
                <LockOpen aria-hidden className="h-3 w-3 mr-1" /> Unfreeze…
              </Button>
            </span>
          ) : (
            <Button
              variant="outline" size="sm" className="h-6 px-2 text-xs"
              aria-label={clips.length === 0
                ? 'Freeze segmentation — there are no clips to freeze yet'
                : 'Freeze segmentation'}
              disabled={clips.length === 0}
              onClick={() => setFreezeDialogOpen(true)}
            >
              <Lock aria-hidden className="h-3 w-3 mr-1" /> Freeze segmentation
            </Button>
          )}
          {/* The coverage gauge (6a — D33): ONE number-bearing region, absorbing
            * what used to be a bare clip count. Freeze-branched, because the two
            * modes measure different things (§8d): an OPEN clip set has no honest
            * denominator except the timeline itself (mark one clip, code it, and
            * an N-of-M would read 100%), while a FROZEN one fixed M before any
            * coding. Blind scope is labelled, never silently different (#517). */}
          <span
            className="flex items-center gap-1.5"
            {...(coverageProgress !== null
              ? {
                  role: 'progressbar' as const,
                  'aria-valuemin': 0,
                  'aria-valuemax': coverageProgress.max,
                  'aria-valuenow': coverageProgress.now,
                  'aria-valuetext': coverageProgress.text,
                }
              : {})}
            title={blind
              ? "Colleagues' coding is hidden (blind coding) — this count reflects only coding visible to you. The observations list and Overview show all coders' coverage."
              : coverageProgress?.text}
          >
            <span>
              {clips.length} clip{clips.length === 1 ? '' : 's'}
              {frozen ? (
                clips.length > 0 && <> · {frozenCoverage.codedVisible} of {frozenCoverage.total} coded</>
              ) : (
                coveragePercent !== null && (
                  <>
                    {' '}· {coveragePercent}% {durationIsKnown ? 'covered' : 'of marked extent'}
                    {coverageGaps.length > 0 && <> · {coverageGaps.length} gap{coverageGaps.length === 1 ? '' : 's'}</>}
                  </>
                )
              )}
              {observation?.media_duration_seconds != null && (
                <> · {formatTimestamp(observation.media_duration_seconds)}</>
              )}
            </span>
          </span>
        </span>
      </div>

      {/* ── The horizontal split (slab 4d): content column + the coding rail ── */}
      <div className="flex-1 min-h-0 flex">
      {/* ── Video / audio + clip list ── */}
      <div className="flex-1 min-w-0 flex flex-col">
        {isVideo && hasPlayableMedia && observation && (
          <div className="flex-shrink-0">
            <VideoPane
              key={observationId}
              ref={videoPaneHandleRef}
              projectId={projectId}
              ownerKind="observation"
              ownerId={observationId}
              mediaRef={mediaElementRef}
              mediaVersion={observation.media_version}
              segments={clips}
              mediaDuration={observation.media_duration_seconds}
              mediaOffset={0}
              isVbr={observation.media_is_vbr === true}
              isPlaying={isPlaying}
              isMediaReady={isMediaReady}
              isBuffering={isBuffering}
              mediaError={mediaError}
              isTranscriptOnly={isTranscriptOnly}
              currentTime={currentPlaybackTime}
              playbackSpeed={playbackSpeed}
              onTogglePlayback={togglePlayback}
              onCycleSpeed={cyclePlaybackSpeed}
              onTimeChange={(t) => { handleTimeSeek(t) }}
              // #662: the ClipTimeline below is the seek surface — wider, with
              // a hover time ticker, and the one the clips are actually drawn
              // against. A second slider at a different scale meant reading one
              // and clicking the other; the divergence reached 31 s at the tail.
              hasExternalScrubber
            />
          </div>
        )}
        {!isVideo && hasPlayableMedia && observation && (
          // Audio observation: the hidden element + a minimal transport row.
          // The full transport (J-K-L, the timeline) arrives in 3d.
          <div className="flex items-center gap-2 px-3.5 py-1.5 border-b border-mm-border-subtle bg-mm-surface text-xs text-mm-text-secondary">
            <audio
              ref={(el) => { mediaElementRef.current = el }}
              src={`/api/projects/${projectId}/observations/${observationId}/media/stream${observation.media_version ? `?v=${encodeURIComponent(observation.media_version)}` : ''}`}
              preload="metadata"
            />
            <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={togglePlayback} disabled={!isMediaReady}>
              {isPlaying ? 'Pause' : 'Play'}
            </Button>
            <span className="tabular-nums">
              {formatTimecode(currentPlaybackTime ?? 0)}
              {observation.media_duration_seconds != null && <> / {formatTimestamp(observation.media_duration_seconds)}</>}
            </span>
            {mediaError && <span className="text-destructive">{mediaError}</span>}
          </div>
        )}

        <ClipTimeline
          clips={clips}
          lanes={timelineLanes}
          extentSeconds={timelineExtent}
          codedIntervals={codedIntervals}
          clipFill={clipFill}
          frozen={frozen}
          recordingEndSeconds={recordingEnd}
          currentTime={currentPlaybackTime}
          selectedIds={selectedClips}
          nowPlayingIds={nowPlayingIds}
          armedInTime={armedInTime}
          isPlaying={isPlaying}
          boundaryPreview={boundaryPreview}
          onSeek={seekWithoutPausing}
          onClipClick={(id, e) => {
            setFollowOn(false) // a manual click breaks Follow (D14)
            selection.handleItemClick(id, e)
          }}
          onCreateRange={(start, end) => {
            // Sub-0.1s drags are pointer noise, not a unit; a deliberate
            // instant is P / double-click (a point event).
            if (end - start >= 0.1) void createClipWithHistory(start, end)
          }}
          onCreatePoint={(t) => { void createClipWithHistory(t, t) }}
          onShowShortcuts={openKeyboardHelp}
          onBoundaryCommit={(clipId, edge, value) => {
            if (frozen) { refuseFrozen(); return }
            const clip = clips.find(c => c.id === clipId)
            if (!clip) return
            const base = edge === 'start' ? clip.start_time : clip.end_time
            void commitBoundary(clipId, edge, value, base)
          }}
        />

        {/* The precise boundary path (a11y + exact entry): timecode inputs for
          * the single-selected clip. Nudges preview here too via boundaryPreview. */}
        {selectedClips.length === 1 && (() => {
          const clip = clips.find(c => c.id === selectedClips[0])
          if (!clip) return null
          const startValue = boundaryPreview?.clipId === clip.id && boundaryPreview.edge === 'start'
            ? boundaryPreview.value : clip.start_time
          const endValue = boundaryPreview?.clipId === clip.id && boundaryPreview.edge === 'end'
            ? boundaryPreview.value : clip.end_time
          const commitField = (edge: 'start' | 'end') => (v: number) => {
            if (frozen) { refuseFrozen(); return }
            flushNudge()
            const clamped = clampBoundary(edge, v, clip)
            const base = edge === 'start' ? clip.start_time : clip.end_time
            void commitBoundary(clip.id, edge, clamped, base)
          }
          return (
            <div className="flex items-center gap-2 px-3.5 py-1 border-b border-mm-border-subtle bg-mm-surface text-xs text-mm-text-secondary">
              <span className="font-medium">Selected clip</span>
              <label className="flex items-center gap-1">
                Start
                <TimecodeField label="Start time" value={startValue} onCommit={commitField('start')} />
              </label>
              <label className="flex items-center gap-1">
                End
                <TimecodeField label="End time" value={endValue} onCommit={commitField('end')} />
              </label>
              <span className="tabular-nums text-mm-text-faint">
                {clip.start_time === clip.end_time ? 'point event' : formatTimecode(endValue - startValue)}
              </span>
            </div>
          )
        })()}

        {/* Nudge/drag commits are announced here — the visual timeline is
          * aria-hidden, so this is what a screen reader hears (§8h.4). */}
        <div role="status" aria-live="polite" className="sr-only" data-testid="clip-announce">{announceText}</div>

        {/* ⚠️ The search box used to live INSIDE the column-header flex, where
          * it consumed 196 px of the `flex-1` Label track that the ROWS give to
          * the label. Measured: "Codes" sat at x=688 over a column that starts
          * at 884, and "Notes" at 876 over one at 1072 — both a full 196 px
          * left of what they name, which put the "Codes" header directly over
          * the label text. A long VTT cue then read as bleeding into the codes
          * column, when in truth the HEADER was in the wrong place.
          *
          * It gets its own row now, so the header below mirrors the row's
          * column model EXACTLY: w-28 / flex-1 / w-44 / w-16, gap-3, px-3.5.
          * Change one and change the other — `ObservationWorkbench.test.tsx`
          * asserts they agree. */}
        <div className="flex items-center justify-end px-3.5 py-1 border-b border-mm-border-subtle bg-mm-surface">
          <span className="relative">
            <Search aria-hidden className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-mm-text-faint" />
            <Input
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              placeholder="Search clips…"
              aria-label="Search clips"
              className="h-6 w-44 pl-7 text-xs"
            />
          </span>
        </div>

        {/* Column header — mirrors the clip row's columns exactly (see above) */}
        <div
          data-testid="clip-column-header"
          className="flex items-start gap-3 px-3.5 py-1.5 border-b border-mm-border-subtle bg-mm-surface text-xs text-mm-text-secondary"
          style={{ paddingRight: `calc(0.875rem + ${clipGutter.gutter}px)` }}
        >
          <span className="w-28 flex-none">Time</span>
          <span className="flex-1 min-w-0">Label</span>
          <span data-col="codes" className="w-44 flex-none flex items-center gap-1.5">
            Codes
            {coders.length > 1 && !blind && (
              <CoderFilterPopover
                coders={coders}
                activeCoderId={selfId}
                hidden={hiddenCoders}
                onChange={setHiddenCoders}
                activeCoderIds={coderCoverage.isLoaded ? coderCoverage.activeCoderIds : undefined}
                extraCoders={coderCoverage.extraCoders}
                showArchived={showArchivedCoders}
                onShowArchivedChange={setShowArchivedCoders}
              />
            )}
          </span>
          <span data-col="notes" className="w-16 flex-none text-right">Notes</span>
          {/* Row actions get a track but no name (#740) — the header names data
              columns; naming this one is what put "Notes" over a delete button. */}
          <span className="w-8 flex-none" aria-hidden />
        </div>

        {clips.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-sm text-mm-text-secondary px-6 text-center">
            No clips yet. Press <kbd className="px-1 border border-mm-border-medium rounded">I</kbd> while
            the recording plays, then <kbd className="px-1 border border-mm-border-medium rounded">O</kbd>, to
            mark your first clip — or drag a range on the timeline above.
          </div>
        ) : (
          <div className="flex-1 min-h-0">
            <Virtuoso<ObservationSegment, ClipListContext>
              ref={virtuosoRef}
              scrollerRef={clipGutter.setScroller}
              data={filteredClips}
              context={clipListContext}
              components={clipListComponents}
              computeItemKey={(_i, clip) => clip.id}
              itemContent={(index, clip) => {
                const selected = selectedClips.includes(clip.id)
                const { range, duration } = clipTimeLabel(clip)
                const editing = editingClipId === clip.id
                // Blind rule: the chip widget's PRESENCE must key on VISIBLE
                // rows (a widget appearing on colleague-only-coded clips would
                // leak "someone coded this" through blind mode). Selection
                // additionally shows it so the + affordance is reachable.
                const hasVisibleChips =
                  visibleCodeChipRows(clip.applied_code_details, chipHidden).length > 0
                // Shape-AGNOSTIC (D30/D32): a clip quoted only by a sub-clip
                // range IS quoted to the researcher. The `s` TOGGLE still reads
                // wholeQuoted — display and toggle are different questions.
                const quoted = anyQuoted.has(clip.id)
                // Position in the FULL clip list, not the filtered view: "next"
                // must mean the next clip on the TIMELINE, not the next one that
                // happens to match the search box.
                const clipIndex = clips.findIndex(c => c.id === clip.id)
                // D27: the timeline is aria-hidden — the LIST row carries the
                // accessible now-playing/coded state. Selection wins visually.
                const nowPlaying = nowPlayingIds.has(clip.id)
                return (
                  /* #654 — the clip-row context menu. Radix's Root renders NO
                   * DOM node and Trigger `asChild` clones its child, so the
                   * listbox → presentation → option ownership (#436/#484)
                   * survives this wrapper; `ObservationWorkbench.test.tsx`
                   * pins that rather than trusting it. Every item here is a
                   * SECOND path to something already reachable from the
                   * toolbar, the code rail, or a key in the shortcuts dialog —
                   * the menu is never the only way to do anything. */
                  <ContextMenu>
                  <ContextMenuTrigger asChild>
                  <div
                    id={`clip-${clip.id}`}
                    role="option"
                    aria-selected={selected}
                    // #751: the real length of the set being arrowed through.
                    // `index` is Virtuoso's index into `data` (= `filteredClips`),
                    // not the render window's, so it and `filteredClips.length`
                    // are the same fact from the same array — which is the point.
                    // With the search box active this correctly reports the
                    // FILTERED count; "of 13" while 3 rows are reachable would
                    // just be a different wrong number.
                    {...optionPositionAria(index + 1, filteredClips.length)}
                    // "— quoted" joins the composite name (D30): the indicator
                    // beside it is a role="img" sibling, which a browse-mode
                    // reader only meets by touring INTO the row — so a sub-clip
                    // quote would otherwise be invisible from the list.
                    aria-label={
                      `${range}${clip.text ? ` — ${clip.text}` : ''}` +
                      `${hasVisibleChips ? ' — coded' : ''}${quoted ? ' — quoted' : ''}` +
                      `${nowPlaying ? ' — now playing' : ''}`
                    }
                    className={cn(
                      'flex items-start gap-3 px-3.5 py-2 border-b border-mm-border-subtle bg-mm-surface text-sm cursor-default',
                      selected ? SELECTED_ROW : nowPlaying ? NOW_PLAYING_ROW : undefined,
                    )}
                    onClick={(e) => {
                      setFollowOn(false) // a manual click breaks Follow (D14)
                      selection.handleItemClick(clip.id, e)
                    }}
                    onDoubleClick={() => startLabelEdit(clip)}
                    // Right-click on an UNSELECTED row selects it (SegmentRow's
                    // rule) so the menu's selection-scoped items act on what was
                    // clicked. Right-click INSIDE an existing multi-selection
                    // leaves it intact — otherwise "Merge selected clips" could
                    // never be reached from the menu at all.
                    onContextMenu={() => {
                      if (!selected) {
                        setFollowOn(false)
                        setSelectedClips([clip.id])
                      }
                    }}
                  >
                    <span className="w-28 flex-none text-xs text-mm-text-secondary tabular-nums pt-0.5">
                      {range}
                      <br />
                      <span className="text-mm-text-faint">{duration}</span>
                    </span>
                    {editing ? (
                      <Input
                        autoFocus
                        value={editingLabel}
                        onChange={e => setEditingLabel(e.target.value)}
                        onBlur={() => void commitLabelEdit()}
                        onKeyDown={e => {
                          if (e.key === 'Enter') void commitLabelEdit()
                          if (e.key === 'Escape') setEditingClipId(null)
                        }}
                        onClick={e => e.stopPropagation()}
                        className="h-7 flex-1 text-sm"
                        aria-label="Clip label"
                      />
                    ) : (
                      <span className={cn('flex-1 min-w-0', !clip.text && 'italic text-mm-text-faint')}>
                        {clip.text || 'Unlabeled clip — press F2 to label'}
                      </span>
                    )}
                    <span data-col="codes" className="w-44 flex-none flex items-center pt-0.5">
                      {(selected || hasVisibleChips) && !editing && (
                        <InlineCodeActions
                          projectId={projectId}
                          itemType="segment"
                          itemId={clip.id}
                          appliedCodeIds={clip.applied_codes}
                          codeMap={codeMap}
                          allCodes={codes}
                          onCodeChange={invalidateAfterCodeChange}
                          onFocusCode={handleFocusCode}
                          appliedCodeDetails={clip.applied_code_details}
                          coderMap={chipCoderMap}
                          hiddenCoderIds={chipHidden}
                        />
                      )}
                    </span>
                    {/* #740: this column is what the "Notes" header NAMES — quote
                        status and the notes themselves. Delete moved to its own
                        unlabelled track below: a header names a data column, not
                        a row action, and on a clip with no note (12 of 13 in the
                        live fixture) this cell was nothing but a trash can under
                        the word "Notes". */}
                    <span data-col="notes" className="w-16 flex-none flex items-center justify-end gap-1 flex-wrap pt-0.5">
                      {quoted && (
                        <Quote
                          role="img"
                          aria-label="Quoted clip"
                          className="h-3.5 w-3.5 text-mm-text-faint"
                        />
                      )}
                      {/* One badge PER note, carrying its sequence number and
                          opening it — the SegmentRow affordance (D11). The count
                          badge it replaces was `role="img"`, so a clip with three
                          notes offered no way to reach any particular one. The
                          payload already carried `sequence_number`. */}
                      {/* #747: numbered by the note's OWN `sequence_number`
                          again. This rendered by POSITION for one release
                          because observation notes were all stored as 0 — a
                          display-side label over a backend gap, which the export
                          and the Memos & Notes page (both quoting the stored
                          number) could not use. The numbers are real now, so
                          expect gaps: deleting note 2 leaves 1 and 3, which is
                          what a stable label looks like. */}
                      {clip.attached_notes.map(note => (
                        <button
                          key={note.id}
                          type="button"
                          aria-label={`Note ${note.sequence_number} on clip ${range}`}
                          title={`Note ${note.sequence_number} — click to view`}
                          className="w-5 h-5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 text-[10px] font-bold flex items-center justify-center hover:bg-amber-200 dark:hover:bg-amber-800/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={(e) => { e.stopPropagation(); handleNoteClick(note.id) }}
                        >
                          {note.sequence_number}
                        </button>
                      ))}
                    </span>
                    {/* Row actions — deliberately unlabelled in the header. */}
                    <span className="w-8 flex-none flex items-center justify-end pt-0.5">
                      <Button
                        variant="ghost" size="icon"
                        className="h-6 w-6 text-mm-text-faint hover:text-destructive"
                        aria-label={`Delete clip ${range}${clip.text ? ` — ${clip.text}` : ''}`}
                        disabled={frozen}
                        onClick={(e) => { e.stopPropagation(); void deleteClip(clip) }}
                      >
                        <Trash2 aria-hidden className="h-3.5 w-3.5" />
                      </Button>
                    </span>
                  </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-60">
                    {/* Coding — the rail and the chord keys do the same thing. */}
                    <ContextMenuSub>
                      <ContextMenuSubTrigger>Apply Code</ContextMenuSubTrigger>
                      <ContextMenuSubContent className="max-h-64 overflow-y-auto w-56">
                        {/* Parity with SegmentRow: the menu can also MAKE the
                          * code, which is the answer when none of the listed
                          * ones fit — and the same create-and-apply gesture as
                          * `c`, so a project with no codes yet is not a dead
                          * end here. */}
                        <ContextMenuItem
                          onClick={() => openCreateCodeDialog(
                            selected ? selectedClips : [clip.id],
                          )}
                        >
                          New Code…
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        {codes.filter(c => c.is_active).length === 0 ? (
                          <ContextMenuItem disabled>No codes yet</ContextMenuItem>
                        ) : codes.filter(c => c.is_active).map(code => {
                          // INV-6 (#446): "do I have it?", never "does anyone?" —
                          // the same chokepoint the chips and the chord use, so a
                          // colleague's code never reads as mine.
                          const isApplied = isCodeAppliedByActiveCoder(
                            clip.applied_code_details, clip.applied_codes ?? [], code.id, selfId,
                          )
                          return (
                            <ContextMenuItem key={code.id} onClick={() => handleCodeToggle(code)}>
                              <span className="flex items-center gap-2 flex-1 min-w-0">
                                {isApplied
                                  ? <Check aria-hidden className="w-3 h-3 text-mm-green-text flex-shrink-0" />
                                  : <span className="w-3 flex-shrink-0" />}
                                <span
                                  aria-hidden
                                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                                  style={{ backgroundColor: getCodeColor(code) }}
                                />
                                <span className={cn('truncate', isApplied && 'font-medium')}>{code.name}</span>
                              </span>
                              {/* The menu is also where the KEY gets taught —
                                * a researcher who never opens the shortcuts
                                * dialog still meets it here, on the way to
                                * doing the thing by mouse. */}
                              {codeIdToShortcutLabel.get(code.id) && (
                                <span className="text-xs text-mm-text-faint ml-2 font-mono flex-shrink-0">
                                  {codeIdToShortcutLabel.get(code.id)}
                                </span>
                              )}
                            </ContextMenuItem>
                          )
                        })}
                      </ContextMenuSubContent>
                    </ContextMenuSub>
                    <ContextMenuItem onClick={() => openNoteDialog(clip.id)}>
                      Add Note
                    </ContextMenuItem>

                    <ContextMenuSeparator />

                    {/* #669 — Conversations carries four clipboard actions and
                      * Documents two; clips had none. A clip's quotable content
                      * is its LABEL and, just as often, its TIME RANGE — that is
                      * what gets pasted into a memo or a paper. */}
                    <ContextMenuItem
                      onClick={() => void navigator.clipboard?.writeText(range)}
                    >
                      Copy Timecode Range
                    </ContextMenuItem>
                    <ContextMenuItem
                      disabled={!clip.text}
                      onClick={() => void navigator.clipboard?.writeText(clip.text ?? '')}
                    >
                      Copy Label
                    </ContextMenuItem>
                    <ContextMenuItem
                      onClick={() => void navigator.clipboard?.writeText(
                        // Mirrors SegmentRow's `"text" - speaker` shape, with the
                        // observation and timecode standing in for the speaker —
                        // a clip's attribution is WHERE it is, not who spoke.
                        clip.text
                          ? `"${clip.text}" — ${observation?.name ?? 'Observation'}, ${range}`
                          : `${observation?.name ?? 'Observation'}, ${range}`,
                      )}
                    >
                      Copy as Quote
                    </ContextMenuItem>

                    <ContextMenuSeparator />

                    {/* Annotation — legal while frozen (D22/D29). */}
                    <ContextMenuItem onClick={() => startLabelEdit(clip)}>
                      Rename Label
                    </ContextMenuItem>
                    <ContextMenuItem onClick={handleToggleQuote}>
                      {wholeQuoted.has(clip.id) ? 'Unquote Clip' : 'Quote Clip'}
                    </ContextMenuItem>
                    <ContextMenuItem
                      onClick={() => {
                        setQuoteDraft({ start: clip.start_time, end: clip.end_time })
                        setQuoteTarget(clip)
                      }}
                    >
                      Quote a Portion…
                    </ContextMenuItem>

                    <ContextMenuSeparator />

                    {/* Segmentation — the clip SET, so all three refuse while
                      * frozen (D22). Split reads the ROW's clip, not the shared
                      * selection, for the reason splitAtPlayhead documents. */}
                    <ContextMenuItem
                      disabled={frozen || !playheadInside(clip)}
                      onClick={() => void splitAtPlayhead(clip)}
                    >
                      Split at Playhead
                    </ContextMenuItem>
                    {/* #670 — adjacent merge from a SINGLE selection, the
                      * Conversations affordance. `clips` is sequence_order'd
                      * (resequenced by time after every op), so neighbours are
                      * simply the next and previous entries. */}
                    <ContextMenuItem
                      disabled={frozen || clipIndex < 0 || clipIndex >= clips.length - 1}
                      onClick={() => void mergeClipIds([clip.id, clips[clipIndex + 1].id])}
                    >
                      Merge with Next
                    </ContextMenuItem>
                    <ContextMenuItem
                      disabled={frozen || clipIndex <= 0}
                      onClick={() => void mergeClipIds([clips[clipIndex - 1].id, clip.id])}
                    >
                      Merge with Previous
                    </ContextMenuItem>
                    <ContextMenuItem disabled={!canMerge} onClick={() => void mergeSelection()}>
                      Merge Selected Clips
                    </ContextMenuItem>
                    <ContextMenuItem
                      disabled={frozen}
                      className="text-destructive focus:text-destructive"
                      onClick={() => void deleteClip(clip)}
                    >
                      Delete Clip
                    </ContextMenuItem>
                  </ContextMenuContent>
                  </ContextMenu>
                )
              }}
            />
          </div>
        )}
      </div>

      {/* ── The coding rail (slab 4d): Codes / Notes / Memos, whole-column
        * collapsible to a slim icon rail (the CodingWorkbench #39 pattern). ── */}
      {rightColumn.collapsed ? (
        <div
          role="toolbar"
          aria-orientation="vertical"
          aria-label="Panels (collapsed)"
          className="w-10 flex-shrink-0 flex flex-col items-center gap-1 py-2 bg-mm-surface border-l border-mm-border-subtle"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={rightColumn.expand} aria-label="Expand panels">
                <PanelRightOpen className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left" className="text-xs">Expand panels</TooltipContent>
          </Tooltip>
          <span className="w-5 h-px bg-mm-border-subtle my-1" />
          {([
            { key: 'codes' as const, label: 'Codes', Icon: Tags, focus: () => codePanelRef.current?.focus() },
            { key: 'notes' as const, label: 'Notes', Icon: StickyNote, focus: () => notesPanelRef.current?.focusInput() },
            { key: 'memos' as const, label: 'Memos', Icon: NotebookPen, focus: () => memoPanelRef.current?.focus() },
          ]).map(({ key, label, Icon, focus }) => (
            <Tooltip key={key}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  aria-label={`Open ${label}`}
                  onClick={() => {
                    rightColumn.expand()
                    expandPanelIfCollapsed(key)
                    setFocusedPanel(key)
                    requestAnimationFrame(() => focus())
                  }}
                >
                  <Icon className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs">{label}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      ) : (
        <div className="relative flex flex-col bg-mm-surface overflow-hidden w-80 shrink-0 border-l border-mm-border-subtle">
          <CollapsiblePanel
            title="Codes"
            isCollapsed={panelStates.codes.collapsed}
            onToggle={() => togglePanel('codes')}
            className={panelStates.codes.collapsed ? '' : 'flex-[2] min-h-0'}
            headerExtra={
              <button
                onClick={(e) => { e.stopPropagation(); rightColumn.collapse() }}
                aria-label="Collapse panels"
                title="Collapse panels — reclaim width for the video and clip list"
                className="text-mm-text-muted hover:text-mm-text-secondary transition-colors"
              >
                <PanelRightClose className="w-3.5 h-3.5" />
              </button>
            }
          >
            <PageErrorBoundary>
              <CodePanel
                ref={codePanelRef}
                codes={codes}
                projectId={projectId}
                /* #752: this workbench codes CLIPS, not segments. */
                disabledHint="Select a clip to apply codes."
                selectedCodesMap={selectedCodesMap}
                onCodeToggle={handleCodeToggle}
                onMultiCodeToggle={handleMultiCodeToggle}
                onCreateCode={(name) => createCodeMutation.mutate(name)}
                onAddCodeMemo={(codeId, codeName) => {
                  rightColumn.expand()
                  expandPanelIfCollapsed('memos')
                  setFocusedPanel('memos')
                  setCreateMemoForCode({ id: codeId, name: codeName })
                }}
                disabled={selectedClips.length === 0}
                categories={chordCategories}
                isFocused={focusedPanel === 'codes'}
                onFocusChange={(focused) => setFocusedPanel(focused ? 'codes' : 'list')}
                onNavigateToTranscript={() => setFocusedPanel('list')}
                onNavigateToPrevPanel={() => setFocusedPanel('list')}
                onNavigateToNextPanel={() => {
                  if (!panelStates.notes.collapsed) setFocusedPanel('notes')
                  else if (!panelStates.memos.collapsed) setFocusedPanel('memos')
                }}
              />
            </PageErrorBoundary>
          </CollapsiblePanel>

          <CollapsiblePanel
            title="Notes"
            isCollapsed={panelStates.notes.collapsed}
            onToggle={() => togglePanel('notes')}
            className={panelStates.notes.collapsed ? '' : 'flex-1 min-h-0'}
            headerExtra={
              <span className="text-xs text-mm-text-faint">{obsNotes.length}</span>
            }
          >
            <PageErrorBoundary>
              <ObservationNotesPanel
                ref={notesPanelRef}
                notes={obsNotes}
                clipMap={clipMap}
                selectedClipId={selectedClips.length === 1 ? selectedClips[0] : null}
                noteInput={noteInput}
                onNoteInputChange={setNoteInput}
                onCreateNote={handleCreateNote}
                isCreating={createNoteMutation.isPending}
                onJumpToClip={(segId) => {
                  setSelectedClips([segId])
                  const index = filteredClips.findIndex(c => c.id === segId)
                  if (index >= 0) virtuosoRef.current?.scrollIntoView({ index, behavior: 'auto' })
                }}
              />
            </PageErrorBoundary>
          </CollapsiblePanel>

          <CollapsiblePanel
            title="Memos"
            isCollapsed={panelStates.memos.collapsed}
            onToggle={() => togglePanel('memos')}
            className={panelStates.memos.collapsed ? '' : 'flex-1 min-h-0'}
          >
            <PageErrorBoundary>
              <MemoPanel
                ref={memoPanelRef}
                projectId={projectId}
                entityId={observationId}
                entityType="observation"
                codes={codes}
                createForCode={createMemoForCode}
                onCreateForCodeHandled={() => setCreateMemoForCode(null)}
                isFocused={focusedPanel === 'memos'}
                onFocusChange={focused => { if (focused) setFocusedPanel('memos') }}
                onNavigateToTranscript={() => setFocusedPanel('list')}
                onNavigateToPrevPanel={() => {
                  if (!panelStates.notes.collapsed) setFocusedPanel('notes')
                  else if (!panelStates.codes.collapsed) setFocusedPanel('codes')
                }}
                onNavigateToNextPanel={() => {}}
              />
            </PageErrorBoundary>
          </CollapsiblePanel>
        </div>
      )}
      </div>

      {/* Chord shortcut indicator (the CodingWorkbench HUD, verbatim) */}
      {chordPrefix !== null && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-mm-surface border border-mm-border-medium rounded-lg px-4 py-2 shadow-lg z-50">
          <span className="text-sm font-mono text-mm-text">{chordPrefix}.</span>
          <span className="text-sm text-mm-text-muted ml-1">{pendingCategoryName || 'Category'} — press 1-9</span>
        </div>
      )}
      {/* The armed mark's own HUD (slab 5b): `s` gains a second meaning while a
        * mark is armed, so the surface has to say so — until now "armed" was
        * visible ONLY inside the aria-hidden timeline. Mutually exclusive with
        * the chord HUD in practice (a chord commits or clears first). */}
      {chordPrefix === null && armedInTime !== null && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-mm-surface border border-mm-border-medium rounded-lg px-4 py-2 shadow-lg z-50">
          <span className="text-sm font-mono text-mm-text">{formatTimecode(armedInTime)}</span>
          <span className="text-sm text-mm-text-muted ml-1">
            marked — <kbd className="font-mono">O</kbd> to cut a clip, <kbd className="font-mono">S</kbd> to quote the range
          </span>
        </div>
      )}

      <ConfirmDialog
        open={freezeDialogOpen}
        onOpenChange={setFreezeDialogOpen}
        title="Freeze the clip set?"
        description={`${FROZEN_CONSEQUENCES} ${FREEZE_BEFORE_YOU_DISTRIBUTE}`}
        confirmLabel="Freeze segmentation"
        onConfirm={() => void confirmFreeze()}
      />
      <ConfirmDialog
        open={unfreezeDialogOpen}
        onOpenChange={setUnfreezeDialogOpen}
        title="Unfreeze the clip set?"
        description={UNFREEZE_CONSEQUENCES}
        confirmLabel="Unfreeze"
        onConfirm={() => void confirmUnfreeze()}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title="Delete this clip?"
        description={deleteTarget ? describeClipDeletion(deleteTarget, anyQuoted.has(deleteTarget.id)) : ''}
        confirmLabel="Delete clip"
        onConfirm={() => void confirmAnnotatedDelete()}
      />

      {/* `c` / the row menu's "New Code…" — create AND apply in one gesture
        * (#665), the conversation + document workbench flow. The clip ids are
        * the ones CAPTURED when the dialog opened, not the live selection: the
        * researcher may click elsewhere while the dialog is up, and the code
        * belongs to what they were looking at when they pressed the key. */}
      {createCodeDialog && (
        <FloatingCreateCode
          position={createCodeDialog.position}
          projectId={projectId}
          categories={categories}
          initialName={createCodeDialog.initialName}
          onCreated={(code) => {
            const clipIds = createCodeDialog.clipIds
            setCreateCodeDialog(null)
            applyCodeToClips(clipIds, code)
          }}
          onClose={() => setCreateCodeDialog(null)}
        />
      )}

      {/* `n` / the row menu's Add Note — anchored at the clip (#671) */}
      {createNoteDialog && (
        <FloatingCreateNote
          position={createNoteDialog.position}
          isPending={createNotePending}
          onSubmit={async (content) => {
            setCreateNotePending(true)
            try {
              await notesApi.createForObservation(projectId, observationId, {
                content,
                segment_id: createNoteDialog.clipId,
              })
              queryClient.invalidateQueries({ queryKey: ['observation-notes', projectId, observationId] })
              invalidateClips()   // the row's note badge counts them
              setCreateNoteDialog(null)
              rightColumn.expand()
              expandPanelIfCollapsed('notes')
            } finally {
              setCreateNotePending(false)
            }
          }}
          onClose={() => setCreateNoteDialog(null)}
        />
      )}

      {/* D30: quote a portion of a clip by exact timecode. A form, so it uses
        * Dialog rather than ConfirmDialog (an AlertDialog). Validation lives
        * HERE because TimecodeField commits per field while containment spans
        * both — and it is the same `clipContainsRange` the backend mirrors, so
        * a refusal is named before the request rather than after it. */}
      <Dialog open={quoteTarget !== null} onOpenChange={(open) => { if (!open) setQuoteTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Quote a portion of this clip</DialogTitle>
            <DialogDescription>
              {quoteTarget
                ? `The quote must sit inside the clip (${formatTimecode(quoteTarget.start_time)}–${formatTimecode(quoteTarget.end_time)}). Equal times mark a single moment.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-end gap-3">
            <TimecodeField
              label="Quote start time"
              value={quoteDraft.start}
              onCommit={(v) => setQuoteDraft(d => ({ ...d, start: v }))}
            />
            <TimecodeField
              label="Quote end time"
              value={quoteDraft.end}
              onCommit={(v) => setQuoteDraft(d => ({ ...d, end: v }))}
            />
          </div>
          {quoteTarget && !clipContainsRange(quoteTarget, quoteDraft) && (
            <p role="alert" className="text-xs text-mm-rose-text">
              That range falls outside the clip.
            </p>
          )}
          {quoteDraft.end < quoteDraft.start && (
            <p role="alert" className="text-xs text-mm-rose-text">
              The end time must not come before the start time.
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setQuoteTarget(null)}>Cancel</Button>
            <Button
              disabled={
                !quoteTarget
                || quoteDraft.end < quoteDraft.start
                || !clipContainsRange(quoteTarget, quoteDraft)
              }
              onClick={() => {
                const range = { start: quoteDraft.start, end: quoteDraft.end }
                const clip = quoteTarget
                setQuoteTarget(null)
                if (clip) void quoteRange(range, clip)
              }}
            >
              Quote range
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── The observation notes panel (slab 4d — the DocumentNotesPanel pattern) ──
//
// Notes are observation-level or clip-anchored (the Note CHECK requires
// observation_id either way — a clip note keeps its parent when the clip dies,
// which is why delete_clip can honestly say "notes detach to the observation").
// The anchor badge shows the clip's TIMECODE, resolved from the workbench's
// clip list — the wire carries only the clip's sequence_order + label snippet.

interface ObservationNotesPanelHandle {
  focusInput: () => void
  /** Scroll a specific note into view and flag it (#740).
   *
   *  The clip row's note badge used to be a COUNT with `role="img"` — three
   *  notes on a clip offered no way to reach any particular one, while both
   *  sibling surfaces render one clickable badge per note. This is the other
   *  end of that affordance. Deliberately lighter than `NotesPanel.focusNote`:
   *  that one drives a focused-index/selection state machine this panel does
   *  not have, and porting it to say "here it is" would be the expensive half
   *  of a cheap fix. */
  focusNote: (noteId: number) => void
}

const ObservationNotesPanel = forwardRef<ObservationNotesPanelHandle, {
  notes: ObservationNote[]
  clipMap: Map<number, ObservationSegment>
  selectedClipId: number | null
  noteInput: string
  onNoteInputChange: (value: string) => void
  onCreateNote: () => void
  isCreating: boolean
  onJumpToClip: (segmentId: number) => void
}>(function ObservationNotesPanel({
  notes,
  clipMap,
  selectedClipId,
  noteInput,
  onNoteInputChange,
  onCreateNote,
  isCreating,
  onJumpToClip,
}, ref) {
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [flaggedNoteId, setFlaggedNoteId] = useState<number | null>(null)
  const flagTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (flagTimer.current) clearTimeout(flagTimer.current) }, [])

  useImperativeHandle(ref, () => ({
    focusInput: () => inputRef.current?.focus(),
    focusNote: (noteId: number) => {
      setFlaggedNoteId(noteId)
      if (flagTimer.current) clearTimeout(flagTimer.current)
      // The flag is transient: it answers "which one did I click?" and then
      // gets out of the way. It is NOT selection, but it borrows the selection
      // recipe because that is the single source for "this is the one" — and
      // `SELECTED_ROW` draws its bar as an inset shadow, so applying it cannot
      // shift the row's layout (lib/selection.ts).
      flagTimer.current = setTimeout(() => setFlaggedNoteId(null), 2000)
      // rAF, because the panel may have been collapsed a tick ago and an
      // unmounted node cannot be scrolled to.
      requestAnimationFrame(() => {
        listRef.current
          ?.querySelector(`[data-note-id="${noteId}"]`)
          ?.scrollIntoView({ block: 'nearest' })
      })
    },
  }), [])

  return (
    <div className="h-full flex flex-col">
      {/* Create input — anchored to the single-selected clip, else observation-level */}
      <div className="p-3 border-b space-y-1">
        <div className="flex gap-2">
          <Input
            ref={inputRef}
            value={noteInput}
            onChange={e => onNoteInputChange(e.target.value)}
            onKeyDown={e => {
              if ((e.key === 'Tab' || e.key === 'Enter') && noteInput.trim()) {
                e.preventDefault()
                onCreateNote()
              }
            }}
            placeholder={selectedClipId ? 'Add note to selected clip…' : 'Add observation note…'}
            aria-label={selectedClipId ? 'Add note to selected clip' : 'Add observation note'}
            className="h-8 text-sm"
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={!noteInput.trim() || isCreating}
            onClick={onCreateNote}
            title="Add note (Tab or Enter)"
          >
            <span className="text-xs">Add</span>
          </Button>
        </div>
        <p className="text-xs text-mm-text-faint">
          {selectedClipId
            ? 'The note anchors to the selected clip.'
            : 'No clip selected — the note attaches to the observation.'}
        </p>
      </div>

      {/* Notes list */}
      <div ref={listRef} className="flex-1 overflow-y-auto">
        {notes.length === 0 ? (
          <div className="p-4 text-sm text-mm-text-muted text-center">
            No notes yet
          </div>
        ) : (
          notes.map(note => {
            const clip = note.segment_id != null ? clipMap.get(note.segment_id) : undefined
            return (
              <div
                key={note.id}
                data-note-id={note.id}
                className={`px-3 py-2 border-b border-mm-border-subtle hover:bg-mm-surface-hover cursor-pointer group ${
                  note.id === flaggedNoteId ? SELECTED_ROW : ''
                }`}
                onClick={() => {
                  if (note.segment_id != null && clip) onJumpToClip(note.segment_id)
                }}
              >
                <div className="flex items-start gap-2">
                  {note.segment_id != null && (
                    <span className="inline-flex items-center justify-center h-5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 text-[10px] font-medium shrink-0 px-1.5 tabular-nums">
                      {clip ? formatTimecode(clip.start_time) : `#${note.segment_sequence_order ?? '?'}`}
                    </span>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-mm-text line-clamp-2">{note.content}</p>
                    {note.segment_text_snippet && (
                      <p className="text-xs text-mm-text-faint mt-0.5 truncate italic">
                        {note.segment_text_snippet}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
})
