import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronRight, ChevronDown, ExternalLink, FileText, MessageSquare,
  LoaderCircle, TableProperties
} from 'lucide-react'
import { allNotesApi } from '@/lib/api'
import {
  formatDate,
  ENTITY_TYPE_COLORS,
} from '@/lib/memo-constants'
import { useTheme } from '@/lib/theme-context'
import { getUnfocusedStyle } from '@/lib/utils'

type SourceFilter = 'all' | 'conversations' | 'documents' | 'text'

const SOURCE_FILTER_COLORS: Record<SourceFilter, { active: string; inactive: string }> = {
  all:           { active: 'bg-mm-text text-mm-bg', inactive: 'bg-mm-bg text-mm-text-muted hover:bg-mm-surface-hover' },
  conversations: { active: 'bg-teal-600 text-white dark:bg-teal-500 dark:text-white', inactive: 'bg-teal-50 text-teal-700 hover:bg-teal-100 dark:bg-teal-900/20 dark:text-teal-300 dark:hover:bg-teal-900/30' },
  documents:     { active: 'bg-indigo-600 text-white dark:bg-indigo-500 dark:text-white', inactive: 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-900/20 dark:text-indigo-300 dark:hover:bg-indigo-900/30' },
  text:          { active: 'bg-sky-600 text-white dark:bg-sky-500 dark:text-white', inactive: 'bg-sky-50 text-sky-700 hover:bg-sky-100 dark:bg-sky-900/20 dark:text-sky-300 dark:hover:bg-sky-900/30' },
}

const SOURCE_FILTERS: { value: SourceFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'conversations', label: 'Conversations' },
  { value: 'documents', label: 'Documents' },
  { value: 'text', label: 'Text' },
]

// --- Flat note type ---

interface FlatNote {
  id: number
  content: string
  sequenceNumber: number
  createdAt: string
  sourceType: 'conversation' | 'document' | 'comment'
  sourceId: number
  sourceName: string
  speakerName?: string
  contextText?: string
  conversationId?: number
  segmentId?: number | null
}

interface SourceGroup {
  key: string
  label: string
  sourceType: 'conversation' | 'document' | 'comment'
  sourceId: number
  notes: FlatNote[]
}

// --- Component ---

interface AllNotesPanelProps {
  projectId: number
  search?: string
  focusedType?: string | null
  focusedEntityId?: number | null
  onFocus?: (type: string, entityId: number | null, label: string, color: string) => void
}

