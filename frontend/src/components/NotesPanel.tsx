import { useState, useMemo, useCallback, useRef, useEffect, forwardRef, useImperativeHandle } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Search, Plus, Trash2, Link2, Link2Off, Paperclip, X } from 'lucide-react'
import { useDraggable } from '@dnd-kit/core'
import { toast } from 'sonner'
import { notesApi, type Note } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export interface NotesPanelHandle {
  focus: () => void
  focusLastItem: () => void
  focusNote: (noteId: number) => void
  createForExcerpt: (excerptId: number, segmentId: number) => void
}

interface NotesPanelProps {
  projectId: number
  conversationId: number
  selectedSegmentId: number | null
  onJumpToSegment: (segmentId: number) => void
  // Keyboard navigation props (Item 56, 57)
  isFocused?: boolean
  onFocusChange?: (focused: boolean) => void
  onNavigateToTranscript?: () => void  // Left arrow
  onNavigateToPrevPanel?: () => void   // Up from first note (to Codes)
  onNavigateToNextPanel?: () => void   // Down from last note (to Summary)
}

const NotesPanel = forwardRef<NotesPanelHandle, NotesPanelProps>(function NotesPanel({
  projectId,
  conversationId,
  selectedSegmentId,
  onJumpToSegment,
  isFocused = false,
  onFocusChange,
  onNavigateToTranscript,
  onNavigateToPrevPanel,
  onNavigateToNextPanel,
}, ref) {
  const queryClient = useQueryClient()
  const [searchQuery, setSearchQuery] = useState('')
  const [newNoteContent, setNewNoteContent] = useState('')
  const [associatingNoteId, setAssociatingNoteId] = useState<number | null>(null)
  const [pendingExcerptId, setPendingExcerptId] = useState<number | null>(null)
  const [pendingExcerptSegmentId, setPendingExcerptSegmentId] = useState<number | null>(null)

  // Keyboard navigation state (Item 56)
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [selectedNoteIndices, setSelectedNoteIndices] = useState<Set<number>>(new Set())
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const shiftAnchorRef = useRef<number | null>(null)
  const skipFocusResetRef = useRef(false) // Prevents onFocus from resetting after focusLastItem

  const { data: notesData, refetch: refetchNotes } = useQuery({
    queryKey: ['notes', conversationId],
    queryFn: () => notesApi.listForConversation(conversationId),
    enabled: !!conversationId,
  })

  const notes = useMemo(() => notesData?.notes ?? [], [notesData?.notes])

  const filteredNotes = useMemo(() => {
    if (!searchQuery) return notes
    const query = searchQuery.toLowerCase()
    return notes.filter(note => note.content.toLowerCase().includes(query))
  }, [notes, searchQuery])

  // Expose methods to parent
  useImperativeHandle(ref, () => ({
    focus: () => {
      containerRef.current?.focus()
    },
    focusLastItem: () => {
      if (filteredNotes.length > 0) {
        const lastIndex = filteredNotes.length - 1
        skipFocusResetRef.current = true
        setFocusedIndex(lastIndex)
        setSelectedNoteIndices(new Set([lastIndex]))
      }
      containerRef.current?.focus()
    },
    focusNote: (noteId: number) => {
      // Find the note in the filtered list
      const index = filteredNotes.findIndex(n => n.id === noteId)
      if (index >= 0) {
        skipFocusResetRef.current = true
        setFocusedIndex(index)
        setSelectedNoteIndices(new Set([index]))
        containerRef.current?.focus()
        // Scroll the note into view
        setTimeout(() => {
          const items = listRef.current?.querySelectorAll('[data-note-item]')
          items?.[index]?.scrollIntoView({ block: 'nearest' })
        }, 0)
      } else {
        // Note might be filtered out - clear filter and try again
        if (searchQuery) {
          setSearchQuery('')
          // After clearing, find and focus the note
          setTimeout(() => {
            const noteIndex = notes.findIndex(n => n.id === noteId)
            if (noteIndex >= 0) {
              skipFocusResetRef.current = true
              setFocusedIndex(noteIndex)
              setSelectedNoteIndices(new Set([noteIndex]))
              containerRef.current?.focus()
            }
          }, 0)
        }
      }
    },
    createForExcerpt: (excerptId: number, segmentId: number) => {
      setPendingExcerptId(excerptId)
      setPendingExcerptSegmentId(segmentId)
      inputRef.current?.focus()
    },
  }), [filteredNotes, notes, searchQuery])

  const createNoteMutation = useMutation({
    mutationFn: (data: { content: string; excerpt_id?: number; segment_id?: number }) =>
      notesApi.create(conversationId, { content: data.content, excerpt_id: data.excerpt_id, segment_id: data.segment_id }),
    onSuccess: (newNote) => {
      queryClient.invalidateQueries({ queryKey: ['segments'] })
      refetchNotes().then(() => {
        setNewNoteContent('')
        // Enter association mode and auto-focus the new note in the list
        setAssociatingNoteId(newNote.id)
        setTimeout(() => {
          // Use the latest notes from query cache
          const cached = queryClient.getQueryData<{ notes: Note[] }>(['notes', conversationId])
          const notesList = cached?.notes || []
          const index = notesList.findIndex(n => n.id === newNote.id)
          if (index >= 0) {
            skipFocusResetRef.current = true
            setFocusedIndex(index)
            setSelectedNoteIndices(new Set([index]))
            containerRef.current?.focus()
            setTimeout(() => {
              const items = listRef.current?.querySelectorAll('[data-note-item]')
              items?.[index]?.scrollIntoView({ block: 'nearest' })
            }, 0)
          }
        }, 100)
      })
    },
  })

  const updateNoteMutation = useMutation({
    mutationFn: ({ noteId, segmentId }: { noteId: number; segmentId: number | null }) =>
      notesApi.update(projectId, noteId, { segment_id: segmentId === null ? 0 : segmentId }),
    onSuccess: () => {
      refetchNotes()
      queryClient.invalidateQueries({ queryKey: ['segments', conversationId] })
    },
  })

  const archiveNoteMutation = useMutation({
    mutationFn: (noteId: number) => notesApi.archive(projectId, noteId),
    onSuccess: () => {
      refetchNotes()
      toast.success('Note archived')
    },
  })

  const handleCreateNote = useCallback(() => {
    if (newNoteContent.trim()) {
      const data: { content: string; excerpt_id?: number; segment_id?: number } = { content: newNoteContent.trim() }
      if (pendingExcerptId) {
        data.excerpt_id = pendingExcerptId
        if (pendingExcerptSegmentId) {
          data.segment_id = pendingExcerptSegmentId
        }
        setPendingExcerptId(null)
        setPendingExcerptSegmentId(null)
      }
      createNoteMutation.mutate(data)
    }
  }, [newNoteContent, pendingExcerptId, pendingExcerptSegmentId, createNoteMutation])

  // Handle association with selected segment
  const handleAssociate = useCallback((noteId: number) => {
    if (associatingNoteId === noteId && selectedSegmentId) {
      // Associate with selected segment
      updateNoteMutation.mutate({ noteId, segmentId: selectedSegmentId })
      setAssociatingNoteId(null)
    } else if (associatingNoteId === noteId) {
      // Cancel association mode
      setAssociatingNoteId(null)
    } else {
      // Enter association mode
      setAssociatingNoteId(noteId)
    }
  }, [associatingNoteId, selectedSegmentId, updateNoteMutation])

  const handleNoteClick = useCallback((note: Note) => {
    if (note.segment_id) {
      // Jump to the associated segment
      onJumpToSegment(note.segment_id)
    }
  }, [onJumpToSegment])

  const handleDisassociate = useCallback((noteId: number) => {
    updateNoteMutation.mutate({ noteId, segmentId: null })
  }, [updateNoteMutation])

  // Keyboard navigation (Item 56)
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isFocused) return

    if (e.target === e.currentTarget || !(e.target instanceof HTMLInputElement)) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (e.ctrlKey || e.metaKey) {
          // Ctrl+ArrowDown: Jump to last note
          const newIndex = filteredNotes.length - 1
          if (newIndex >= 0) {
            setFocusedIndex(newIndex)
            setSelectedNoteIndices(new Set([newIndex]))
            shiftAnchorRef.current = null
          }
        } else if (e.shiftKey) {
          // Shift+ArrowDown: Extend selection
          const newIndex = Math.min(focusedIndex + 1, filteredNotes.length - 1)
          if (shiftAnchorRef.current === null) {
            shiftAnchorRef.current = focusedIndex >= 0 ? focusedIndex : 0
          }
          setFocusedIndex(newIndex)
          const startIdx = Math.min(shiftAnchorRef.current, newIndex)
          const endIdx = Math.max(shiftAnchorRef.current, newIndex)
          const newSet = new Set<number>()
          for (let i = startIdx; i <= endIdx; i++) newSet.add(i)
          setSelectedNoteIndices(newSet)
        } else if (filteredNotes.length > 0 && focusedIndex >= filteredNotes.length - 1) {
          // At last note - navigate to next panel (Item 57)
          onNavigateToNextPanel?.()
        } else if (filteredNotes.length === 0) {
          // No notes - navigate to next panel
          onNavigateToNextPanel?.()
        } else {
          const newIndex = Math.min(focusedIndex + 1, filteredNotes.length - 1)
          setFocusedIndex(newIndex)
          setSelectedNoteIndices(new Set([newIndex]))
          shiftAnchorRef.current = null
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (e.ctrlKey || e.metaKey) {
          // Ctrl+ArrowUp: Jump to first note
          setFocusedIndex(0)
          setSelectedNoteIndices(new Set([0]))
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
          setSelectedNoteIndices(newSet)
        } else if (focusedIndex <= 0) {
          // At top of list - check if we should go to input or prev panel
          if (focusedIndex === 0) {
            setFocusedIndex(-1)
            setSelectedNoteIndices(new Set())
            shiftAnchorRef.current = null
            inputRef.current?.focus()
          } else {
            // Already at input level, go to prev panel (Item 57)
            onNavigateToPrevPanel?.()
          }
        } else {
          const newIndex = focusedIndex - 1
          setFocusedIndex(newIndex)
          setSelectedNoteIndices(new Set([newIndex]))
          shiftAnchorRef.current = null
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setFocusedIndex(-1)
        setSelectedNoteIndices(new Set())
        shiftAnchorRef.current = null
        // Navigate to transcript (Item 56)
        onNavigateToTranscript?.()
        containerRef.current?.blur()
      } else if ((e.key === ' ' || e.key === 'Enter') && focusedIndex >= 0 && focusedIndex < filteredNotes.length) {
        e.preventDefault()
        const note = filteredNotes[focusedIndex]
        if (associatingNoteId === note.id && selectedSegmentId) {
          // Complete association and return focus to input
          updateNoteMutation.mutate({ noteId: note.id, segmentId: selectedSegmentId })
          setAssociatingNoteId(null)
          setTimeout(() => inputRef.current?.focus(), 0)
        } else if (note.segment_id) {
          // Jump to segment
          onJumpToSegment(note.segment_id)
        } else {
          // Enter association mode
          setAssociatingNoteId(note.id)
        }
      } else if (e.key === 'Escape' && associatingNoteId !== null) {
        // Cancel association mode and return focus to input
        e.preventDefault()
        setAssociatingNoteId(null)
        setTimeout(() => inputRef.current?.focus(), 0)
      }
    }
  }, [isFocused, filteredNotes, focusedIndex, associatingNoteId, selectedSegmentId, updateNoteMutation, onJumpToSegment, onNavigateToTranscript, onNavigateToPrevPanel, onNavigateToNextPanel])

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.key === 'Tab' || e.key === 'Enter') && newNoteContent.trim()) {
      e.preventDefault()
      handleCreateNote()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (filteredNotes.length > 0) {
        setFocusedIndex(0)
        setSelectedNoteIndices(new Set([0]))
        containerRef.current?.focus()
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      // Go to prev panel (Codes)
      onNavigateToPrevPanel?.()
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      onNavigateToTranscript?.()
    }
  }, [newNoteContent, handleCreateNote, filteredNotes.length, onNavigateToPrevPanel, onNavigateToTranscript])

  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Shift') {
      shiftAnchorRef.current = null
    }
  }, [])

  // Scroll focused item into view (Item 55)
  useEffect(() => {
    if (focusedIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll('[data-note-item]')
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
        // Reset state when gaining focus, unless focusLastItem was just called
        if (skipFocusResetRef.current) {
          skipFocusResetRef.current = false
        } else {
          setFocusedIndex(-1)
          setSelectedNoteIndices(new Set())
          shiftAnchorRef.current = null
        }
      }}
      onBlur={(e) => {
        if (!containerRef.current?.contains(e.relatedTarget as Node)) {
          onFocusChange?.(false)
          setFocusedIndex(-1)
          setSelectedNoteIndices(new Set())
          shiftAnchorRef.current = null
        }
      }}
    >
      {/* Header with Search/Add */}
      <div className="p-3 border-b">
        <div className="relative flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-2.5 w-4 h-4 text-mm-text-faint" />
            <Input
              ref={inputRef}
              aria-label="Search or add note"
              placeholder="Search or add note..."
              value={newNoteContent || searchQuery}
              onChange={(e) => {
                if (e.target.value.length > 0 && searchQuery) {
                  setNewNoteContent(e.target.value)
                  setSearchQuery('')
                } else if (notes.some(n => n.content.toLowerCase().includes(e.target.value.toLowerCase()))) {
                  setSearchQuery(e.target.value)
                  setNewNoteContent('')
                } else {
                  setNewNoteContent(e.target.value)
                }
              }}
              onKeyDown={handleInputKeyDown}
              className="pl-8 h-9"
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={!newNoteContent.trim()}
            onClick={handleCreateNote}
            title="Add new note (Tab or Enter)"
          >
            <Plus className={cn("w-4 h-4", newNoteContent.trim() && "text-green-600")} />
          </Button>
        </div>
        <div aria-live="polite">
          {pendingExcerptId && (
            <div className="mt-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded p-2 flex items-center gap-2">
              <Paperclip className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
              <span className="text-xs text-amber-700 dark:text-amber-300 flex-1">Add a note to this excerpt?</span>
              <button
                onClick={() => { setPendingExcerptId(null); setPendingExcerptSegmentId(null) }}
                className="text-amber-500 hover:text-amber-700 dark:hover:text-amber-300 flex-shrink-0"
                aria-label="Dismiss excerpt prompt"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          {newNoteContent.trim() && (
            <p className="text-xs text-green-600 dark:text-green-400 mt-1"><kbd className="px-1 py-0.5 bg-mm-bg border border-mm-border-medium rounded text-[10px] font-mono">Tab</kbd>{' or '}<kbd className="px-1 py-0.5 bg-mm-bg border border-mm-border-medium rounded text-[10px] font-mono">Enter</kbd>{' to create note'}</p>
          )}
          {associatingNoteId && (
            <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-1 bg-emerald-50 dark:bg-emerald-950/30 p-1 rounded">
              {selectedSegmentId
                ? <><kbd className="px-1 py-0.5 bg-mm-bg border border-mm-border-medium rounded text-[10px] font-mono">Enter</kbd>{' to link to selected segment, or '}<kbd className="px-1 py-0.5 bg-mm-bg border border-mm-border-medium rounded text-[10px] font-mono">Esc</kbd>{' to cancel'}</>
                : <><kbd className="px-1 py-0.5 bg-mm-bg border border-mm-border-medium rounded text-[10px] font-mono">Space</kbd>{' to associate, or '}<kbd className="px-1 py-0.5 bg-mm-bg border border-mm-border-medium rounded text-[10px] font-mono">Esc</kbd>{' to cancel'}</>}
            </p>
          )}
        </div>
      </div>

      {/* Notes List */}
      <div ref={listRef} className="flex-1 overflow-y-auto">
        {filteredNotes.length === 0 ? (
          <div className="p-4 text-sm text-mm-text-muted text-center">
            {searchQuery ? 'No matching notes' : 'No notes yet. Add one above.'}
          </div>
        ) : (
          filteredNotes.map((note, index) => (
            <NoteItem
              key={note.id}
              note={note}
              isAssociating={associatingNoteId === note.id}
              isFocused={isFocused && focusedIndex === index}
              isSelected={isFocused && selectedNoteIndices.has(index)}
              onNoteClick={() => handleNoteClick(note)}
              onAssociate={() => handleAssociate(note.id)}
              onDisassociate={() => handleDisassociate(note.id)}
              onArchive={() => archiveNoteMutation.mutate(note.id)}
            />
          ))
        )}
      </div>

      {/* Shortcuts help */}
      <div className="p-3 border-t">
        <p className="text-xs text-mm-text-muted">
          Tab/Enter: create, Space: associate/jump, Shift+Arrow: multi-select
        </p>
      </div>
    </div>
  )
})

