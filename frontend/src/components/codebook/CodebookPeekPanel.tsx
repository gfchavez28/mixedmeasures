import { useState, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { X, ChevronRight, ChevronDown, ExternalLink, Power, PowerOff, FolderInput, Trash2, StickyNote, Merge, FolderPlus } from 'lucide-react'
import { toast } from 'sonner'
import { codesApi, categoriesApi, codeAnalysisApi, memosApi } from '@/lib/api'
import type { CodebookTreeResponse, CodebookCategoryNode, CodebookCodeNode } from '@/lib/api'
import type { SelectionAnalysis } from './codebook-selection'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { ColorSwatchPicker } from '@/components/ColorSwatchPicker'
import CategoryTreePicker from './CategoryTreePicker'
import { COLOR_DEFAULT } from '@/lib/codebook-constants'

interface UndoMoveCode {
  type: 'move-code'
  entityId: number
  entityName: string
  prevValue: number | null
  prevName: string
}

interface UndoMoveCategory {
  type: 'move-category'
  entityId: number
  entityName: string
  prevValue: number | null
  prevName: string
}

interface UndoBulkMove {
  type: 'bulk-move'
  entityName: string
  prevCategories: Map<number, number | null>
}

interface UndoMerge {
  type: 'merge'
  entityId: number
  entityName: string
  sourceCodeIds: number[]
  targetCodeName: string
}

interface UndoBulkMoveCategories {
  type: 'bulk-move-categories'
  entityName: string
  prevParentIds: Map<number, number | null>
}

interface UndoMergeCategory {
  type: 'merge-category'
  entityId: number
  entityName: string
  mergedCategorySourceInfos: { id: number; name: string; color: string | null; parentId: number | null }[]
}

interface UndoGroupInto {
  type: 'group-into'
  entityId: number
  entityName: string
  newCategoryId: number
  originalParentIds?: Map<number, number | null>
  originalCodeCategories?: Map<number, number | null>
}

export type UndoEntry =
  | UndoMoveCode
  | UndoMoveCategory
  | UndoBulkMove
  | UndoMerge
  | UndoBulkMoveCategories
  | UndoMergeCategory
  | UndoGroupInto

interface CodebookPeekPanelProps {
  projectId: number
  selection: string
  treeData: CodebookTreeResponse
  onSelect: (sel: string | null) => void
  onClose: () => void
  onRecordUndo?: (entry: UndoEntry) => void
  multiSelect?: Set<string>
  selectionAnalysis?: SelectionAnalysis
  onMerge?: () => void
  onMergeCategories?: () => void
  onGroupInto?: () => void
}

interface CodeLookup {
  code: CodebookCodeNode
  categoryChain: CodebookCategoryNode[]
}

interface CategoryLookup {
  category: CodebookCategoryNode
  parentChain: CodebookCategoryNode[]
}

function getCodeColor(code: CodebookCodeNode, categoryColor: string | null): string {
  return code.color || categoryColor || COLOR_DEFAULT
}

/** Walk tree to build lookup maps */
function buildMaps(tree: CodebookCategoryNode[], uncategorized: CodebookCodeNode[], universal: CodebookCodeNode[]) {
  const codeMap = new Map<number, CodeLookup>()
  const categoryMap = new Map<number, CategoryLookup>()

  for (const c of uncategorized) codeMap.set(c.id, { code: c, categoryChain: [] })
  for (const c of universal) codeMap.set(c.id, { code: c, categoryChain: [] })

  function walk(nodes: CodebookCategoryNode[], parentChain: CodebookCategoryNode[]) {
    for (const cat of nodes) {
      const chain = [...parentChain, cat]
      categoryMap.set(cat.id, { category: cat, parentChain })
      for (const code of cat.codes) {
        codeMap.set(code.id, { code, categoryChain: chain })
      }
      walk(cat.children, chain)
    }
  }
  walk(tree, [])

  return { codeMap, categoryMap }
}

/** Collect all descendant category IDs (including self) */
function collectDescendantIds(cat: CodebookCategoryNode): Set<number> {
  const ids = new Set<number>([cat.id])
  for (const child of cat.children) {
    for (const id of collectDescendantIds(child)) ids.add(id)
  }
  return ids
}

/** Collect all descendant categories for delete confirmation */
function collectDescendantCategories(cat: CodebookCategoryNode): CodebookCategoryNode[] {
  const result: CodebookCategoryNode[] = []
  for (const child of cat.children) {
    result.push(child)
    result.push(...collectDescendantCategories(child))
  }
  return result
}

/** Collect all codes in subtree (direct + descendant categories) */
function collectSubtreeCodes(cat: CodebookCategoryNode): CodebookCodeNode[] {
  const result = [...cat.codes]
  for (const child of cat.children) {
    result.push(...collectSubtreeCodes(child))
  }
  return result
}

/** Max depth of subtree below a category (0 = leaf, 1 = has children, etc.) */
function getSubtreeDepth(cat: CodebookCategoryNode): number {
  if (cat.children.length === 0) return 0
  let max = 0
  for (const child of cat.children) {
    const d = 1 + getSubtreeDepth(child)
    if (d > max) max = d
  }
  return max
}

// ── Stat box helper ───────────────────────────────────────────────────

function StatGrid({ items }: { items: { label: string; value: number }[] }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map(item => (
        <div key={item.label} className="rounded-md bg-mm-bg border border-mm-border-subtle p-2 text-center">
          <div className="text-lg font-semibold text-mm-text tabular-nums">{item.value}</div>
          <div className="text-[10px] text-mm-text-faint uppercase tracking-wide">{item.label}</div>
        </div>
      ))}
    </div>
  )
}

