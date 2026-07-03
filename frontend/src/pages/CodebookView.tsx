import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { CircleCheck } from 'lucide-react'
import { toast } from 'sonner'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { codebookApi, codesApi, categoriesApi, conversationsApi, textCodingApi, projectPortabilityApi } from '@/lib/api'
import { invalidateDerivedCounts } from '@/lib/coding-cache'
import type { CodebookTreeResponse, CodebookCategoryNode } from '@/lib/api'
import { useCodebookState } from '@/hooks/useCodebookState'
import { analyzeSelection, collectCategoryCodeIds, collectDescendantCodeNumericIds, parseCodeNodeId } from '@/components/codebook/codebook-selection'
import { computeCodebookDiagnostics } from '@/lib/codebook-utils'
import CodebookToolbar from '@/components/codebook/CodebookToolbar'
import CodebookFrozenWarningDialog from '@/components/codebook/CodebookFrozenWarningDialog'
import { useFreezeGuard } from '@/hooks/useFreezeGuard'
import CodebookHidePanel from '@/components/codebook/CodebookHidePanel'
import CodebookTreeView from '@/components/codebook/CodebookTreeView'
import CodebookPeekPanel from '@/components/codebook/CodebookPeekPanel'
import type { UndoEntry } from '@/components/codebook/CodebookPeekPanel'
import CodebookOverviewView from '@/components/codebook/CodebookOverviewView'
import CodebookActionBar from '@/components/codebook/CodebookActionBar'
import CodebookNodeMenu from '@/components/codebook/CodebookNodeMenu'
import CreateCodePanel from '@/components/codebook/CreateCodePanel'
import CreateCategoryPanel from '@/components/codebook/CreateCategoryPanel'
import MergeCodesDialog from '@/components/codebook/MergeCodesDialog'
import MergeCategoriesDialog from '@/components/codebook/MergeCategoriesDialog'
import GroupIntoCategoryDialog from '@/components/codebook/GroupIntoCategoryDialog'
import { exportAsPng } from '@/lib/chart-export'

const MAX_UNDO_STACK = 10

