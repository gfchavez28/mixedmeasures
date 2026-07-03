import { useState, useMemo, useCallback, useRef, useEffect, forwardRef, useImperativeHandle } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Search, Plus, Trash2, FileText } from 'lucide-react'
import { memosApi, type Memo, type Code, type Conversation } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export interface MemoPanelHandle {
  focus: () => void
  focusLastItem: () => void
  focusMemo: (memoId: number) => void
}

interface MemoPanelProps {
  projectId: number
  conversationId?: number  // Deprecated — use entityId instead
  entityId?: number        // ID of the conversation or document
  entityType?: 'conversation' | 'document' | null  // null = no entity context (e.g. comment coding)
  codes?: Code[]  // For displaying code names on code-type memos
  conversations?: Conversation[]  // For displaying conversation names on conversation-type memos
  // Create memo for a specific code (passed from CodePanel)
  createForCode?: { id: number; name: string } | null
  onCreateForCodeHandled?: () => void  // Called when the create request has been handled
  // Keyboard navigation props
  isFocused?: boolean
  onFocusChange?: (focused: boolean) => void
  onNavigateToTranscript?: () => void  // Left arrow
  onNavigateToPrevPanel?: () => void   // Up from first memo
  onNavigateToNextPanel?: () => void   // Down from last memo
}