export default function AllNotesPanel({ projectId, search = '', focusedType, focusedEntityId, onFocus }: AllNotesPanelProps) {
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [showArchived, setShowArchived] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [expandedNotes, setExpandedNotes] = useState<Set<number>>(new Set())
  const announceRef = useRef<HTMLDivElement>(null)

  // Debounce the external search prop
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(timer)
  }, [search])

  const { data, isLoading } = useQuery({
    queryKey: ['all-notes', projectId, debouncedSearch, showArchived],
    queryFn: () => allNotesApi.list(projectId, debouncedSearch || undefined, showArchived),
  })

  const conversations = useMemo(() => data?.conversations ?? [], [data?.conversations])
  const comments = useMemo(() => data?.texts ?? [], [data?.texts])
  const documents = useMemo(() => data?.documents ?? [], [data?.documents])

  // Filter by source type
  const filteredConversations = useMemo(
    () => sourceFilter === 'all' || sourceFilter === 'conversations' ? conversations : [],
    [sourceFilter, conversations],
  )
  const filteredDocuments = useMemo(
    () => sourceFilter === 'all' || sourceFilter === 'documents' ? documents : [],
    [sourceFilter, documents],
  )
  const filteredComments = useMemo(
    () => sourceFilter === 'all' || sourceFilter === 'text' ? comments : [],
    [sourceFilter, comments],
  )

  // Build flat source groups
  const sourceGroups = useMemo<SourceGroup[]>(() => {
    const groups: SourceGroup[] = []

    for (const conv of filteredConversations) {
      const notes: FlatNote[] = []
      for (const note of conv.general_notes) {
        notes.push({
          id: note.id,
          content: note.content,
          sequenceNumber: note.sequence_number,
          createdAt: note.created_at,
          sourceType: 'conversation',
          sourceId: conv.conversation_id,
          sourceName: conv.conversation_name,
          contextText: note.segment_text ?? undefined,
          conversationId: conv.conversation_id,
          segmentId: note.segment_id,
        })
      }
      for (const speaker of conv.speakers) {
        for (const note of speaker.notes) {
          notes.push({
            id: note.id,
            content: note.content,
            sequenceNumber: note.sequence_number,
            createdAt: note.created_at,
            sourceType: 'conversation',
            sourceId: conv.conversation_id,
            sourceName: conv.conversation_name,
            speakerName: speaker.speaker_name,
            contextText: note.segment_text ?? undefined,
            conversationId: conv.conversation_id,
            segmentId: note.segment_id,
          })
        }
      }
      if (notes.length > 0) {
        groups.push({
          key: `conv-${conv.conversation_id}`,
          label: conv.conversation_name,
          sourceType: 'conversation',
          sourceId: conv.conversation_id,
          notes,
        })
      }
    }

    for (const doc of filteredDocuments) {
      const notes: FlatNote[] = doc.notes.map(note => ({
        id: note.id,
        content: note.content,
        sequenceNumber: note.sequence_number,
        createdAt: note.created_at,
        sourceType: 'document' as const,
        sourceId: doc.document_id,
        sourceName: doc.document_name,
        contextText: note.segment_text ?? undefined,
        segmentId: note.segment_id,
      }))
      if (notes.length > 0) {
        groups.push({
          key: `doc-${doc.document_id}`,
          label: doc.document_name,
          sourceType: 'document',
          sourceId: doc.document_id,
          notes,
        })
      }
    }

    for (const col of filteredComments) {
      const notes: FlatNote[] = []
      for (const r of col.rows) {
        for (const note of r.notes) {
          notes.push({
            id: note.id,
            content: note.content,
            sequenceNumber: note.sequence_number,
            createdAt: note.created_at,
            sourceType: 'comment',
            sourceId: col.column_id,
            sourceName: col.column_name || col.column_text,
            speakerName: r.row_label,
            contextText: note.source_text ?? undefined,
          })
        }
      }
      if (notes.length > 0) {
        groups.push({
          key: `col-${col.column_id}`,
          label: col.column_name || col.column_text,
          sourceType: 'comment',
          sourceId: col.column_id,
          notes,
        })
      }
    }

    return groups
  }, [filteredConversations, filteredDocuments, filteredComments])

  const totalCount = useMemo(() => sourceGroups.reduce((s, g) => s + g.notes.length, 0), [sourceGroups])

  // Announce search results
  useEffect(() => {
    if (debouncedSearch && announceRef.current) {
      announceRef.current.textContent = `${totalCount} note${totalCount !== 1 ? 's' : ''} found`
    }
  }, [debouncedSearch, totalCount])

  // Auto-expand all groups when searching
  useEffect(() => {
    if (debouncedSearch) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- expand groups to show search matches
      setExpanded(new Set(sourceGroups.map(g => g.key)))
    }
  }, [debouncedSearch, sourceGroups])

  const toggleExpand = useCallback((key: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const toggleNoteExpand = useCallback((noteId: number) => {
    setExpandedNotes(prev => {
      const next = new Set(prev)
      if (next.has(noteId)) next.delete(noteId)
      else next.add(noteId)
      return next
    })
  }, [])

  return (
    <div className="flex flex-col h-full">
      {/* Header with source filter + count */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-mm-border-subtle bg-mm-bg flex-shrink-0">
        <FileText className="h-3.5 w-3.5 text-mm-text-muted flex-shrink-0" />
        <span className="text-xs font-semibold text-mm-text-muted uppercase tracking-wider">Notes</span>
        <span className="text-xs text-mm-text-muted bg-mm-surface rounded-full px-2 py-0.5">
          {totalCount}
        </span>
        <button
          onClick={() => setShowArchived(prev => !prev)}
          className={`text-[11px] px-2 py-0.5 rounded-full transition-colors ${showArchived ? 'bg-mm-bg text-mm-text' : 'text-mm-text-faint hover:text-mm-text-muted'}`}
          aria-pressed={showArchived}
          aria-label="Show archived notes"
        >
          {showArchived ? 'Hide archived' : 'Archived'}
        </button>
        <div className="flex items-center gap-1 ml-auto">
          {SOURCE_FILTERS.map(sf => {
            const colors = SOURCE_FILTER_COLORS[sf.value]
            return (
            <button
              key={sf.value}
              onClick={() => setSourceFilter(sf.value)}
              className={`px-2.5 py-1 text-xs font-medium rounded-full whitespace-nowrap transition-colors ${
                sourceFilter === sf.value ? colors.active : colors.inactive
              }`}
              aria-pressed={sourceFilter === sf.value}
            >
              {sf.label}
            </button>
            )
          })}
        </div>
      </div>

      {/* Announcements */}
      <div ref={announceRef} aria-live="polite" className="sr-only" />

      {/* Grouped flat list */}
      <div className="flex-1 overflow-y-auto" role="list" aria-label="Notes">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <LoaderCircle className="h-5 w-5 animate-spin text-mm-text-muted" />
          </div>
        ) : totalCount === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <FileText className="h-8 w-8 text-mm-text-muted/40 mb-2" />
            <p className="text-sm text-mm-text-muted">
              {debouncedSearch ? 'No notes match your search' : 'No notes yet'}
            </p>
            <p className="text-xs text-mm-text-muted/70 mt-1">
              Notes are created in conversations, documents, and the Text Coding tab
            </p>
          </div>
        ) : (
          sourceGroups.map(group => (
            <NoteSourceGroup
              key={group.key}
              group={group}
              projectId={projectId}
              isExpanded={expanded.has(group.key)}
              expandedNotes={expandedNotes}
              onToggle={() => toggleExpand(group.key)}
              onToggleNote={toggleNoteExpand}
              focusedType={focusedType}
              focusedEntityId={focusedEntityId}
              onFocus={onFocus}
            />
          ))
        )}
      </div>
    </div>
  )
}

