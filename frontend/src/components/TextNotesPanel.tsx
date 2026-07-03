import { useState, useMemo, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, X, Check, PenLine } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { textCodingApi } from '@/lib/api'

/** Note shape returned by the text-coding notes endpoints */
interface TextCodingNote {
  id: number
  conversation_id: number | null
  segment_id: number | null
  dataset_value_id: number | null
  excerpt_id: number | null
  content: string
  sequence_number: number
  is_archived: boolean
  created_at: string
  updated_at: string
}

interface TextNotesPanelProps {
  projectId: number
  focalColumnIds: number[]
  selectedValueId: number | null
  onDeleteNote?: (noteId: number, noteContent: string, datasetValueId: number) => void
}

export default function TextNotesPanel({ projectId, focalColumnIds, selectedValueId, onDeleteNote }: TextNotesPanelProps) {
  const queryClient = useQueryClient()
  const [newContent, setNewContent] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editContent, setEditContent] = useState('')

  const columnIdsStr = focalColumnIds.join(',')

  // Broad query: all notes for focal columns
  const { data: allNotes = [] } = useQuery<TextCodingNote[]>({
    queryKey: ['text-notes', projectId, columnIdsStr],
    queryFn: () => textCodingApi.listNotes(projectId, { column_ids: columnIdsStr }),
    enabled: focalColumnIds.length > 0,
  })

  // Split notes: selected comment's notes first, then rest
  const { selectedNotes, otherNotes } = useMemo(() => {
    if (!selectedValueId) return { selectedNotes: [] as TextCodingNote[], otherNotes: allNotes }
    const selected = allNotes.filter(n => n.dataset_value_id === selectedValueId)
    const other = allNotes.filter(n => n.dataset_value_id !== selectedValueId)
    return { selectedNotes: selected, otherNotes: other }
  }, [allNotes, selectedValueId])

  const invalidateNotes = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['text-notes', projectId, columnIdsStr] })
    queryClient.invalidateQueries({ queryKey: ['text-data', projectId] })
  }, [queryClient, projectId, columnIdsStr])

  const createMutation = useMutation({
    mutationFn: (content: string) =>
      textCodingApi.createNote(projectId, { dataset_value_id: selectedValueId!, content }),
    onSuccess: () => {
      invalidateNotes()
      setNewContent('')
    },
    onError: () => { toast.error('Failed to create note') },
  })

  const updateMutation = useMutation({
    mutationFn: ({ noteId, content }: { noteId: number; content: string }) =>
      textCodingApi.updateNote(projectId, noteId, { content }),
    onSuccess: () => {
      invalidateNotes()
      setEditingId(null)
    },
    onError: () => { toast.error('Failed to update note') },
  })

  const deleteMutation = useMutation({
    mutationFn: (noteId: number) => textCodingApi.deleteNote(projectId, noteId),
    onSuccess: invalidateNotes,
    onError: () => { toast.error('Failed to delete note') },
  })

  const handleCreate = () => {
    if (!newContent.trim() || !selectedValueId) return
    createMutation.mutate(newContent.trim())
  }

  const handleDelete = useCallback((note: TextCodingNote) => {
    if (onDeleteNote && note.dataset_value_id) {
      onDeleteNote(note.id, note.content, note.dataset_value_id)
    } else {
      // Fallback: delete with undo toast
      deleteMutation.mutate(note.id)
      toast('Note deleted', {
        action: {
          label: 'Undo',
          onClick: () => {
            if (note.dataset_value_id) {
              textCodingApi.createNote(projectId, {
                dataset_value_id: note.dataset_value_id,
                content: note.content,
              }).then(() => invalidateNotes())
            }
          },
        },
      })
    }
  }, [onDeleteNote, deleteMutation, projectId, invalidateNotes])

  const renderNote = (note: TextCodingNote, highlight: boolean) => (
    <div key={note.id} className={`px-2 py-1.5 text-sm group ${highlight ? 'bg-mm-blue/10 rounded' : ''}`}>
      {editingId === note.id ? (
        <div className="flex flex-col gap-1">
          <textarea
            aria-label="Note content"
            className="w-full text-sm border border-mm-border-subtle bg-mm-surface text-mm-text rounded-md p-1.5 min-h-[60px] resize-none focus:outline-none focus:ring-2 focus:ring-ring"
            value={editContent}
            onChange={e => setEditContent(e.target.value)}
            autoFocus
          />
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-xs"
              onClick={() => updateMutation.mutate({ noteId: note.id, content: editContent })}
            >
              <Check className="w-3 h-3 mr-1" />
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-xs"
              onClick={() => setEditingId(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-1">
          <p
            className="flex-1 text-xs cursor-pointer hover:bg-mm-surface-hover rounded p-1"
            onClick={() => { setEditingId(note.id); setEditContent(note.content) }}
          >
            {note.content}
          </p>
          <button
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 shrink-0 text-mm-text-faint hover:text-red-500 transition-opacity"
            onClick={() => handleDelete(note)}
            aria-label="Delete note"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}
    </div>
  )

  return (
    <div className="flex flex-col h-full" role="region" aria-label="Notes panel">

      {/* Add note input — above list, matching code panel layout */}
      <div className="px-2 py-1.5">
        {selectedValueId ? (
          <div className="flex gap-1">
            <div className="relative flex-1">
              <PenLine className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder="Add a note..."
                value={newContent}
                onChange={e => setNewContent(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleCreate() } }}
                className="h-7 pl-7 text-xs"
                aria-label="New note content"
              />
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={handleCreate}
              disabled={!newContent.trim()}
              aria-label="Add note"
            >
              <Plus className="w-3.5 h-3.5" />
            </Button>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground text-center py-1">Select a text to add notes</p>
        )}
      </div>

      {/* Note list */}
      <div className="flex-1 overflow-y-auto max-h-[30vh] px-2 py-1 border-t border-mm-border-subtle">
        {/* Selected comment's notes highlighted at top */}
        {selectedNotes.length > 0 && (
          <>
            {selectedNotes.map(note => renderNote(note, true))}
            {otherNotes.length > 0 && (
              <div className="border-t border-mm-border-subtle my-1" />
            )}
          </>
        )}

        {/* Other notes */}
        {otherNotes.map(note => renderNote(note, false))}

        {allNotes.length === 0 && (
          <div className="px-2 py-3 text-xs text-muted-foreground text-center">
            No notes yet
          </div>
        )}
      </div>
    </div>
  )
}
