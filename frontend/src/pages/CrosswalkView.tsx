/**
 * CrosswalkView — Tier 3 Variable Groups crosswalk page.
 *
 * Phase 3a shipped: drag-to-swap, conflict flash, undo toast, post-swap green
 * flash, search highlights.
 *
 * Phase 3b (in progress): all remaining mutations, 4 context menus, bulk
 * assign toolbar + picker, SwapErrorOverlay, drag-to-empty-cell move,
 * navigation hook (session storage + focus targets), ambient pills
 * (Σ badge → Analysis).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import {
  datasetsApi,
  domainsApi,
  equivalenceApi,
  extractApiError,
  metricsApi,
  recodeApi,
  type ProjectColumnInfo,
  type DomainMemberInput,
} from '@/lib/api'
import { CrosswalkHeader } from '@/components/crosswalk/CrosswalkHeader'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { downloadBlob } from '@/lib/api/download'
import { buildCrosswalkCsv } from '@/lib/crosswalk-csv'
import { UTF8_BOM } from '@/lib/csv'
import { CrosswalkColumnHeaders } from '@/components/crosswalk/CrosswalkColumnHeaders'
import { CrosswalkGrid } from '@/components/crosswalk/CrosswalkGrid'
import { UnassignedPanel } from '@/components/crosswalk/UnassignedPanel'
import { CrosswalkEmptyState } from '@/components/crosswalk/CrosswalkEmptyState'
import { AllDatasetsOffState } from '@/components/crosswalk/AllDatasetsOffState'
import { SuggestionBanner } from '@/components/crosswalk/SuggestionBanner'
import { SuggestionGhostRow } from '@/components/crosswalk/SuggestionGhostRow'
import { SuggestEmptyFallback } from '@/components/crosswalk/SuggestEmptyFallback'
import {
  buildGrid,
  computeUnassignedColumns,
  computeProjectDatasets,
  computeDatasetColumnCounts,
  computeColumnIdsByDomain,
} from '@/components/crosswalk/buildGrid'
import { useDatasetToggles } from '@/components/crosswalk/useDatasetToggles'
import { useMutedDatasetDots } from '@/components/crosswalk/useMutedDatasetDots'
import { getDatasetAccent } from '@/components/crosswalk/dataset-color'
import { useCrosswalkSearch } from '@/components/crosswalk/useCrosswalkSearch'
import { useCrosswalkDomainShape } from '@/components/crosswalk/useCrosswalkDomainShape'
import { useCrosswalkSelection } from '@/components/crosswalk/useCrosswalkSelection'
import { useCrosswalkCollapse } from '@/components/crosswalk/useCrosswalkCollapse'
import { useCrosswalkDialogState } from '@/components/crosswalk/useCrosswalkDialogState'
import { useSuggestGroups } from '@/components/crosswalk/useSuggestGroups'
import {
  useCrosswalkDnD,
  CrosswalkDnDProvider,
  type CrosswalkDnDHandlerRefs,
} from '@/components/crosswalk/useCrosswalkDnD'
import { useCrosswalkMutations, type MoveSnapshot } from '@/components/crosswalk/useCrosswalkMutations'
import {
  CreateDomainDialog,
  RenameDomainDialog,
  ZeroMemberDialog,
} from '@/components/crosswalk/DomainDialogs'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { navigateToScaleScore } from '@/components/crosswalk/navigation'
import { SwapErrorOverlay } from '@/components/crosswalk/SwapErrorOverlay'
import { BulkAssignPickerDialog } from '@/components/crosswalk/BulkAssignPickerDialog'
import { CopyRecodeDialog } from '@/components/CopyRecodeDialog'
import { useOpenCopyRecode } from '@/hooks/useOpenCopyRecode'
import { useCrosswalkNavigation } from '@/components/crosswalk/useCrosswalkNavigation'
import type { BracketData, RowData } from '@/components/crosswalk/crosswalk-types'
import '@/components/crosswalk/crosswalk.css'

export default function CrosswalkView() {
  const { projectId } = useParams<{ projectId: string }>()
  const pid = Number(projectId)
  const { project } = useProjectLayout()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // ── Server state ─────────────────────────────────────────────────────────
  const { data: allColumnsData, isLoading: columnsLoading } = useQuery({
    queryKey: ['project-columns', pid],
    queryFn: () => datasetsApi.allColumns(pid),
    enabled: !!pid,
  })

  const { data: domainsData, isLoading: domainsLoading } = useQuery({
    queryKey: ['analysis-domains', pid],
    queryFn: () => domainsApi.list(pid),
    enabled: !!pid,
  })

  const { data: equivalenceGroupsData, isLoading: egLoading } = useQuery({
    queryKey: ['equivalence-groups', pid],
    queryFn: () => equivalenceApi.list(pid),
    enabled: !!pid,
  })

  const { data: reverseColsData } = useQuery({
    queryKey: ['reverse-columns', pid],
    queryFn: () => recodeApi.listReverseScoredColumns(pid),
    enabled: !!pid,
  })

  // Phase 3b: metrics query, feeds buildGrid's scale_score_metric state.
  const { data: metricsData } = useQuery({
    queryKey: ['metrics', pid],
    queryFn: () => metricsApi.list(pid),
    enabled: !!pid,
  })

  const allColumns = useMemo(
    () => allColumnsData?.columns ?? [],
    [allColumnsData?.columns],
  )
  const domains = useMemo(() => domainsData?.domains ?? [], [domainsData?.domains])
  const equivalenceGroups = useMemo(
    () => equivalenceGroupsData?.groups ?? [],
    [equivalenceGroupsData?.groups],
  )
  const reverseScoredColumnIds = useMemo(
    () => new Set(reverseColsData?.column_ids ?? []),
    [reverseColsData?.column_ids],
  )
  const metrics = useMemo(() => metricsData?.metrics ?? [], [metricsData?.metrics])

  const columnsById = useMemo(() => {
    const map = new Map<number, (typeof allColumns)[number]>()
    for (const c of allColumns) map.set(c.id, c)
    return map
  }, [allColumns])

  // Domain-shape derivations — single pass over `domains[].members[]`
  // produces all four maps the page (and useCrosswalkDnD) need.
  const {
    domainMemberColumnIds,
    domainByColumnId,
    domainByEgId,
    bracketDatasetsByDomainId,
  } = useCrosswalkDomainShape(domains, columnsById)

  // Track domains whose last createScoreMetricMutation failed — overrides
  // buildGrid's state derivation to 'failed' for the bracket's Σ badge.
  const [failedScoreMetricDomainIds, setFailedScoreMetricDomainIds] = useState<Set<number>>(
    () => new Set(),
  )

  const projectDatasets = useMemo(
    () => computeProjectDatasets(allColumns),
    [allColumns],
  )
  const datasetNames = useMemo(() => {
    const map = new Map<number, string>()
    for (const ds of projectDatasets) map.set(ds.dataset_id, ds.dataset_name)
    return map
  }, [projectDatasets])
  const datasetColumnCounts = useMemo(
    () => computeDatasetColumnCounts(allColumns),
    [allColumns],
  )

  const toggleState = useDatasetToggles(projectDatasets.map((d) => d.dataset_id))

  // Per-project muted-dot state — local-storage backed Set<datasetId> + a
  // global `allMuted` boolean. Drives the click-to-toggle dataset-dot
  // visibility across crosswalk surfaces (column headers + cell dots).
  const datasetDots = useMutedDatasetDots(pid)

  // Stable resolver: dataset_id → effective accent color. Memoize so the
  // identity stays stable across renders and Cell's React.memo can still
  // skip work for unchanged cells (foot-gun #332).
  const resolveDatasetColor = useMemo(() => {
    const allIds = projectDatasets.map((d) => d.dataset_id)
    const colorById = new Map<number, string | null>()
    for (const ds of projectDatasets) colorById.set(ds.dataset_id, ds.dataset_color)
    return (datasetId: number): string =>
      getDatasetAccent(datasetId, allIds, colorById.get(datasetId) ?? null)
  }, [projectDatasets])

  // Color-change mutation — reused by the column header dot's right-click
  // picker. Same invalidation pattern as the Datasets list page version
  // so the dot picks up the new color across surfaces without a refresh.
  const datasetColorMutation = useMutation({
    mutationFn: ({ id, color }: { id: number; color: string | null }) =>
      datasetsApi.update(pid, id, { color }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-columns', pid] })
      queryClient.invalidateQueries({ queryKey: ['datasets', pid] })
    },
    onError: (err: Error) =>
      toast.error(extractApiError(err, 'Failed to update dataset color')),
  })
  const handleDatasetColorChange = useCallback(
    (datasetId: number, color: string | null) => {
      datasetColorMutation.mutate({ id: datasetId, color })
    },
    [datasetColorMutation],
  )

  const grid = useMemo(
    () =>
      buildGrid({
        domains,
        allColumns,
        equivalenceGroups,
        reverseScoredColumnIds,
        metrics,
        failedScoreMetricDomainIds,
      }),
    [domains, allColumns, equivalenceGroups, reverseScoredColumnIds, metrics, failedScoreMetricDomainIds],
  )

  const unassigned = useMemo(
    () => computeUnassignedColumns(allColumns, domainMemberColumnIds),
    [allColumns, domainMemberColumnIds],
  )

  const search = useCrosswalkSearch({ grid, unassigned })

  // #327: derive domain IDs whose columns intersect the current search match
  // set. Used to transiently uncollapse those brackets so search highlights
  // are visible without mutating the persisted collapse set. Computed in
  // CrosswalkView (depends on grid + search); fed into useCrosswalkCollapse.
  const columnIdsByDomain = useMemo(() => computeColumnIdsByDomain(grid), [grid])
  const domainIdsWithSearchMatches = useMemo(() => {
    if (!search.isActive || search.searchHighlightIds.size === 0) {
      return new Set<number>()
    }
    const out = new Set<number>()
    for (const [domainId, columnIds] of columnIdsByDomain) {
      for (const cid of columnIds) {
        if (search.searchHighlightIds.has(cid)) {
          out.add(domainId)
          break
        }
      }
    }
    return out
  }, [columnIdsByDomain, search.isActive, search.searchHighlightIds])

  // #327: per-project bracket collapse state + transient drag-hover expand.
  // Persisted to localStorage `mm-crosswalk-collapsed-${pid}`.
  const {
    collapsedDomainIds,
    effectiveCollapsedIds,
    toggleCollapse,
    collapseAll,
    expandAll,
    handleBracketHoverExpand,
  } = useCrosswalkCollapse(pid, domains, domainIdsWithSearchMatches)

  // Multi-select state for cells (Cmd/Ctrl-click) and Unassigned panel
  // checkboxes. Selection persists across mutations by design; Escape
  // clears the cell selection, panel selection auto-prunes when its
  // backing `unassigned` array shrinks.
  const {
    selectedCellIds,
    handleCellClick,
    selectedUnassignedIds,
    setSelectedUnassignedIds,
    toggleUnassigned,
    clearUnassignedSelection,
  } = useCrosswalkSelection(unassigned)

  const activeDatasets = useMemo(() => {
    if (toggleState.isAllOff) return []
    return projectDatasets.filter((ds) => toggleState.isActive(ds.dataset_id))
  }, [projectDatasets, toggleState])
  const activeDatasetIds = useMemo(
    () => activeDatasets.map((ds) => ds.dataset_id),
    [activeDatasets],
  )

  // #12d-a — export the crosswalk as a CSV harmonization table (consulting
  // deliverable). Columns follow the on-screen active-dataset order; a UTF-8
  // BOM keeps non-ASCII item wording intact when opened in Excel.
  const handleExportCsv = useCallback(() => {
    const csv = buildCrosswalkCsv(grid, activeDatasets)
    const blob = new Blob([UTF8_BOM + csv], { type: 'text/csv;charset=utf-8;' })
    const slug =
      (project?.name ?? 'project')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'project'
    downloadBlob(blob, `${slug}-crosswalk.csv`)
  }, [grid, activeDatasets, project])

  const crosswalkColsStyle = useMemo<React.CSSProperties>(
    () => ({
      ['--crosswalk-cols' as never]: `repeat(${Math.max(activeDatasetIds.length, 1)}, minmax(0, 1fr))`,
    }),
    [activeDatasetIds.length],
  )

  // ── Dialog state ─────────────────────────────────────────────────────────
  // All open/close state for the 9 crosswalk dialogs lives in one hook.
  // Confirm-handlers stay in CrosswalkView (they need direct access to
  // mutations), but the state cluster is consolidated.
  const {
    createDialogOpen,
    setCreateDialogOpen,
    pendingCreateColumnIds,
    setPendingCreateColumnIds,
    renameDialogDomain,
    setRenameDialogDomain,
    deleteDomainConfirm,
    setDeleteDomainConfirm,
    deleteRowConfirm,
    setDeleteRowConfirm,
    zeroMemberConfirm,
    setZeroMemberConfirm,
    bulkAssignOpen,
    setBulkAssignOpen,
    bulkAssignPreselectedBracketId,
    setBulkAssignPreselectedBracketId,
    openBulkAssignWithoutPreselect,
    swapErrorState,
    setSwapErrorState,
    copyRecodeState,
    setCopyRecodeState,
  } = useCrosswalkDialogState()

  // ── DnD + mutations wiring ───────────────────────────────────────────────
  const dndHandlersRef = useRef<CrosswalkDnDHandlerRefs>({})

  // #342: snapshot of the most recent move-members result, used to drive
  // the Undo toast effect below. Mirrors the swap snapshot pattern.
  const [lastMoveSnapshot, setLastMoveSnapshot] = useState<MoveSnapshot | null>(null)

  const mutations = useCrosswalkMutations({
    projectId: pid,
    onSwapSuccess: (s) => dndHandlersRef.current.onSwapSuccess?.(s),
    onMoveSuccess: (i) => dndHandlersRef.current.onMoveSuccess?.(i),
    onMoveSnapshot: (s) => setLastMoveSnapshot(s),
    onScoreMetricFailed: (domainId) => {
      setFailedScoreMetricDomainIds((prev) => {
        if (prev.has(domainId)) return prev
        const next = new Set(prev)
        next.add(domainId)
        return next
      })
    },
    onScoreMetricRecovered: (domainId) => {
      setFailedScoreMetricDomainIds((prev) => {
        if (!prev.has(domainId)) return prev
        const next = new Set(prev)
        next.delete(domainId)
        return next
      })
    },
    onSwapTypeMismatch: (payload, error) => {
      setSwapErrorState({
        originalPayload: payload,
        columnIds: error.column_ids ?? [],
        message: error.message,
      })
    },
  })

  // #327: bracket order for the sortable's drag-end branch. The DnD hook
  // reads through optionsRef so this only needs to be referentially stable.
  const bracketIds = useMemo(() => domains.map((d) => d.id), [domains])

  const handleNewBracketDrop = useCallback(
    (columnIds: number[]) => {
      setPendingCreateColumnIds(columnIds.length > 0 ? new Set(columnIds) : null)
      setCreateDialogOpen(true)
    },
    [setCreateDialogOpen, setPendingCreateColumnIds],
  )

  const dnd = useCrosswalkDnD({
    activeDatasetIds,
    allColumns,
    mutations,
    handlerRefs: dndHandlersRef,
    domainByColumnId,
    domainByEgId,
    selectedColumnIds: selectedCellIds,
    bracketIds,
    onBracketHoverExpand: handleBracketHoverExpand,
    onNewBracketDrop: handleNewBracketDrop,
    bracketDatasetsByDomainId,
    selectedUnassignedColumnIds: selectedUnassignedIds,
  })
  const {
    activeDragColumnId,
    lastSwapSnapshot,
    clearSwapSnapshot,
    conflictFlashColumnId,
    swapFlashColumnIds,
    submitSwap,
    blockDragStartRef,
  } = dnd

  // TanStack Query's useMutation returns fresh result objects per render, so
  // listing `mutations.fooMutation` in any useCallback's deps causes that
  // callback to churn identity on every parent render — which defeats the
  // React.memo wrappers on Bracket / EquivalenceRow / Cell. Read mutations
  // through this ref inside handlers; they're invoked at user-action time,
  // not during render. (Mirrors the same pattern in useCrosswalkDnD.)
  const mutationsRef = useRef(mutations)
  useEffect(() => {
    mutationsRef.current = mutations
  }, [mutations])

  // ── Undo toast for swap (Phase 3a.11, preserved) ─────────────────────────
  const latestSwapTimestampRef = useRef<number>(0)
  useEffect(() => {
    if (!lastSwapSnapshot) return
    const myTimestamp = lastSwapSnapshot.timestamp
    latestSwapTimestampRef.current = myTimestamp
    const inversePayload = lastSwapSnapshot.inversePayload

    let toastTitle = 'Swap applied'
    if (inversePayload.length === 1) {
      const { column_id_a, column_id_b } = inversePayload[0]
      const colA = columnsById.get(column_id_a)
      const colB = columnsById.get(column_id_b)
      if (colA && colB) {
        const codeA = colA.column_code ?? `col ${colA.id}`
        const codeB = colB.column_code ?? `col ${colB.id}`
        toastTitle = `Swapped ${codeA} ↔ ${codeB} in ${colA.dataset_name}`
      }
    } else if (inversePayload.length > 1) {
      const datasets = new Set<string>()
      for (const { column_id_a } of inversePayload) {
        const col = columnsById.get(column_id_a)
        if (col) datasets.add(col.dataset_name)
      }
      toastTitle = `Swapped ${inversePayload.length} pairs in ${Array.from(datasets).join(', ')}`
    }

    toast(toastTitle, {
      id: 'crosswalk-swap-toast',
      action: {
        label: 'Undo',
        onClick: () => {
          if (latestSwapTimestampRef.current !== myTimestamp) {
            toast.error('Undo unavailable — newer swap has landed.')
            return
          }
          submitSwap(inversePayload)
        },
      },
      duration: 8000,
      onDismiss: () => clearSwapSnapshot(),
      onAutoClose: () => clearSwapSnapshot(),
    })
  }, [lastSwapSnapshot, submitSwap, clearSwapSnapshot, columnsById])

  // ── Undo toast for move-members (#342) ────────────────────────────────────
  // Single-source moves get a real Undo action. Multi-source moves still
  // get a toast (so the user sees what happened) but with no action button
  // and an "Undo unavailable" suffix.
  const latestMoveTimestampRef = useRef<number>(0)
  useEffect(() => {
    if (!lastMoveSnapshot) return
    const snap = lastMoveSnapshot
    const myTimestamp = snap.timestamp
    latestMoveTimestampRef.current = myTimestamp

    // Build a descriptive title. Examples:
    //   "Moved Q3 to Engagement"          (1 col, target domain)
    //   "Moved 3 columns to Engagement"   (multi col, target domain)
    //   "Removed Q3 from Wave 1"          (target_mode='strip', source domain)
    //   "Moved Q3"                         (no source, no target — shouldn't happen)
    const codes = snap.columnCodes.filter((c): c is string => c != null)
    const subj = snap.columnIds.length === 1
      ? (codes[0] ?? 'column')
      : codes.length > 0 && codes.length <= 3
        ? codes.join(', ')
        : `${snap.columnIds.length} columns`
    let title: string
    if (snap.targetLabel) {
      title = `Moved ${subj} to ${snap.targetLabel}`
    } else if (snap.sourceLabels.domain_name) {
      title = `Removed ${subj} from ${snap.sourceLabels.domain_name}`
    } else {
      title = `Moved ${subj}`
    }

    const dissolvedDesc = snap.dissolvedCount > 0
      ? `${snap.dissolvedCount} empty equivalence ${snap.dissolvedCount === 1 ? 'row' : 'rows'} dissolved.`
      : undefined

    if (snap.inversePlan) {
      const plan = snap.inversePlan
      toast(title, {
        id: 'crosswalk-move-toast',
        description: dissolvedDesc,
        action: {
          label: 'Undo',
          onClick: () => {
            if (latestMoveTimestampRef.current !== myTimestamp) {
              toast.error('Undo unavailable — newer move has landed.')
              return
            }
            mutationsRef.current.moveMembersMutation.mutate(plan)
          },
        },
        duration: 8000,
        onDismiss: () => setLastMoveSnapshot(null),
        onAutoClose: () => setLastMoveSnapshot(null),
      })
    } else {
      // Multi-source: Undo not available in this scope. Tell the user why.
      toast(`${title} (Undo unavailable for moves spanning multiple sources)`, {
        id: 'crosswalk-move-toast',
        duration: 6000,
        onDismiss: () => setLastMoveSnapshot(null),
        onAutoClose: () => setLastMoveSnapshot(null),
      })
    }
  }, [lastMoveSnapshot])

  // Phase 3.5: Unassigned panel visibility. Default open on first visit;
  // persist per-project in localStorage.
  const panelStorageKey = `mm-crosswalk-panel-${pid}`
  const [panelOpen, setPanelOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    const stored = window.localStorage.getItem(panelStorageKey)
    return stored == null ? true : stored === 'true'
  })
  const togglePanel = useCallback(() => {
    setPanelOpen((prev) => {
      const next = !prev
      try {
        window.localStorage.setItem(panelStorageKey, String(next))
      } catch {
        // localStorage quota / privacy mode — fall through silently.
      }
      return next
    })
  }, [panelStorageKey])
  const closePanel = useCallback(() => {
    setPanelOpen(false)
    try {
      window.localStorage.setItem(panelStorageKey, 'false')
    } catch {
      // ignore
    }
  }, [panelStorageKey])

  // Transient pulse on a bracket's "+ Add variable row" button. Set when
  // the user clicks that button (no drop is happening yet); cleared after
  // the CSS animation completes (~1.2s, matches `crosswalk-add-row-pulse`
  // keyframes). Single-active-pulse is fine — clicking another bracket's
  // button just retargets the pulse.
  const [pulseAddRowDomainId, setPulseAddRowDomainId] = useState<number | null>(null)
  useEffect(() => {
    if (pulseAddRowDomainId == null) return
    const t = setTimeout(() => setPulseAddRowDomainId(null), 1200)
    return () => clearTimeout(t)
  }, [pulseAddRowDomainId])

  // ── Copy-recode hook ─────────────────────────────────────────────────────
  const openCopyRecode = useOpenCopyRecode({
    projectId: pid,
    onOpen: (args) => setCopyRecodeState(args),
  })

  // ── Navigation (session storage, focus targets) ──────────────────────────
  useCrosswalkNavigation({
    projectId: pid,
    searchQuery: search.query,
    setSearchQuery: search.setQuery,
  })

  // ── Mutation invocation helpers for children ─────────────────────────────

  const handleCreateDomain = useCallback(
    (data: {
      name: string
      description?: string | null
      color?: string | null
      members?: DomainMemberInput[]
    }) => {
      const hadMembers = (data.members?.length ?? 0) > 0
      mutations.createDomainMutation.mutate(data, {
        onSuccess: () => {
          setCreateDialogOpen(false)
          // Clear Unassigned selection only when the user opted to include
          // them as members — otherwise leave the selection intact so they
          // can bulk-assign later.
          if (hadMembers) setSelectedUnassignedIds(new Set())
        },
      })
    },
    [mutations.createDomainMutation, setCreateDialogOpen, setSelectedUnassignedIds],
  )

  const handleRenameDomain = useCallback(
    (domainId: number, data: { name: string; description?: string | null; color?: string | null }) => {
      mutations.updateDomainMutation.mutate(
        { domainId, data },
        { onSuccess: () => setRenameDialogDomain(null) },
      )
    },
    [mutations.updateDomainMutation, setRenameDialogDomain],
  )

  const handleDeleteDomainConfirmed = useCallback(() => {
    if (!deleteDomainConfirm) return
    mutations.deleteDomainMutation.mutate(
      { domainId: deleteDomainConfirm.id, domainName: deleteDomainConfirm.name },
      { onSettled: () => setDeleteDomainConfirm(null) },
    )
  }, [deleteDomainConfirm, mutations.deleteDomainMutation, setDeleteDomainConfirm])

  const handleDeleteRowConfirmed = useCallback(() => {
    if (!deleteRowConfirm) return
    mutations.deleteRowMutation.mutate(
      { groupId: deleteRowConfirm.groupId, label: deleteRowConfirm.label },
      { onSettled: () => setDeleteRowConfirm(null) },
    )
  }, [deleteRowConfirm, mutations.deleteRowMutation, setDeleteRowConfirm])

  // Mutation-using handlers below thread to memoized children (Bracket /
  // EquivalenceRow / Cell). They read mutations through `mutationsRef.current`
  // so the useCallback identities stay stable across parent renders even
  // though TanStack's mutation result objects do not.

  /** "+ Add variable row" click handler (replaces the prior dialog-opening
   * behavior). The button is now a drop target — see Bracket.tsx — so the
   * primary gesture is drag-from-Unassigned (or any cell). The click path
   * is for keyboard / mouse users who haven't grabbed a card yet:
   *   1. If the unassigned panel is closed, open it (so the user can see
   *      what's draggable).
   *   2. If there are no unassigned columns, info toast (same as before).
   *   3. Otherwise, pulse the bracket's row-end button to anchor attention.
   *
   * Researchers who prefer a checkbox-flow can right-click an unassigned
   * card → "Add to variable group…" → BulkAssignPickerDialog (preserved
   * keyboard / accessibility fallback). The per-bracket button no longer
   * opens the dialog; that path is retired in favor of drag + the panel's
   * own toolbar Add… button. */
  const handleAddRow = useCallback((bracket: BracketData) => {
    if (unassigned.length === 0) {
      toast.info('No unassigned columns to add', {
        description:
          'All columns are already in a variable group. Remove a column from another group first.',
      })
      return
    }
    if (!panelOpen) togglePanel()
    setPulseAddRowDomainId(bracket.domain_id)
  }, [unassigned.length, panelOpen, togglePanel])

  const handleDeleteRow = useCallback((row: RowData, cellCount: number) => {
    if (row.kind === 'unlinked') {
      // Synthetic single-cell rows are standalone domain members. "Delete
      // row" removes the column from its owning variable group, which
      // dissolves the row visually.
      const owningDomain = domains.find((d) =>
        d.members.some(
          (m) => m.member_type === 'column' && m.member_id === row.column_id,
        ),
      )
      if (!owningDomain) return
      mutationsRef.current.removeMembersMutation.mutate({
        domainId: owningDomain.id,
        members: [{ member_type: 'column', member_id: row.column_id }],
      })
      return
    }
    if (cellCount <= 1) {
      mutationsRef.current.deleteRowMutation.mutate({
        groupId: row.equivalence_group_id,
        label: row.auto_label,
      })
      return
    }
    setDeleteRowConfirm({
      groupId: row.equivalence_group_id,
      label: row.auto_label,
      cellCount,
    })
  }, [domains, setDeleteRowConfirm])

  const handleReorderDomain = useCallback(
    (domainId: number, direction: 'up' | 'down') => {
      const idx = domains.findIndex((d) => d.id === domainId)
      if (idx === -1) return
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1
      if (targetIdx < 0 || targetIdx >= domains.length) return
      const ids = domains.map((d) => d.id)
      ;[ids[idx], ids[targetIdx]] = [ids[targetIdx], ids[idx]]
      mutationsRef.current.reorderDomainsMutation.mutate({ domainIds: ids })
    },
    [domains],
  )

  const handleReorderRow = useCallback(
    (domainId: number, rowIndex: number, direction: 'up' | 'down') => {
      const domain = domains.find((d) => d.id === domainId)
      const bracket = grid.brackets.find((b) => b.domain_id === domainId)
      if (!domain || !bracket) return
      const targetIdx = direction === 'up' ? rowIndex - 1 : rowIndex + 1
      if (targetIdx < 0 || targetIdx >= bracket.rows.length) return

      // Path A #325: rows are a discriminated union. Build a stable per-row
      // identity (eg or unlinked column) so reorder can swap them and rebuild
      // the member sequence.
      type RowKey =
        | { kind: 'eg'; egId: number }
        | { kind: 'unlinked'; columnId: number }
      const rowKeys: RowKey[] = bracket.rows.map((r) =>
        r.kind === 'eg'
          ? { kind: 'eg', egId: r.equivalence_group_id }
          : { kind: 'unlinked', columnId: r.column_id },
      )
      ;[rowKeys[rowIndex], rowKeys[targetIdx]] = [rowKeys[targetIdx], rowKeys[rowIndex]]

      // Map each domain member (id, member_id) into the owning row key, so
      // the reorder operation can rewrite the member sequence in row order.
      const memberIdsByKey = new Map<string, number[]>()
      const keyOf = (k: RowKey) =>
        k.kind === 'eg' ? `eg:${k.egId}` : `col:${k.columnId}`
      for (const m of domain.members) {
        if (m.member_type !== 'column') continue
        const col = columnsById.get(m.member_id)
        if (!col) continue
        const key =
          col.equivalence_group_id != null
            ? `eg:${col.equivalence_group_id}`
            : `col:${col.id}`
        if (!memberIdsByKey.has(key)) memberIdsByKey.set(key, [])
        memberIdsByKey.get(key)!.push(m.id)
      }
      const orderedMemberIds: number[] = []
      for (const k of rowKeys) {
        orderedMemberIds.push(...(memberIdsByKey.get(keyOf(k)) ?? []))
      }
      mutationsRef.current.reorderRowsMutation.mutate({
        domainId,
        memberIds: orderedMemberIds,
      })
    },
    [domains, grid.brackets, columnsById],
  )

  const handleRemoveFromRow = useCallback(
    (columnId: number) => {
      const col = columnsById.get(columnId)
      if (!col || col.equivalence_group_id == null) return
      // The mutation auto-deletes the EG if this was the last cell, so no
      // per-handler special-casing needed — drag-to-panel and context-menu
      // both route through the same single call.
      mutationsRef.current.removeColumnFromRowMutation.mutate({
        groupId: col.equivalence_group_id,
        columnId,
      })
    },
    [columnsById],
  )

  // Path A revised: "Remove from variable group" performs a full unassign
  // — sever both domain membership AND the equivalence link, so the column
  // lands in the Unassigned panel. This eliminates the prior "preserve
  // equivalence" path that left invisible orphan EGs behind. If the
  // removal would empty the domain, the ZeroMemberDialog still asks
  // whether to keep the empty group or delete it; either path full-unassigns
  // the column.
  const handleRemoveFromVariableGroup = useCallback(
    (columnId: number) => {
      const owningDomain = domains.find((d) =>
        d.members.some((m) => m.member_type === 'column' && m.member_id === columnId),
      )
      if (!owningDomain) return
      const member: DomainMemberInput = { member_type: 'column', member_id: columnId }
      const columnMemberCount = owningDomain.members.filter((m) => m.member_type === 'column').length
      if (columnMemberCount <= 1) {
        setZeroMemberConfirm({
          domainId: owningDomain.id,
          domainName: owningDomain.name,
          members: [member],
        })
        return
      }
      mutationsRef.current.moveMembersMutation.mutate({
        column_ids: [columnId],
        source_domain_id: owningDomain.id,
        target_domain_id: null,
        target_mode: 'strip',
      })
    },
    [domains, setZeroMemberConfirm],
  )

  const handleZeroMemberKeepEmpty = useCallback(() => {
    if (!zeroMemberConfirm) return
    const columnIds = zeroMemberConfirm.members
      .filter((m) => m.member_type === 'column')
      .map((m) => m.member_id)
    if (columnIds.length === 0) {
      setZeroMemberConfirm(null)
      return
    }
    mutations.moveMembersMutation.mutate(
      {
        column_ids: columnIds,
        source_domain_id: zeroMemberConfirm.domainId,
        target_domain_id: null,
        target_mode: 'strip',
      },
      { onSettled: () => setZeroMemberConfirm(null) },
    )
  }, [zeroMemberConfirm, mutations.moveMembersMutation, setZeroMemberConfirm])

  const handleZeroMemberDeleteGroup = useCallback(() => {
    if (!zeroMemberConfirm) return
    mutations.deleteDomainMutation.mutate(
      { domainId: zeroMemberConfirm.domainId, domainName: zeroMemberConfirm.domainName },
      { onSettled: () => setZeroMemberConfirm(null) },
    )
  }, [zeroMemberConfirm, mutations.deleteDomainMutation, setZeroMemberConfirm])

  const handleScaleScoreClick = useCallback(
    (metricId: number, domainId: number) => navigateToScaleScore(navigate, pid, metricId, domainId),
    [navigate, pid],
  )

  const handleCopyRecode = useCallback(
    (cellColumnId: number, rowColumnIds: number[]) => {
      const src = columnsById.get(cellColumnId)
      if (!src) return
      const targets = rowColumnIds
        .filter((id) => id !== cellColumnId)
        .map((id) => columnsById.get(id))
        .filter((c): c is ProjectColumnInfo => c != null)
      if (targets.length === 0) return
      openCopyRecode(src, targets)
    },
    [columnsById, openCopyRecode],
  )

  const handleQuickAddDrawerItem = useCallback(
    (column: ProjectColumnInfo) => {
      setSelectedUnassignedIds(new Set([column.id]))
      setBulkAssignOpen(true)
    },
    [setSelectedUnassignedIds, setBulkAssignOpen],
  )

  const handleViewInDataset = useCallback(
    (col: ProjectColumnInfo | { dataset_id: number; id: number }) => {
      navigate(`/projects/${pid}/datasets/${col.dataset_id}?column=${col.id}`)
    },
    [navigate, pid],
  )

  const handleSwapErrorRetry = useCallback(() => {
    if (!swapErrorState) return
    // #340: rapid-double-click guard. submitSwap doesn't itself check
    // swapInFlight before calling mutate, so without this gate two clicks
    // within one render dispatched two swap mutations. The overlay also
    // visually disables the Retry button via isRetrying below; this is the
    // correctness backstop.
    if (mutations.swapMutation.isPending) return
    submitSwap(swapErrorState.originalPayload)
    setSwapErrorState(null)
  }, [swapErrorState, submitSwap, setSwapErrorState, mutations.swapMutation.isPending])

  // Stable bracket-action callbacks — replace inline arrows in JSX so memo'd
  // children downstream of CrosswalkGrid don't see new prop identities every
  // parent render. (Distinct from the existing `handleRenameDomain` defined
  // earlier, which fires the rename mutation; these open the dialogs.)
  const handleOpenRenameDialog = useCallback(
    (bracket: BracketData) => {
      setRenameDialogDomain(bracket)
    },
    [setRenameDialogDomain],
  )

  const handleDeleteDomainOpen = useCallback(
    (bracket: BracketData) => {
      setDeleteDomainConfirm({ id: bracket.domain_id, name: bracket.name })
    },
    [setDeleteDomainConfirm],
  )

  const handleCreateScoreMetric = useCallback((bracket: BracketData) => {
    mutationsRef.current.createScoreMetricMutation.mutate({
      domainId: bracket.domain_id,
      domainName: bracket.name,
    })
  }, [])

  // ── Phase 4: Suggest Groups ──────────────────────────────────────────────
  const {
    suggestActive,
    suggestLoading,
    visibleSuggestions,
    handleSuggestClick,
    handleDismissSuggestion,
    handleDismissAllSuggestions,
    handleAcceptSuggestion,
    handleAcceptAllSuggestions,
  } = useSuggestGroups({
    projectId: pid,
    allColumns,
    domainMemberColumnIds,
    mutationsRef,
  })

  // Empty-fallback wiring (CTA 1 — Browse Unassigned panel).
  const handleBrowseUnassigned = useCallback(() => {
    if (!panelOpen) togglePanel()
  }, [panelOpen, togglePanel])

  // Phase 4.4: TypePickerPopover handler. Single-column path through
  // bulkTypeUpdateMutation (which is dataset-scoped — see foot-gun,
  // safe here because we always batch by single dataset_id). The mutation's
  // own onError surfaces the recode_definitions_exist 409 toast.
  const handleTypeChange = useCallback(
    (columnId: number, datasetId: number, newType: string) => {
      mutationsRef.current.bulkTypeUpdateMutation.mutate({
        datasetId,
        columnIds: [columnId],
        columnType: newType,
      })
    },
    [],
  )

  const isLoading = columnsLoading || domainsLoading || egLoading
  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-6 w-48 bg-mm-surface rounded" />
          <div className="h-4 w-96 bg-mm-surface rounded" />
          <div className="h-32 w-full bg-mm-surface/50 rounded-lg mt-8" />
        </div>
      </div>
    )
  }

  const hasNoGroups = grid.brackets.length === 0
  const showAllDatasetsOff = toggleState.isAllOff

  return (
    <CrosswalkDnDProvider dnd={dnd}>
      <div
        className="p-6 max-w-7xl mx-auto h-full flex flex-col"
        style={crosswalkColsStyle}
      >
        <CrosswalkHeader
          searchQuery={search.query}
          onSearchChange={search.setQuery}
          onSearchClear={search.clear}
          datasets={projectDatasets}
          toggleState={toggleState}
          bracketCount={grid.brackets.length}
          onCreateDomain={() => setCreateDialogOpen(true)}
          onSuggestGroups={handleSuggestClick}
          isSuggestLoading={suggestLoading}
          datasetCount={projectDatasets.length}
          panelOpen={panelOpen}
          onTogglePanel={togglePanel}
          collapsedCount={collapsedDomainIds.size}
          onCollapseAll={collapseAll}
          onExpandAll={expandAll}
          allDotsHidden={datasetDots.allMuted}
          onToggleAllDots={datasetDots.toggleAllMuted}
          onExportCsv={handleExportCsv}
        />

        {/* Body row: main grid (scrolls) + optional panel (scrolls
         * independently). `min-h-0` is load-bearing — without it, flex
         * children default to min-height: auto and both regions overflow
         * into ProjectLayout's scroll container. */}
        <div className="flex flex-1 min-h-0 gap-4">
          <main className="flex-1 min-w-0 overflow-y-auto">
            {showAllDatasetsOff ? (
              <AllDatasetsOffState />
            ) : hasNoGroups && suggestActive && !suggestLoading && visibleSuggestions.length === 0 ? (
              // Suggest finished, found nothing, and project has no brackets:
              // surface the three-CTA empty fallback (§2 item 42).
              <SuggestEmptyFallback
                onBrowseUnassigned={handleBrowseUnassigned}
                onCreateBlank={() => setCreateDialogOpen(true)}
                dragActive={activeDragColumnId != null}
              />
            ) : hasNoGroups ? (
              <CrosswalkEmptyState
                datasetCount={projectDatasets.length}
                onSuggest={handleSuggestClick}
                onCreateBlank={() => setCreateDialogOpen(true)}
                isSuggestLoading={suggestLoading}
              />
            ) : (
              <>
                <CrosswalkColumnHeaders
                  activeDatasets={activeDatasets}
                  columnCounts={datasetColumnCounts}
                  allDatasetIds={projectDatasets.map((d) => d.dataset_id)}
                  isMuted={datasetDots.isMuted}
                  onToggleMute={datasetDots.toggleMuted}
                  onColorChange={handleDatasetColorChange}
                />

                <CrosswalkGrid
                  grid={grid}
                  activeDatasetIds={activeDatasetIds}
                  datasetNames={datasetNames}
                  searchHighlightIds={search.searchHighlightIds}
                  activeDragColumnId={activeDragColumnId}
                  conflictFlashColumnId={conflictFlashColumnId}
                  swapFlashColumnIds={swapFlashColumnIds}
                  onAddRow={handleAddRow}
                  onScoreMetricClick={handleScaleScoreClick}
                  onRemoveFromRow={handleRemoveFromRow}
                  onCopyRecode={handleCopyRecode}
                  onDeleteRow={handleDeleteRow}
                  onReorderRow={handleReorderRow}
                  onRenameDomain={handleOpenRenameDialog}
                  onDeleteDomain={handleDeleteDomainOpen}
                  onReorderDomain={handleReorderDomain}
                  onCreateScoreMetric={handleCreateScoreMetric}
                  domainMemberColumnIds={domainMemberColumnIds}
                  onRemoveFromVariableGroup={handleRemoveFromVariableGroup}
                  blockDragStartRef={blockDragStartRef}
                  onViewInDataset={handleViewInDataset}
                  selectedCellIds={selectedCellIds}
                  onCellClick={handleCellClick}
                  effectiveCollapsedIds={effectiveCollapsedIds}
                  onToggleCollapse={toggleCollapse}
                  onCreateDomain={() => setCreateDialogOpen(true)}
                  projectId={pid}
                  onTypeChange={handleTypeChange}
                  resolveDatasetColor={resolveDatasetColor}
                  isDatasetDotMuted={datasetDots.isMuted}
                  onToggleDatasetMute={datasetDots.toggleMuted}
                  pulseAddRowDomainId={pulseAddRowDomainId}
                />

                {/* Phase 4.1/4.2: Suggest ghost rows render between existing
                 * brackets and the AddVariableGroupTile (Revision 7). */}
                {suggestActive && visibleSuggestions.length > 0 && (
                  <div data-testid="suggestion-ghost-list">
                    <SuggestionBanner
                      suggestionCount={visibleSuggestions.length}
                      isAccepting={mutations.bulkCreateDomainsMutation.isPending}
                      onAcceptAll={handleAcceptAllSuggestions}
                      onDismissAll={handleDismissAllSuggestions}
                    />
                    {visibleSuggestions.map(({ s, originalIndex }) => (
                      <SuggestionGhostRow
                        key={originalIndex}
                        suggestion={s}
                        index={originalIndex}
                        isAccepting={mutations.bulkCreateDomainsMutation.isPending}
                        onAccept={handleAcceptSuggestion}
                        onDismiss={handleDismissSuggestion}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </main>

          {!showAllDatasetsOff && panelOpen && (
            <UnassignedPanel
              unassigned={unassigned}
              selectedIds={selectedUnassignedIds}
              onToggle={toggleUnassigned}
              searchHighlightIds={search.searchHighlightIds}
              searchActive={search.isActive}
              onClose={closePanel}
              onClearSelection={clearUnassignedSelection}
              onBulkAssign={openBulkAssignWithoutPreselect}
              onSearchClear={search.clear}
              blockDragStartRef={blockDragStartRef}
              onViewInDataset={handleViewInDataset}
              onQuickAdd={handleQuickAddDrawerItem}
              activeDragColumnId={activeDragColumnId}
            />
          )}
        </div>

        {/* Dialogs */}
        <CreateDomainDialog
          open={createDialogOpen}
          onOpenChange={(open) => {
            setCreateDialogOpen(open)
            // When the dialog closes (cancel OR successful create), clear the
            // pending drop seed so the next time the dialog opens via the
            // toolbar button or empty-state CTA it falls back to whatever
            // selection the Unassigned panel has.
            if (!open) setPendingCreateColumnIds(null)
          }}
          onConfirm={handleCreateDomain}
          loading={mutations.createDomainMutation.isPending}
          // Drop intent (pendingCreateColumnIds) wins over the Unassigned
          // panel selection when both are present — drag carries explicit
          // column choice; the panel selection is ambient state.
          initialSelectedColumnIds={pendingCreateColumnIds ?? selectedUnassignedIds}
          columnsById={columnsById}
        />
        <RenameDomainDialog
          bracket={renameDialogDomain}
          onClose={() => setRenameDialogDomain(null)}
          onConfirm={handleRenameDomain}
          loading={mutations.updateDomainMutation.isPending}
        />
        <ConfirmDialog
          open={deleteDomainConfirm != null}
          onOpenChange={(open) => !open && setDeleteDomainConfirm(null)}
          title="Delete variable group?"
          description={
            deleteDomainConfirm
              ? `"${deleteDomainConfirm.name}" and its scale score metric will be removed. Equivalence rows in this group stay intact — they just become Ungrouped rows.`
              : ''
          }
          confirmLabel="Delete group"
          loadingLabel="Deleting..."
          onConfirm={handleDeleteDomainConfirmed}
          destructive
          loading={mutations.deleteDomainMutation.isPending}
        />
        <ConfirmDialog
          open={deleteRowConfirm != null}
          onOpenChange={(open) => !open && setDeleteRowConfirm(null)}
          title="Delete this row?"
          description={
            deleteRowConfirm
              ? `${deleteRowConfirm.cellCount} column${deleteRowConfirm.cellCount === 1 ? '' : 's'} in "${deleteRowConfirm.label}" will become unassigned.`
              : ''
          }
          confirmLabel="Delete row"
          loadingLabel="Deleting..."
          onConfirm={handleDeleteRowConfirmed}
          destructive
          loading={mutations.deleteRowMutation.isPending}
        />
        <ZeroMemberDialog
          open={zeroMemberConfirm != null}
          onOpenChange={(open) => {
            if (!open) setZeroMemberConfirm(null)
          }}
          domainName={zeroMemberConfirm?.domainName ?? ''}
          onKeepEmpty={handleZeroMemberKeepEmpty}
          onDeleteGroup={handleZeroMemberDeleteGroup}
          loadingKeepEmpty={mutations.moveMembersMutation.isPending}
          loadingDeleteGroup={mutations.deleteDomainMutation.isPending}
        />
        <BulkAssignPickerDialog
          open={bulkAssignOpen}
          onOpenChange={(next) => {
            setBulkAssignOpen(next)
            if (!next) setBulkAssignPreselectedBracketId(null)
          }}
          preselectedBracketId={bulkAssignPreselectedBracketId}
          brackets={grid.brackets}
          columnIds={Array.from(selectedUnassignedIds)}
          onConfirm={(bracketId) => {
            const domain = domains.find((d) => d.id === bracketId)
            mutations.bulkAssignMutation.mutate(
              {
                domainId: bracketId,
                domainName: domain?.name ?? 'group',
                columnIds: Array.from(selectedUnassignedIds),
                allColumns,
              },
              {
                onSuccess: (result) => {
                  setBulkAssignOpen(false)
                  if (result.succeeded.length > 0) {
                    setSelectedUnassignedIds(new Set())
                  }
                },
              },
            )
          }}
          loading={mutations.bulkAssignMutation.isPending}
        />
        {swapErrorState && (
          <SwapErrorOverlay
            open
            message={swapErrorState.message}
            affectedColumnIds={swapErrorState.columnIds}
            allColumns={allColumns}
            projectId={pid}
            onRetry={handleSwapErrorRetry}
            onClose={() => setSwapErrorState(null)}
            isRetrying={mutations.swapMutation.isPending}
          />
        )}
        {copyRecodeState && (
          <CopyRecodeDialog
            open
            onClose={() => setCopyRecodeState(null)}
            sourceColumn={copyRecodeState.sourceColumn}
            sourceDefId={copyRecodeState.sourceDefId}
            targetColumns={copyRecodeState.targetColumns}
            projectId={pid}
            invalidateKeys={[
              ['equivalence-groups', pid],
              ['reverse-columns', pid],
            ]}
          />
        )}
      </div>
    </CrosswalkDnDProvider>
  )
}