export default function CodebookView() {
  const { projectId, project } = useProjectLayout()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const cb = useCodebookState()
  const [hidePanelOpen, setHidePanelOpen] = useState(false)
  const [searchMatchCount, setSearchMatchCount] = useState(0)
  const treeContainerRef = useRef<HTMLDivElement>(null)
  const [srAnnouncement, setSrAnnouncement] = useState('')
  const announce = useCallback((msg: string) => {
    setSrAnnouncement('')
    requestAnimationFrame(() => {
      setSrAnnouncement(msg)
      setTimeout(() => setSrAnnouncement(''), 1000)
    })
  }, [])

  // ── Source queries (for hide panel + visible source computation) ─────────
  const { data: convsData } = useQuery({
    queryKey: ['conversations', projectId],
    queryFn: () => conversationsApi.list(projectId),
  })
  const { data: colsData } = useQuery({
    queryKey: ['text-columns', projectId],
    queryFn: () => textCodingApi.columns(projectId),
  })
  const conversations = useMemo(() => convsData?.conversations ?? [], [convsData?.conversations])
  const textColumns = useMemo(() => colsData?.columns ?? [], [colsData?.columns])

  // Creation panel state (floating panels replace modal dialogs)
  const [showCreateCode, setShowCreateCode] = useState(false)
  const [showCreateCategory, setShowCreateCategory] = useState(false)
  const [spotlightCatId, setSpotlightCatId] = useState<number | null>(null)
  const [spotlightLabel, setSpotlightLabel] = useState('')
  const [spotlightColor, setSpotlightColor] = useState('')

  // Dialog state (merge/group operations still use modal dialogs)
  const [showMergeDialog, setShowMergeDialog] = useState(false)
  const [mergePending, setMergePending] = useState(false)
  const [showMergeCategoriesDialog, setShowMergeCategoriesDialog] = useState(false)
  const [mergeCategoriesPending, setMergeCategoriesPending] = useState(false)
  const [showGroupIntoDialog, setShowGroupIntoDialog] = useState(false)
  const [groupIntoPending, setGroupIntoPending] = useState(false)

  // Undo stack
  const undoStackRef = useRef<UndoEntry[]>([])

  // ── Multi-select + targeting state ─────────────────────────────────────

  const [multiSelect, setMultiSelect] = useState<Set<string>>(new Set())
  const [targetingMode, setTargetingMode] = useState(false)
  const [menuState, setMenuState] = useState<{ x: number; y: number; nodeId: string } | null>(null)
  const lastSelectedRef = useRef<string | null>(null)

  // "Last viewed" on mount
  useEffect(() => {
    localStorage.setItem(`mm-last-analysis-${projectId}`, 'codebook')
  }, [projectId])

  // ── Compute visible source IDs (all - hidden) ─────────────────────────
  const visibleConvIds = useMemo(() => {
    if (cb.hiddenConvIds.size === 0) return null // null = all
    const all = conversations.map(c => c.id)
    const visible = all.filter(id => !cb.hiddenConvIds.has(id))
    return visible.length > 0 ? visible : [-1] // sentinel: no results
  }, [conversations, cb.hiddenConvIds])

  const visibleColIds = useMemo(() => {
    if (cb.hiddenColIds.size === 0) return null // null = all
    const all = textColumns.map(c => c.column_id)
    const visible = all.filter(id => !cb.hiddenColIds.has(id))
    return visible.length > 0 ? visible : [-1] // sentinel: no results
  }, [textColumns, cb.hiddenColIds])

  // Build query params
  const treeParams = useMemo(() => {
    const params: Record<string, string | boolean | number> = {}
    if (visibleConvIds) params.conversation_ids = visibleConvIds.join(',')
    if (visibleColIds) params.text_column_ids = visibleColIds.join(',')
    if (cb.inactive) params.include_inactive = true
    if (cb.minSeg > 0) params.min_segments = cb.minSeg
    if (cb.maxSeg !== null) params.max_segments = cb.maxSeg
    return params
  }, [visibleConvIds, visibleColIds, cb.inactive, cb.minSeg, cb.maxSeg])

  const { data: treeData, isLoading } = useQuery({
    queryKey: ['codebook-tree', projectId, ...Object.entries(treeParams).flat()],
    queryFn: () => codebookApi.tree(projectId, treeParams),
    enabled: !isNaN(projectId),
    staleTime: 30_000,
  })

  // Baseline tree query (no segment filters) — for computing the slider range
  const baselineTreeParams = useMemo(() => {
    const params: Record<string, string | boolean | number> = {}
    if (visibleConvIds) params.conversation_ids = visibleConvIds.join(',')
    if (visibleColIds) params.text_column_ids = visibleColIds.join(',')
    if (cb.inactive) params.include_inactive = true
    return params
  }, [visibleConvIds, visibleColIds, cb.inactive])

  const hasSegFilter = cb.minSeg > 0 || cb.maxSeg !== null

  const { data: baselineTreeData } = useQuery({
    queryKey: ['codebook-tree', projectId, ...Object.entries(baselineTreeParams).flat()],
    queryFn: () => codebookApi.tree(projectId, baselineTreeParams),
    enabled: !isNaN(projectId) && hasSegFilter,
    staleTime: 60_000,
  })

  // Max segment count across all codes (from unfiltered baseline)
  const dataSegMax = useMemo(() => {
    const data = hasSegFilter ? (baselineTreeData ?? treeData) : treeData
    if (!data) return 0
    let max = 0
    for (const c of data.universal_codes) if (c.segment_count > max) max = c.segment_count
    for (const c of data.uncategorized_codes) if (c.segment_count > max) max = c.segment_count
    const tree = data.tree
    function walk(cats: typeof tree) {
      for (const cat of cats) {
        for (const c of cat.codes) if (c.segment_count > max) max = c.segment_count
        walk(cat.children)
      }
    }
    walk(tree)
    return max
  }, [hasSegFilter, baselineTreeData, treeData])

  // Derived counts
  const totalCodes = useMemo(() => {
    if (!treeData) return 0
    const data = treeData
    let count = data.universal_codes.length + data.uncategorized_codes.length
    function countInTree(nodes: typeof data.tree) {
      for (const cat of nodes) {
        count += cat.codes.length
        countInTree(cat.children)
      }
    }
    countInTree(data.tree)
    return count
  }, [treeData])

  const totalCategories = useMemo(() => {
    if (!treeData) return 0
    const data = treeData
    let count = 0
    function countCats(nodes: typeof data.tree) {
      for (const cat of nodes) {
        count++
        countCats(cat.children)
      }
    }
    countCats(data.tree)
    return count
  }, [treeData])

  const isEmpty = treeData && totalCodes === 0 && treeData.universal_codes.length === 0

  // Diagnostics for health badges
  const diagnostics = useMemo(() => {
    if (!treeData) return { unused: 0, uncategorized: 0, emptyCategories: 0, lowCoverage: 0 }
    return computeCodebookDiagnostics(treeData)
  }, [treeData])

  const [healthPopover, setHealthPopover] = useState(false)

  // ── Client-side code hiding (tree) ─────────────────────────────────────
  const filteredTreeData = useMemo((): CodebookTreeResponse | undefined => {
    if (!treeData || cb.hiddenCodeIds.size === 0) return treeData
    const hidden = cb.hiddenCodeIds
    function filterCodes<T extends { id: number }>(codes: T[]): T[] {
      return codes.filter(c => !hidden.has(c.id))
    }
    function filterTree(nodes: CodebookCategoryNode[]): CodebookCategoryNode[] {
      return nodes.map(cat => ({
        ...cat,
        codes: filterCodes(cat.codes),
        children: filterTree(cat.children),
      }))
    }
    return {
      universal_codes: treeData.universal_codes, // universal codes not hideable
      tree: filterTree(treeData.tree),
      uncategorized_codes: filterCodes(treeData.uncategorized_codes),
    }
  }, [treeData, cb.hiddenCodeIds])

  // Filtered counts (use filteredTreeData for display, original for diagnostics)
  const filteredTotalCodes = useMemo(() => {
    if (!filteredTreeData) return 0
    const data = filteredTreeData
    let count = data.universal_codes.length + data.uncategorized_codes.length
    function countInTree(nodes: CodebookCategoryNode[]) {
      for (const cat of nodes) {
        count += cat.codes.length
        countInTree(cat.children)
      }
    }
    countInTree(data.tree)
    return count
  }, [filteredTreeData])

  const filteredIsEmpty = filteredTreeData && filteredTotalCodes === 0 && filteredTreeData.universal_codes.length === 0

  // ── Prune hidden codes from multi-select ──────────────────────────────
  useEffect(() => {
    if (cb.hiddenCodeIds.size === 0) return
    const pruned = new Set<string>()
    let changed = false
    for (const nodeId of multiSelect) {
      const codeId = parseCodeNodeId(nodeId)
      if (codeId !== null && cb.hiddenCodeIds.has(codeId)) { changed = true; continue }
      pruned.add(nodeId)
    }
    if (changed) setMultiSelect(pruned)
  }, [cb.hiddenCodeIds, multiSelect])

  // Determine empty state message
  const emptyMessage = useMemo(() => {
    if (!filteredTreeData) return null
    if (filteredTotalCodes === 0 && filteredTreeData.universal_codes.length === 0) {
      if (cb.hiddenConvIds.size > 0 || cb.hiddenColIds.size > 0) {
        // Check if ALL sources are hidden
        const allConvsHidden = conversations.length > 0 && conversations.every(c => cb.hiddenConvIds.has(c.id))
        const allColsHidden = textColumns.length > 0 && textColumns.every(c => cb.hiddenColIds.has(c.column_id))
        if ((conversations.length === 0 || allConvsHidden) && (textColumns.length === 0 || allColsHidden)) {
          return 'All sources are hidden \u2014 show at least one source to see code usage'
        }
      }
      if (cb.hiddenCodeIds.size > 0 && totalCodes > 0) {
        return `All codes are hidden \u2014 ${cb.hiddenCodeIds.size} code${cb.hiddenCodeIds.size !== 1 ? 's' : ''} hidden`
      }
      if (cb.minSeg > 0 || cb.maxSeg !== null) {
        return 'No codes in the selected segment range'
      }
      if (cb.search) {
        return 'No codes match the current filters'
      }
      return 'Create codes in conversations or the Text Coding tab to see your codebook here'
    }
    return null
  }, [filteredTreeData, filteredTotalCodes, totalCodes, cb.hiddenConvIds, cb.hiddenColIds, cb.hiddenCodeIds, conversations, textColumns, cb.minSeg, cb.maxSeg, cb.search])

  const handleSearchMatchCount = useCallback((count: number) => {
    setSearchMatchCount(count)
  }, [])

  const hiddenTooltip = useMemo(() => {
    const parts: string[] = []
    if (cb.hiddenCodeIds.size > 0) parts.push(`${cb.hiddenCodeIds.size} code${cb.hiddenCodeIds.size !== 1 ? 's' : ''} hidden`)
    const srcCount = cb.hiddenConvIds.size + cb.hiddenColIds.size
    if (srcCount > 0) parts.push(`${srcCount} source${srcCount !== 1 ? 's' : ''} filtered`)
    return parts.join(' \u00b7 ')
  }, [cb.hiddenCodeIds.size, cb.hiddenConvIds.size, cb.hiddenColIds.size])

  // ── Selection analysis ────────────────────────────────────────────────

  const selectionAnalysis = useMemo(
    () => analyzeSelection(multiSelect, treeData),
    [multiSelect, treeData],
  )

  // Clear multi-select when switching modes
  useEffect(() => {
    setMultiSelect(new Set())
    setTargetingMode(false)
    setMenuState(null)
  }, [cb.mode])

  // Announce multi-select count changes
  const prevMultiSize = useRef(0)
  useEffect(() => {
    if (multiSelect.size !== prevMultiSize.current) {
      prevMultiSize.current = multiSelect.size
      if (multiSelect.size > 0) {
        announce(`${multiSelect.size} item${multiSelect.size !== 1 ? 's' : ''} selected`)
      }
    }
  }, [multiSelect.size, announce])

  // ── Undo stack ──────────────────────────────────────────────────────────

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['codes', projectId] })
    queryClient.invalidateQueries({ queryKey: ['categories', projectId] })
    queryClient.invalidateQueries({ queryKey: ['codebook-tree', projectId] })
    queryClient.invalidateQueries({ queryKey: ['project-summary', projectId] })
    invalidateDerivedCounts(queryClient, projectId, { metrics: true })  // #450: cross-surface counts
  }, [queryClient, projectId])

  // ── Color change handlers (shared by tree tooltip + peek panel) ──────

  const handleCodeColorChange = useCallback(async (codeId: number, color: string | null) => {
    await codesApi.update(projectId, codeId, { color })
    invalidateAll()
  }, [projectId, invalidateAll])

  const handleCategoryColorChange = useCallback(async (categoryId: number, color: string) => {
    await categoriesApi.update(projectId, categoryId, { color })
    invalidateAll()
  }, [projectId, invalidateAll])

  const handleRecordUndo = useCallback((entry: UndoEntry) => {
    undoStackRef.current.push(entry)
    if (undoStackRef.current.length > MAX_UNDO_STACK) {
      undoStackRef.current.shift()
    }
  }, [])

  const handleUndo = useCallback(async () => {
    const entry = undoStackRef.current.pop()
    if (!entry) {
      toast.info('Nothing to undo')
      return
    }

    try {
      if (entry.type === 'move-code') {
        await codesApi.update(projectId, entry.entityId, { category_id: entry.prevValue })
        toast.success(`Moved "${entry.entityName}" back to ${entry.prevName}`)
      } else if (entry.type === 'move-category') {
        await categoriesApi.update(projectId, entry.entityId, { parent_id: entry.prevValue })
        toast.success(`Moved "${entry.entityName}" back to ${entry.prevName}`)
      } else if (entry.type === 'bulk-move') {
        const promises = Array.from(entry.prevCategories.entries()).map(
          ([codeId, prevCatId]) => codesApi.update(projectId, codeId, { category_id: prevCatId })
        )
        await Promise.all(promises)
        toast.success(`Undid move of ${entry.prevCategories.size} codes`)
      } else if (entry.type === 'merge') {
        const promises = entry.sourceCodeIds.map(
          codeId => codesApi.update(projectId, codeId, { is_active: true })
        )
        await Promise.all(promises)
        toast.success(`Restored ${entry.sourceCodeIds.length} code${entry.sourceCodeIds.length !== 1 ? 's' : ''} (applications remain with "${entry.targetCodeName}")`)
      } else if (entry.type === 'bulk-move-categories') {
        const promises = Array.from(entry.prevParentIds.entries()).map(
          ([catId, prevParentId]) => categoriesApi.update(projectId, catId, { parent_id: prevParentId })
        )
        await Promise.all(promises)
        toast.success(`Undid move of ${entry.prevParentIds.size} categories`)
      } else if (entry.type === 'merge-category') {
        for (const src of entry.mergedCategorySourceInfos) {
          await categoriesApi.create(projectId, {
            name: src.name,
            color: src.color ?? undefined,
            parent_id: src.parentId,
          })
        }
        toast.success(`Restored ${entry.mergedCategorySourceInfos.length} categories (codes and memos remain with "${entry.entityName}")`)
      } else if (entry.type === 'group-into') {
        // Restore original positions then delete the new category
        if (entry.originalParentIds) {
          const catPromises = Array.from(entry.originalParentIds.entries()).map(
            ([catId, prevParentId]) => categoriesApi.update(projectId, catId, { parent_id: prevParentId })
          )
          await Promise.all(catPromises)
        }
        if (entry.originalCodeCategories) {
          const codePromises = Array.from(entry.originalCodeCategories.entries()).map(
            ([codeId, prevCatId]) => codesApi.update(projectId, codeId, { category_id: prevCatId })
          )
          await Promise.all(codePromises)
        }
        await categoriesApi.delete(projectId, entry.newCategoryId)
        toast.success(`Undid grouping, deleted "${entry.entityName}"`)
      }
      invalidateAll()
    } catch {
      toast.error('Failed to undo')
      invalidateAll()
    }
  }, [projectId, invalidateAll])

  // Ctrl+Z handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        const active = document.activeElement
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return
        if (undoStackRef.current.length === 0) return
        e.preventDefault()
        handleUndo()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleUndo])

  // ── Bulk move mutation ────────────────────────────────────────────────

  const bulkMoveMut = useMutation({
    mutationFn: ({ codeIds, targetCategoryId }: { codeIds: number[]; targetCategoryId: number | null }) =>
      codesApi.bulkMove(projectId, codeIds, targetCategoryId),
    onSuccess: () => invalidateAll(),
  })

  // ── Multi-select handlers ──────────────────────────────────────────────

  const handleBulkMove = useCallback(async (targetCategoryId: number) => {
    const codeIds = selectionAnalysis.movableCodes
    const catIds = selectionAnalysis.movableCategories.filter(id => id !== targetCategoryId)

    if (codeIds.length === 0 && catIds.length === 0) return

    // Find target category name
    let targetName = selectionAnalysis.targetCategory?.name
    if (!targetName && treeData) {
      const findName = (nodes: typeof treeData.tree): string => {
        for (const cat of nodes) {
          if (cat.id === targetCategoryId) return cat.name
          const found = findName(cat.children)
          if (found) return found
        }
        return ''
      }
      targetName = findName(treeData.tree) || 'Unknown'
    }

    // Move codes
    if (codeIds.length > 0) {
      const prevCategories = new Map<number, number | null>()
      for (const code of selectionAnalysis.codes) {
        if (!code.isUniversal) {
          prevCategories.set(code.id, code.categoryId)
        }
      }
      handleRecordUndo({
        type: 'bulk-move',
        entityName: `${codeIds.length} codes`,
        prevCategories,
      })
      bulkMoveMut.mutate(
        { codeIds, targetCategoryId },
        {
          onSuccess: () => {
            toast.success(`Moved ${codeIds.length} code${codeIds.length !== 1 ? 's' : ''} to ${targetName}`)
            announce(`Moved ${codeIds.length} codes to ${targetName}`)
          },
          onError: () => toast.error('Failed to move codes'),
        },
      )
    }

    // Move categories
    if (catIds.length > 0) {
      // Build parent map from treeData
      const prevParentIds = new Map<number, number | null>()
      if (treeData) {
        const walkForParents = (nodes: CodebookCategoryNode[]) => {
          for (const cat of nodes) {
            if (catIds.includes(cat.id)) prevParentIds.set(cat.id, cat.parent_id)
            walkForParents(cat.children)
          }
        }
        walkForParents(treeData.tree)
      }

      handleRecordUndo({
        type: 'bulk-move-categories',
        entityName: `${catIds.length} categories`,
        prevParentIds,
      })

      try {
        await categoriesApi.bulkMove(projectId, catIds, targetCategoryId)
        toast.success(`Moved ${catIds.length} categor${catIds.length !== 1 ? 'ies' : 'y'} to ${targetName}`)
        announce(`Moved ${catIds.length} categories to ${targetName}`)
        invalidateAll()
      } catch {
        toast.error('Failed to move categories')
        invalidateAll()
      }
    }

    setMultiSelect(new Set())
    setTargetingMode(false)
    setMenuState(null)
  }, [selectionAnalysis, treeData, projectId, handleRecordUndo, bulkMoveMut, invalidateAll, announce])

  const handleEnterTargeting = useCallback(() => {
    setTargetingMode(true)
    setMenuState(null)
  }, [])

  const handleExitTargeting = useCallback(() => {
    setTargetingMode(false)
  }, [])

  const handleTargetingComplete = useCallback((categoryId: number) => {
    handleBulkMove(categoryId)
  }, [handleBulkMove])

  const handleContextMenu = useCallback((nodeId: string, x: number, y: number) => {
    setMenuState({ x, y, nodeId })
  }, [])

  const handleSelectAllInCategory = useCallback((catId: number) => {
    if (!treeData) return
    const codeIds = collectCategoryCodeIds(catId, treeData)
    const next = new Set(multiSelect)
    for (const id of codeIds) next.add(id)
    // Also include the category itself
    next.add(`cat-${catId}`)
    setMultiSelect(next)
  }, [treeData, multiSelect])

  const handleHideCodes = useCallback(() => {
    const hideable = selectionAnalysis.codes.filter(c => !c.isUniversal)
    if (hideable.length === 0) return
    const ids = hideable.map(c => c.id)
    const next = new Set(cb.hiddenCodeIds)
    for (const id of ids) next.add(id)
    cb.setHiddenCodeIds(next)

    const label = hideable.length === 1 ? `"${hideable[0].name}"` : `${hideable.length} codes`
    toast(`Hidden ${label}`, {
      action: {
        label: 'Undo',
        onClick: () => cb.removeHiddenCodeIds(ids),
      },
      duration: 5000,
    })

    setMultiSelect(new Set())
    setMenuState(null)
  }, [selectionAnalysis, cb])

  const handleHideCategoryDescendants = useCallback((catId: number) => {
    if (!treeData) return
    const ids = collectDescendantCodeNumericIds(catId, treeData)
    if (ids.length === 0) return
    const next = new Set(cb.hiddenCodeIds)
    for (const id of ids) next.add(id)
    cb.setHiddenCodeIds(next)

    toast(`Hidden ${ids.length} code${ids.length !== 1 ? 's' : ''}`, {
      action: {
        label: 'Undo',
        onClick: () => cb.removeHiddenCodeIds(ids),
      },
      duration: 5000,
    })

    setMultiSelect(new Set())
    setMenuState(null)
  }, [treeData, cb])

  const handleRequestMerge = useCallback(() => {
    if (selectionAnalysis.movableCodes.length < 2) return
    setShowMergeDialog(true)
    setMenuState(null)
  }, [selectionAnalysis.movableCodes.length])

  const handleMergeComplete = useCallback(async (sourceIds: number[], targetId: number) => {
    setMergePending(true)
    let skippedTotal = 0
    let failed = 0

    // Find target name for undo/toast
    let targetName = ''
    if (treeData) {
      const findName = (nodes: typeof treeData.tree): string => {
        for (const cat of nodes) {
          for (const code of cat.codes) {
            if (code.id === targetId) return code.name
          }
          const found = findName(cat.children)
          if (found) return found
        }
        return ''
      }
      targetName = findName(treeData.tree)
      if (!targetName) {
        for (const c of [...treeData.uncategorized_codes, ...treeData.universal_codes]) {
          if (c.id === targetId) { targetName = c.name; break }
        }
      }
    }
    targetName = targetName || 'target code'

    try {
      const succeededIds: number[] = []
      for (const sourceId of sourceIds) {
        try {
          const result = await codesApi.merge(projectId, sourceId, targetId, false)
          skippedTotal += result.skipped
          succeededIds.push(sourceId)
        } catch {
          failed++
        }
      }

      if (failed > 0 && failed < sourceIds.length) {
        toast.warning(`Merged ${succeededIds.length} of ${sourceIds.length} codes into "${targetName}" (${failed} failed)`)
      } else if (failed === sourceIds.length) {
        toast.error('Failed to merge codes')
      } else {
        const detail = skippedTotal > 0 ? ` (${skippedTotal} duplicate${skippedTotal !== 1 ? 's' : ''} skipped)` : ''
        toast.success(`Merged ${sourceIds.length} code${sourceIds.length !== 1 ? 's' : ''} into "${targetName}"${detail}`)
      }

      if (succeededIds.length > 0) {
        handleRecordUndo({
          type: 'merge',
          entityId: targetId,
          entityName: targetName,
          sourceCodeIds: succeededIds,
          targetCodeName: targetName,
        })
      }

      setMultiSelect(new Set())
      cb.setSelection(`code:${targetId}`)
      announce(`Merged ${sourceIds.length - failed} codes into ${targetName}`)
    } finally {
      setMergePending(false)
      setShowMergeDialog(false)
      invalidateAll()
    }
  }, [projectId, treeData, handleRecordUndo, invalidateAll, cb, announce])

  // ── Category merge handlers ──────────────────────────────────────────

  const handleRequestMergeCategories = useCallback(() => {
    if (selectionAnalysis.categories.length < 2) return
    setShowMergeCategoriesDialog(true)
    setMenuState(null)
  }, [selectionAnalysis.categories.length])

  const handleMergeCategoriesComplete = useCallback(async (sourceIds: number[], targetId: number) => {
    setMergeCategoriesPending(true)

    // Find target name
    let targetName = ''
    const sourceInfos: { id: number; name: string; color: string | null; parentId: number | null }[] = []
    if (treeData) {
      const walkFind = (nodes: CodebookCategoryNode[]) => {
        for (const cat of nodes) {
          if (cat.id === targetId) targetName = cat.name
          if (sourceIds.includes(cat.id)) {
            sourceInfos.push({ id: cat.id, name: cat.name, color: cat.color, parentId: cat.parent_id })
          }
          walkFind(cat.children)
        }
      }
      walkFind(treeData.tree)
    }
    targetName = targetName || 'target category'

    try {
      const result = await categoriesApi.merge(projectId, sourceIds, targetId)
      toast.success(`Merged ${sourceIds.length} categories into "${targetName}" (${result.merged_codes} codes, ${result.reparented_categories} subcategories moved)`)

      handleRecordUndo({
        type: 'merge-category',
        entityId: targetId,
        entityName: targetName,
        mergedCategorySourceInfos: sourceInfos,
      })

      setMultiSelect(new Set())
      cb.setSelection(`cat:${targetId}`)
      announce(`Merged ${sourceIds.length} categories into ${targetName}`)
    } catch (err) {
      const detail = (err as Error & { response?: { data?: { detail?: string } } }).response?.data?.detail
      toast.error(detail || 'Failed to merge categories')
    } finally {
      setMergeCategoriesPending(false)
      setShowMergeCategoriesDialog(false)
      invalidateAll()
    }
  }, [projectId, treeData, handleRecordUndo, invalidateAll, cb, announce])

  // ── Group into new category handlers ─────────────────────────────────

  const handleRequestGroupInto = useCallback(() => {
    if (!selectionAnalysis.canGroupInto) return
    setShowGroupIntoDialog(true)
    setMenuState(null)
  }, [selectionAnalysis.canGroupInto])

  const handleGroupIntoComplete = useCallback(async (data: { name: string; color: string }) => {
    setGroupIntoPending(true)

    const codeIds = selectionAnalysis.codes.filter(c => !c.isUniversal).map(c => c.id)
    const catIds = selectionAnalysis.movableCategories

    // Capture current parent/category mappings for undo
    const originalCodeCategories = new Map<number, number | null>()
    for (const code of selectionAnalysis.codes) {
      if (!code.isUniversal) originalCodeCategories.set(code.id, code.categoryId)
    }
    const originalParentIds = new Map<number, number | null>()
    if (treeData) {
      const walkForParents = (nodes: CodebookCategoryNode[]) => {
        for (const cat of nodes) {
          if (catIds.includes(cat.id)) originalParentIds.set(cat.id, cat.parent_id)
          walkForParents(cat.children)
        }
      }
      walkForParents(treeData.tree)
    }

    try {
      const created = await categoriesApi.groupInto(projectId, {
        name: data.name,
        color: data.color,
        category_ids: catIds.length > 0 ? catIds : undefined,
        code_ids: codeIds.length > 0 ? codeIds : undefined,
      })

      toast.success(`Created "${data.name}" with ${codeIds.length + catIds.length} items`)

      handleRecordUndo({
        type: 'group-into',
        entityId: created.id,
        entityName: data.name,
        newCategoryId: created.id,
        originalParentIds: originalParentIds.size > 0 ? originalParentIds : undefined,
        originalCodeCategories: originalCodeCategories.size > 0 ? originalCodeCategories : undefined,
      })

      setMultiSelect(new Set())
      cb.setSelection(`cat:${created.id}`)
      announce(`Grouped items into ${data.name}`)
    } catch (err) {
      const detail = (err as Error & { response?: { data?: { detail?: string } } }).response?.data?.detail
      toast.error(detail || 'Failed to group into category')
    } finally {
      setGroupIntoPending(false)
      setShowGroupIntoDialog(false)
      invalidateAll()
    }
  }, [projectId, treeData, selectionAnalysis, handleRecordUndo, invalidateAll, cb, announce])

  const handleClearMultiSelect = useCallback(() => {
    setMultiSelect(new Set())
    setTargetingMode(false)
    setMenuState(null)
  }, [])

  // ── Document-level keyboard shortcuts (M, G, Shift+G, Delete) ─────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip if input focused
      const active = document.activeElement
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return
      // Skip if no multi-select
      if (multiSelect.size === 0) return

      if (e.key === 'm' || e.key === 'M') {
        if (selectionAnalysis.canMove && !targetingMode) {
          e.preventDefault()
          if (selectionAnalysis.targetCategory && selectionAnalysis.movableCategories.length === 0) {
            // Direct move if a single category is in the selection and only codes need moving
            handleBulkMove(selectionAnalysis.targetCategory.id)
          } else {
            handleEnterTargeting()
          }
        }
      } else if (e.key === 'G' && e.shiftKey) {
        // Shift+G: group into new category
        if (selectionAnalysis.canGroupInto) {
          e.preventDefault()
          handleRequestGroupInto()
        }
      } else if (e.key === 'g' && !e.shiftKey) {
        // g: merge (codes or categories)
        if (selectionAnalysis.canMergeCategories) {
          e.preventDefault()
          handleRequestMergeCategories()
        } else if (selectionAnalysis.canMerge) {
          e.preventDefault()
          handleRequestMerge()
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectionAnalysis.codes.length > 0 && !selectionAnalysis.codes.every(c => c.isUniversal)) {
          e.preventDefault()
          handleHideCodes()
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [multiSelect.size, selectionAnalysis, targetingMode, handleBulkMove, handleEnterTargeting, handleRequestMerge, handleRequestMergeCategories, handleRequestGroupInto, handleHideCodes])

  // ── Creation panel callbacks ────────────────────────────────────────────

  const handleCreated = useCallback((sel: string) => {
    cb.setSelection(sel)
  }, [cb])

  const clearSpotlight = useCallback(() => {
    setSpotlightCatId(null)
    setSpotlightLabel('')
    setSpotlightColor('')
  }, [])

  const handleCloseCreateCode = useCallback(() => {
    setShowCreateCode(false)
    clearSpotlight()
  }, [clearSpotlight])

  const handleCloseCreateCategory = useCallback(() => {
    setShowCreateCategory(false)
    clearSpotlight()
  }, [clearSpotlight])

  // Track J · J3-1: warn before adding codes/categories to a frozen codebook (soft).
  const freezeGuard = useFreezeGuard(!!project?.codebook_frozen_at)

  // Toggle: open one panel, close the other
  const handleToggleCreateCode = useCallback(() => {
    setShowCreateCategory(false)
    setShowCreateCode(prev => !prev)
    clearSpotlight()
  }, [clearSpotlight])

  const handleToggleCreateCategory = useCallback(() => {
    setShowCreateCode(false)
    setShowCreateCategory(prev => !prev)
    clearSpotlight()
  }, [clearSpotlight])

  // Spotlight type derived from which panel is open
  const spotlightType = showCreateCode ? 'code' as const : showCreateCategory ? 'category' as const : null

  // ── PNG export ──────────────────────────────────────────────────────────

  const handleExport = useCallback(async (filename: string) => {
    const el = treeContainerRef.current
    if (!el) return

    const origOverflow = el.style.overflow
    const origHeight = el.style.height
    const origMaxHeight = el.style.maxHeight

    el.style.overflow = 'visible'
    el.style.height = 'auto'
    el.style.maxHeight = 'none'

    try {
      await exportAsPng(el, filename)
      toast.success(`${filename === 'codebook-tree' ? 'Tree' : 'Overview'} exported as PNG`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed')
    } finally {
      el.style.overflow = origOverflow
      el.style.height = origHeight
      el.style.maxHeight = origMaxHeight
    }
  }, [])

  // ── Screen reader announcements ──────────────────────────────────────────

  // Announce mode changes
  const prevMode = useRef(cb.mode)
  useEffect(() => {
    if (prevMode.current !== cb.mode) {
      prevMode.current = cb.mode
      announce(`Switched to ${cb.mode} view`)
    }
  }, [cb.mode, announce])

  // Announce format changes
  const prevCatFormat = useRef(cb.catFormat)
  const prevCodeFormat = useRef(cb.codeFormat)
  useEffect(() => {
    if (prevCatFormat.current !== cb.catFormat) {
      prevCatFormat.current = cb.catFormat
      announce(`Category format: ${cb.catFormat}`)
    }
    if (prevCodeFormat.current !== cb.codeFormat) {
      prevCodeFormat.current = cb.codeFormat
      announce(`Code format: ${cb.codeFormat}`)
    }
  }, [cb.catFormat, cb.codeFormat, announce])

  // Announce spotlight changes for screen readers
  useEffect(() => {
    if (spotlightCatId && treeData) {
      const findName = (cats: CodebookCategoryNode[]): string | null => {
        for (const cat of cats) {
          if (cat.id === spotlightCatId) return cat.name
          const found = findName(cat.children)
          if (found) return found
        }
        return null
      }
      const name = findName(treeData.tree)
      if (name) announce(`Preview: ${spotlightType === 'category' ? 'child of' : 'in'} ${name}`)
    }
  }, [spotlightCatId, spotlightType, treeData, announce])

  // ── Codebook import/export ───────────────────────────────────────────

  const [isExportingCodebook, setIsExportingCodebook] = useState(false)

  const handleExportCodebook = useCallback(async (format: 'native' | 'qdc') => {
    setIsExportingCodebook(true)
    try {
      await projectPortabilityApi.exportCodebook(projectId, format)
      toast.success(format === 'qdc' ? 'QDC codebook exported' : 'Codebook exported')
    } catch {
      toast.error('Codebook export failed')
    } finally {
      setIsExportingCodebook(false)
    }
  }, [projectId])

  const handleImportCodebook = useCallback(async (file: File) => {
    try {
      const counts = await projectPortabilityApi.importCodebook(projectId, file)
      const parts: string[] = []
      if (counts.codes_created > 0) parts.push(`${counts.codes_created} codes created`)
      if (counts.categories_created > 0) parts.push(`${counts.categories_created} categories created`)
      if (counts.codes_skipped > 0) parts.push(`${counts.codes_skipped} codes skipped`)
      if (counts.codes_uncategorized > 0) parts.push(`${counts.codes_uncategorized} codes left uncategorized`)
      toast.success(parts.length > 0 ? parts.join('. ') : 'Codebook imported (no changes)')
      queryClient.invalidateQueries({ queryKey: ['codes', projectId] })
      queryClient.invalidateQueries({ queryKey: ['categories', projectId] })
      queryClient.invalidateQueries({ queryKey: ['codebook-tree', projectId] })
    } catch {
      toast.error('Codebook import failed')
    }
  }, [projectId, queryClient])

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar (two-row) */}
      <CodebookToolbar
        cb={cb}
        searchMatchCount={searchMatchCount}
        diagnostics={diagnostics}
        totalCodes={filteredTotalCodes}
        totalCategories={totalCategories}
        treeData={filteredTreeData}
        isEmpty={!!filteredIsEmpty}
        hidePanelOpen={hidePanelOpen}
        onToggleHidePanel={() => setHidePanelOpen(prev => !prev)}
        hiddenCount={cb.hiddenCodeIds.size + cb.hiddenConvIds.size + cb.hiddenColIds.size}
        hiddenTooltip={hiddenTooltip}
        projectId={projectId}
        onCreateCode={() => (showCreateCode ? handleToggleCreateCode() : freezeGuard.guard(handleToggleCreateCode))}
        onCreateCategory={() => (showCreateCategory ? handleToggleCreateCategory() : freezeGuard.guard(handleToggleCreateCategory))}
        onTreeExport={() => handleExport('codebook-tree')}
        onOverviewExport={() => handleExport('codebook-overview')}
        onExportCodebook={handleExportCodebook}
        onImportCodebook={handleImportCodebook}
        isExportingCodebook={isExportingCodebook}
        dataSegMax={dataSegMax}
      />

      <CodebookFrozenWarningDialog
        open={freezeGuard.warnOpen}
        onProceed={freezeGuard.onProceed}
        onCancel={freezeGuard.onCancel}
      />

      {/* Content area: 3-panel layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Hide Panel */}
        <div
          className={`border-r border-mm-border-subtle bg-mm-surface shrink-0 transition-[width,opacity] duration-150 overflow-hidden ${
            hidePanelOpen ? 'w-56 opacity-100' : 'w-0 opacity-0'
          }`}
        >
          {hidePanelOpen && treeData && (
            <CodebookHidePanel
              treeData={treeData}
              conversations={conversations}
              textColumns={textColumns}
              hiddenCodeIds={cb.hiddenCodeIds}
              hiddenConvIds={cb.hiddenConvIds}
              hiddenColIds={cb.hiddenColIds}
              onHiddenCodeIdsChange={cb.setHiddenCodeIds}
              onHiddenConvIdsChange={cb.setHiddenConvIds}
              onHiddenColIdsChange={cb.setHiddenColIds}
              onClearAll={cb.clearAllHidden}
            />
          )}
        </div>

        {/* Center: Main visualization (wrapper for action bar positioning) */}
        <div className="flex-1 relative overflow-hidden">
          <div ref={treeContainerRef} className="h-full p-4 overflow-hidden">
            {isLoading && (
              <div className="space-y-3 animate-pulse">
                <div className="h-4 w-48 bg-mm-border-subtle rounded" />
                <div className="space-y-2 ml-4">
                  <div className="h-3 w-36 bg-mm-border-subtle/60 rounded" />
                  <div className="h-3 w-44 bg-mm-border-subtle/60 rounded" />
                  <div className="h-3 w-32 bg-mm-border-subtle/60 rounded" />
                </div>
                <div className="h-4 w-40 bg-mm-border-subtle rounded" />
                <div className="space-y-2 ml-4">
                  <div className="h-3 w-40 bg-mm-border-subtle/60 rounded" />
                  <div className="h-3 w-28 bg-mm-border-subtle/60 rounded" />
                </div>
                <div className="h-4 w-52 bg-mm-border-subtle rounded" />
                <div className="space-y-2 ml-4">
                  <div className="h-3 w-36 bg-mm-border-subtle/60 rounded" />
                  <div className="h-3 w-48 bg-mm-border-subtle/60 rounded" />
                  <div className="h-3 w-32 bg-mm-border-subtle/60 rounded" />
                  <div className="h-3 w-44 bg-mm-border-subtle/60 rounded" />
                </div>
              </div>
            )}

            {!isLoading && filteredIsEmpty && emptyMessage && (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <span className="text-3xl mb-3" role="presentation">&#128214;</span>
                <p className="text-sm text-mm-text-secondary max-w-sm">{emptyMessage}</p>
              </div>
            )}

            {!isLoading && filteredTreeData && !filteredIsEmpty && cb.mode === 'tree' && (
              <div className="h-full bg-mm-surface rounded-lg border border-mm-border-subtle p-4">
              <CodebookTreeView
                treeData={filteredTreeData}
                catFormat={cb.catFormat}
                codeFormat={cb.codeFormat}
                sizing={cb.sizing}
                search={cb.search}
                selection={cb.selection}
                onSelect={cb.setSelection}
                onSearchMatchCount={handleSearchMatchCount}
                multiSelect={multiSelect}
                targetingMode={targetingMode}
                lastSelectedRef={lastSelectedRef}
                onMultiSelectChange={setMultiSelect}
                onContextMenu={handleContextMenu}
                onTargetingComplete={handleTargetingComplete}
                onExitTargeting={handleExitTargeting}
                onCodeColorChange={handleCodeColorChange}
                onCategoryColorChange={handleCategoryColorChange}
                spotlightCategoryId={spotlightCatId}
                spotlightType={spotlightType}
                spotlightLabel={spotlightLabel}
                spotlightColor={spotlightColor}
              />
              </div>
            )}

            {!isLoading && filteredTreeData && !filteredIsEmpty && cb.mode === 'overview' && (
              <CodebookOverviewView
                treeData={filteredTreeData}
                sizing={cb.sizing}
                selection={cb.selection}
                onSelect={cb.setSelection}
                announce={announce}
              />
            )}
          </div>

          {/* Floating action bar */}
          {multiSelect.size > 0 && treeData && (
            <CodebookActionBar
              analysis={selectionAnalysis}
              targetingMode={targetingMode}
              onMove={handleEnterTargeting}
              onDirectMove={() => {
                if (selectionAnalysis.targetCategory) handleBulkMove(selectionAnalysis.targetCategory.id)
              }}
              onMerge={handleRequestMerge}
              onMergeCategories={handleRequestMergeCategories}
              onGroupInto={handleRequestGroupInto}
              onHide={handleHideCodes}
              onClear={handleClearMultiSelect}
            />
          )}

          {/* Context menu */}
          {menuState && treeData && (
            <CodebookNodeMenu
              x={menuState.x}
              y={menuState.y}
              nodeId={menuState.nodeId}
              analysis={selectionAnalysis}
              treeData={treeData}
              onMove={() => { handleEnterTargeting(); setMenuState(null) }}
              onDirectMove={() => {
                if (selectionAnalysis.targetCategory) handleBulkMove(selectionAnalysis.targetCategory.id)
                setMenuState(null)
              }}
              onMerge={() => { handleRequestMerge(); setMenuState(null) }}
              onMergeCategories={() => { handleRequestMergeCategories(); setMenuState(null) }}
              onGroupInto={() => { handleRequestGroupInto(); setMenuState(null) }}
              onHide={() => { handleHideCodes(); setMenuState(null) }}
              onHideCategoryDescendants={(catId) => { handleHideCategoryDescendants(catId); setMenuState(null) }}
              onSelectAllInCategory={handleSelectAllInCategory}
              onViewSegments={(codeId) => navigate(`/projects/${projectId}/analysis/qualitative?tab=content&contentMode=by-code&codes=${codeId}`)}
              onViewInPeek={(nodeId) => {
                const sel = nodeId.replace('code-', 'code:').replace('cat-', 'cat:')
                cb.setSelection(sel)
                setMenuState(null)
              }}
              onClose={() => setMenuState(null)}
            />
          )}

          {/* Floating creation panels */}
          {showCreateCode && treeData && (
            <CreateCodePanel
              projectId={projectId}
              treeData={treeData}
              onCreated={handleCreated}
              onClose={handleCloseCreateCode}
              onHoverCategory={setSpotlightCatId}
              onLabelChange={setSpotlightLabel}
            />
          )}
          {showCreateCategory && treeData && (
            <CreateCategoryPanel
              projectId={projectId}
              treeData={treeData}
              onCreated={handleCreated}
              onClose={handleCloseCreateCategory}
              onHoverCategory={setSpotlightCatId}
              onLabelChange={setSpotlightLabel}
              onColorChange={setSpotlightColor}
            />
          )}
        </div>

        {/* Right: Peek Panel */}
        {(cb.selection || multiSelect.size > 1) && treeData && (
          <div className="w-[300px] border-l border-mm-border-subtle bg-mm-surface overflow-y-auto shrink-0">
            <CodebookPeekPanel
              projectId={projectId}
              selection={cb.selection || ''}
              treeData={treeData}
              onSelect={cb.setSelection}
              onClose={() => { cb.setSelection(null); setMultiSelect(new Set()) }}
              onRecordUndo={handleRecordUndo}
              multiSelect={multiSelect}
              selectionAnalysis={selectionAnalysis}
              onMerge={handleRequestMerge}
              onMergeCategories={handleRequestMergeCategories}
              onGroupInto={handleRequestGroupInto}
            />
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="px-4 py-1.5 border-t border-mm-border-subtle text-xs text-mm-text-faint flex items-center gap-3 shrink-0">
        <span>{filteredTotalCodes} codes{cb.hiddenCodeIds.size > 0 ? ` (${cb.hiddenCodeIds.size} hidden)` : ''}</span>
        <span className="text-mm-border-medium">{'\u00b7'}</span>
        <span>{totalCategories} categories</span>

        {/* Health badges (use original treeData for diagnostics) */}
        {treeData && !isEmpty && (() => {
          const healthTotal = diagnostics.unused + diagnostics.uncategorized + diagnostics.emptyCategories + diagnostics.lowCoverage
          if (healthTotal === 0) {
            return (
              <>
                <span className="text-mm-border-medium">{'\u00b7'}</span>
                <span className="flex items-center gap-1 text-mm-text-muted">
                  <CircleCheck className="w-3 h-3 text-green-500" />
                  All clear
                </span>
              </>
            )
          }
          const pills: { label: string; count: number }[] = []
          if (diagnostics.unused > 0) pills.push({ label: 'unused', count: diagnostics.unused })
          if (diagnostics.uncategorized > 0) pills.push({ label: 'uncategorized', count: diagnostics.uncategorized })
          if (diagnostics.emptyCategories > 0) pills.push({ label: 'empty cat', count: diagnostics.emptyCategories })
          if (diagnostics.lowCoverage > 0) pills.push({ label: '1-source', count: diagnostics.lowCoverage })
          return (
            <>
              <span className="text-mm-border-medium">{'\u00b7'}</span>
              <div className="relative inline-flex items-center">
                <button
                  onClick={() => setHealthPopover(p => !p)}
                  className="flex items-center gap-1 hover:opacity-80 transition-opacity"
                  aria-expanded={healthPopover}
                  aria-label="Codebook health diagnostics"
                >
                  {pills.map(p => (
                    <span
                      key={p.label}
                      className="px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 text-[10px] font-medium"
                    >
                      {p.count} {p.label}
                    </span>
                  ))}
                </button>
                {healthPopover && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setHealthPopover(false)} />
                    <div className="absolute bottom-full left-0 mb-2 z-50 w-64 bg-mm-surface border border-mm-border-subtle rounded-lg shadow-lg p-3 space-y-1 text-xs text-mm-text-muted">
                      {diagnostics.unused > 0 && (
                        <p><span className="font-medium">{diagnostics.unused} unused codes</span> — applied to zero segments</p>
                      )}
                      {diagnostics.uncategorized > 0 && (
                        <p><span className="font-medium">{diagnostics.uncategorized} uncategorized codes</span> — not assigned to any category</p>
                      )}
                      {diagnostics.emptyCategories > 0 && (
                        <p><span className="font-medium">{diagnostics.emptyCategories} empty categories</span> — contain no codes</p>
                      )}
                      {diagnostics.lowCoverage > 0 && (
                        <p><span className="font-medium">{diagnostics.lowCoverage} single-source codes</span> — appear in only one source</p>
                      )}
                    </div>
                  </>
                )}
              </div>
            </>
          )
        })()}

        <span className="text-mm-border-medium">{'\u00b7'}</span>
        {cb.mode === 'tree' && <span>Cat: {cb.catFormat} · Codes: {cb.codeFormat}</span>}
        {multiSelect.size > 0 && (
          <>
            <span className="text-mm-border-medium">{'\u00b7'}</span>
            <span className="text-mm-blue-text">{multiSelect.size} selected</span>
          </>
        )}
        {cb.search && (
          <>
            <span className="text-mm-border-medium">{'\u00b7'}</span>
            <span>Filter: &ldquo;{cb.search}&rdquo; ({searchMatchCount} match{searchMatchCount !== 1 ? 'es' : ''})</span>
          </>
        )}
      </div>

      {/* Screen reader announcements */}
      <div aria-live="polite" className="sr-only">{srAnnouncement}</div>

      {/* Dialogs (merge/group operations still use modal dialogs) */}
      {treeData && (
        <>
          <MergeCodesDialog
            open={showMergeDialog}
            onOpenChange={setShowMergeDialog}
            sourceCodeIds={selectionAnalysis.movableCodes}
            treeData={treeData}
            onConfirm={handleMergeComplete}
            isPending={mergePending}
          />
          <MergeCategoriesDialog
            open={showMergeCategoriesDialog}
            onOpenChange={setShowMergeCategoriesDialog}
            categoryIds={selectionAnalysis.movableCategories}
            treeData={treeData}
            onConfirm={handleMergeCategoriesComplete}
            isPending={mergeCategoriesPending}
          />
          <GroupIntoCategoryDialog
            open={showGroupIntoDialog}
            onOpenChange={setShowGroupIntoDialog}
            analysis={selectionAnalysis}
            treeData={treeData}
            onConfirm={handleGroupIntoComplete}
            isPending={groupIntoPending}
          />
        </>
      )}
    </div>
  )
}
