/**
 * The observation timeline (slab 3d; category lanes slab 4e; the coding-density
 * strip 6a): ruler · marking strip · D28 category lanes (sticky ruler+strip, vertically scrollable past
 * the cap, per-lane collapse; a lone Uncoded lane renders headerless — the
 * slab-3 look) · full-height playhead · overhang shading. Lane GROUPING is the
 * caller's (`buildLanes` — it owns the codes list and the blind lens); this
 * component only renders lanes and runs per-lane track assignment.
 *
 * Interaction contract:
 *  - The VISUAL layer is aria-hidden: every operation here has a keyboard path
 *    (I/O/P marks, arrow nudges, the timecode inputs) and the clip LIST is the
 *    accessible tree (#436/#484). The zoom controls are real buttons OUTSIDE
 *    the hidden layer.
 *  - Boundary drag = setPointerCapture (the VideoPane PiP precedent — dnd-kit
 *    is a discrete-drop library, wrong for continuous drag), preview locally,
 *    commit ONE value on release via onBoundaryCommit. Handles draw ~6px but
 *    hit ≥24px (#437).
 *  - The coding-density strip (6a/D36) sits in the HEADER, deliberately OUTSIDE
 *    the scroll container: inside it, zoom would crop the very overview it exists
 *    to give context for. aria-hidden + non-interactive; the toolbar gauge's text
 *    is its accessible equivalent.
 *  - Drag on empty lane space creates a range (release below the 4px movement
 *    threshold is a SEEK instead); double-click on the marking strip drops a
 *    point event. Clips render windowed — only those intersecting the visible
 *    window mount (the 2,000-clip cap × DOM nodes).
 *  - Time readouts (#655): the drag label covers BOTH kinds — a boundary drag
 *    shows its value, a create drag shows start–end · duration — and
 *    HoverTimeReadout answers "what time is under my pointer?" from its OWN
 *    state, because hover at pointer rate through this component's state would
 *    re-render every lane and bar on every mouse move.
 *  - Bars take their CODE's colour (#656), computed by the CALLER through the
 *    blind lens for the same reason lane membership is; uncoded stays teal, so
 *    the surface reads "coloured = coded, teal = still to do".
 *  - Discoverability + vocabulary (#657/#658): a ghost "Drag to mark a clip"
 *    rides the horizontal scroll in clear Uncoded lane space, and the header's
 *    Info popover names LANES vs TRACKS — in the header deliberately, since the
 *    layer below is aria-hidden and vocabulary there would be mouse-only.
 */
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { ChevronDown, ChevronRight, Info, Minus, Plus } from 'lucide-react'

import type { ObservationSegment } from '@/lib/api'
import {
  assignTracks, clampBoundary, dragReadout,
  type ClipFill, type Interval, type TimelineDrag, type TimelineLane,
} from '@/lib/clip-timeline'
import { NOW_PLAYING_BAR, SELECTED_BAR } from '@/lib/selection'
import { Button } from '@/components/ui/button'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { cn, formatTimecode, getContrastColor } from '@/lib/utils'

const TRACK_HEIGHT = 22
const STRIP_HEIGHT = 16
const RULER_HEIGHT = 18
const LANE_HEADER_HEIGHT = 16
const LANE_PAD = 4
/** The lanes area scrolls vertically past this (sticky ruler + strip — §8b). */
const LANES_MAX_HEIGHT = 288
const CREATE_DRAG_THRESHOLD_PX = 4
/** Roughly what "Drag to mark a clip" occupies — the #657 room test. */
const GHOST_HINT_WIDTH_PX = 132
const MIN_PX_PER_SEC = 0.005
const MAX_PX_PER_SEC = 200

/** ~80px between ticks, snapped to a humane step. */
function tickStep(pxPerSec: number): number {
  const target = 80 / pxPerSec
  const steps = [0.1, 0.5, 1, 5, 10, 30, 60, 300, 600, 1800, 3600]
  return steps.find(s => s >= target) ?? 7200
}

export interface BoundaryPreview {
  clipId: number
  edge: 'start' | 'end'
  value: number
}

