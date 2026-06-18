import { useState, useCallback, useMemo, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Plus, StickyNote, Trash2, ChevronDown, ChevronRight, Pencil,
  Save, LoaderCircle
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import {
  memosApi,
  codesApi,
  conversationsApi,
  materialsApi,
  type Memo,
} from '@/lib/api'
import { getUnfocusedStyle } from '@/lib/utils'
import { toast } from 'sonner'
import {
  type FilterType,
  ENTITY_TYPE_LABELS,
  ENTITY_TYPE_COLORS,
  ENTITY_TYPE_ICONS,
  entityTypeHexColor,
  FILTER_CHIPS,
  formatDate,
} from '@/lib/memo-constants'


// Active/inactive color pairs for filter chips — aligned with ENTITY_TYPE_COLORS
const FILTER_CHIP_COLORS: Record<FilterType, { active: string; inactive: string }> = {
  all:          { active: 'bg-gray-700 text-white dark:bg-gray-300 dark:text-gray-900', inactive: 'bg-mm-bg text-mm-text-muted hover:bg-mm-surface-hover' },
  project:      { active: 'bg-purple-600 text-white dark:bg-purple-500 dark:text-white', inactive: 'bg-purple-50 text-purple-700 hover:bg-purple-100 dark:bg-purple-900/20 dark:text-purple-300 dark:hover:bg-purple-900/30' },
  conversation: { active: 'bg-teal-600 text-white dark:bg-teal-500 dark:text-white', inactive: 'bg-teal-50 text-teal-700 hover:bg-teal-100 dark:bg-teal-900/20 dark:text-teal-300 dark:hover:bg-teal-900/30' },
  code:         { active: 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-white', inactive: 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/20 dark:text-emerald-300 dark:hover:bg-emerald-900/30' },
  code_category:{ active: 'bg-blue-600 text-white dark:bg-blue-500 dark:text-white', inactive: 'bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/20 dark:text-blue-300 dark:hover:bg-blue-900/30' },
  analysis:     { active: 'bg-orange-600 text-white dark:bg-orange-500 dark:text-white', inactive: 'bg-orange-50 text-orange-700 hover:bg-orange-100 dark:bg-orange-900/20 dark:text-orange-300 dark:hover:bg-orange-900/30' },
  dataset:      { active: 'bg-sky-600 text-white dark:bg-sky-500 dark:text-white', inactive: 'bg-sky-50 text-sky-700 hover:bg-sky-100 dark:bg-sky-900/20 dark:text-sky-300 dark:hover:bg-sky-900/30' },
  canvas:       { active: 'bg-indigo-600 text-white dark:bg-indigo-500 dark:text-white', inactive: 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-900/20 dark:text-indigo-300 dark:hover:bg-indigo-900/30' },
}

const CREATABLE_ENTITY_TYPES: { value: string; label: string }[] = [
  { value: 'project', label: 'Project' },
  { value: 'conversation', label: 'Conversation' },
  { value: 'code', label: 'Code' },
  { value: 'analysis', label: 'Analysis' },
]

interface MemosPanelContentProps {
  projectId: number
  headerExtra?: React.ReactNode
  search?: string
  defaultEntityType?: string
  defaultEntityId?: number | null
  focusedType?: string | null
  focusedEntityId?: number | null
  onFocus?: (type: string, entityId: number | null, label: string, color: string) => void
}

export default function MemosPanelContent({ projectId, headerExtra, search = '', defaultEntityType, defaultEntityId, focusedType, focusedEntityId, onFocus }: MemosPanelContentProps) {
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<FilterType>('all')
  const [expandedMemoId, setExpandedMemoId] = useState<number | null>(null)
  const [editingMemoId, setEditingMemoId] = useState<number | null>(null)
  const [editContent, setEditContent] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const effectiveDefaultType = defaultEntityType || 'project'
  const effectiveDefaultId = defaultEntityId ?? null
  const [newEntityType, setNewEntityType] = useState<string>(effectiveDefaultType)
  const [newEntityId, setNewEntityId] = useState<number | null>(effectiveDefaultId)
  const [newContent, setNewContent] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Memo | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  // Data queries
  const { data: memosData, isLoading } = useQuery({
    queryKey: ['memos', projectId, showArchived],
    queryFn: () => memosApi.list(projectId, undefined, undefined, showArchived),
  })

  const { data: codesData } = useQuery({
    queryKey: ['codes', projectId],
    queryFn: () => codesApi.list(projectId),
  })

  const { data: conversationsData } = useQuery({
    queryKey: ['conversations', projectId],
    queryFn: () => conversationsApi.list(projectId),
  })

  const { data: collectionsData } = useQuery({
    queryKey: ['material-collections', projectId],
    queryFn: () => materialsApi.list(projectId),
  })

  const defaultCollectionId = collectionsData?.collections?.[0]?.id ?? null

  const { data: collectionDetail } = useQuery({
    queryKey: ['material-collection-detail', projectId, defaultCollectionId],
    queryFn: () => materialsApi.get(projectId, defaultCollectionId!),
    enabled: !!defaultCollectionId,
  })

  const memos = useMemo(() => memosData?.memos ?? [], [memosData?.memos])
  const codes = useMemo(() => codesData?.codes ?? [], [codesData?.codes])
  const conversations = useMemo(() => conversationsData?.conversations ?? [], [conversationsData?.conversations])
  const savedMaterials = useMemo(() => collectionDetail?.materials ?? [], [collectionDetail?.materials])
  const materialMap = useMemo(
    () => new Map(savedMaterials.map((e: { id: number; auto_name: string; custom_name: string | null }) => [e.id, e])),
    [savedMaterials],
  )

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  // Filter memos by type and search
  const filteredMemos = useMemo(() => {
    let result = memos
    if (filter === 'dataset') {
      result = result.filter(m => {
        const et = m.entity_type as string
        return et === 'dataset' || et === 'dataset_row' || et === 'dataset_column'
      })
    } else if (filter !== 'all') {
      result = result.filter(m => (m.entity_type as string) === filter)
    }
    if (search) {
      const q = search.toLowerCase()
      result = result.filter(m => m.content.toLowerCase().includes(q))
    }
    return result
  }, [memos, filter, search])

  // Build collapsible groups by entity
  const memoGroups = useMemo(() => {
    const groupMap = new Map<string, { entityType: string; entityId: number; memos: Memo[] }>()
    for (const memo of filteredMemos) {
      const key = `${memo.entity_type}-${memo.entity_id}`
      let group = groupMap.get(key)
      if (!group) {
        group = { entityType: memo.entity_type, entityId: memo.entity_id, memos: [] }
        groupMap.set(key, group)
      }
      group.memos.push(memo)
    }
    return Array.from(groupMap.entries()).map(([key, g]) => ({ key, ...g }))
  }, [filteredMemos])

  // Auto-expand all groups when searching
  useEffect(() => {
    if (search) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- expand groups to show search matches
      setExpandedGroups(new Set(memoGroups.map(g => g.key)))
    }
  }, [search, memoGroups])

  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // Mutations
  const createMutation = useMutation({
    mutationFn: (data: { entity_type: string; entity_id: number; content?: string }) =>
      memosApi.create(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memos', projectId] })
      setIsCreating(false)
      setNewContent('')
      setNewEntityType(effectiveDefaultType)
      setNewEntityId(effectiveDefaultId)
    },
    onError: () => toast.error('Failed to create memo'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ memoId, content }: { memoId: number; content: string }) =>
      memosApi.update(projectId, memoId, { content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memos', projectId] })
      setEditingMemoId(null)
    },
    onError: () => toast.error('Failed to update memo'),
  })

  const archiveMutation = useMutation({
    mutationFn: (memoId: number) => memosApi.archive(projectId, memoId),
    onSuccess: (_data, archivedMemoId) => {
      queryClient.invalidateQueries({ queryKey: ['memos', projectId] })
      if (expandedMemoId === archivedMemoId) {
        setExpandedMemoId(null)
        setEditingMemoId(null)
      }
      setDeleteTarget(null)
      toast.success('Memo archived')
    },
    onError: () => toast.error('Failed to archive memo'),
  })

  const restoreMutation = useMutation({
    mutationFn: (memoId: number) => memosApi.restore(projectId, memoId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memos', projectId] })
      toast.success('Memo restored')
    },
    onError: () => toast.error('Failed to restore memo'),
  })

  const permanentDeleteMutation = useMutation({
    mutationFn: (memoId: number) => memosApi.permanentDelete(projectId, memoId),
    onSuccess: (_data, deletedMemoId) => {
      queryClient.invalidateQueries({ queryKey: ['memos', projectId] })
      if (expandedMemoId === deletedMemoId) {
        setExpandedMemoId(null)
        setEditingMemoId(null)
      }
      toast.success('Memo permanently deleted')
    },
    onError: () => toast.error('Failed to delete memo'),
  })

  const handleExpandMemo = useCallback((memo: Memo) => {
    if (expandedMemoId === memo.id) {
      setExpandedMemoId(null)
      setEditingMemoId(null)
    } else {
      setExpandedMemoId(memo.id)
      setEditingMemoId(null)
    }
  }, [expandedMemoId])

  const handleStartEdit = useCallback((memo: Memo) => {
    setEditingMemoId(memo.id)
    setEditContent(memo.content)
  }, [])

  const handleSaveEdit = useCallback((memoId: number) => {
    updateMutation.mutate({ memoId, content: editContent })
  }, [editContent, updateMutation])

  const handleCreate = useCallback(() => {
    const entityId = newEntityType === 'project' ? projectId : newEntityId
    if (entityId == null) {
      toast.error(`Please select a ${ENTITY_TYPE_LABELS[newEntityType]?.toLowerCase() ?? 'target'} first`)
      return
    }
    createMutation.mutate({
      entity_type: newEntityType,
      entity_id: entityId,
      content: newContent || undefined,
    })
  }, [newEntityType, newEntityId, newContent, projectId, createMutation])

  const getEntityName = useCallback((memo: Memo): string | null => {
    switch (memo.entity_type) {
      case 'project':
        return null
      case 'conversation': {
        const conv = conversations.find(c => c.id === memo.entity_id)
        return conv?.name ?? `Conversation #${memo.entity_id}`
      }
      case 'code': {
        const code = codes.find(c => c.id === memo.entity_id)
        return code?.name ?? `Code #${memo.entity_id}`
      }
      case 'code_category':
        return `Category #${memo.entity_id}`
      case 'analysis': {
        const el = materialMap.get(memo.entity_id)
        return (el?.custom_name || el?.auto_name) ?? `Analysis #${memo.entity_id}`
      }
      default:
        return `${ENTITY_TYPE_LABELS[memo.entity_type] ?? memo.entity_type} #${memo.entity_id}`
    }
  }, [conversations, codes, materialMap])

  const getGroupLabel = useCallback((entityType: string, entityId: number): string => {
    const name = getEntityName({ entity_type: entityType, entity_id: entityId } as Memo)
    if (name) return name
    return ENTITY_TYPE_LABELS[entityType] ?? entityType
  }, [getEntityName])

  const entityOptions = useMemo(() => {
    switch (newEntityType) {
      case 'project':
        return []
      case 'conversation':
        return conversations.map(c => ({ id: c.id, label: c.name }))
      case 'code':
        return codes.map(c => ({ id: c.id, label: c.name }))
      case 'analysis':
        return savedMaterials.map((a: { id: number; auto_name: string; custom_name: string | null }) => ({ id: a.id, label: a.custom_name || a.auto_name }))
      default:
        return []
    }
  }, [newEntityType, conversations, codes, savedMaterials])

  const canCreate = newEntityType === 'project' || newEntityId != null

  return (
    <>
      {/* Header */}
      <div className="border-b border-mm-border-subtle bg-mm-bg flex-shrink-0">
        <div className="flex items-center gap-2 px-4 py-2">
          <StickyNote className="h-3.5 w-3.5 text-mm-text-muted flex-shrink-0" />
          <span className="text-xs font-semibold text-mm-text-muted uppercase tracking-wider">Memos</span>
          <span className="text-xs text-mm-text-muted bg-mm-surface rounded-full px-2 py-0.5">
            {filteredMemos.length}
          </span>
          <button
            onClick={() => setShowArchived(prev => !prev)}
            className={`text-[11px] px-2 py-0.5 rounded-full transition-colors ${showArchived ? 'bg-mm-bg text-mm-text' : 'text-mm-text-faint hover:text-mm-text-muted'}`}
            aria-pressed={showArchived}
            aria-label="Show archived memos"
          >
            {showArchived ? 'Hide archived' : 'Archived'}
          </button>
          {/* In page context: chips inline. In slide-out: action buttons here, chips below. */}
          {headerExtra ? (
            <div className="ml-auto flex items-center">{headerExtra}</div>
          ) : (
            <div className="flex items-center gap-1 ml-auto overflow-x-auto">
              {FILTER_CHIPS.map(chip => {
                const colors = FILTER_CHIP_COLORS[chip.value]
                return (
                <button
                  key={chip.value}
                  onClick={() => setFilter(chip.value)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-full whitespace-nowrap transition-colors ${
                    filter === chip.value ? colors.active : colors.inactive
                  }`}
                  aria-pressed={filter === chip.value}
                >
                  {chip.label}
                </button>
                )
              })}
            </div>
          )}
        </div>
        {/* Second row for slide-out: filter chips */}
        {headerExtra && (
          <div className="flex items-center gap-1 px-4 pb-2 overflow-x-auto">
            {FILTER_CHIPS.map(chip => {
              const colors = FILTER_CHIP_COLORS[chip.value]
              return (
              <button
                key={chip.value}
                onClick={() => setFilter(chip.value)}
                className={`px-2.5 py-1 text-xs font-medium rounded-full whitespace-nowrap transition-colors ${
                  filter === chip.value ? colors.active : colors.inactive
                }`}
                aria-pressed={filter === chip.value}
              >
                {chip.label}
              </button>
              )
            })}
          </div>
        )}
      </div>

      {/* New memo button / form */}
      <div className="px-4 py-2 border-b border-mm-border-subtle">
        {!isCreating ? (
          <Button
            variant="outline"
            size="sm"
            className="w-full text-mm-text-muted border-dashed"
            onClick={() => setIsCreating(true)}
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New Memo
          </Button>
        ) : (
          <div className="space-y-2">
            <Select value={newEntityType} onValueChange={(v) => { setNewEntityType(v); setNewEntityId(null) }}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                {CREATABLE_ENTITY_TYPES.map(t => (
                  <SelectItem key={t.value} value={t.value} className="text-xs">
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {newEntityType !== 'project' && entityOptions.length > 0 && (
              <Select
                value={newEntityId != null ? String(newEntityId) : ''}
                onValueChange={(v) => setNewEntityId(Number(v))}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder={`Select ${ENTITY_TYPE_LABELS[newEntityType]?.toLowerCase() ?? 'entity'}...`} />
                </SelectTrigger>
                <SelectContent>
                  {entityOptions.map(opt => (
                    <SelectItem key={opt.id} value={String(opt.id)} className="text-xs">
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {newEntityType !== 'project' && entityOptions.length === 0 && (
              <p className="text-xs text-mm-text-muted italic px-1">
                No {ENTITY_TYPE_LABELS[newEntityType]?.toLowerCase() ?? 'entities'} available
              </p>
            )}

            <Textarea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="Write your memo..."
              className="text-xs min-h-[60px] resize-none"
              rows={3}
            />

            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => { setIsCreating(false); setNewContent(''); setNewEntityId(null) }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="h-7 text-xs"
                disabled={!canCreate || createMutation.isPending}
                onClick={handleCreate}
              >
                {createMutation.isPending ? (
                  <LoaderCircle className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <Save className="h-3 w-3 mr-1" />
                )}
                Create
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Memo list */}
      <div className="flex-1 overflow-y-auto" role="list" aria-label="Memos">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <LoaderCircle className="h-5 w-5 animate-spin text-mm-text-muted" />
          </div>
        ) : filteredMemos.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <StickyNote className="h-8 w-8 text-mm-text-muted/40 mb-2" />
            <p className="text-sm text-mm-text-muted">
              {filter === 'all' ? 'No memos yet' : `No ${FILTER_CHIPS.find(f => f.value === filter)?.label.toLowerCase() ?? ''} memos`}
            </p>
            <p className="text-xs text-mm-text-muted/70 mt-1">
              Create a memo to capture your reflections
            </p>
          </div>
        ) : (
          memoGroups.map(group => {
            const GroupIcon = ENTITY_TYPE_ICONS[group.entityType] ?? StickyNote
            const groupLabel = getGroupLabel(group.entityType, group.entityId)
            const isGroupExpanded = expandedGroups.has(group.key)
            const groupColor = entityTypeHexColor(group.entityType)

            return (
              <div key={group.key}>
                {/* Collapsible group header */}
                <button
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-mm-text hover:bg-mm-surface-hover transition-colors"
                  onClick={() => toggleGroup(group.key)}
                  aria-expanded={isGroupExpanded}
                >
                  {isGroupExpanded
                    ? <ChevronDown className="h-3.5 w-3.5 text-mm-text-muted flex-shrink-0" />
                    : <ChevronRight className="h-3.5 w-3.5 text-mm-text-muted flex-shrink-0" />
                  }
                  <GroupIcon className="h-3.5 w-3.5 text-mm-text-muted flex-shrink-0" />
                  <span
                    className="truncate cursor-pointer hover:underline"
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation()
                      onFocus?.(
                        group.entityType,
                        group.entityType === 'project' ? null : group.entityId,
                        groupLabel,
                        groupColor,
                      )
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        e.stopPropagation()
                        onFocus?.(
                          group.entityType,
                          group.entityType === 'project' ? null : group.entityId,
                          groupLabel,
                          groupColor,
                        )
                      }
                    }}
                    title={`Focus on "${groupLabel}"`}
                  >
                    {groupLabel}
                  </span>
                  <span className="text-xs text-mm-text-muted ml-auto flex-shrink-0">
                    {group.memos.length} memo{group.memos.length !== 1 ? 's' : ''}
                  </span>
                </button>

                {/* Memo cards within group */}
                {isGroupExpanded && (
                  <div className="px-3 pb-2 space-y-1.5">
                    {group.memos.map(memo => {
                      const isExpanded = expandedMemoId === memo.id
                      const isEditing = editingMemoId === memo.id
                      const colors = ENTITY_TYPE_COLORS[memo.entity_type] ?? ENTITY_TYPE_COLORS.project

                      const isFocusMatch = !focusedType || (
                        focusedEntityId != null
                          ? (memo.entity_type === focusedType && memo.entity_id === focusedEntityId)
                          : memo.entity_type === focusedType
                      )

                      return (
                        <div
                          key={memo.id}
                          className={`group rounded-md border border-mm-border-subtle bg-mm-bg p-3${memo.is_archived ? ' opacity-60 italic' : ''}`}
                          style={getUnfocusedStyle(isFocusMatch)}
                        >
                          {/* Meta row: type chip + ID + date */}
                          <div className="flex items-center gap-2 mb-1">
                            <span
                              role="button"
                              tabIndex={0}
                              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${colors.bg} ${colors.text} hover:ring-1 hover:ring-current/30 transition-shadow cursor-pointer`}
                              onClick={() => {
                                onFocus?.(
                                  memo.entity_type,
                                  null,
                                  ENTITY_TYPE_LABELS[memo.entity_type] ?? memo.entity_type,
                                  entityTypeHexColor(memo.entity_type),
                                )
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault()
                                  onFocus?.(
                                    memo.entity_type,
                                    null,
                                    ENTITY_TYPE_LABELS[memo.entity_type] ?? memo.entity_type,
                                    entityTypeHexColor(memo.entity_type),
                                  )
                                }
                              }}
                              title={`Focus on ${ENTITY_TYPE_LABELS[memo.entity_type]} entries`}
                            >
                              {ENTITY_TYPE_LABELS[memo.entity_type] ?? memo.entity_type}
                            </span>
                            <span className="text-[10px] text-mm-text-muted">
                              M-{memo.numeric_id}
                            </span>
                            <span className="text-[10px] text-mm-text-muted ml-auto flex-shrink-0">
                              {formatDate(memo.updated_at)}
                            </span>
                          </div>

                          {/* Content — click to expand */}
                          {!isExpanded && !isEditing && (
                            <button
                              className="w-full text-left"
                              onClick={() => handleExpandMemo(memo)}
                              title="Click to expand"
                            >
                              <p className="text-xs text-mm-text line-clamp-3 whitespace-pre-wrap">
                                {memo.content || '(empty)'}
                              </p>
                            </button>
                          )}

                          {/* Read-only expanded state */}
                          {isExpanded && !isEditing && (
                            <div>
                              <button
                                className="w-full text-left"
                                onClick={() => handleExpandMemo(memo)}
                                title="Click to collapse"
                              >
                                <p className="text-xs text-mm-text whitespace-pre-wrap">
                                  {memo.content || '(empty)'}
                                </p>
                              </button>
                              <div className="flex items-center justify-between mt-2">
                                {memo.is_archived ? (
                                  <div className="flex items-center gap-1">
                                    <Button variant="ghost" size="sm" className="h-7 text-xs text-mm-text-muted hover:text-mm-text" onClick={() => restoreMutation.mutate(memo.id)}>Restore</Button>
                                    <Button variant="ghost" size="sm" className="h-7 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/20" onClick={() => permanentDeleteMutation.mutate(memo.id)}>
                                      <Trash2 className="h-3 w-3 mr-1" />Delete
                                    </Button>
                                  </div>
                                ) : (
                                  <Button variant="ghost" size="sm" className="h-7 text-xs text-mm-text-muted hover:text-mm-text hover:bg-mm-bg" onClick={() => setDeleteTarget(memo)}>
                                    <Trash2 className="h-3 w-3 mr-1" />Archive
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 text-xs"
                                  onClick={() => handleStartEdit(memo)}
                                >
                                  <Pencil className="h-3 w-3 mr-1" />
                                  Edit
                                </Button>
                              </div>
                            </div>
                          )}

                          {/* Editing state */}
                          {isEditing && (
                            <div className="space-y-2">
                              <Textarea
                                value={editContent}
                                onChange={(e) => setEditContent(e.target.value)}
                                className="text-xs min-h-[80px] resize-none"
                                rows={4}
                                placeholder="Write your memo..."
                                autoFocus
                              />
                              <div className="flex items-center justify-between">
                                {memo.is_archived ? (
                                  <div className="flex items-center gap-1">
                                    <Button variant="ghost" size="sm" className="h-7 text-xs text-mm-text-muted hover:text-mm-text" onClick={() => restoreMutation.mutate(memo.id)}>Restore</Button>
                                    <Button variant="ghost" size="sm" className="h-7 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/20" onClick={() => permanentDeleteMutation.mutate(memo.id)}>
                                      <Trash2 className="h-3 w-3 mr-1" />Delete
                                    </Button>
                                  </div>
                                ) : (
                                  <Button variant="ghost" size="sm" className="h-7 text-xs text-mm-text-muted hover:text-mm-text hover:bg-mm-bg" onClick={() => setDeleteTarget(memo)}>
                                    <Trash2 className="h-3 w-3 mr-1" />Archive
                                  </Button>
                                )}
                                <div className="flex items-center gap-2">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 text-xs"
                                    onClick={() => setEditingMemoId(null)}
                                  >
                                    Cancel
                                  </Button>
                                  <Button
                                    size="sm"
                                    className="h-7 text-xs"
                                    disabled={editContent === memo.content || updateMutation.isPending}
                                    onClick={() => handleSaveEdit(memo.id)}
                                  >
                                    {updateMutation.isPending ? (
                                      <LoaderCircle className="h-3 w-3 animate-spin mr-1" />
                                    ) : (
                                      <Save className="h-3 w-3 mr-1" />
                                    )}
                                    Save
                                  </Button>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteTarget != null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title="Archive memo"
        description={`Archive memo M-${deleteTarget?.numeric_id ?? ''}? You can restore it later.`}
        confirmLabel="Archive"
        onConfirm={() => deleteTarget && archiveMutation.mutate(deleteTarget.id)}
      />
    </>
  )
}