const MemoPanel = forwardRef<MemoPanelHandle, MemoPanelProps>(function MemoPanel({
  projectId,
  conversationId,
  entityId: entityIdProp,
  entityType: entityTypeProp = 'conversation',
  codes = [],
  conversations = [],
  createForCode,
  onCreateForCodeHandled,
  isFocused = false,
  onFocusChange,
  onNavigateToTranscript,
  onNavigateToPrevPanel,
  onNavigateToNextPanel,
}, ref) {
  // Resolve entity — prefer new entityId/entityType props, fall back to conversationId
  const entityType = entityTypeProp
  const entityId = entityIdProp ?? conversationId ?? 0
  const hasEntityContext = entityType != null && entityId > 0
  const entityLabel = entityType === 'document' ? 'Document' : 'Conversation'

  const queryClient = useQueryClient()
  const [searchQuery, setSearchQuery] = useState('')
  const [filterMode, setFilterMode] = useState<'conversation' | 'project' | 'codes' | 'all'>(hasEntityContext ? 'conversation' : 'all')
  const [editingMemoId, setEditingMemoId] = useState<number | null>(null)
  const [editContent, setEditContent] = useState('')

  // Inline input state (hybrid search/create like NotesPanel)
  const [inputValue, setInputValue] = useState('')

  // Code memo creation state (NewMemoForm is only used for code memos)
  const [isCreatingForCode, setIsCreatingForCode] = useState(false)
  const [newMemoContent, setNewMemoContent] = useState('')
  const [creatingForCode, setCreatingForCode] = useState<{ id: number; name: string } | null>(null)

  // Handle createForCode prop from parent (e.g., when clicking "Add Memo" on a code)
  /* eslint-disable react-hooks/set-state-in-effect -- sync local creation state from parent prop */
  useEffect(() => {
    if (createForCode) {
      setIsCreatingForCode(true)
      setNewMemoContent('')
      setCreatingForCode(createForCode)
      onCreateForCodeHandled?.()
    }
  }, [createForCode, onCreateForCodeHandled])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Keyboard navigation state
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [selectedMemoIndices, setSelectedMemoIndices] = useState<Set<number>>(new Set())
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const shiftAnchorRef = useRef<number | null>(null)
  const skipFocusResetRef = useRef(false)

  // Auto-save debounce
  const saveTimeoutRef = useRef<NodeJS.Timeout>(undefined)

  const { data: memosData } = useQuery({
    queryKey: ['memos', projectId, filterMode, filterMode === 'conversation' ? entityId : null],
    queryFn: () => {
      if (filterMode === 'conversation' && hasEntityContext) {
        return memosApi.list(projectId, entityType!, entityId)
      } else if (filterMode === 'project') {
        return memosApi.list(projectId, 'project', projectId)
      } else if (filterMode === 'codes') {
        // Fetch all memos and filter to code-type on client side
        return memosApi.list(projectId).then(data => ({
          ...data,
          memos: data.memos.filter(m => m.entity_type === 'code')
        }))
      } else {
        return memosApi.list(projectId)
      }
    },
    enabled: !!projectId,
  })

  const memos = useMemo(() => memosData?.memos ?? [], [memosData?.memos])

  const filteredMemos = useMemo(() => {
    if (!searchQuery) return memos
    const query = searchQuery.toLowerCase()
    return memos.filter(memo =>
      memo.content.toLowerCase().includes(query) ||
      (memo.title && memo.title.toLowerCase().includes(query))
    )
  }, [memos, searchQuery])

  // Determine if inline creation is allowed (not in codes filter mode)
  const canCreateInline = filterMode !== 'codes'

  // Expose methods to parent
  useImperativeHandle(ref, () => ({
    focus: () => {
      containerRef.current?.focus()
    },
    focusLastItem: () => {
      if (filteredMemos.length > 0) {
        const lastIndex = filteredMemos.length - 1
        skipFocusResetRef.current = true
        setFocusedIndex(lastIndex)
        setSelectedMemoIndices(new Set([lastIndex]))
      }
      containerRef.current?.focus()
    },
    focusMemo: (memoId: number) => {
      const index = filteredMemos.findIndex(m => m.id === memoId)
      if (index >= 0) {
        skipFocusResetRef.current = true
        setFocusedIndex(index)
        setSelectedMemoIndices(new Set([index]))
        containerRef.current?.focus()
        setTimeout(() => {
          const items = listRef.current?.querySelectorAll('[data-memo-item]')
          items?.[index]?.scrollIntoView({ block: 'nearest' })
        }, 0)
      }
    },
  }), [filteredMemos])

  const createMemoMutation = useMutation({
    mutationFn: ({ content, forCode }: { content: string; forCode?: { id: number; name: string } | null }) => {
      // If creating for a specific code, use that
      if (forCode) {
        return memosApi.create(projectId, {
          entity_type: 'code',
          entity_id: forCode.id,
          content: content.trim()
        })
      }
      // Inline creation: entity type based on current filter mode
      const createType = filterMode === 'project' ? 'project' : (entityType ?? 'project')
      const createId = filterMode === 'project' ? projectId : entityId
      return memosApi.create(projectId, {
        entity_type: createType,
        entity_id: createId,
        content: content.trim()
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memos', projectId] })
      // Reset inline input
      setInputValue('')
      setSearchQuery('')
      // Reset code memo form
      setIsCreatingForCode(false)
      setNewMemoContent('')
      setCreatingForCode(null)
    },
  })

  // Handle inline creation (from input)
  const handleInlineCreate = useCallback(() => {
    const trimmed = inputValue.trim()
    if (trimmed && canCreateInline) {
      createMemoMutation.mutate({ content: trimmed })
    }
  }, [inputValue, canCreateInline, createMemoMutation])

  // Handle saving code memo from NewMemoForm
  const handleSaveCodeMemo = useCallback(() => {
    const trimmed = newMemoContent.trim()
    if (trimmed && creatingForCode) {
      createMemoMutation.mutate({ content: trimmed, forCode: creatingForCode })
    } else {
      setIsCreatingForCode(false)
      setNewMemoContent('')
      setCreatingForCode(null)
    }
  }, [newMemoContent, creatingForCode, createMemoMutation])

  // Handle cancelling code memo creation
  const handleCancelCodeMemo = useCallback(() => {
    setIsCreatingForCode(false)
    setCreatingForCode(null)
    setNewMemoContent('')
  }, [])

  // Handle input change — hybrid search/create like NotesPanel
  const handleInputChange = useCallback((value: string) => {
    setInputValue(value)
    setSearchQuery(value)
  }, [])

  // Input keyboard handler
  const handleInputKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.key === 'Tab' || e.key === 'Enter') && inputValue.trim() && canCreateInline) {
      e.preventDefault()
      handleInlineCreate()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setInputValue('')
      setSearchQuery('')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (filteredMemos.length > 0) {
        setFocusedIndex(0)
        setSelectedMemoIndices(new Set([0]))
        containerRef.current?.focus()
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      onNavigateToPrevPanel?.()
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      onNavigateToTranscript?.()
    }
  }, [inputValue, canCreateInline, handleInlineCreate, filteredMemos.length, onNavigateToPrevPanel, onNavigateToTranscript])

  const updateMemoMutation = useMutation({
    mutationFn: ({ memoId, content }: { memoId: number; content: string }) =>
      memosApi.update(projectId, memoId, { content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memos', projectId] })
    },
  })

  const archiveMemoMutation = useMutation({
    mutationFn: (memoId: number) => memosApi.archive(projectId, memoId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memos', projectId] })
    },
  })

  const handleSaveEdit = useCallback((memoId: number, content: string) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }
    saveTimeoutRef.current = setTimeout(() => {
      updateMemoMutation.mutate({ memoId, content })
    }, 2000)
  }, [updateMemoMutation])

  const handleFinishEdit = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }
    if (editingMemoId !== null) {
      updateMemoMutation.mutate({ memoId: editingMemoId, content: editContent })
    }
    setEditingMemoId(null)
    setEditContent('')
  }, [editingMemoId, editContent, updateMemoMutation])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [])

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isFocused) return

    // If editing, let the textarea handle keys
    if (editingMemoId !== null) {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleFinishEdit()
      }
      return
    }

    if (e.target === e.currentTarget || !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (e.ctrlKey || e.metaKey) {
          // Ctrl+ArrowDown: Jump to last memo
          const newIndex = filteredMemos.length - 1
          if (newIndex >= 0) {
            setFocusedIndex(newIndex)
            setSelectedMemoIndices(new Set([newIndex]))
            shiftAnchorRef.current = null
          }
        } else if (e.shiftKey) {
          // Shift+ArrowDown: Extend selection
          const newIndex = Math.min(focusedIndex + 1, filteredMemos.length - 1)
          if (shiftAnchorRef.current === null) {
            shiftAnchorRef.current = focusedIndex >= 0 ? focusedIndex : 0
          }
          setFocusedIndex(newIndex)
          const startIdx = Math.min(shiftAnchorRef.current, newIndex)
          const endIdx = Math.max(shiftAnchorRef.current, newIndex)
          const newSet = new Set<number>()
          for (let i = startIdx; i <= endIdx; i++) newSet.add(i)
          setSelectedMemoIndices(newSet)
        } else if (filteredMemos.length > 0 && focusedIndex >= filteredMemos.length - 1) {
          // At last memo - navigate to next panel
          onNavigateToNextPanel?.()
        } else if (filteredMemos.length === 0) {
          onNavigateToNextPanel?.()
        } else {
          const newIndex = Math.min(focusedIndex + 1, filteredMemos.length - 1)
          setFocusedIndex(newIndex)
          setSelectedMemoIndices(new Set([newIndex]))
          shiftAnchorRef.current = null
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (e.ctrlKey || e.metaKey) {
          // Ctrl+ArrowUp: Jump to first memo
          setFocusedIndex(0)
          setSelectedMemoIndices(new Set([0]))
          shiftAnchorRef.current = null
        } else if (e.shiftKey && focusedIndex > 0) {
          // Shift+ArrowUp: Extend selection
          const newIndex = focusedIndex - 1
          if (shiftAnchorRef.current === null) {
            shiftAnchorRef.current = focusedIndex
          }
          setFocusedIndex(newIndex)
          const startIdx = Math.min(shiftAnchorRef.current, newIndex)
          const endIdx = Math.max(shiftAnchorRef.current, newIndex)
          const newSet = new Set<number>()
          for (let i = startIdx; i <= endIdx; i++) newSet.add(i)
          setSelectedMemoIndices(newSet)
        } else if (focusedIndex <= 0) {
          if (focusedIndex === 0) {
            setFocusedIndex(-1)
            setSelectedMemoIndices(new Set())
            shiftAnchorRef.current = null
            inputRef.current?.focus()
          } else {
            onNavigateToPrevPanel?.()
          }
        } else {
          const newIndex = focusedIndex - 1
          setFocusedIndex(newIndex)
          setSelectedMemoIndices(new Set([newIndex]))
          shiftAnchorRef.current = null
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setFocusedIndex(-1)
        setSelectedMemoIndices(new Set())
        shiftAnchorRef.current = null
        onNavigateToTranscript?.()
        containerRef.current?.blur()
      } else if ((e.key === ' ' || e.key === 'Enter') && focusedIndex >= 0 && focusedIndex < filteredMemos.length) {
        e.preventDefault()
        const memo = filteredMemos[focusedIndex]
        setEditingMemoId(memo.id)
        setEditContent(memo.content)
      }
    }
  }, [isFocused, filteredMemos, focusedIndex, editingMemoId, handleFinishEdit, onNavigateToTranscript, onNavigateToPrevPanel, onNavigateToNextPanel])

  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Shift') {
      shiftAnchorRef.current = null
    }
  }, [])

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll('[data-memo-item]')
      items[focusedIndex]?.scrollIntoView({ block: 'nearest' })
    }
  }, [focusedIndex])

  return (
    <div
      ref={containerRef}
      className={cn(
        "h-full flex flex-col outline-none",
        isFocused && "ring-2 ring-inset ring-emerald-500"
      )}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onFocus={() => {
        onFocusChange?.(true)
        if (skipFocusResetRef.current) {
          skipFocusResetRef.current = false
        } else {
          setFocusedIndex(-1)
          setSelectedMemoIndices(new Set())
          shiftAnchorRef.current = null
        }
      }}
      onBlur={(e) => {
        if (!containerRef.current?.contains(e.relatedTarget as Node)) {
          onFocusChange?.(false)
          setFocusedIndex(-1)
          setSelectedMemoIndices(new Set())
          shiftAnchorRef.current = null
        }
      }}
    >
      {/* Header with Filter and Add */}
      <div className="p-3 border-b space-y-2">
        {/* Filter toggle */}
        <div className="flex gap-1 flex-wrap">
          {hasEntityContext && (
            <Button
              size="sm"
              variant={filterMode === 'conversation' ? 'default' : 'ghost'}
              className="text-xs h-7 px-2"
              onClick={() => setFilterMode('conversation')}
            >
              {entityLabel}
            </Button>
          )}
          <Button
            size="sm"
            variant={filterMode === 'project' ? 'default' : 'ghost'}
            className="text-xs h-7 px-2"
            onClick={() => setFilterMode('project')}
          >
            Project
          </Button>
          <Button
            size="sm"
            variant={filterMode === 'codes' ? 'default' : 'ghost'}
            className="text-xs h-7 px-2"
            onClick={() => setFilterMode('codes')}
          >
            Codes
          </Button>
          <Button
            size="sm"
            variant={filterMode === 'all' ? 'default' : 'ghost'}
            className="text-xs h-7 px-2"
            onClick={() => setFilterMode('all')}
          >
            All
          </Button>
        </div>

        {/* Hybrid Search/Add input */}
        <div className="relative flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-2.5 w-4 h-4 text-mm-text-faint" />
            <Input
              ref={inputRef}
              placeholder={canCreateInline ? "Search or add memo..." : "Search memos..."}
              value={inputValue}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleInputKeyDown}
              className="pl-8 h-9"
            />
          </div>
          {canCreateInline && (
            <Button
              size="sm"
              variant="ghost"
              disabled={!inputValue.trim()}
              onClick={handleInlineCreate}
              title="Add new memo (Tab or Enter)"
            >
              <Plus className={cn("w-4 h-4", inputValue.trim() && "text-green-600")} />
            </Button>
          )}
        </div>
        {inputValue.trim() && canCreateInline && (
          <p className="text-xs text-green-600"><kbd className="px-1 py-0.5 bg-mm-bg border border-mm-border-medium rounded text-[10px] font-mono">Tab</kbd>{' or '}<kbd className="px-1 py-0.5 bg-mm-bg border border-mm-border-medium rounded text-[10px] font-mono">Enter</kbd>{' to create memo'}</p>
        )}
        {filterMode === 'codes' && (
          <p className="text-xs text-mm-text-muted">Add code memos from the CODES panel</p>
        )}
      </div>

      {/* Memos List */}
      <div ref={listRef} className="flex-1 overflow-y-auto">
        {/* Code Memo Form (only for code memos from CodePanel) */}
        {isCreatingForCode && creatingForCode && (
          <NewMemoForm
            content={newMemoContent}
            onChange={setNewMemoContent}
            onSave={handleSaveCodeMemo}
            onCancel={handleCancelCodeMemo}
            isSaving={createMemoMutation.isPending}
            codeName={creatingForCode.name}
          />
        )}

        {filteredMemos.length === 0 && !isCreatingForCode ? (
          <div className="p-4 text-sm text-mm-text-muted text-center">
            {searchQuery ? 'No matching memos' : 'No memos yet. Add one above.'}
          </div>
        ) : filteredMemos.length > 0 && (
          filteredMemos.map((memo, index) => (
            <MemoItem
              key={memo.id}
              memo={memo}
              codes={codes}
              conversations={conversations}
              isEditing={editingMemoId === memo.id}
              editContent={editContent}
              onEditContentChange={(content) => {
                setEditContent(content)
                handleSaveEdit(memo.id, content)
              }}
              onStartEdit={() => {
                setEditingMemoId(memo.id)
                setEditContent(memo.content)
              }}
              onFinishEdit={handleFinishEdit}
              isFocused={isFocused && focusedIndex === index}
              isSelected={isFocused && selectedMemoIndices.has(index)}
              onArchive={() => archiveMemoMutation.mutate(memo.id)}
            />
          ))
        )}
      </div>

      {/* Shortcuts help */}
      <div className="p-3 border-t">
        <p className="text-xs text-mm-text-muted">
          Tab/Enter: create, Enter: edit, Shift+Arrow: multi-select
        </p>
      </div>
    </div>
  )
})