interface ClipTimelineProps {
  clips: ObservationSegment[]
  /**
   * D28 category lanes (buildLanes) — the caller owns grouping (it holds the
   * codes list + the blind lens); this component only renders. A single
   * 'uncoded' lane renders headerless (the slab-3 look). A clip may appear in
   * several lanes (multi-category, D13); every instance renders the SAME clip —
   * boundary edits and selection act on the one underlying Segment.
   */
  lanes: TimelineLane<ObservationSegment>[]
  /** max(recording duration, max clip end) — the drawable extent. */
  extentSeconds: number
  /**
   * The coding-density strip (6a/D36): the ranges of every VISIBLE-CODED clip,
   * RAW and pre-union — overlapping marks stack their translucency, so density
   * reads for free with no binning math. The caller owns the blind lens
   * (`isSegmentCodedVisible` on `effectiveHidden`), exactly as it owns lane
   * membership.
   *
   * Positions are drawn over `extentSeconds`, NOT the gauge's denominator: the
   * strip is an OVERVIEW of the timeline below it, so its coordinate space must
   * be the drawn one or the marks mis-register against the bars they summarize.
   * The two differ only when the 60 s ruler floor is in play (a sub-minute
   * timeline); the strip carries no numbers, and the gauge text is its
   * accessible equivalent (D36), so there is nothing to disagree about.
   */
  codedIntervals?: Interval[]
  /**
   * A clip's bar colour in a given lane (#656), or null to keep the neutral
   * teal — which is what an UNCODED clip should read as, so the timeline says
   * "coloured = coded, teal = still to do" for free.
   *
   * The caller's job for the same reason `lanes` is: it owns the codes list and
   * the BLIND LENS, and a colour derived here from raw `applied_code_details`
   * would leak "a colleague coded this" through a channel lane placement
   * already closes (D28). Omit it entirely and every bar stays teal.
   */
  clipFill?: (clip: ObservationSegment, laneKey: string) => ClipFill | null
  /** Where the recording actually ends (overhang shading); null = unknown. */
  recordingEndSeconds: number | null
  currentTime: number | null
  selectedIds: number[]
  /** Clips containing the playhead right now (D27) — the green not-selection ring. */
  nowPlayingIds?: Set<number>
  /** D22: while frozen the clip SET is read-only — no drag-create, no boundary
   * handles (label edits and selection stay live; the workbench toolbar carries
   * the unfreeze flow). Seeks keep working: frozen gates EDITING, not viewing. */
  frozen: boolean
  /** The armed I in-point (marking machine), or null. */
  armedInTime: number | null
  isPlaying: boolean
  /** An uncommitted keyboard-nudge/timecode edit to render in place. */
  boundaryPreview: BoundaryPreview | null
  onSeek: (time: number) => void
  onClipClick: (id: number, e: ReactMouseEvent) => void
  onCreateRange: (start: number, end: number) => void
  onCreatePoint: (time: number) => void
  onBoundaryCommit: (clipId: number, edge: 'start' | 'end', value: number) => void
  /** Opens the `?` dialog (#663). The header's hint lists three keys; this
   *  surface has closer to twenty, and nothing pointed at the full list. */
  onShowShortcuts?: () => void
}

/** setPointerCapture throws InvalidPointerId for a synthetic/test pointer —
 * capture is an enhancement (smooth off-element drags), never a precondition. */
function capturePointer(el: HTMLElement | null, pointerId: number) {
  try {
    el?.setPointerCapture?.(pointerId)
  } catch {
    // untrusted pointer (jsdom / synthetic drive) — drag still works on-element
  }
}

/**
 * The cursor-following time readout (#655) — "what time is under my pointer?",
 * which the timeline could not answer at all: its only time surfaces were the
 * window label, the ruler ticks, per-clip tooltips and the boundary drag.
 *
 * ⚠️ Deliberately a SEPARATE component with its own listener and its own state.
 * Hover fires at pointer rate, and lifting it into ClipTimeline's state would
 * re-render every lane, track and clip bar on every mouse move — turning idle
 * hover into the cost of a drag, on a 2 GB-RAM target. Here the re-render is
 * one absolutely-positioned label.
 */
function HoverTimeReadout({
  containerRef, pxPerSec, extent, suppressed,
}: {
  containerRef: RefObject<HTMLDivElement | null>
  pxPerSec: number
  extent: number
  /** A drag owns the label while it lasts — two floating readouts is noise. */
  suppressed: boolean
}) {
  const [offsetPx, setOffsetPx] = useState<number | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      // Clamp to the DRAWN extent, not the element: contentWidth stretches to
      // the viewport when zoomed out past fit, and the blank tail past the end
      // of the timeline has no honest time to report.
      setOffsetPx(Math.max(0, Math.min(extent * pxPerSec, e.clientX - rect.left)))
    }
    const onLeave = () => setOffsetPx(null)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerleave', onLeave)
    return () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', onLeave)
    }
  }, [containerRef, pxPerSec, extent])

  if (offsetPx === null || suppressed) return null
  return (
    <>
      <div
        className="absolute top-0 bottom-0 w-px bg-mm-text-faint/40 pointer-events-none"
        style={{ left: offsetPx }}
      />
      <div
        className="absolute text-[9px] text-mm-text-muted bg-mm-surface/90 rounded px-1 tabular-nums pointer-events-none"
        style={{ left: offsetPx + 4, top: 2 }}
      >
        {formatTimecode(offsetPx / pxPerSec)}
      </div>
    </>
  )
}

