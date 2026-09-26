import { useState, useMemo, useEffect, useRef, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { X, ChevronDown, ChevronRight, Check, Plus, ExternalLink } from 'lucide-react'
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { excerptsApi, materialsApi, memosApi } from '@/lib/api'
import { excerptDisplayLabel, excerptAttributionLine } from '@/lib/canvas-excerpt'
import { useListLoad } from '@/hooks/useListLoad'
import { LoadState } from '@/components/LoadStatus'

// ── Props ────────────────────────────────────────────────────────────────────

interface MaterialsDrawerProps {
  projectId: number
  onCanvasSourceIds: {
    onCanvasExcerptIds: Set<number>
    onCanvasMaterialIds: Set<number>
    onCanvasMemoIds: Set<number>
  }
  open: boolean
  onClose: () => void
  initialSection?: 'excerpts' | 'charts' | 'memos' | null
  onInsertExcerpt: (excerptId: number) => void
  onInsertMaterial: (materialId: number) => void
  onInsertMemo: (memoId: number) => void
  insertingId?: number | null
  /**
   * Where focus goes when this pane closes (#955's class). The pane becomes
   * `inert`, which blurs whatever was focused inside it — including its own
   * Close button — so without a destination focus falls to `<body>`.
   */
  closeReturnRef?: RefObject<HTMLElement | null>
}

// ── Section key type ─────────────────────────────────────────────────────────

type Section = 'excerpts' | 'charts' | 'memos'

// ── Component ────────────────────────────────────────────────────────────────

export default function MaterialsDrawer({
  projectId,
  onCanvasSourceIds,
  open,
  onClose,
  initialSection,
  onInsertExcerpt,
  onInsertMaterial,
  onInsertMemo,
  insertingId,
  closeReturnRef,
}: MaterialsDrawerProps) {
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Record<Section, boolean>>({
    excerpts: false,
    charts: false,
    memos: false,
  })
  const filterRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  // Auto-expand initial section when drawer opens
  useEffect(() => {
    if (open && initialSection) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- must re-derive on each open (drawer stays mounted, so lazy-init can't re-run), and the rAF focus below has to be in an effect regardless
      setExpanded({
        excerpts: initialSection === 'excerpts',
        charts: initialSection === 'charts',
        memos: initialSection === 'memos',
      })
      // Focus filter input after animation
      requestAnimationFrame(() => filterRef.current?.focus())
    }
  }, [open, initialSection])

  // Reset filter when closing
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear the filter when the drawer closes (reset-on-close; drawer stays mounted)
    if (!open) setFilter('')
  }, [open])

  const panelRef = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(open)
  /**
   * #955's class: a focused control that disappears needs a destination.
   *
   * Making the closed pane `inert` is what removes its phantom tab stops, and
   * it also blurs whatever was focused inside it — its own Close button, most
   * of the time — so focus would land on `<body>` and put the keyboard user
   * back at the top of the page. It goes to the toggle that owns this pane,
   * which is the first rung of `lib/dialog-focus-return.ts`'s ladder.
   *
   * ⚠️ Only when focus was actually LOST, and only on the open→closed
   * TRANSITION: `open === false` is true on every render of a closed canvas, so
   * an unconditional focus call would fight the researcher for focus.
   */
  useEffect(() => {
    if (wasOpen.current && !open) {
      const active = document.activeElement
      const lost = active == null
        || active === document.body
        || !active.isConnected
        || (panelRef.current?.contains(active) ?? false)
      if (lost) closeReturnRef?.current?.focus()
    }
    wasOpen.current = open
  }, [open, closeReturnRef])

  // ── Queries (only fetch when drawer is open) ──────────────────────────────

  const excerptsQuery = useQuery({
    queryKey: ['excerpts', projectId],
    queryFn: () => excerptsApi.list(projectId),
    enabled: open,
  })
  const excerptsData = excerptsQuery.data

  const materialsQuery = useQuery({
    queryKey: ['materials-all', projectId],
    queryFn: () => materialsApi.listAllMaterials(projectId),
    enabled: open,
  })
  const materialsData = materialsQuery.data

  const memosQuery = useQuery({
    queryKey: ['memos', projectId],
    queryFn: () => memosApi.list(projectId),
    enabled: open,
  })
  const memosData = memosQuery.data

  /**
   * #963 Tier 2 — each section speaks for its OWN list.
   *
   * Three separate loads rather than one combined: the Excerpts section has no
   * business waiting on the memos request, and a failure in one must not blank
   * the two that answered.
   *
   * ⚠️ **The DISABLED case is decided by the pane, not by a branch here.** All
   * three queries are `enabled: open`, and a disabled query with nothing cached
   * reads `loading` forever (#961 §1). While closed this pane is `inert` and
   * `aria-hidden`, so nothing it says is reachable by eye, by Tab or by a
   * reader; the first honest render is the one after it opens.
   */
  const excerptsLoad = useListLoad(excerptsQuery)
  const materialsLoad = useListLoad(materialsQuery)
  const memosLoad = useListLoad(memosQuery)

  // useMemo'd for stable identity — each feeds a filtering useMemo below.
  const excerpts = useMemo(() => excerptsData?.excerpts ?? [], [excerptsData])
  const materials = useMemo(() => materialsData ?? [], [materialsData])
  const memos = useMemo(() => memosData?.memos ?? [], [memosData])

  // ── "Already on canvas" sets (derived from theme content in CanvasView) ────

  const onCanvasExcerpts = onCanvasSourceIds.onCanvasExcerptIds
  const onCanvasMaterials = onCanvasSourceIds.onCanvasMaterialIds
  const onCanvasMemos = onCanvasSourceIds.onCanvasMemoIds

  // ── Filtered lists ────────────────────────────────────────────────────────

  const lowerFilter = filter.toLowerCase()

  const filteredExcerpts = useMemo(
    () =>
      lowerFilter
        ? excerpts.filter(
            e =>
              // #630 sibling: filter on what the row DISPLAYS. A clip's
              // excerpt_text is empty and it has no speaker/conversation, so
              // the old three-field test could never match one — it was
              // unfindable by the observation name shown on its own row.
              excerptDisplayLabel(e).toLowerCase().includes(lowerFilter) ||
              excerptAttributionLine(e, { includeSpeaker: true })
                .toLowerCase()
                .includes(lowerFilter),
          )
        : excerpts,
    [excerpts, lowerFilter],
  )

  const filteredMaterials = useMemo(
    () =>
      lowerFilter
        ? materials.filter(
            m =>
              m.auto_name.toLowerCase().includes(lowerFilter) ||
              (m.custom_name?.toLowerCase().includes(lowerFilter) ?? false),
          )
        : materials,
    [materials, lowerFilter],
  )

  const filteredMemos = useMemo(
    () =>
      lowerFilter
        ? memos.filter(
            m =>
              (m.title?.toLowerCase().includes(lowerFilter) ?? false) ||
              m.content.toLowerCase().includes(lowerFilter),
          )
        : memos,
    [memos, lowerFilter],
  )

  // ── Toggle section ────────────────────────────────────────────────────────

  const toggleSection = (section: Section) => {
    setExpanded(prev => ({ ...prev, [section]: !prev[section] }))
  }

  const inserting = insertingId != null

  return (
    <div
      ref={panelRef}
      data-materials-panel
      role="complementary"
      aria-label="Materials panel"
      /**
       * 🔴 **A collapsed pane keeps its controls in the Tab order unless it is
       * `inert` (#910's rule, reached one step earlier).** This pane collapses
       * to `w-0` and carried NEITHER marker: measured in Chrome, five focusable
       * controls — Close, the filter box and three section headers — with
       * `.focus()` succeeding on a 24px button inside a 0px pane. Reachable by
       * Tab, invisible on screen, and announced by a reader: the worst
       * combination there is.
       *
       * The two go together and under the SAME condition. `aria-hidden` alone
       * hides it from a reader and leaves the tab stops; `inert` alone removes
       * focus and hit-testing and leaves it in the tree.
       */
      inert={!open}
      aria-hidden={!open || undefined}
      className={`shrink-0 h-full flex flex-col bg-mm-surface border-l border-mm-border-subtle shadow-xl overflow-hidden transition-[width] duration-250 ease-in-out ${open ? 'w-[280px]' : 'w-0 border-l-0'}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-mm-border-subtle shrink-0">
        <h2 className="text-base font-semibold text-mm-text">Materials</h2>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded hover:bg-mm-bg text-mm-text-muted hover:text-mm-text transition-colors"
          aria-label="Close materials panel"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Filter input */}
      <div className="px-3 py-2 border-b border-mm-border-subtle shrink-0 relative">
        <input
          ref={filterRef}
          type="text"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter materials..."
          className="w-full text-sm rounded-md border border-border bg-mm-bg px-2.5 py-1.5 pr-7 text-mm-text placeholder:text-mm-text-faint outline-none focus:ring-1 focus:ring-ring"
        />
        {filter && (
          <button
            type="button"
            onClick={() => { setFilter(''); filterRef.current?.focus() }}
            className="absolute right-5 top-1/2 -translate-y-1/2 p-0.5 rounded text-mm-text-muted hover:text-mm-text transition-colors"
            aria-label="Clear filter"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Scrollable sections */}
      <div className="flex-1 overflow-y-auto">
        {/* ── Excerpts ─────────────────────────────────────────────────── */}
        <SectionHeader
          label="Excerpts"
          count={excerptsLoad.status === 'ready' ? filteredExcerpts.length : null}
          expanded={expanded.excerpts}
          onToggle={() => toggleSection('excerpts')}
        />
        {expanded.excerpts && (
          <div className="px-2 pb-2" role="region" aria-label="Excerpts">
            {excerptsLoad.status !== 'ready' ? (
              /* #963 — "there are none" and "we have not asked yet" are
                 different sentences, and this one also names a place to go
                 and make some. */
              <LoadState
                load={excerptsLoad}
                loadingLabel="Loading excerpts…"
                failedTitle="Your excerpts could not be loaded"
                size="panel"
              />
            ) : filteredExcerpts.length === 0 ? (
              <p className="text-xs text-mm-text-muted italic px-2 py-1">
                {lowerFilter ? 'No excerpts match your filter.' : 'Create excerpts in a Coding Workbench to embed them here.'}
              </p>
            ) : (
              filteredExcerpts.map(e => {
                const isOnCanvas = onCanvasExcerpts.has(e.id)
                // #630: a clip has no speaker and no conversation, and a
                // time-range quote carries no text — so the old
                // `{excerpt_text}` over `[speaker, conversation]` row rendered
                // completely blank. Both lines now come from the same helpers
                // the embed uses, so the drawer and the embed cannot drift.
                const label = excerptDisplayLabel(e)
                const attribution = excerptAttributionLine(e, { includeSpeaker: true })
                return (
                  <ContextMenu key={e.id}>
                    <ContextMenuTrigger asChild>
                      <button
                        type="button"
                        onClick={() => onInsertExcerpt(e.id)}
                        disabled={inserting}
                        // Guards the empty case generally: a dataset-value
                        // excerpt is the other parent kind that can render thin,
                        // and a button with no text has no accessible name.
                        aria-label={`Insert ${[label, attribution].filter(Boolean).join(' — ') || 'excerpt'}`}
                        className={`w-full text-left px-2 py-1.5 rounded hover:bg-mm-bg transition-colors disabled:opacity-40 ${
                          isOnCanvas ? 'opacity-60 bg-mm-bg/50' : ''
                        }`}
                      >
                        <p className="text-xs text-mm-text italic line-clamp-2 leading-relaxed">
                          {label}
                        </p>
                        <div className="flex items-center gap-1 mt-0.5">
                          <p className="text-[10px] text-mm-text-muted truncate">
                            {attribution}
                          </p>
                          {isOnCanvas && (
                            <span className="ml-auto flex items-center gap-0.5 text-[10px] text-mm-text-faint shrink-0">
                              <Check className="w-3 h-3" />
                              On canvas
                            </span>
                          )}
                        </div>
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onSelect={() => onInsertExcerpt(e.id)}>
                        <Plus className="w-4 h-4 mr-2" />Insert into Theme
                      </ContextMenuItem>
                      {e.conversation_id && (
                        <>
                          <ContextMenuSeparator />
                          <ContextMenuItem onSelect={() => navigate(`/projects/${projectId}/conversations/${e.conversation_id}`)}>
                            <ExternalLink className="w-4 h-4 mr-2" />View Source
                          </ContextMenuItem>
                        </>
                      )}
                    </ContextMenuContent>
                  </ContextMenu>
                )
              })
            )}
          </div>
        )}

        {/* ── Charts ───────────────────────────────────────────────────── */}
        <SectionHeader
          label="Charts"
          count={materialsLoad.status === 'ready' ? filteredMaterials.length : null}
          expanded={expanded.charts}
          onToggle={() => toggleSection('charts')}
        />
        {expanded.charts && (
          <div className="px-2 pb-2" role="region" aria-label="Charts">
            {materialsLoad.status !== 'ready' ? (
              /* #963 — "there are none" and "we have not asked yet" are
                 different sentences, and this one also names a place to go
                 and make some. */
              <LoadState
                load={materialsLoad}
                loadingLabel="Loading charts…"
                failedTitle="Your charts could not be loaded"
                size="panel"
              />
            ) : filteredMaterials.length === 0 ? (
              <p className="text-xs text-mm-text-muted italic px-2 py-1">
                {lowerFilter ? 'No charts match your filter.' : 'Create charts in the Analysis View to embed them here.'}
              </p>
            ) : (
              filteredMaterials.map(m => {
                const isOnCanvas = onCanvasMaterials.has(m.id)
                const name = m.custom_name ?? m.auto_name
                const isQual = m.source_tab.startsWith('qualitative')
                return (
                  <ContextMenu key={m.id}>
                    <ContextMenuTrigger asChild>
                      <button
                        type="button"
                        onClick={() => onInsertMaterial(m.id)}
                        disabled={inserting}
                        className={`w-full text-left px-2 py-1.5 rounded hover:bg-mm-bg transition-colors disabled:opacity-40 ${
                          isOnCanvas ? 'opacity-60 bg-mm-bg/50' : ''
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-mm-text truncate flex-1">{name}</span>
                          <span
                            className={`text-[10px] font-medium shrink-0 rounded px-1 py-0.5 ${
                              isQual
                                ? 'text-emerald-700 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-900/30'
                                : 'text-mm-blue-text bg-mm-blue/12'
                            }`}
                          >
                            {isQual ? 'Q' : 'N'}
                          </span>
                        </div>
                        {isOnCanvas && (
                          <span className="flex items-center gap-0.5 text-[10px] text-mm-text-faint mt-0.5">
                            <Check className="w-3 h-3" />
                            On canvas
                          </span>
                        )}
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onSelect={() => onInsertMaterial(m.id)}>
                        <Plus className="w-4 h-4 mr-2" />Insert into Theme
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => navigate(`/projects/${projectId}/analysis/quantitative?material=${m.id}`)}>
                        <ExternalLink className="w-4 h-4 mr-2" />View Source
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                )
              })
            )}
          </div>
        )}

        {/* ── Memos ────────────────────────────────────────────────────── */}
        <SectionHeader
          label="Memos"
          count={memosLoad.status === 'ready' ? filteredMemos.length : null}
          expanded={expanded.memos}
          onToggle={() => toggleSection('memos')}
        />
        {expanded.memos && (
          <div className="px-2 pb-2" role="region" aria-label="Memos">
            {memosLoad.status !== 'ready' ? (
              /* #963 — "there are none" and "we have not asked yet" are
                 different sentences, and this one also names a place to go
                 and make some. */
              <LoadState
                load={memosLoad}
                loadingLabel="Loading memos…"
                failedTitle="Your memos could not be loaded"
                size="panel"
              />
            ) : filteredMemos.length === 0 ? (
              <p className="text-xs text-mm-text-muted italic px-2 py-1">
                {lowerFilter ? 'No memos match your filter.' : 'Write memos from any workbench to embed them here.'}
              </p>
            ) : (
              filteredMemos.map(m => {
                const isOnCanvas = onCanvasMemos.has(m.id)
                const preview =
                  m.content.length > 120 ? m.content.slice(0, 120) + '...' : m.content
                return (
                  <ContextMenu key={m.id}>
                    <ContextMenuTrigger asChild>
                      <button
                        type="button"
                        onClick={() => onInsertMemo(m.id)}
                        disabled={inserting}
                        className={`w-full text-left px-2 py-1.5 rounded hover:bg-mm-bg transition-colors disabled:opacity-40 ${
                          isOnCanvas ? 'opacity-60 bg-mm-bg/50' : ''
                        }`}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] font-mono font-medium text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/30 rounded px-1 py-0.5 shrink-0">
                            M-{m.numeric_id}
                          </span>
                          {m.title && (
                            <span className="text-xs font-medium text-mm-text truncate">
                              {m.title}
                            </span>
                          )}
                        </div>
                        {preview && (
                          <p className="text-[10px] text-mm-text-muted line-clamp-2 mt-0.5 leading-relaxed">
                            {preview}
                          </p>
                        )}
                        {isOnCanvas && (
                          <span className="flex items-center gap-0.5 text-[10px] text-mm-text-faint mt-0.5">
                            <Check className="w-3 h-3" />
                            On canvas
                          </span>
                        )}
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onSelect={() => onInsertMemo(m.id)}>
                        <Plus className="w-4 h-4 mr-2" />Insert into Theme
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => navigate(`/projects/${projectId}/memos-notes`)}>
                        <ExternalLink className="w-4 h-4 mr-2" />View Source
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                )
              })
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Section header sub-component ─────────────────────────────────────────────

function SectionHeader({
  label,
  count,
  expanded,
  onToggle,
}: {
  label: string
  /** #963 — `null` while the section's list is unanswered: a count is a claim,
   *  and an absent badge makes none. */
  count: number | null
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-mm-bg/60 transition-colors border-b border-mm-border-subtle"
      aria-expanded={expanded}
    >
      {expanded ? (
        <ChevronDown className="w-3.5 h-3.5 text-mm-text-muted shrink-0" />
      ) : (
        <ChevronRight className="w-3.5 h-3.5 text-mm-text-muted shrink-0" />
      )}
      <span className="text-xs font-semibold text-mm-text">{label}</span>
      {count !== null && (
        <span className="text-[10px] text-mm-text-secondary bg-mm-bg rounded-full px-1.5 py-0.5 tabular-nums ml-auto">
          {count}
        </span>
      )}
    </button>
  )
}