export default NotesPanel

function NoteItem({
  note,
  isAssociating,
  isFocused = false,
  isSelected = false,
  onNoteClick,
  onAssociate,
  onDisassociate,
  onArchive,
}: {
  note: Note
  isAssociating: boolean
  isFocused?: boolean
  isSelected?: boolean
  onNoteClick: () => void
  onAssociate: () => void
  onDisassociate: () => void
  onArchive: () => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `note-${note.id}`,
    data: { type: 'note' as const, note },
  })

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      data-note-item
      className={cn(
        'px-3 py-2 border-b border-mm-border-subtle hover:bg-mm-surface-hover group',
        isAssociating && 'bg-emerald-50 dark:bg-emerald-900/30 ring-1 ring-emerald-300 dark:ring-emerald-700',
        isSelected && 'bg-emerald-100 dark:bg-emerald-900/40',
        isFocused && 'ring-2 ring-inset ring-emerald-500 bg-emerald-50 dark:bg-emerald-900/30',
        note.segment_id && 'cursor-pointer',
        isDragging && 'opacity-40'
      )}
      onClick={note.segment_id ? onNoteClick : undefined}
    >
      <div className="flex items-start gap-2">
        {/* Amber count badge matching segment row */}
        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 text-[10px] font-medium flex-shrink-0">
          {note.sequence_number}
        </span>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-sm text-mm-text line-clamp-2">{note.content}</p>
          {note.excerpt_id && (
            <span className="text-xs text-amber-600 dark:text-amber-400 inline-flex items-center gap-1">
              <Paperclip className="w-3 h-3 inline" /> Excerpt note
            </span>
          )}
          {note.segment_id && !note.excerpt_id && (
            <span className="text-xs text-mm-text-faint">Linked to segment</span>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          {note.segment_id ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={(e) => {
                e.stopPropagation()
                onDisassociate()
              }}
              title="Unlink from segment"
            >
              <Link2Off className="w-3 h-3 text-mm-text-faint hover:text-mm-text-secondary" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className={cn("h-6 w-6", isAssociating && "bg-emerald-100 dark:bg-emerald-900/40")}
              onClick={(e) => {
                e.stopPropagation()
                onAssociate()
              }}
              title={isAssociating ? "Cancel association" : "Link to segment"}
            >
              <Link2 className={cn("w-3 h-3", isAssociating ? "text-emerald-600" : "text-mm-text-faint hover:text-mm-text-secondary")} />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={(e) => {
              e.stopPropagation()
              onArchive()
            }}
            title="Archive note"
          >
            <Trash2 className="w-3 h-3 text-mm-text-faint hover:text-red-500" />
          </Button>
        </div>
      </div>
    </div>
  )
}