export default function ClipTimeline({
  clips,
  lanes,
  extentSeconds,
  codedIntervals,
  clipFill,
  frozen,
  recordingEndSeconds,
  currentTime,
  selectedIds,
  nowPlayingIds,
  armedInTime,
  isPlaying,
  boundaryPreview,
  onSeek,
  onClipClick,
  onCreateRange,
  onCreatePoint,
  onBoundaryCommit,
  onShowShortcuts,
}: ClipTimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [pxPerSec, setPxPerSec] = useState(1)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [drag, setDrag] = useState<TimelineDrag | null>(null)
  const dragRef = useRef<TimelineDrag | null>(null)
  dragRef.current = drag

  const extent = Math.max(extentSeconds, 1)
  const clipById = useMemo(() => new Map(clips.map(c => [c.id, c])), [clips])
  // A Set, not `selectedIds.includes`: the bar map runs it once per rendered
  // clip, and `nowPlayingIds` next to it is already a Set.
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  const fit = useCallback(() => {
    const w = scrollRef.current?.clientWidth ?? 0
    if (w > 0) setPxPerSec(Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, w / extent)))
  }, [extent])

  // Initial zoom = Fit (and track the viewport for windowing/auto-pan).
  useLayoutEffect(() => {
    fit()
    const el = scrollRef.current
    if (!el) return
    setViewportWidth(el.clientWidth)
    if (typeof ResizeObserver === 'undefined') return // jsdom
    const ro = new ResizeObserver(() => setViewportWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [fit])

  const zoom = useCallback((factor: number) => {
    const el = scrollRef.current
    // Keep the window's CENTER time stable through the zoom.
    const centerTime = el ? (el.scrollLeft + el.clientWidth / 2) / pxPerSec : 0
    const next = Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, pxPerSec * factor))
    setPxPerSec(next)
    requestAnimationFrame(() => {
      if (el) el.scrollLeft = centerTime * next - el.clientWidth / 2
    })
  }, [pxPerSec])

  const contentWidth = Math.max(extent * pxPerSec, viewportWidth)

  // Auto-pan: while playing, keep the playhead inside the middle of the window.
  useEffect(() => {
    if (!isPlaying || currentTime === null || dragRef.current) return
    const el = scrollRef.current
    if (!el) return
    const playheadPx = currentTime * pxPerSec
    const lo = el.scrollLeft + el.clientWidth * 0.1
    const hi = el.scrollLeft + el.clientWidth * 0.85
    if (playheadPx < lo || playheadPx > hi) {
      el.scrollLeft = Math.max(0, playheadPx - el.clientWidth * 0.3)
    }
  }, [currentTime, isPlaying, pxPerSec])

  const timeAt = useCallback((clientX: number): number => {
    const rect = contentRef.current?.getBoundingClientRect()
    if (!rect) return 0
    return Math.max(0, Math.min(extent, (clientX - rect.left) / pxPerSec))
  }, [extent, pxPerSec])

  // ── Windowed rendering + lane layout (D28) ────────────────────────────────
  const windowStart = scrollLeft / pxPerSec - 60 / pxPerSec
  const windowEnd = (scrollLeft + viewportWidth) / pxPerSec + 60 / pxPerSec

  const [collapsedLanes, setCollapsedLanes] = useState<Set<string>>(new Set())
  const toggleLane = useCallback((key: string) => {
    setCollapsedLanes(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // A lone Uncoded lane = the slab-3 look: no header chrome to manage.
  const showHeaders = !(lanes.length === 1 && lanes[0].key === 'uncoded')
  const laneLayouts = useMemo(() => lanes.map(lane => {
    const collapsed = showHeaders && collapsedLanes.has(lane.key)
    const tracks = assignTracks(lane.clips)
    const trackCount = Math.max(1, ...[...tracks.values()].map(t => t + 1))
    const headerH = showHeaders ? LANE_HEADER_HEIGHT : 0
    const bodyH = collapsed ? 0 : trackCount * TRACK_HEIGHT + LANE_PAD
    return { lane, collapsed, tracks, headerH, bodyH, height: headerH + bodyH }
  }), [lanes, collapsedLanes, showHeaders])
  const lanesContentHeight = laneLayouts.reduce((sum, l) => sum + l.height, 0)
  // Sticky ruler + strip; the lanes area scrolls vertically past the cap (§8b).
  const lanesVisibleHeight = Math.min(lanesContentHeight, LANES_MAX_HEIGHT)

  // ── Pointer interactions ──────────────────────────────────────────────────
  const beginBoundaryDrag = useCallback((
    e: ReactPointerEvent, clip: ObservationSegment, edge: 'start' | 'end',
  ) => {
    e.stopPropagation()
    e.preventDefault()
    capturePointer(contentRef.current, e.pointerId)
    setDrag({ kind: 'boundary', clipId: clip.id, edge, value: edge === 'start' ? clip.start_time : clip.end_time })
  }, [])

  const frozenRef = useRef(frozen)
  frozenRef.current = frozen

  const beginLanePointer = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0) return
    if (frozenRef.current) {
      // Read-only lane: a bare click still seeks; a drag can't create.
      onSeek(timeAt(e.clientX))
      return
    }
    capturePointer(contentRef.current, e.pointerId)
    const t = timeAt(e.clientX)
    setDrag({ kind: 'create', anchor: t, current: t, moved: false })
  }, [timeAt, onSeek])

  const handlePointerMove = useCallback((e: ReactPointerEvent) => {
    const current = dragRef.current
    if (!current) return
    const t = timeAt(e.clientX)
    if (current.kind === 'boundary') {
      // Map, not `clips.find`: this runs at pointer rate, and the clip cap is
      // 2,000 — a linear scan per move is work the drag can't afford.
      const clip = clipById.get(current.clipId)
      if (clip) setDrag({ ...current, value: clampBoundary(current.edge, t, clip) })
    } else {
      const moved = current.moved || Math.abs((t - current.anchor) * pxPerSec) >= CREATE_DRAG_THRESHOLD_PX
      setDrag({ ...current, current: t, moved })
    }
  }, [clipById, pxPerSec, timeAt])

  const handlePointerUp = useCallback((e: ReactPointerEvent) => {
    const current = dragRef.current
    if (!current) return
    setDrag(null)
    try { contentRef.current?.releasePointerCapture?.(e.pointerId) } catch { /* synthetic pointer */ }
    if (current.kind === 'boundary') {
      onBoundaryCommit(current.clipId, current.edge, current.value)
    } else if (current.moved) {
      onCreateRange(Math.min(current.anchor, current.current), Math.max(current.anchor, current.current))
    } else {
      // Below the movement threshold: the gesture was a click — a seek.
      onSeek(current.anchor)
    }
  }, [onBoundaryCommit, onCreateRange, onSeek])

  // ── Geometry helpers ──────────────────────────────────────────────────────
  const px = (t: number) => t * pxPerSec
  const step = tickStep(pxPerSec)
  const ticks: number[] = []
  for (let t = Math.floor(windowStart / step) * step; t <= Math.min(windowEnd, extent); t += step) {
    if (t >= 0) ticks.push(t)
  }
  const totalHeight = RULER_HEIGHT + STRIP_HEIGHT + lanesVisibleHeight + 8
  const playheadPx = currentTime !== null ? px(currentTime) : null
  const readout = dragReadout(drag)
  const windowLabel = `${formatTimecode(Math.max(0, scrollLeft / pxPerSec))} – ${formatTimecode(Math.min(extent, (scrollLeft + viewportWidth) / pxPerSec))}`

  const previewedEdge = (clip: ObservationSegment, edge: 'start' | 'end'): number => {
    if (drag?.kind === 'boundary' && drag.clipId === clip.id && drag.edge === edge) return drag.value
    if (boundaryPreview && boundaryPreview.clipId === clip.id && boundaryPreview.edge === edge) {
      return boundaryPreview.value
    }
    return edge === 'start' ? clip.start_time : clip.end_time
  }

  return (
    <div className="border-b border-mm-border-subtle bg-mm-surface flex-shrink-0">
      <div className="flex items-center gap-2 px-3.5 py-1 text-xs text-mm-text-muted">
        <span className="font-semibold text-mm-text-secondary">Timeline</span>
        <span className="tabular-nums">{windowLabel}</span>
        <Button variant="outline" size="icon" className="h-5 w-5" aria-label="Zoom out" onClick={() => zoom(1 / 1.5)}>
          <Minus aria-hidden className="h-3 w-3" />
        </Button>
        <Button variant="outline" size="icon" className="h-5 w-5" aria-label="Zoom in" onClick={() => zoom(1.5)}>
          <Plus aria-hidden className="h-3 w-3" />
        </Button>
        <Button variant="outline" size="sm" className="h-5 px-2 text-xs" onClick={fit}>
          Fit
        </Button>
        {/* #658: the code has always distinguished LANES (one per code
          * category) from TRACKS (the stacked rows inside a lane, packed by
          * overlap), and the UI named neither — so a researcher had no words
          * for what they were looking at, which is exactly the question that
          * produced this issue. It lives in the HEADER, deliberately: the layer
          * below is aria-hidden, so vocabulary parked in a lane would be
          * mouse-only, and this is the one part of the timeline a screen reader
          * and the keyboard can both reach. */}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost" size="icon" className="h-5 w-5"
              aria-label="About the timeline: lanes, tracks and colours"
            >
              <Info aria-hidden className="h-3 w-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 text-xs space-y-2" aria-label="About the timeline lanes">
            <p>
              <strong className="text-mm-text-secondary">Lanes</strong> are the labelled rows —
              one per code category, then Uncategorized, then Uncoded. A clip coded in two
              categories appears in both.
            </p>
            <p>
              <strong className="text-mm-text-secondary">Tracks</strong> are the rows stacked
              inside a lane. Clips share a track when they don&apos;t overlap in time and stack
              onto a new one when they do, so nothing is ever hidden behind anything else.
            </p>
            <p>
              A bar takes <strong className="text-mm-text-secondary">its code&apos;s colour</strong>;
              clips you haven&apos;t coded yet stay teal, and a code with no colour of its own shows
              grey — set one in the codebook. Drag empty space in any lane to mark a new clip; it
              starts uncoded wherever you drew it.
            </p>
          </PopoverContent>
        </Popover>
        <span className="ml-auto tabular-nums">
          <kbd className="px-1 border border-mm-border-medium rounded text-[10px]">I</kbd>/
          <kbd className="px-1 border border-mm-border-medium rounded text-[10px]">O</kbd> mark ·{' '}
          <kbd className="px-1 border border-mm-border-medium rounded text-[10px]">P</kbd> point ·{' '}
          <kbd className="px-1 border border-mm-border-medium rounded text-[10px]">U</kbd> next gap
          {onShowShortcuts && (
            <>
              {' · '}
              <button
                type="button"
                onClick={onShowShortcuts}
                className="underline decoration-dotted underline-offset-2 hover:text-mm-text-secondary"
                title="All keyboard shortcuts (?)"
              >
                <kbd className="px-1 border border-mm-border-medium rounded text-[10px]">?</kbd> all keys
              </button>
            </>
          )}
        </span>
      </div>

      {/* The coding-density strip (6a/D36) — a FULL-EXTENT overview, deliberately
        * OUTSIDE the scroll container: inside it, zoom would crop the overview to
        * the very window it exists to give context for. Marks are translucent, so
        * overlapping clips stack darker and density reads without binning math.
        * Decorative by construction: aria-hidden + non-interactive (a click-to-seek
        * here would be a mouse-only shortcut, and the timeline below already
        * offers click-seek); the toolbar gauge's text carries the numbers. */}
      {codedIntervals !== undefined && (
        <div
          aria-hidden
          data-testid="coverage-density-strip"
          className="relative mx-3.5 mb-1 h-2 rounded-sm bg-mm-border-subtle overflow-hidden"
        >
          {codedIntervals.map((interval, i) => {
            const left = (Math.max(0, interval.start) / extent) * 100
            const width = (Math.max(0, interval.end - interval.start) / extent) * 100
            return (
              <div
                key={`${interval.start}-${interval.end}-${i}`}
                className="absolute inset-y-0 bg-[hsl(var(--mm-green))]/40"
                style={{
                  left: `${Math.min(left, 100)}%`,
                  // A coded POINT event covers no time (D7) but still happened —
                  // give it a hairline so the overview doesn't silently omit it.
                  width: `max(2px, ${Math.min(width, 100 - left)}%)`,
                }}
              />
            )
          })}
        </div>
      )}

      <div
        ref={scrollRef}
        className="overflow-x-auto overflow-y-hidden"
        onScroll={e => setScrollLeft((e.target as HTMLDivElement).scrollLeft)}
      >
        {/* The visual layer: pointer-first, aria-hidden — the clip LIST is the
          * accessible tree, and every gesture here has a keyboard path. */}
        <div
          ref={contentRef}
          aria-hidden
          className="relative select-none"
          style={{ width: contentWidth, height: totalHeight }}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          {/* Overhang: timeline past the end of the recording (cue clips are
            * kept, never clamped — but there is no video behind them). */}
          {recordingEndSeconds !== null && recordingEndSeconds < extent && (
            <div
              className="absolute top-0 bottom-0 bg-mm-bg opacity-70"
              style={{
                left: px(recordingEndSeconds),
                width: px(extent - recordingEndSeconds),
                backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 6px, hsl(var(--mm-border-medium)) 6px 7px)',
              }}
            />
          )}

          {/* Ruler (click = seek) */}
          <div
            className="absolute left-0 right-0 border-b border-mm-border-subtle cursor-pointer"
            style={{ top: 0, height: RULER_HEIGHT }}
            onClick={e => onSeek(timeAt(e.clientX))}
          >
            {ticks.map(t => (
              <span
                key={t}
                className="absolute text-[9px] text-mm-text-faint tabular-nums border-l border-mm-border-subtle pl-0.5"
                style={{ left: px(t), top: 2, height: RULER_HEIGHT - 2 }}
              >
                {formatTimecode(t)}
              </span>
            ))}
          </div>

          {/* Marking strip: armed bar grows with the playhead; double-click = point event */}
          <div
            className="absolute left-0 right-0 bg-mm-bg cursor-pointer"
            style={{ top: RULER_HEIGHT, height: STRIP_HEIGHT }}
            onClick={e => onSeek(timeAt(e.clientX))}
            onDoubleClick={e => onCreatePoint(timeAt(e.clientX))}
          >
            {armedInTime !== null && currentTime !== null && (
              <div
                className="absolute top-0.5 bottom-0.5 rounded-sm bg-mm-teal-text opacity-70"
                style={{
                  left: px(Math.min(armedInTime, currentTime)),
                  width: Math.max(2, px(Math.abs(currentTime - armedInTime))),
                }}
              />
            )}
          </div>

          {/* The lanes (D28): stacked category lanes, vertically scrollable past
            * the cap; a lone Uncoded lane renders headerless (the slab-3 look).
            * Empty lane space drags CREATE — always an UNCODED clip (D13). */}
          <div
            className="absolute left-0 right-0 overflow-y-auto overflow-x-hidden"
            style={{ top: RULER_HEIGHT + STRIP_HEIGHT + 2, height: lanesVisibleHeight }}
          >
            {laneLayouts.map(({ lane, collapsed, tracks, headerH, bodyH }) => (
              <div key={lane.key} className="relative" style={{ height: headerH + bodyH }}>
                {showHeaders && (
                  <div
                    /* #659, found by the #657/#658 live drive: this was
                     * `sticky left-0`, which is INERT here — sticky resolves
                     * against the nearest scrollport, and that is the lanes box
                     * (`overflow-x: hidden`), not the horizontal scroller
                     * outside it. So the box itself translates with the panned
                     * content and the label rode away with it (measured at
                     * viewport x = −2200 after a pan). Offsetting by the
                     * scrollLeft this component already tracks pins it for
                     * real — the same technique as the #657 ghost hint. */
                    className="relative z-10 flex items-center gap-1 w-fit pr-2 text-[9px] font-medium text-mm-text-faint uppercase tracking-wide cursor-pointer"
                    style={{ height: LANE_HEADER_HEIGHT, left: scrollLeft }}
                    // #658: name the concept where the pointer already is; the
                    // Info popover in the header carries the full explanation.
                    title={`Lane: ${lane.label} — ${lane.clips.length} clip${lane.clips.length === 1 ? '' : 's'}`}
                    onClick={() => toggleLane(lane.key)}
                    onPointerDown={e => e.stopPropagation()}
                  >
                    {collapsed
                      ? <ChevronRight className="h-2.5 w-2.5" />
                      : <ChevronDown className="h-2.5 w-2.5" />}
                    {lane.label}
                    <span className="normal-case tracking-normal">({lane.clips.length})</span>
                  </div>
                )}
                {!collapsed && (
                  /* #653: the cursor IS the affordance. Empty track space is
                   * the only place drag-create works, and it was the only
                   * interactive region on the timeline that signalled nothing —
                   * the ruler and strip are `cursor-pointer`, clip bars are
                   * `cursor-pointer`, boundary handles are `cursor-ew-resize`.
                   * The gesture was hinted only in the clip list's ZERO-clip
                   * empty state, which disappears after the first clip and sits
                   * in a different panel, so past that moment nothing on screen
                   * said it existed. Crosshair is the video-editor convention
                   * for "drag here to mark a range"; when frozen the lane only
                   * seeks, so it reverts to pointer.
                   *
                   * `title` is a mouse-only hint by design — this subtree is
                   * aria-hidden, and the keyboard path (I/O) is already in the
                   * Keyboard Shortcuts dialog (#644). */
                  <div
                    className={`absolute left-0 right-0 ${frozen ? 'cursor-pointer' : 'cursor-crosshair'}`}
                    style={{ top: headerH, height: bodyH }}
                    title={frozen ? undefined : 'Drag to mark a clip'}
                    onPointerDown={beginLanePointer}
                  >
                    {/* #657: #653 shipped the crosshair, which only helps once
                      * the pointer is already in the right band — the report
                      * was that FINDING the band took a while. The prose hint
                      * that existed lived in the clip list's zero-clip empty
                      * state, so it vanished after the first clip and sat in a
                      * different panel anyway.
                      *
                      * It rides the horizontal scroll (`left: scrollLeft`)
                      * rather than sitting at left:0, which would scroll out of
                      * view on the first pan — the lane body is absolutely
                      * positioned inside the scroll container, so the header's
                      * `sticky left-0` trick isn't available here, but the
                      * component already tracks scrollLeft in state.
                      *
                      * "When the lane has room" is measured, not guessed: if any
                      * clip in this lane overlaps where the label would sit, it
                      * is skipped rather than drawn under a bar. Mouse-only by
                      * construction (aria-hidden subtree), which is fine — the
                      * keyboard path is I/O, in the shortcuts dialog since #644. */}
                    {!frozen && lane.key === 'uncoded' && !lane.clips.some(c =>
                      c.end_time >= scrollLeft / pxPerSec
                      && c.start_time <= (scrollLeft + GHOST_HINT_WIDTH_PX) / pxPerSec,
                    ) && (
                      <div
                        className="absolute text-[10px] italic text-mm-text-faint/70 pointer-events-none whitespace-nowrap"
                        style={{ left: scrollLeft + 8, top: 4 }}
                      >
                        Drag to mark a clip
                      </div>
                    )}
                    {lane.clips
                      .filter(c => c.end_time >= windowStart && c.start_time <= windowEnd)
                      .map(clip => {
                        const track = tracks.get(clip.id) ?? 0
                        const start = previewedEdge(clip, 'start')
                        const end = previewedEdge(clip, 'end')
                        const selected = selectedSet.has(clip.id)
                        const nowPlaying = nowPlayingIds?.has(clip.id) ?? false
                        // #656: the code's own colour, or null for uncoded —
                        // which keeps the neutral teal, so the timeline reads
                        // "coloured = coded, teal = still to do" at a glance.
                        const fill = clipFill?.(clip, lane.key) ?? null
                        const codeSuffix = fill && fill.codeNames.length > 0
                          ? ` · ${fill.codeNames.join(', ')}`
                          : ''
                        // ONE colour = exactly one code, always. With several,
                        // the bar bands by HEIGHT (see ClipFill) — a solid fill
                        // would silently under-report {A,B} as {A}.
                        const banded = (fill?.colors.length ?? 0) > 1
                        if (clip.start_time === clip.end_time) {
                          // Point event: a pin, not a bar (D7).
                          return (
                            <div
                              key={clip.id}
                              data-testid="clip-pin"
                              className={cn(
                                'absolute w-2.5 h-2.5 rotate-45 cursor-pointer',
                                !fill && 'bg-mm-teal-text',
                                selected && SELECTED_BAR,
                                !selected && nowPlaying && NOW_PLAYING_BAR,
                              )}
                              style={{
                                left: px(start) - 5,
                                top: track * TRACK_HEIGHT + 5,
                                // A 10px rotated pin cannot carry bands; it
                                // takes the first code's colour and the tooltip
                                // names the rest.
                                backgroundColor: fill?.colors[0],
                              }}
                              onPointerDown={e => e.stopPropagation()}
                              onClick={e => { e.stopPropagation(); onClipClick(clip.id, e) }}
                              title={`${formatTimecode(start)}${clip.text ? ` — ${clip.text}` : ''}${codeSuffix}`}
                            />
                          )
                        }
                        return (
                          <div
                            key={clip.id}
                            data-testid="clip-bar"
                            className={cn(
                              'absolute rounded text-[10px] leading-[18px] px-1.5 overflow-hidden whitespace-nowrap cursor-pointer',
                              !fill && 'bg-mm-teal-text/80 text-white',
                              selected && SELECTED_BAR,
                              // Selection wins when both apply (D27) — the ring
                              // only marks UNSELECTED playhead containment.
                              !selected && nowPlaying && NOW_PLAYING_BAR,
                            )}
                            style={{
                              left: px(start),
                              width: Math.max(3, px(end - start)),
                              top: track * TRACK_HEIGHT + 2,
                              height: TRACK_HEIGHT - 4,
                              // ONE code → a solid fill; SEVERAL → the band
                              // elements below. (A hard-stop gradient would do
                              // it in one property, but it draws hairline seams
                              // at fractional device pixels and cannot be
                              // asserted in jsdom.) Rendering is windowed, so
                              // the extra nodes are bounded by what's on screen,
                              // not by the 2,000-clip cap.
                              backgroundColor: banded ? undefined : fill?.colors[0],
                              // A code colour is arbitrary, so the label cannot
                              // stay hard-coded white — getContrastColor is the
                              // same WCAG-luminance pick the code chips use.
                              // A BANDED bar has no single background to
                              // contrast against, so it drops the inline label
                              // rather than guess; the clip list and the
                              // tooltip both still carry it.
                              color: fill && !banded ? getContrastColor(fill.colors[0]) : undefined,
                            }}
                            onPointerDown={e => e.stopPropagation()}
                            onClick={e => { e.stopPropagation(); onClipClick(clip.id, e) }}
                            title={`${formatTimecode(start)}–${formatTimecode(end)}${clip.text ? ` — ${clip.text}` : ''}${codeSuffix}`}
                          >
                            {/* Bands stack by HEIGHT — each spans the clip's
                              * whole width, because each code applies to the
                              * whole clip. A width split would say "A, then B". */}
                            {banded && fill!.colors.map((c, i, a) => (
                              <span
                                key={`${c}-${i}`}
                                data-testid="clip-band"
                                data-band-color={c}
                                className="absolute left-0 right-0"
                                style={{
                                  top: `${(i / a.length) * 100}%`,
                                  height: `${100 / a.length}%`,
                                  backgroundColor: c,
                                }}
                              />
                            ))}
                            {banded ? null : clip.text}
                            {/* More codes than bands: say so rather than let
                              * the bar quietly under-report the set. */}
                            {fill && fill.overflow > 0 && (
                              <span className="absolute right-0.5 top-0 text-[8px] leading-[18px] font-medium text-white [text-shadow:0_0_2px_rgba(0,0,0,0.9)]">
                                +{fill.overflow}
                              </span>
                            )}
                            {/* Boundary handles: ~6px visible, 24px hit (#437). Absent —
                              * not merely inert — while frozen (D22). */}
                            {!frozen && (
                              <>
                                <span
                                  className="absolute left-0 top-0 bottom-0 w-6 -ml-3 cursor-ew-resize"
                                  onPointerDown={e => beginBoundaryDrag(e, clip, 'start')}
                                >
                                  <span className="absolute left-3 top-0 bottom-0 w-1 rounded-sm opacity-70 bg-current" />
                                </span>
                                <span
                                  className="absolute right-0 top-0 bottom-0 w-6 -mr-3 cursor-ew-resize"
                                  onPointerDown={e => beginBoundaryDrag(e, clip, 'end')}
                                >
                                  <span className="absolute right-3 top-0 bottom-0 w-1 rounded-sm opacity-70 bg-current" />
                                </span>
                              </>
                            )}
                          </div>
                        )
                      })}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Create-drag preview — spans the lanes area (the created clip is
            * uncoded regardless of which lane the drag started in, D13). */}
          {drag?.kind === 'create' && drag.moved && (
            <div
              className="absolute rounded border border-mm-teal-text bg-mm-teal-text/20 pointer-events-none"
              style={{
                top: RULER_HEIGHT + STRIP_HEIGHT + 2,
                height: lanesVisibleHeight,
                left: px(Math.min(drag.anchor, drag.current)),
                width: Math.max(2, px(Math.abs(drag.current - drag.anchor))),
              }}
            />
          )}

          {/* The live drag readout — BOTH kinds since #655. A boundary drag
            * shows the value; a create drag shows start–end · duration, which
            * is the one that was missing: there is no existing bar to read the
            * numbers off, so the range was marked blind. */}
          {readout && (
            <div
              className="absolute text-[9px] bg-mm-text text-mm-surface rounded px-1 tabular-nums pointer-events-none whitespace-nowrap"
              style={{ left: px(readout.at) + 4, top: RULER_HEIGHT }}
            >
              {readout.text}
            </div>
          )}

          <HoverTimeReadout
            containerRef={contentRef}
            pxPerSec={pxPerSec}
            extent={extent}
            suppressed={drag !== null}
          />

          {/* Full-height playhead — through ruler, strip, and every track (§8b). */}
          {playheadPx !== null && (
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-mm-green pointer-events-none"
              style={{ left: playheadPx }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