export default MemoPanel

function MemoItem({
  memo,
  codes,
  conversations,
  isEditing,
  editContent,
  onEditContentChange,
  onStartEdit,
  onFinishEdit,
  isFocused = false,
  isSelected = false,
  onArchive,
}: {
  memo: Memo
  codes: Code[]
  conversations: Conversation[]
  isEditing: boolean
  editContent: string
  onEditContentChange: (content: string) => void
  onStartEdit: () => void
  onFinishEdit: () => void
  isFocused?: boolean
  isSelected?: boolean
  onArchive: () => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus()
      // Move cursor to end
      textareaRef.current.selectionStart = textareaRef.current.value.length
    }
  }, [isEditing])

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  return (
    <div
      data-memo-item
      className={cn(
        'px-3 py-2 border-b border-mm-border-subtle hover:bg-mm-surface-hover group',
        isSelected && 'bg-emerald-100 dark:bg-emerald-900/40',
        isFocused && 'ring-2 ring-inset ring-emerald-500 bg-emerald-50 dark:bg-emerald-900/30',
        !isEditing && 'cursor-pointer'
      )}
      onClick={!isEditing ? onStartEdit : undefined}
    >
      <div className="flex items-start gap-2">
        {/* Icon */}
        <FileText className="w-4 h-4 text-mm-text-faint flex-shrink-0 mt-0.5" />

        {/* Content */}
        <div className="flex-1 min-w-0">
          {isEditing ? (
            <textarea
              ref={textareaRef}
              value={editContent}
              aria-label="Memo content"
              onChange={(e) => onEditContentChange(e.target.value)}
              onBlur={onFinishEdit}
              className="w-full min-h-[60px] text-sm text-mm-text border rounded p-2 focus:outline-none focus:ring-1 focus:ring-emerald-500 resize-none"
              placeholder="Write your memo..."
            />
          ) : (
            <>
              <p className="text-sm text-mm-text line-clamp-2">
                {memo.content || <span className="text-mm-text-faint italic">Empty memo</span>}
              </p>
              <span className="text-xs text-mm-text-faint">
                {formatDate(memo.updated_at)}
                {memo.entity_type === 'project' && (
                  <span className="ml-2 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 px-1 rounded">project</span>
                )}
                {memo.entity_type === 'conversation' && (
                  <span className="ml-2 bg-mm-blue/12 text-mm-blue-text px-1 rounded">
                    {conversations.find(c => c.id === memo.entity_id)?.name || 'conversation'}
                  </span>
                )}
                {memo.entity_type === 'code' && (
                  <span className="ml-2 bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300 px-1 rounded">
                    {codes.find(c => c.id === memo.entity_id)?.name || `code #${memo.entity_id}`}
                  </span>
                )}
              </span>
            </>
          )}
        </div>

        {/* Actions */}
        {!isEditing && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={(e) => {
                e.stopPropagation()
                onArchive()
              }}
              title="Delete memo"
            >
              <Trash2 className="w-3 h-3 text-mm-text-faint hover:text-red-500" />
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

function NewMemoForm({
  content,
  onChange,
  onSave,
  onCancel,
  isSaving,
  codeName,
}: {
  content: string
  onChange: (content: string) => void
  onSave: () => void
  onCancel: () => void
  isSaving: boolean
  codeName: string
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const hasContent = content.trim().length > 0

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      if (hasContent) {
        onSave()
      }
    }
  }

  return (
    <div className="px-3 py-3 border-b-2 border-emerald-200 bg-emerald-50 dark:bg-emerald-950/30">
      <div className="flex items-start gap-2">
        <FileText className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <div className="text-xs text-emerald-600 mb-1 font-medium">
            New memo for code: {codeName}
          </div>
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full min-h-[80px] text-sm text-mm-text border rounded p-2 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-none"
            placeholder="Write your memo... (Ctrl+Enter to save)"
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-xs text-mm-text-muted">
              {hasContent ? '' : 'Content required to save'}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={onCancel}
                disabled={isSaving}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={onSave}
                disabled={!hasContent || isSaving}
              >
                {isSaving ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
