import { useState, useMemo, useCallback, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown, ChevronRight, ArrowRight, Trash2, LoaderCircle, Save,
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
import {
  scratchpadApi,
  codesApi,
  conversationsApi,
  materialsApi,
  type ScratchpadEntry,
} from '@/lib/api'
import { formatDate, ENTITY_TYPE_LABELS } from '@/lib/memo-constants'
import { toast } from 'sonner'

const CREATABLE_ENTITY_TYPES: { value: string; label: string }[] = [
  { value: 'project', label: 'Project' },
  { value: 'conversation', label: 'Conversation' },
  { value: 'code', label: 'Code' },
  { value: 'analysis', label: 'Analysis' },
]

interface ScratchpadSectionProps {
  projectId: number
  search?: string
  onExpandedChange?: (expanded: boolean) => void
}

export default function ScratchpadSection({ projectId, search, onExpandedChange }: ScratchpadSectionProps) {
  const queryClient = useQueryClient()

  const { data: scratchpadData } = useQuery({
    queryKey: ['scratchpad', projectId, false],
    queryFn: () => scratchpadApi.list(projectId, false),
  })

  const allEntries = useMemo(() => scratchpadData?.entries ?? [], [scratchpadData?.entries])
  const count = allEntries.length

  const [isExpanded, setIsExpanded] = useState(false)
  const expanded = isExpanded

  // Notify parent of expanded state changes
  useEffect(() => {
    onExpandedChange?.(expanded)
  }, [expanded, onExpandedChange])

  // Client-side search filter when expanded
  const entries = useMemo(() => {
    if (!expanded || !search?.trim()) return allEntries
    const q = search.trim().toLowerCase()
    return allEntries.filter(e => e.content.toLowerCase().includes(q))
  }, [allEntries, expanded, search])

  const [editingId, setEditingId] = useState<number | null>(null)
  const [editContent, setEditContent] = useState('')
  const [convertingId, setConvertingId] = useState<number | null>(null)
  const [convertEntityType, setConvertEntityType] = useState('project')
  const [convertEntityId, setConvertEntityId] = useState<number | null>(null)

  // Data for entity picker
  const { data: codesData } = useQuery({
    queryKey: ['codes', projectId],
    queryFn: () => codesApi.list(projectId),
    enabled: convertingId != null,
  })
  const { data: conversationsData } = useQuery({
    queryKey: ['conversations', projectId],
    queryFn: () => conversationsApi.list(projectId),
    enabled: convertingId != null,
  })
  const { data: collectionsData } = useQuery({
    queryKey: ['material-collections', projectId],
    queryFn: () => materialsApi.list(projectId),
    enabled: convertingId != null,
  })
  const defaultCollectionId = collectionsData?.collections?.[0]?.id ?? null
  const { data: collectionDetail } = useQuery({
    queryKey: ['material-collection-detail', projectId, defaultCollectionId],
    queryFn: () => materialsApi.get(projectId, defaultCollectionId!),
    enabled: !!defaultCollectionId && convertingId != null,
  })

  const entityOptions = useMemo(() => {
    switch (convertEntityType) {
      case 'project':
        return []
      case 'conversation':
        return (conversationsData?.conversations ?? []).map(c => ({ id: c.id, label: c.name }))
      case 'code':
        return (codesData?.codes ?? []).map(c => ({ id: c.id, label: c.name }))
      case 'analysis':
        return (collectionDetail?.materials ?? []).map((a: { id: number; auto_name: string; custom_name: string | null }) => ({ id: a.id, label: a.custom_name || a.auto_name }))
      default:
        return []
    }
  }, [convertEntityType, conversationsData, codesData, collectionDetail])

  // Mutations
  const convertMutation = useMutation({
    mutationFn: ({ entryId, entityType, entityId }: { entryId: number; entityType: string; entityId: number }) =>
      scratchpadApi.convert(projectId, entryId, {
        target_type: 'memo',
        entity_type: entityType,
        entity_id: entityId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scratchpad', projectId] })
      queryClient.invalidateQueries({ queryKey: ['memos', projectId] })
      setConvertingId(null)
      toast.success('Converted to memo')
    },
    onError: () => toast.error('Failed to convert'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ entryId, content }: { entryId: number; content: string }) =>
      scratchpadApi.update(projectId, entryId, { content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scratchpad', projectId] })
      setEditingId(null)
    },
    onError: () => toast.error('Failed to update'),
  })

  const deleteMutation = useMutation({
    mutationFn: (entryId: number) => scratchpadApi.delete(projectId, entryId),
    onSuccess: (_data, entryId) => {
      queryClient.invalidateQueries({ queryKey: ['scratchpad', projectId] })
      toast('Entry discarded')
      if (editingId === entryId) setEditingId(null)
      if (convertingId === entryId) setConvertingId(null)
    },
    onError: () => toast.error('Failed to discard'),
  })

  const handleStartEdit = useCallback((entry: ScratchpadEntry) => {
    setEditingId(entry.id)
    setEditContent(entry.content)
    setConvertingId(null)
  }, [])

  const handleSaveEdit = useCallback((entryId: number) => {
    if (!editContent.trim()) return
    updateMutation.mutate({ entryId, content: editContent.trim() })
  }, [editContent, updateMutation])

  const handleStartConvert = useCallback((entryId: number) => {
    setConvertingId(entryId)
    setConvertEntityType('project')
    setConvertEntityId(null)
    setEditingId(null)
  }, [])

  const handleConvert = useCallback((entryId: number) => {
    const entityId = convertEntityType === 'project' ? projectId : convertEntityId
    if (entityId == null) return
    convertMutation.mutate({ entryId, entityType: convertEntityType, entityId })
  }, [convertEntityType, convertEntityId, projectId, convertMutation])

  if (count === 0) {
    // Neutral persistent header when empty — blends with background
    return (
      <div className="border-b border-mm-border-subtle bg-stone-50 dark:bg-mm-surface flex-shrink-0">
        <div className="flex items-center gap-2 px-4 py-2">
          <span className="text-xs font-semibold text-stone-400 dark:text-stone-500">
            Scratchpad
          </span>
          <span className="text-[10px] text-stone-400 dark:text-stone-500 italic">
            Use Jot to capture thoughts
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="border-b border-mm-border-subtle bg-stone-50 dark:bg-mm-surface flex-shrink-0">
      {/* Scratchpad header */}
      <button
        onClick={() => setIsExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2 text-left transition-colors bg-amber-700 hover:bg-amber-800 dark:bg-amber-800/80 dark:hover:bg-amber-900"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-white/80 flex-shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-white/80 flex-shrink-0" />
        )}
        <span className="text-xs font-semibold text-white dark:text-amber-200">
          Scratchpad
        </span>
        <span className="text-[10px] text-white dark:text-amber-200 bg-white/20 dark:bg-amber-700/60 rounded-full px-2 py-0.5">
          {count}
        </span>
      </button>

      {/* Entries — white cards on neutral background */}
      {expanded && (
        <ul className="py-1.5" role="list" aria-label="Scratchpad entries">
          {entries.map(entry => {
            const isEditing = editingId === entry.id
            const isConverting = convertingId === entry.id

            return (
              <li
                key={entry.id}
                className="mx-3 my-1.5 rounded-md border border-mm-border-subtle border-l-2 border-l-amber-400 dark:border-l-amber-500 bg-white dark:bg-mm-bg p-3 group"
              >
                {/* Meta row — always first, matching Memos/Notes */}
                <div className="flex items-center gap-2 mb-1.5">
                  {entry.context_hint && (
                    <span className="text-[10px] text-amber-600 dark:text-amber-400 bg-amber-100/70 dark:bg-amber-900/20 rounded px-1.5 py-0.5 truncate max-w-[150px]">
                      {entry.context_hint}
                    </span>
                  )}
                  <span className="text-[10px] font-mono text-amber-600 dark:text-amber-400">
                    J-{entry.numeric_id}
                  </span>
                  <span className="text-[10px] text-mm-text-muted ml-auto flex-shrink-0">
                    {formatDate(entry.created_at)}
                  </span>
                </div>

                {/* Content */}
                {isEditing ? (
                  <div className="space-y-1.5">
                    <Textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      className="text-xs min-h-[60px] resize-none"
                      rows={3}
                      autoFocus
                    />
                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-[11px]"
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        className="h-6 text-[11px]"
                        disabled={!editContent.trim() || editContent === entry.content || updateMutation.isPending}
                        onClick={() => handleSaveEdit(entry.id)}
                      >
                        {updateMutation.isPending ? <LoaderCircle className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
                        Save
                      </Button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="w-full text-left"
                    onClick={() => handleStartEdit(entry)}
                    title="Click to edit"
                  >
                    <p className="text-xs text-mm-text line-clamp-2 whitespace-pre-wrap">
                      {entry.content}
                    </p>
                  </button>
                )}

                {/* Actions */}
                {!isEditing && (
                  <div className="flex items-center gap-1 mt-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-[11px] text-mm-text-muted hover:text-mm-text px-1.5"
                      onClick={(e) => { e.stopPropagation(); handleStartConvert(entry.id) }}
                    >
                      <ArrowRight className="h-3 w-3 mr-0.5" />
                      Convert to Memo...
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-[11px] text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20 px-1.5 ml-auto"
                      onClick={(e) => { e.stopPropagation(); deleteMutation.mutate(entry.id) }}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="h-3 w-3 mr-0.5" />
                      Discard
                    </Button>
                  </div>
                )}

                {/* Convert form (entity picker) */}
                {isConverting && (
                  <div className="mt-2 p-2 rounded border border-mm-border-subtle bg-mm-surface space-y-1.5">
                    <Select value={convertEntityType} onValueChange={(v) => { setConvertEntityType(v); setConvertEntityId(null) }}>
                      <SelectTrigger className="h-7 text-xs">
                        <SelectValue placeholder="Type" />
                      </SelectTrigger>
                      <SelectContent>
                        {CREATABLE_ENTITY_TYPES.map(t => (
                          <SelectItem key={t.value} value={t.value} className="text-xs">
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {convertEntityType !== 'project' && entityOptions.length > 0 && (
                      <Select
                        value={convertEntityId != null ? String(convertEntityId) : ''}
                        onValueChange={(v) => setConvertEntityId(Number(v))}
                      >
                        <SelectTrigger className="h-7 text-xs">
                          <SelectValue placeholder={`Select ${ENTITY_TYPE_LABELS[convertEntityType]?.toLowerCase() ?? 'entity'}...`} />
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

                    {convertEntityType !== 'project' && entityOptions.length === 0 && (
                      <p className="text-[10px] text-mm-text-muted italic px-1">
                        No {ENTITY_TYPE_LABELS[convertEntityType]?.toLowerCase() ?? 'entities'} available
                      </p>
                    )}

                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-[11px]"
                        onClick={() => setConvertingId(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        className="h-6 text-[11px]"
                        disabled={
                          (convertEntityType !== 'project' && convertEntityId == null) ||
                          convertMutation.isPending
                        }
                        onClick={() => handleConvert(entry.id)}
                      >
                        {convertMutation.isPending ? <LoaderCircle className="h-3 w-3 animate-spin mr-1" /> : null}
                        Convert
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            )
          })}
          {expanded && search?.trim() && entries.length === 0 && (
            <li className="mx-3 my-1.5 text-xs text-mm-text-muted italic text-center py-3">
              No scratchpad entries match "{search.trim()}"
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