// --- Source group with collapsible header ---

function NoteSourceGroup({
  group,
  projectId,
  isExpanded,
  expandedNotes,
  onToggle,
  onToggleNote,
  focusedType,
  focusedEntityId,
  onFocus,
}: {
  group: SourceGroup
  projectId: number
  isExpanded: boolean
  expandedNotes: Set<number>
  onToggle: () => void
  onToggleNote: (id: number) => void
  focusedType?: string | null
  focusedEntityId?: number | null
  onFocus?: (type: string, entityId: number | null, label: string, color: string) => void
}) {
  const { isDark } = useTheme()
  const Icon = group.sourceType === 'conversation' ? MessageSquare
    : group.sourceType === 'document' ? FileText
    : TableProperties
  const sourceColor = group.sourceType === 'conversation'
    ? (isDark ? '#14b8a6' : '#0d9488')
    : group.sourceType === 'document'
      ? (isDark ? '#818cf8' : '#4f46e5')
      : (isDark ? '#38bdf8' : '#0284c7')

  return (
    <div>
      {/* Collapsible group header */}
      <button
        className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-mm-text hover:bg-mm-surface-hover transition-colors"
        onClick={onToggle}
        aria-expanded={isExpanded}
      >
        {isExpanded
          ? <ChevronDown className="h-3.5 w-3.5 text-mm-text-muted flex-shrink-0" />
          : <ChevronRight className="h-3.5 w-3.5 text-mm-text-muted flex-shrink-0" />
        }
        <Icon className="h-3.5 w-3.5 text-mm-text-muted flex-shrink-0" />
        <span className="truncate">{group.label}</span>
        <span className="text-xs text-mm-text-muted ml-auto flex-shrink-0">
          {group.notes.length} note{group.notes.length !== 1 ? 's' : ''}
        </span>
      </button>

      {/* Note cards */}
      {isExpanded && (
        <div className="px-3 pb-2 space-y-1.5">
          {group.notes.map(note => (
            <NoteCard
              key={note.id}
              note={note}
              projectId={projectId}
              sourceColor={sourceColor}
              isContentExpanded={expandedNotes.has(note.id)}
              onToggleContent={() => onToggleNote(note.id)}
              focusedType={focusedType}
              focusedEntityId={focusedEntityId}
              onFocus={onFocus}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// --- Individual note card (unified template) ---

function NoteCard({
  note,
  projectId,
  sourceColor,
  isContentExpanded,
  onToggleContent,
  focusedType,
  focusedEntityId,
  onFocus,
}: {
  note: FlatNote
  projectId: number
  sourceColor: string
  isContentExpanded: boolean
  onToggleContent: () => void
  focusedType?: string | null
  focusedEntityId?: number | null
  onFocus?: (type: string, entityId: number | null, label: string, color: string) => void
}) {
  const typeLabel = note.sourceType === 'conversation' ? 'Conversation'
    : note.sourceType === 'document' ? 'Document'
    : 'Text'
  const colors = ENTITY_TYPE_COLORS[note.sourceType] ?? ENTITY_TYPE_COLORS.project
  const url = note.sourceType === 'conversation'
    ? `/projects/${projectId}/conversations/${note.conversationId}${note.segmentId ? `?segment=${note.segmentId}` : ''}`
    : note.sourceType === 'document'
      ? `/projects/${projectId}/documents/${note.sourceId}`
      : `/projects/${projectId}/datasets/text-coding`

  const isFocusMatch = !focusedType || (
    focusedEntityId != null
      ? (note.sourceType === focusedType && note.sourceId === focusedEntityId)
      : note.sourceType === focusedType
  )

  return (
    <div
      className="group rounded-md border border-mm-border-subtle bg-mm-bg p-3"
      style={getUnfocusedStyle(isFocusMatch)}
    >
      {/* Meta row: type chip + ID + speaker + date */}
      <div className="flex items-center gap-2 mb-1">
        <span
          role="button"
          tabIndex={0}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${colors.bg} ${colors.text} hover:ring-1 hover:ring-current/30 transition-shadow cursor-pointer`}
          onClick={() => onFocus?.(note.sourceType, null, typeLabel, sourceColor)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onFocus?.(note.sourceType, null, typeLabel, sourceColor)
            }
          }}
          title={`Focus on ${typeLabel} notes`}
        >
          {typeLabel}
        </span>
        <span className="text-[10px] text-mm-text-muted">
          N-{note.sequenceNumber}
        </span>
        {note.speakerName && (
          <span
            role="button"
            tabIndex={0}
            className="text-[10px] text-mm-text-muted truncate max-w-[120px] hover:underline cursor-pointer"
            onClick={() => onFocus?.(note.sourceType, note.sourceId, note.sourceName, sourceColor)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onFocus?.(note.sourceType, note.sourceId, note.sourceName, sourceColor)
              }
            }}
            title={`Focus on "${note.sourceName}" — ${note.speakerName}`}
          >
            {note.speakerName}
          </span>
        )}
        <span className="text-[10px] text-mm-text-muted ml-auto flex-shrink-0">
          {formatDate(note.createdAt)}
        </span>
      </div>

      {/* Content — always dark */}
      <p className={`text-xs text-mm-text whitespace-pre-wrap ${!isContentExpanded ? 'line-clamp-2' : ''}`}>
        {note.content}
      </p>
      {note.content.length > 120 && (
        <button
          onClick={onToggleContent}
          className="text-[10px] text-mm-accent hover:underline mt-0.5"
        >
          {isContentExpanded ? 'Show less' : 'Show more'}
        </button>
      )}

      {/* Context block — associated segment/comment */}
      {note.contextText && (
        <div className={`mt-1.5 pl-2 border-l-2 ${note.sourceType === 'conversation' ? 'border-teal-300 dark:border-teal-700' : note.sourceType === 'document' ? 'border-indigo-300 dark:border-indigo-700' : 'border-sky-300 dark:border-sky-700'}`}>
          <p className="text-[11px] text-mm-text-secondary italic line-clamp-2">
            {note.contextText}
          </p>
        </div>
      )}

      {/* Navigate link — visible on hover */}
      <div className="flex justify-end mt-1">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="opacity-0 group-hover:opacity-100 transition-opacity"
          title={`Open in ${note.sourceType === 'conversation' ? 'conversation' : note.sourceType === 'document' ? 'document' : 'text coding'}`}
        >
          <ExternalLink className="h-3 w-3 text-mm-text-muted hover:text-mm-accent" />
        </a>
      </div>
    </div>
  )
}