export default function CodebookPeekPanel({
  projectId,
  selection,
  treeData,
  onSelect,
  onClose,
  onRecordUndo,
  multiSelect,
  selectionAnalysis,
  onMerge,
  onMergeCategories,
  onGroupInto,
}: CodebookPeekPanelProps) {
  const isMultiSelectMode = (multiSelect?.size ?? 0) > 1
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const { codeMap, categoryMap } = useMemo(
    () => buildMaps(treeData.tree, treeData.uncategorized_codes, treeData.universal_codes),
    [treeData],
  )

  const isCodeSelection = selection.startsWith('code:')
  const entityId = parseInt(selection.split(':')[1], 10)

  const codeLookup = isCodeSelection ? codeMap.get(entityId) : null
  const categoryLookup = !isCodeSelection ? categoryMap.get(entityId) : null

  // Pre-compute category-related derived data (must be at top level for hooks rules)
  const categoryExcludeIds = useMemo(
    () => categoryLookup ? collectDescendantIds(categoryLookup.category) : new Set<number>(),
    [categoryLookup],
  )
  const descendantCategories = useMemo(
    () => categoryLookup ? collectDescendantCategories(categoryLookup.category) : [],
    [categoryLookup],
  )
  const subtreeCodes = useMemo(
    () => categoryLookup ? collectSubtreeCodes(categoryLookup.category) : [],
    [categoryLookup],
  )
  const categoryMoveMaxDepth = useMemo(
    () => categoryLookup ? 3 - getSubtreeDepth(categoryLookup.category) : 3,
    [categoryLookup],
  )

  const { openMemos, openCodebook } = useProjectLayout()

  // ── Data queries ───────────────────────────────────────────────────────

  // Sample segments for code peek
  const { data: sampleSegments } = useQuery({
    queryKey: ['code-sample-segments', projectId, entityId],
    queryFn: () => codeAnalysisApi.segmentsWithContext(projectId, entityId, { limit: 3, context_size: 0 }),
    enabled: !isMultiSelectMode && isCodeSelection && !!codeLookup && (codeLookup?.code.segment_count ?? 0) > 0,
    staleTime: 60_000,
  })

  // Memos for code or category
  const memoEntityType = isCodeSelection ? 'code' : 'code_category'
  const { data: memosData } = useQuery({
    queryKey: ['entity-memos', projectId, memoEntityType, entityId],
    queryFn: () => memosApi.list(projectId, memoEntityType, entityId),
    enabled: !isMultiSelectMode && !!(codeLookup || categoryLookup),
    staleTime: 60_000,
  })

  // ── Local state ────────────────────────────────────────────────────────

  const [editingDesc, setEditingDesc] = useState(false)
  const [descValue, setDescValue] = useState('')
  const [showMoveTo, setShowMoveTo] = useState(false)
  const [deletingCategory, setDeletingCategory] = useState<CodebookCategoryNode | null>(null)
  const [colorPickerOpen, setColorPickerOpen] = useState(false)

  // ── Invalidation ──────────────────────────────────────────────────────

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['codes', projectId] })
    queryClient.invalidateQueries({ queryKey: ['categories', projectId] })
    queryClient.invalidateQueries({ queryKey: ['codebook-tree', projectId] })
    queryClient.invalidateQueries({ queryKey: ['codebook-cooccurrence', projectId] })
    queryClient.invalidateQueries({ queryKey: ['project-summary', projectId] })
  }, [queryClient, projectId])

  // ── Mutations ─────────────────────────────────────────────────────────

  const updateCodeMut = useMutation({
    mutationFn: ({ codeId, data }: { codeId: number; data: Record<string, unknown> }) =>
      codesApi.update(projectId, codeId, data),
    onSuccess: invalidateAll,
  })

  const updateCategoryMut = useMutation({
    mutationFn: ({ categoryId, data }: { categoryId: number; data: Record<string, unknown> }) =>
      categoriesApi.update(projectId, categoryId, data),
    onSuccess: invalidateAll,
    onError: (err: Error & { response?: { data?: { detail?: string } } }) => {
      const detail = err.response?.data?.detail
      toast.error(detail || 'Failed to move category')
    },
  })

  const deleteCategoryMut = useMutation({
    mutationFn: (categoryId: number) => categoriesApi.delete(projectId, categoryId),
    onSuccess: () => {
      invalidateAll()
      toast.success(`Deleted category "${deletingCategory?.name}"`)
      setDeletingCategory(null)
      onClose()
    },
    onError: (err: Error & { response?: { data?: { detail?: string } } }) => {
      const detail = err.response?.data?.detail
      toast.error(detail || 'Failed to delete category')
    },
  })

  // ── Handlers ──────────────────────────────────────────────────────────

  const handleSaveDesc = useCallback(() => {
    if (!codeLookup) return
    updateCodeMut.mutate({ codeId: codeLookup.code.id, data: { description: descValue || null } })
    setEditingDesc(false)
  }, [codeLookup, descValue, updateCodeMut])

  const handleToggleActive = useCallback(() => {
    if (!codeLookup) return
    const code = codeLookup.code
    const next = !code.is_active

    if (code.is_active && code.segment_count > 0) {
      // Deactivate with confirmation via undo toast
      updateCodeMut.mutate(
        { codeId: code.id, data: { is_active: false } },
        {
          onSuccess: () => {
            toast(`Deactivated "${code.name}" (${code.segment_count} application${code.segment_count !== 1 ? 's' : ''} preserved)`, {
              action: {
                label: 'Undo',
                onClick: () => {
                  updateCodeMut.mutate({ codeId: code.id, data: { is_active: true } })
                  toast.success('Reactivated')
                },
              },
              duration: 8000,
            })
          },
        },
      )
    } else {
      updateCodeMut.mutate({ codeId: code.id, data: { is_active: next } })
      toast.success(next ? 'Code activated' : 'Code deactivated')
    }
  }, [codeLookup, updateCodeMut])

  const handleMoveCode = useCallback((targetCategoryId: number | null) => {
    if (!codeLookup) return
    const code = codeLookup.code
    if (code.category_id === targetCategoryId) return

    const prevCategoryId = code.category_id
    const prevName = prevCategoryId !== null
      ? (codeLookup.categoryChain.length > 0 ? codeLookup.categoryChain[codeLookup.categoryChain.length - 1].name : 'Unknown')
      : 'Uncategorized'

    onRecordUndo?.({
      type: 'move-code',
      entityId: code.id,
      entityName: code.name,
      prevValue: prevCategoryId,
      prevName,
    })

    const targetName = targetCategoryId !== null
      ? (categoryMap.get(targetCategoryId)?.category.name ?? 'Unknown')
      : 'Uncategorized'

    updateCodeMut.mutate(
      { codeId: code.id, data: { category_id: targetCategoryId } },
      { onSuccess: () => toast.success(`Moved "${code.name}" to ${targetName}`) },
    )
    setShowMoveTo(false)
  }, [codeLookup, updateCodeMut, onRecordUndo, categoryMap])

  const handleMoveCategory = useCallback((targetParentId: number | null) => {
    if (!categoryLookup) return
    const cat = categoryLookup.category
    if (cat.parent_id === targetParentId) return

    const prevParentId = cat.parent_id ?? null
    const prevName = prevParentId !== null
      ? (categoryLookup.parentChain.length > 0 ? categoryLookup.parentChain[categoryLookup.parentChain.length - 1].name : 'Unknown')
      : 'Root level'

    onRecordUndo?.({
      type: 'move-category',
      entityId: cat.id,
      entityName: cat.name,
      prevValue: prevParentId,
      prevName,
    })

    const targetName = targetParentId !== null
      ? (categoryMap.get(targetParentId)?.category.name ?? 'Unknown')
      : 'Root level'

    updateCategoryMut.mutate(
      { categoryId: cat.id, data: { parent_id: targetParentId } },
      { onSuccess: () => toast.success(`Moved "${cat.name}" to ${targetName}`) },
    )
    setShowMoveTo(false)
  }, [categoryLookup, updateCategoryMut, onRecordUndo, categoryMap])

  const handleViewSegments = useCallback(() => {
    if (!codeLookup) return
    navigate(`/projects/${projectId}/analysis/qualitative?tab=content&contentMode=by-code&codes=${codeLookup.code.id}`)
  }, [codeLookup, projectId, navigate])

  // ── Breadcrumb ────────────────────────────────────────────────────────

  function renderBreadcrumb(chain: CodebookCategoryNode[]) {
    if (chain.length === 0) return null
    return (
      <div className="flex items-center gap-1 text-xs text-mm-text-muted flex-wrap">
        {chain.map((cat, i) => (
          <span key={cat.id} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="w-3 h-3 text-mm-text-faint shrink-0" />}
            <button
              className="hover:underline hover:text-mm-text-secondary truncate max-w-[120px]"
              onClick={() => onSelect(`cat:${cat.id}`)}
              title={cat.name}
            >
              {cat.name}
            </button>
          </span>
        ))}
      </div>
    )
  }

  // ── Multi-select summary ──────────────────────────────────────────────

  if (isMultiSelectMode && selectionAnalysis) {
    const { codes, categories } = selectionAnalysis
    const totalSegments = codes.reduce((s, c) => s + c.segmentCount, 0)
    const totalSources = codes.reduce((s, c) => s + c.sourceCount, 0)

    // Group codes by category for breakdown
    const catGroups = new Map<string, typeof codes>()
    for (const code of codes) {
      const catKey = code.categoryId !== null
        ? String(code.categoryId)
        : '_uncategorized'
      const list = catGroups.get(catKey) ?? []
      list.push(code)
      catGroups.set(catKey, list)
    }

    // Resolve category names
    const catNameMap = new Map<string, string>()
    catNameMap.set('_uncategorized', 'Uncategorized')
    function walkForNames(nodes: CodebookCategoryNode[]) {
      for (const cat of nodes) {
        catNameMap.set(String(cat.id), cat.name)
        walkForNames(cat.children)
      }
    }
    walkForNames(treeData.tree)

    return (
      <div className="p-3 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-sm font-semibold text-mm-text">
              {codes.length} code{codes.length !== 1 ? 's' : ''} selected
            </h3>
            {categories.length > 0 && (
              <span className="text-[10px] text-mm-text-faint">
                + {categories.length} categor{categories.length !== 1 ? 'ies' : 'y'}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-mm-text-faint hover:text-mm-text-secondary shrink-0"
            aria-label="Close detail panel"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Code list */}
        <div className="space-y-0.5">
          {codes.map(code => (
              <button
                key={code.id}
                className="flex items-center gap-1.5 w-full px-1.5 py-1 text-xs rounded hover:bg-mm-surface-hover text-left"
                onClick={() => onSelect(`code:${code.id}`)}
              >
                <span className="w-2 h-2 rounded-sm shrink-0 bg-mm-text-faint" />
                <span className="truncate flex-1 text-mm-text">{code.name}</span>
                <span className="text-[10px] text-mm-text-faint ml-auto tabular-nums shrink-0">
                  {code.segmentCount} seg
                </span>
              </button>
            ))}
        </div>

        {/* Aggregate stats */}
        <div className="rounded-md bg-mm-bg border border-mm-border-subtle p-2.5 text-xs text-mm-text-secondary space-y-1">
          <div className="flex justify-between">
            <span>Total segments</span>
            <span className="font-semibold tabular-nums">{totalSegments}</span>
          </div>
          <div className="flex justify-between">
            <span>Total sources</span>
            <span className="font-semibold tabular-nums">{totalSources}</span>
          </div>
          {catGroups.size > 1 && (
            <div className="pt-1 border-t border-mm-border-subtle mt-1">
              <span className="text-[10px] text-mm-text-faint uppercase tracking-wide">Categories</span>
              {Array.from(catGroups.entries()).map(([key, groupCodes]) => (
                <div key={key} className="flex justify-between mt-0.5">
                  <span className="truncate">{catNameMap.get(key) ?? 'Unknown'}</span>
                  <span className="tabular-nums shrink-0">{groupCodes.length}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Merge codes action */}
        {selectionAnalysis.canMerge && onMerge && !selectionAnalysis.canMergeCategories && (
          <button
            onClick={onMerge}
            className="flex items-center gap-1.5 w-full px-3 py-2 text-xs font-medium rounded-md bg-mm-blue/10 text-mm-blue-text hover:bg-mm-blue/20 transition-colors"
          >
            <Merge className="w-3.5 h-3.5" />
            Merge {selectionAnalysis.movableCodes.length} codes
          </button>
        )}

        {/* Merge categories action */}
        {selectionAnalysis.canMergeCategories && onMergeCategories && (
          <button
            onClick={onMergeCategories}
            className="flex items-center gap-1.5 w-full px-3 py-2 text-xs font-medium rounded-md bg-mm-blue/10 text-mm-blue-text hover:bg-mm-blue/20 transition-colors"
          >
            <Merge className="w-3.5 h-3.5" />
            Merge {selectionAnalysis.categories.length} categories
          </button>
        )}

        {/* Group into new category */}
        {selectionAnalysis.canGroupInto && onGroupInto && (
          <button
            onClick={onGroupInto}
            className="flex items-center gap-1.5 w-full px-3 py-2 text-xs font-medium rounded-md bg-mm-blue/10 text-mm-blue-text hover:bg-mm-blue/20 transition-colors"
          >
            <FolderPlus className="w-3.5 h-3.5" />
            Group into new category
          </button>
        )}
      </div>
    )
  }

  // ── Code Peek ─────────────────────────────────────────────────────────

  if (isCodeSelection && codeLookup) {
    const { code, categoryChain } = codeLookup
    const parentCat = categoryChain.length > 0 ? categoryChain[categoryChain.length - 1] : null
    const color = getCodeColor(code, parentCat?.color ?? null)

    return (
      <div className="p-3 space-y-3">
        {/* Header */}
        <div className="flex items-start gap-2">
          <Popover open={colorPickerOpen} onOpenChange={setColorPickerOpen}>
            <PopoverTrigger asChild>
              <button
                className="w-5 h-5 rounded-full shrink-0 mt-0.5 ring-offset-1 hover:ring-2 hover:ring-mm-border-medium transition-shadow flex items-center justify-center"
                aria-label={`Change color for ${code.name}`}
                title="Change color"
              >
                <span className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-3" align="start" side="left" collisionPadding={16}>
              <div className="space-y-2">
                <p className="text-xs font-medium text-mm-text-secondary">Code Color</p>
                <ColorSwatchPicker
                  value={code.color || ''}
                  onChange={(c) => {
                    updateCodeMut.mutate({ codeId: code.id, data: { color: c } })
                    setColorPickerOpen(false)
                  }}
                />
                {code.color && (
                  <button
                    className="text-xs text-mm-text-muted hover:text-mm-text mt-1"
                    onClick={() => {
                      updateCodeMut.mutate({ codeId: code.id, data: { color: null } })
                      setColorPickerOpen(false)
                    }}
                  >
                    {code.category_id != null ? 'Clear (inherit from category)' : 'Clear custom color'}
                  </button>
                )}
              </div>
            </PopoverContent>
          </Popover>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-mm-text truncate">{code.name}</h3>
            {code.is_universal && (
              <span className="text-[10px] text-mm-text-faint uppercase">Universal</span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-mm-text-faint hover:text-mm-text-secondary shrink-0"
            aria-label="Close detail panel"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Stats */}
        <StatGrid items={[
          { label: 'Segments', value: code.segment_count },
          { label: 'Sources', value: code.source_count },
          { label: 'Quoted', value: code.excerpt_count },
        ]} />

        {/* Breadcrumb */}
        {categoryChain.length > 0 && (
          <div>
            <div className="text-[10px] text-mm-text-faint uppercase tracking-wide mb-1">Category</div>
            {renderBreadcrumb(categoryChain)}
          </div>
        )}

        {/* Description */}
        <div>
          <div className="text-[10px] text-mm-text-faint uppercase tracking-wide mb-1">Description</div>
          {editingDesc ? (
            <div className="space-y-1.5">
              <textarea
                value={descValue}
                onChange={e => setDescValue(e.target.value)}
                aria-label="Code description"
                className="w-full text-xs rounded-md border border-mm-border-subtle bg-mm-bg text-mm-text p-2 focus:outline-none focus:ring-1 focus:ring-mm-blue/50 resize-y min-h-[60px]"
                placeholder="Add a description..."
                autoFocus
              />
              <div className="flex gap-1.5">
                <button
                  onClick={handleSaveDesc}
                  className="text-[11px] px-2 py-0.5 rounded bg-mm-blue text-white hover:bg-mm-blue/90"
                >
                  Save
                </button>
                <button
                  onClick={() => setEditingDesc(false)}
                  className="text-[11px] px-2 py-0.5 rounded text-mm-text-muted hover:text-mm-text-secondary"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p
              className={`text-xs cursor-pointer rounded px-1.5 py-1 -mx-1.5 hover:bg-mm-surface-hover transition-colors ${
                code.description ? 'text-mm-text' : 'text-mm-text-faint italic'
              }`}
              onClick={() => {
                setDescValue(code.description || '')
                setEditingDesc(true)
              }}
            >
              {code.description || 'Click to add description...'}
            </p>
          )}
        </div>

        {/* Sample segments */}
        {sampleSegments && sampleSegments.conversations.length > 0 && (
          <div>
            <div className="text-[10px] text-mm-text-faint uppercase tracking-wide mb-1">Sample Segments</div>
            <div className="space-y-1.5">
              {sampleSegments.conversations.slice(0, 2).map(conv => (
                <div key={conv.conversation_id}>
                  <div className="text-[10px] text-mm-text-muted font-medium mb-0.5">{conv.conversation_name}</div>
                  {conv.segments.slice(0, 2).map(seg => (
                    <p key={seg.id} className="text-xs text-mm-text-secondary leading-relaxed line-clamp-2 pl-1.5 border-l border-mm-border-subtle mb-1">
                      {seg.text.length > 120 ? seg.text.slice(0, 120) + '…' : seg.text}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Memos */}
        {memosData && memosData.memos.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 text-[10px] text-mm-text-faint uppercase tracking-wide mb-1">
              <StickyNote className="w-3 h-3" />
              Memos ({memosData.memos.length})
            </div>
            <div className="space-y-0.5">
              {memosData.memos.slice(0, 3).map(memo => (
                <button
                  key={memo.id}
                  className="w-full text-left text-xs text-mm-text-secondary hover:text-mm-text hover:bg-mm-surface-hover rounded px-1.5 py-1 truncate"
                  onClick={openMemos}
                  title={memo.content}
                >
                  {memo.title || memo.content.slice(0, 60)}
                </button>
              ))}
              {memosData.memos.length > 3 && (
                <button
                  className="text-xs text-mm-text-faint hover:text-mm-text-secondary px-1.5"
                  onClick={openMemos}
                >
                  +{memosData.memos.length - 3} more…
                </button>
              )}
            </div>
          </div>
        )}

        {/* Organize: move to a category + where to reorder within one */}
        {!code.is_universal && (
          <div className="space-y-1.5">
            <button
              onClick={() => setShowMoveTo(prev => !prev)}
              className="flex items-center gap-1.5 text-xs text-mm-text-secondary hover:text-mm-text transition-colors"
            >
              <FolderInput className="w-3 h-3" />
              Move to category…
              {showMoveTo ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </button>
            {showMoveTo && (
              <div className="mt-1.5">
                <CategoryTreePicker
                  treeData={treeData}
                  value={code.category_id}
                  onChange={handleMoveCode}
                  noneLabel="Uncategorized"
                />
              </div>
            )}
            <p className="text-[11px] text-mm-text-faint leading-snug">
              To reorder codes within a category, open the{' '}
              <button onClick={openCodebook} className="text-mm-blue-text hover:underline">
                Codebook list
              </button>
              .
            </p>
          </div>
        )}

        {/* Active toggle */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-mm-text-muted">Status</span>
          <button
            onClick={handleToggleActive}
            className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded transition-colors ${
              code.is_active
                ? 'text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-950/20'
                : 'text-mm-text-faint hover:bg-mm-surface-hover'
            }`}
          >
            {code.is_active
              ? <><Power className="w-3 h-3" /> Active</>
              : <><PowerOff className="w-3 h-3" /> Inactive</>
            }
          </button>
        </div>

        {/* View segments link */}
        {code.segment_count > 0 && (
          <button
            onClick={handleViewSegments}
            className="flex items-center gap-1.5 text-xs text-mm-blue-text hover:underline"
          >
            <ExternalLink className="w-3 h-3" />
            View all {code.segment_count} segments
          </button>
        )}
      </div>
    )
  }

  // ── Category Peek ─────────────────────────────────────────────────────

  if (!isCodeSelection && categoryLookup) {
    const { category, parentChain } = categoryLookup
    const catColor = category.color || COLOR_DEFAULT
    const depthLabel = category.depth === 0 ? 'Root' : `Level ${category.depth}`

    return (
      <div className="p-3 space-y-3">
        {/* Header */}
        <div className="flex items-start gap-2">
          <Popover open={colorPickerOpen} onOpenChange={setColorPickerOpen}>
            <PopoverTrigger asChild>
              <button
                className="w-5 h-5 rounded shrink-0 mt-0.5 ring-offset-1 hover:ring-2 hover:ring-mm-border-medium transition-shadow flex items-center justify-center"
                aria-label={`Change color for category ${category.name}`}
                title="Change color"
              >
                <span className="w-3 h-3 rounded" style={{ backgroundColor: catColor }} />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-3" align="start" side="left" collisionPadding={16}>
              <div className="space-y-2">
                <p className="text-xs font-medium text-mm-text-secondary">Category Color</p>
                <ColorSwatchPicker
                  value={category.color || ''}
                  onChange={(c) => {
                    updateCategoryMut.mutate({ categoryId: category.id, data: { color: c } })
                    setColorPickerOpen(false)
                  }}
                />
              </div>
            </PopoverContent>
          </Popover>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-mm-text truncate">{category.name}</h3>
            <span className="text-[10px] text-mm-text-faint uppercase">{depthLabel}</span>
          </div>
          <button
            onClick={() => setDeletingCategory(category)}
            className="text-mm-text-faint hover:text-red-500 dark:hover:text-red-400 shrink-0 p-0.5"
            aria-label="Delete category"
            title="Delete category"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onClose}
            className="text-mm-text-faint hover:text-mm-text-secondary shrink-0"
            aria-label="Close detail panel"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Stats */}
        <StatGrid items={[
          { label: 'Direct', value: category.code_count },
          { label: 'Total', value: category.total_code_count },
          { label: 'Segments', value: category.total_segments },
        ]} />

        {/* Breadcrumb */}
        {parentChain.length > 0 && (
          <div>
            <div className="text-[10px] text-mm-text-faint uppercase tracking-wide mb-1">Parent</div>
            {renderBreadcrumb(parentChain)}
          </div>
        )}

        {/* Move to... (reparent) */}
        <div>
          <button
            onClick={() => setShowMoveTo(prev => !prev)}
            className="flex items-center gap-1.5 text-xs text-mm-text-secondary hover:text-mm-text transition-colors"
          >
            <FolderInput className="w-3 h-3" />
            Move to…
            {showMoveTo ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </button>
          {showMoveTo && (
            <div className="mt-1.5">
              <CategoryTreePicker
                treeData={treeData}
                value={category.parent_id ?? null}
                onChange={handleMoveCategory}
                excludeIds={categoryExcludeIds}
                noneLabel="Root level"
                maxDepth={categoryMoveMaxDepth}
              />
            </div>
          )}
        </div>

        {/* Subcategories */}
        {category.children.length > 0 && (
          <div>
            <div className="text-[10px] text-mm-text-faint uppercase tracking-wide mb-1">
              Subcategories ({category.children.length})
            </div>
            <div className="space-y-0.5">
              {category.children.map(child => (
                <button
                  key={child.id}
                  className="flex items-center gap-1.5 w-full px-1.5 py-1 text-xs rounded hover:bg-mm-surface-hover text-left"
                  onClick={() => onSelect(`cat:${child.id}`)}
                >
                  {child.color && (
                    <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: child.color }} />
                  )}
                  <span className="truncate text-mm-text">{child.name}</span>
                  <span className="text-[10px] text-mm-text-faint ml-auto tabular-nums">
                    {child.total_code_count}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Direct codes */}
        {category.codes.length > 0 && (
          <div>
            <div className="text-[10px] text-mm-text-faint uppercase tracking-wide mb-1">
              Codes ({category.codes.length})
            </div>
            <div className="space-y-0.5">
              {category.codes.map(code => (
                <button
                  key={code.id}
                  className="flex items-center gap-1.5 w-full px-1.5 py-1 text-xs rounded hover:bg-mm-surface-hover text-left"
                  onClick={() => onSelect(`code:${code.id}`)}
                >
                  <span
                    className="w-2 h-2 rounded-sm shrink-0"
                    style={{ backgroundColor: getCodeColor(code, catColor) }}
                  />
                  <span className={`truncate text-mm-text ${!code.is_active ? 'opacity-40' : ''}`}>
                    {code.name}
                  </span>
                  <span className="text-[10px] text-mm-text-faint ml-auto tabular-nums">
                    {code.segment_count}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Memos */}
        {memosData && memosData.memos.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 text-[10px] text-mm-text-faint uppercase tracking-wide mb-1">
              <StickyNote className="w-3 h-3" />
              Memos ({memosData.memos.length})
            </div>
            <div className="space-y-0.5">
              {memosData.memos.slice(0, 3).map(memo => (
                <button
                  key={memo.id}
                  className="w-full text-left text-xs text-mm-text-secondary hover:text-mm-text hover:bg-mm-surface-hover rounded px-1.5 py-1 truncate"
                  onClick={openMemos}
                  title={memo.content}
                >
                  {memo.title || memo.content.slice(0, 60)}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Delete category confirmation ─────────────────────────────── */}
        <AlertDialog open={!!deletingCategory} onOpenChange={open => { if (!open) setDeletingCategory(null) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete "{deletingCategory?.name}"?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2 text-sm">
                  <p>This action cannot be undone.</p>
                  {descendantCategories.length > 0 && (
                    <p>
                      <strong>{descendantCategories.length} subcategor{descendantCategories.length === 1 ? 'y' : 'ies'}</strong> will also be deleted:
                      {' '}{descendantCategories.map(c => c.name).join(', ')}
                    </p>
                  )}
                  {subtreeCodes.length > 0 && (
                    <p>
                      <strong>{subtreeCodes.length} code{subtreeCodes.length !== 1 ? 's' : ''}</strong> will become uncategorized
                      {subtreeCodes.length <= 8 && (
                        <>: {subtreeCodes.map(c => c.name).join(', ')}</>
                      )}
                    </p>
                  )}
                  {subtreeCodes.length === 0 && descendantCategories.length === 0 && (
                    <p>This category is empty.</p>
                  )}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => { if (deletingCategory) deleteCategoryMut.mutate(deletingCategory.id) }}
                disabled={deleteCategoryMut.isPending}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    )
  }

  // Fallback — selection doesn't match anything in tree data
  return (
    <div className="p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-mm-text-faint">Not found</span>
        <button onClick={onClose} className="text-mm-text-faint hover:text-mm-text-secondary" aria-label="Close">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <p className="text-xs text-mm-text-faint">
        The selected item ({selection}) was not found in the current tree data. It may have been filtered out.
      </p>
    </div>
  )
}
