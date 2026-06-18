import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Search, FileText, Tag, Users, StickyNote, MessageSquare, MessageCircle, Layers, X, LoaderCircle, ChevronDown, Quote } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  searchApi,
  type SearchEntityType,
  type SegmentSearchResult,
  type CodeSearchResult,
  type ConversationSearchResult,
  type NoteSearchResult,
  type MemoSearchResult,
  type DocumentSearchResult,
  type TextSearchResult,
  type CanvasSearchResult,
} from '@/lib/api'
import { getSpeakerInitials, getInitialsBadgeColors } from '@/lib/conversation-import-utils'

interface SearchPopoverProps {
  open: boolean
  onClose: () => void
  projectId: number
  onOpenCodebook?: () => void
  onOpenMemos?: () => void
}

// UI filter categories (what the user sees)
type FilterCategory = 'conversations' | 'documents' | 'text' | 'canvases' | 'codes' | 'notes' | 'memos'
const ALL_FILTERS: FilterCategory[] = ['conversations', 'documents', 'text', 'canvases', 'codes', 'notes', 'memos']
const DEFAULT_FILTERS: FilterCategory[] = [...ALL_FILTERS]

// All backend entity types (for prefix parsing)
const ALL_BACKEND_TYPES: SearchEntityType[] = ['codes', 'segments', 'documents', 'text', 'canvases', 'notes', 'memos', 'conversations']

// ── Flat result item for keyboard nav ──

type FlatItemType = 'segment' | 'code' | 'conversation' | 'note' | 'memo' | 'document' | 'text' | 'canvas'

type FlatResultItem =
  | { type: 'segment'; data: SegmentSearchResult }
  | { type: 'code'; data: CodeSearchResult }
  | { type: 'conversation'; data: ConversationSearchResult }
  | { type: 'note'; data: NoteSearchResult }
  | { type: 'memo'; data: MemoSearchResult }
  | { type: 'document'; data: DocumentSearchResult }
  | { type: 'text'; data: TextSearchResult }
  | { type: 'canvas'; data: CanvasSearchResult }

function getItemId(item: FlatResultItem): string {
  return `search-result-${item.type}-${item.data.id}`
}

// ── Source badge pill ──

function SourceBadge({ sourceType }: { sourceType?: string }) {
  if (sourceType === 'document') {
    return <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400">Doc</span>
  }
  if (sourceType === 'conversation') {
    return <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400">Conv</span>
  }
  return null
}

/** Map UI filter selections → backend SearchEntityType[] for the API request. */
function filtersToBackendTypes(filters: FilterCategory[]): SearchEntityType[] {
  const types = new Set<SearchEntityType>()
  for (const f of filters) {
    types.add(f as SearchEntityType)
    // Conversations/Documents imply segment text search
    if (f === 'conversations' || f === 'documents') types.add('segments')
  }
  return Array.from(types)
}

export default function SearchPopover({
  open,
  onClose,
  projectId,
  onOpenCodebook,
  onOpenMemos,
}: SearchPopoverProps) {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [selectedFilters, setSelectedFilters] = useState<FilterCategory[]>(DEFAULT_FILTERS)
  const [quotedOnly, setQuotedOnly] = useState(false)
  const [expandedType, setExpandedType] = useState<SearchEntityType | null>(null)
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [debouncedBackendTypes, setDebouncedBackendTypes] = useState<SearchEntityType[]>(() => filtersToBackendTypes(DEFAULT_FILTERS))

  // Which sources are checked (for filtering displayed segment results)
  const showConvSegments = selectedFilters.includes('conversations')
  const showDocSegments = selectedFilters.includes('documents')

  // Reset state when closing
  useEffect(() => {
    if (!open) {
      setQuery('')
      setDebouncedQuery('')
      setExpandedType(null)
      setFocusedIndex(-1)
    }
  }, [open])

  // Auto-focus input on open
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [open])

  // Reset focus when query changes
  useEffect(() => {
    setFocusedIndex(-1)
  }, [query])

  // Parse query for operators (prefix like "code:term" or exclusion like "term -memos")
  const parseQuery = (rawQuery: string): { searchTerm: string; parsedTypes: SearchEntityType[] | null } => {
    const trimmed = rawQuery.trim()
    if (!trimmed) return { searchTerm: '', parsedTypes: null }

    const prefixMatch = trimmed.match(/^(codes?|segments?|notes?|memos?|conversations?|documents?|comments?|canvases?):(.+)$/i)
    if (prefixMatch) {
      let typeName = prefixMatch[1].toLowerCase()
      if (!typeName.endsWith('s')) typeName += 's'
      const searchTerm = prefixMatch[2].trim()
      if (ALL_BACKEND_TYPES.includes(typeName as SearchEntityType) && searchTerm.length > 0) {
        return { searchTerm, parsedTypes: [typeName as SearchEntityType] }
      }
    }

    const exclusionPattern = /\s+-(codes?|segments?|notes?|memos?|conversations?|documents?|comments?|canvases?)(?:\s|$)/gi
    const exclusions: SearchEntityType[] = []
    let searchTerm = trimmed
    let match

    while ((match = exclusionPattern.exec(trimmed)) !== null) {
      let typeName = match[1].toLowerCase()
      if (!typeName.endsWith('s')) typeName += 's'
      if (ALL_BACKEND_TYPES.includes(typeName as SearchEntityType)) {
        exclusions.push(typeName as SearchEntityType)
      }
    }

    if (exclusions.length > 0) {
      searchTerm = trimmed.replace(/\s+-(codes?|segments?|notes?|memos?|conversations?|documents?|comments?|canvases?)(?=\s|$)/gi, '').trim()
      const backendTypes = filtersToBackendTypes(selectedFilters)
      const remainingTypes = backendTypes.filter(t => !exclusions.includes(t))
      if (remainingTypes.length > 0) {
        return { searchTerm, parsedTypes: remainingTypes }
      }
    }

    return { searchTerm: trimmed, parsedTypes: null }
  }

  const { searchTerm: parsedSearchTerm, parsedTypes } = parseQuery(query)
  const effectiveBackendTypes = parsedTypes || filtersToBackendTypes(selectedFilters)
  const hasOperator = parsedTypes !== null

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(parsedSearchTerm)
      setDebouncedBackendTypes(effectiveBackendTypes)
    }, 300)
    return () => clearTimeout(timer)
  }, [parsedSearchTerm, effectiveBackendTypes])

  // Search query
  const { data: searchResults, isLoading, isFetching } = useQuery({
    queryKey: ['search', projectId, debouncedQuery, debouncedBackendTypes.join(','), expandedType, quotedOnly],
    queryFn: () => {
      const quoted = quotedOnly ? true : undefined
      if (expandedType) {
        return searchApi.searchFullType(projectId, debouncedQuery, expandedType, quoted)
      }
      return searchApi.search(projectId, debouncedQuery, debouncedBackendTypes, 5, quoted)
    },
    enabled: open && debouncedQuery.length >= 2 && debouncedBackendTypes.length > 0,
    staleTime: 30000,
  })

  const toggleFilter = (filter: FilterCategory) => {
    setSelectedFilters(prev => {
      if (prev.includes(filter)) {
        if (prev.length === 1) return prev
        return prev.filter(f => f !== filter)
      }
      return [...prev, filter]
    })
    setExpandedType(null)
  }

  // ── Display-filtered results ──
  // Segments: filter by source_type to match checked source checkboxes
  const displaySegments = useMemo(() => {
    if (!searchResults?.segments) return null
    const items = searchResults.segments.items.filter(s => {
      if (s.source_type === 'conversation' && showConvSegments) return true
      if (s.source_type === 'document' && showDocSegments) return true
      return false
    })
    if (items.length === 0) return null
    return { count: items.length, items }
  }, [searchResults?.segments, showConvSegments, showDocSegments])

  // Comments: filter by is_quoted when quotedOnly is on
  const displayTexts = useMemo(() => {
    if (!searchResults?.text) return null
    if (!quotedOnly) return searchResults.text
    const items = searchResults.text.items.filter(c => c.is_quoted)
    if (items.length === 0) return null
    return { count: items.length, items }
  }, [searchResults?.text, quotedOnly])

  // Conversations/Documents name matches: suppress when quotedOnly (name matches aren't "quoted")
  const displayConversations = useMemo(() => {
    if (quotedOnly) return null
    return searchResults?.conversations ?? null
  }, [searchResults?.conversations, quotedOnly])

  const displayDocuments = useMemo(() => {
    if (quotedOnly) return null
    return searchResults?.documents ?? null
  }, [searchResults?.documents, quotedOnly])

  const displayCanvases = useMemo(() => {
    if (quotedOnly) return null
    return searchResults?.canvases ?? null
  }, [searchResults?.canvases, quotedOnly])

  const formatTime = (seconds: number | null): string => {
    if (seconds === null) return ''
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const truncate = (text: string, maxLength: number): string => {
    if (text.length <= maxLength) return text
    return text.slice(0, maxLength) + '...'
  }

  const highlightMatch = (text: string, searchTerm: string): React.ReactNode => {
    if (!searchTerm || searchTerm.length < 2) return text
    const regex = new RegExp(`(${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
    const parts = text.split(regex)
    return parts.map((part, i) => {
      if (part.toLowerCase() === searchTerm.toLowerCase()) {
        return (
          <mark key={i} className="bg-[hsl(var(--mm-green)/0.25)] text-foreground rounded-sm px-0.5">
            {part}
          </mark>
        )
      }
      return part
    })
  }

  const getSnippet = (text: string, searchTerm: string, contextBefore = 35, contextAfter = 70): string => {
    const lowerText = text.toLowerCase()
    const lowerTerm = searchTerm.toLowerCase()
    const matchIndex = lowerText.indexOf(lowerTerm)

    if (matchIndex === -1) {
      const maxLen = contextBefore + contextAfter
      if (text.length <= maxLen) return text
      return text.slice(0, maxLen) + '...'
    }

    let start = Math.max(0, matchIndex - contextBefore)
    let end = Math.min(text.length, matchIndex + searchTerm.length + contextAfter)

    if (start > 0) {
      const spaceIndex = text.indexOf(' ', start)
      if (spaceIndex !== -1 && spaceIndex < matchIndex) start = spaceIndex + 1
    }
    if (end < text.length) {
      const spaceIndex = text.lastIndexOf(' ', end)
      if (spaceIndex > matchIndex + searchTerm.length) end = spaceIndex
    }

    let snippet = text.slice(start, end)
    if (start > 0) snippet = '...' + snippet
    if (end < text.length) snippet = snippet + '...'
    return snippet
  }

  const closeAndNavigate = useCallback((path: string) => {
    onClose()
    navigate(path)
  }, [onClose, navigate])

  const handleSegmentClick = (segment: SegmentSearchResult) => {
    const term = parsedSearchTerm
    if (segment.source_type === 'document') {
      closeAndNavigate(`/projects/${projectId}/documents/${segment.conversation_id}`)
    } else {
      const params = new URLSearchParams({ segment: String(segment.id) })
      if (term) params.set('q', term)
      closeAndNavigate(`/projects/${projectId}/conversations/${segment.conversation_id}?${params}`)
    }
  }

  const handleCodeClick = (_code: CodeSearchResult) => {
    onClose()
    onOpenCodebook?.()
  }

  const handleConversationClick = (conversation: ConversationSearchResult) => {
    closeAndNavigate(`/projects/${projectId}/conversations/${conversation.id}`)
  }

  const handleNoteClick = (note: NoteSearchResult) => {
    if (note.source_type === 'document') {
      closeAndNavigate(`/projects/${projectId}/documents/${note.conversation_id}`)
    } else {
      closeAndNavigate(`/projects/${projectId}/conversations/${note.conversation_id}`)
    }
  }

  const handleMemoClick = (_memo: MemoSearchResult) => {
    onClose()
    onOpenMemos?.()
  }

  const handleDocumentClick = (doc: DocumentSearchResult) => {
    closeAndNavigate(`/projects/${projectId}/documents/${doc.id}`)
  }

  const handleTextClick = (comment: TextSearchResult) => {
    closeAndNavigate(`/projects/${projectId}/datasets/text-coding?columns=${comment.column_id}`)
  }

  const handleCanvasClick = (result: CanvasSearchResult) => {
    closeAndNavigate(`/projects/${projectId}/analysis/canvas?canvas=${result.canvas_id}`)
  }

  const handleShowAll = (type: SearchEntityType) => {
    setExpandedType(type)
    setFocusedIndex(-1)
  }
  const handleBackFromExpanded = () => {
    setExpandedType(null)
    setFocusedIndex(-1)
  }

  // Use display-filtered results for hasResults / counts
  const hasResults = !!(
    (displaySegments && displaySegments.count > 0) ||
    (searchResults?.codes?.count || 0) > 0 ||
    (displayConversations?.count || 0) > 0 ||
    (searchResults?.notes?.count || 0) > 0 ||
    (searchResults?.memos?.count || 0) > 0 ||
    (displayDocuments?.count || 0) > 0 ||
    (displayTexts?.count || 0) > 0 ||
    (displayCanvases?.count || 0) > 0
  )

  const showResults = debouncedQuery.length >= 2

  // Build flat list of navigable result items (in render order)
  const flatItems: FlatResultItem[] = useMemo(() => {
    if (!searchResults || !hasResults) return []
    const items: FlatResultItem[] = []

    // Map SearchEntityType (plural) → FlatItemType (singular)
    const typeMap: Record<SearchEntityType, FlatItemType> = {
      codes: 'code', segments: 'segment', documents: 'document', text: 'text',
      conversations: 'conversation', notes: 'note', memos: 'memo', canvases: 'canvas',
    }

    if (expandedType) {
      const flatType = typeMap[expandedType]
      if (expandedType === 'segments' && displaySegments) {
        for (const item of displaySegments.items) items.push({ type: flatType, data: item } as FlatResultItem)
      } else {
        const resultSet = searchResults[expandedType]
        if (resultSet) {
          for (const item of resultSet.items) items.push({ type: flatType, data: item } as FlatResultItem)
        }
      }
    } else {
      if (searchResults.codes) for (const c of searchResults.codes.items) items.push({ type: 'code', data: c })
      if (displaySegments) for (const s of displaySegments.items) items.push({ type: 'segment', data: s })
      if (displayDocuments) for (const d of displayDocuments.items) items.push({ type: 'document', data: d })
      if (displayTexts) for (const c of displayTexts.items) items.push({ type: 'text', data: c })
      if (displayCanvases) for (const c of displayCanvases.items) items.push({ type: 'canvas', data: c })
      if (displayConversations) for (const c of displayConversations.items) items.push({ type: 'conversation', data: c })
      if (searchResults.notes) for (const n of searchResults.notes.items) items.push({ type: 'note', data: n })
      if (searchResults.memos) for (const m of searchResults.memos.items) items.push({ type: 'memo', data: m })
    }
    return items
  }, [searchResults, hasResults, expandedType, displaySegments, displayTexts, displayConversations, displayDocuments, displayCanvases])

  // Total result count for footer
  const totalResultCount = useMemo(() => {
    if (!searchResults) return 0
    return (displaySegments?.count || 0) +
      (searchResults.codes?.count || 0) +
      (displayConversations?.count || 0) +
      (searchResults.notes?.count || 0) +
      (searchResults.memos?.count || 0) +
      (displayDocuments?.count || 0) +
      (displayTexts?.count || 0) +
      (displayCanvases?.count || 0)
  }, [searchResults, displaySegments, displayConversations, displayDocuments, displayTexts, displayCanvases])

  const activeTypeCount = useMemo(() => {
    if (!searchResults) return 0
    let count = 0
    if ((displaySegments?.count || 0) > 0) count++
    if ((searchResults.codes?.count || 0) > 0) count++
    if ((displayConversations?.count || 0) > 0) count++
    if ((searchResults.notes?.count || 0) > 0) count++
    if ((searchResults.memos?.count || 0) > 0) count++
    if ((displayDocuments?.count || 0) > 0) count++
    if ((displayTexts?.count || 0) > 0) count++
    if ((displayCanvases?.count || 0) > 0) count++
    return count
  }, [searchResults, displaySegments, displayConversations, displayDocuments, displayTexts, displayCanvases])

  // Activate the focused item
  const activateItem = useCallback((item: FlatResultItem) => {
    switch (item.type) {
      case 'segment': handleSegmentClick(item.data as SegmentSearchResult); break
      case 'code': handleCodeClick(item.data as CodeSearchResult); break
      case 'conversation': handleConversationClick(item.data as ConversationSearchResult); break
      case 'note': handleNoteClick(item.data as NoteSearchResult); break
      case 'memo': handleMemoClick(item.data as MemoSearchResult); break
      case 'document': handleDocumentClick(item.data as DocumentSearchResult); break
      case 'text': handleTextClick(item.data as TextSearchResult); break
      case 'canvas': handleCanvasClick(item.data as CanvasSearchResult); break
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, parsedSearchTerm])

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIndex < 0 || !flatItems[focusedIndex]) return
    const id = getItemId(flatItems[focusedIndex])
    const el = document.getElementById(id)
    el?.scrollIntoView({ block: 'nearest' })
  }, [focusedIndex, flatItems])

  // Ghost text suggestion
  const getGhostSuggestion = (): string => {
    const includeMatch = query.match(/^([a-z]+)$/i)
    if (includeMatch) {
      const partial = includeMatch[1].toLowerCase()
      for (const t of ALL_BACKEND_TYPES) {
        if (t.startsWith(partial) && t !== partial) return t.slice(partial.length) + ':'
        if (t.slice(0, -1) === partial) return 's:'
      }
    }
    const excludeMatch = query.match(/\s-([a-z]*)$/i)
    if (excludeMatch) {
      const partial = excludeMatch[1].toLowerCase()
      const alreadyExcluded = (query.match(/\s-([a-z]+)/gi) || []).slice(0, -1).map(m => {
        let t = m.trim().slice(1).toLowerCase()
        if (!t.endsWith('s')) t += 's'
        return t
      })
      for (const t of ALL_BACKEND_TYPES) {
        if (alreadyExcluded.includes(t)) continue
        if (t.startsWith(partial) && t !== partial) return t.slice(partial.length)
        if (partial && t.slice(0, -1).startsWith(partial)) return t.slice(partial.length)
      }
    }
    return ''
  }

  const ghostSuggestion = getGhostSuggestion()

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab' && ghostSuggestion) {
      e.preventDefault()
      setQuery(query + ghostSuggestion)
      return
    }

    // Keyboard navigation
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (flatItems.length > 0) {
        setFocusedIndex(prev => Math.min(prev + 1, flatItems.length - 1))
      }
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusedIndex(prev => Math.max(prev - 1, -1))
      return
    }
    if (e.key === 'Enter' && focusedIndex >= 0 && flatItems[focusedIndex]) {
      e.preventDefault()
      activateItem(flatItems[focusedIndex])
      return
    }
    if (e.key === 'Home' && flatItems.length > 0) {
      e.preventDefault()
      setFocusedIndex(0)
      return
    }
    if (e.key === 'End' && flatItems.length > 0) {
      e.preventDefault()
      setFocusedIndex(flatItems.length - 1)
      return
    }
    if (e.key === 'Escape' && focusedIndex >= 0) {
      e.preventDefault()
      setFocusedIndex(-1)
      inputRef.current?.focus()
      return
    }
  }

  const focusedItemId = focusedIndex >= 0 && flatItems[focusedIndex]
    ? getItemId(flatItems[focusedIndex])
    : undefined

  // ── Render helpers ──

  const renderResultButton = (item: FlatResultItem, globalIndex: number, children: React.ReactNode) => {
    const isFocused = focusedIndex === globalIndex
    const id = getItemId(item)
    return (
      <button
        key={id}
        id={id}
        role="option"
        aria-selected={isFocused}
        tabIndex={-1}
        className={`w-full text-left px-3 py-2 flex items-start gap-2 transition-colors outline-none ${
          isFocused ? 'bg-[hsl(var(--mm-green)/0.14)]' : 'hover:bg-[hsl(var(--mm-green)/0.08)]'
        }`}
        onClick={() => activateItem(item)}
        onMouseEnter={() => setFocusedIndex(globalIndex)}
      >
        {children}
      </button>
    )
  }

  // Track cumulative index across sections
  let globalIdx = 0

  const renderSegment = (segment: SegmentSearchResult, item: FlatResultItem) => {
    const idx = globalIdx++
    return renderResultButton(item, idx, <>
      {segment.is_quoted && <Quote className="w-3.5 h-3.5 text-amber-500 fill-amber-500 flex-shrink-0 mt-0.5" />}
      {segment.speaker_name && (
        <span className={`w-5 h-5 rounded-full text-[11px] font-semibold flex items-center justify-center ring-1 flex-shrink-0 mt-0.5 ${getInitialsBadgeColors(segment.is_facilitator)}`} title={segment.speaker_name}>
          {getSpeakerInitials(segment.speaker_name)}
        </span>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm">{highlightMatch(getSnippet(segment.text, debouncedQuery), debouncedQuery)}</p>
        <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
          <SourceBadge sourceType={segment.source_type} />
          {segment.conversation_name}
          {segment.speaker_name && ` \u00b7 ${segment.speaker_name}`}
          {segment.start_time !== null && ` \u00b7 ${formatTime(segment.start_time)}`}
        </p>
      </div>
    </>)
  }

  const renderCode = (code: CodeSearchResult, item: FlatResultItem) => {
    const idx = globalIdx++
    return renderResultButton(item, idx, <>
      <div className="flex-1 min-w-0">
        <p className="text-sm"><span className="font-mono text-muted-foreground mr-2">{code.numeric_id}</span>{highlightMatch(code.name, debouncedQuery)}</p>
        {code.description && <p className="text-xs text-muted-foreground line-clamp-1">{highlightMatch(code.description, debouncedQuery)}</p>}
      </div>
      <span className="text-xs text-muted-foreground">{code.usage_count} uses</span>
    </>)
  }

  const renderConversation = (conv: ConversationSearchResult, item: FlatResultItem) => {
    const idx = globalIdx++
    return renderResultButton(item, idx, <>
      <div className="flex-1 min-w-0">
        <p className="text-sm">{highlightMatch(conv.name, debouncedQuery)}</p>
        {conv.subject_id && <p className="text-xs text-muted-foreground">Subject: {highlightMatch(conv.subject_id, debouncedQuery)}</p>}
      </div>
      <span className="text-xs text-muted-foreground">{conv.segment_count} segments</span>
    </>)
  }

  const renderNote = (note: NoteSearchResult, item: FlatResultItem) => {
    const idx = globalIdx++
    return renderResultButton(item, idx, <>
      <div className="flex-1 min-w-0">
        <p className="text-sm">{highlightMatch(getSnippet(note.content, debouncedQuery), debouncedQuery)}</p>
        <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
          <SourceBadge sourceType={note.source_type} />
          {note.conversation_name}
          {note.segment_text_preview && ` \u00b7 "${truncate(note.segment_text_preview, 30)}"`}
        </p>
      </div>
    </>)
  }

  const renderMemo = (memo: MemoSearchResult, item: FlatResultItem) => {
    const idx = globalIdx++
    return renderResultButton(item, idx, <>
      <div className="flex-1 min-w-0">
        <p className="text-sm">{highlightMatch(getSnippet(memo.content, debouncedQuery), debouncedQuery)}</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          M-{memo.numeric_id}
          {memo.entity_name ? ` \u00b7 ${memo.entity_type}: ${memo.entity_name}` : ' \u00b7 Project-wide'}
        </p>
      </div>
    </>)
  }

  const renderDocument = (doc: DocumentSearchResult, item: FlatResultItem) => {
    const idx = globalIdx++
    return renderResultButton(item, idx, <>
      <div className="flex-1 min-w-0">
        <p className="text-sm">{highlightMatch(doc.name, debouncedQuery)}</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {doc.segment_count} segments
          {doc.source_format && ` \u00b7 ${doc.source_format.toUpperCase()}`}
        </p>
      </div>
    </>)
  }

  const renderComment = (comment: TextSearchResult, item: FlatResultItem) => {
    const idx = globalIdx++
    return renderResultButton(item, idx, <>
      {comment.is_quoted && <Quote className="w-3.5 h-3.5 text-amber-500 fill-amber-500 flex-shrink-0 mt-0.5" />}
      <div className="flex-1 min-w-0">
        <p className="text-sm">{highlightMatch(getSnippet(comment.value_text, debouncedQuery), debouncedQuery)}</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {comment.column_name}
          {comment.row_identifier && ` \u00b7 ${comment.row_identifier}`}
          {comment.applied_code_count > 0 && ` \u00b7 ${comment.applied_code_count} codes`}
        </p>
      </div>
    </>)
  }

  const renderCanvas = (result: CanvasSearchResult, item: FlatResultItem) => {
    const idx = globalIdx++
    return renderResultButton(item, idx, <>
      <div className="flex-1 min-w-0">
        <p className="text-sm">{highlightMatch(getSnippet(result.match_text, debouncedQuery), debouncedQuery)}</p>
        <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
          <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${
            result.match_type === 'theme'
              ? 'bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400'
              : 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
          }`}>
            {result.match_type === 'theme' ? 'Theme' : 'Content'}
          </span>
          {result.canvas_name}
          {result.theme_name && ` \u00b7 ${result.theme_name}`}
        </p>
      </div>
    </>)
  }

  // Reset globalIdx before every render
  globalIdx = 0

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent
        className="sm:max-w-[560px] p-0 gap-0 overflow-hidden bg-white dark:bg-[hsl(230,10%,12%)] [&>button:last-child]:hidden"
        aria-label="Search qualitative data"
      >
        <DialogTitle className="sr-only">Search qualitative data</DialogTitle>
        <DialogDescription className="sr-only">Search across conversations, documents, codes, and more</DialogDescription>

        {/* Search input */}
        <div className="p-3 border-b bg-[hsl(var(--mm-green)/0.08)]">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            {/* Ghost text overlay */}
            <div className="absolute inset-0 flex items-center pl-9 pr-8 pointer-events-none">
              <span className="text-sm text-transparent">{query}</span>
              <span className="text-sm text-muted-foreground/50">{ghostSuggestion}</span>
            </div>
            <Input
              ref={inputRef}
              type="text"
              placeholder="Search qualitative data..."
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setExpandedType(null)
              }}
              onKeyDown={handleInputKeyDown}
              role="combobox"
              aria-expanded={showResults && hasResults}
              aria-controls="search-results-list"
              aria-activedescendant={focusedItemId}
              aria-label="Search qualitative data"
              className="pl-9 pr-8 border-0 shadow-none focus-visible:ring-0 bg-transparent"
            />
            {query && (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setQuery('')
                  setDebouncedQuery('')
                  inputRef.current?.focus()
                }}
                aria-label="Clear search"
              >
                <X className="w-4 h-4" />
              </button>
            )}
            {(isLoading || isFetching) && debouncedQuery.length >= 2 && (
              <LoaderCircle className="absolute right-8 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground animate-spin" />
            )}
          </div>

          {/* Filter checkboxes */}
          <div className="flex items-center gap-2 mt-2 text-sm flex-wrap">
            {hasOperator && query.length >= 2 && (
              <span className="text-xs text-mm-green-text">
                Searching {effectiveBackendTypes.join(', ')} only
              </span>
            )}
            {!hasOperator && (
              <>
                {/* Sources cluster */}
                <div className="flex items-center gap-2.5">
                  {(['conversations', 'documents', 'text', 'canvases'] as FilterCategory[]).map(f => (
                    <div key={f} className="flex items-center gap-1.5">
                      <Checkbox
                        id={`search-filter-${f}`}
                        checked={selectedFilters.includes(f)}
                        onCheckedChange={() => toggleFilter(f)}
                      />
                      <Label htmlFor={`search-filter-${f}`} className="text-xs font-normal cursor-pointer capitalize">
                        {f}
                      </Label>
                    </div>
                  ))}
                </div>

                <div className="w-px h-4 bg-mm-border-subtle" />

                {/* Annotations cluster */}
                <div className="flex items-center gap-2.5">
                  {(['codes', 'notes', 'memos'] as FilterCategory[]).map(f => (
                    <div key={f} className="flex items-center gap-1.5">
                      <Checkbox
                        id={`search-filter-${f}`}
                        checked={selectedFilters.includes(f)}
                        onCheckedChange={() => toggleFilter(f)}
                      />
                      <Label htmlFor={`search-filter-${f}`} className="text-xs font-normal cursor-pointer capitalize">
                        {f}
                      </Label>
                    </div>
                  ))}
                </div>

                <div className="w-px h-4 bg-mm-border-subtle" />

                {/* Quoted modifier */}
                <div className="flex items-center gap-1.5">
                  <Checkbox
                    id="search-filter-quoted"
                    checked={quotedOnly}
                    onCheckedChange={() => setQuotedOnly(!quotedOnly)}
                  />
                  <Label htmlFor="search-filter-quoted" className="text-xs font-normal cursor-pointer flex items-center gap-1">
                    <Quote className="w-3 h-3 text-amber-500 fill-amber-500" />
                    Quoted only
                  </Label>
                </div>
              </>
            )}
            {ghostSuggestion && (
              <span className="ml-auto text-xs text-muted-foreground">Tab to complete</span>
            )}
          </div>
        </div>

        {/* Results area */}
        <div
          id="search-results-list"
          className="max-h-[400px] overflow-y-auto"
          role="listbox"
          aria-label="Search results"
          aria-busy={isLoading}
        >
          {showResults && !hasResults && !isLoading && (
            <div className="p-6 text-center text-muted-foreground text-sm">
              No results for &ldquo;{debouncedQuery}&rdquo;
            </div>
          )}

          {showResults && isLoading && (
            <div className="p-6 text-center text-muted-foreground text-sm">
              Searching...
            </div>
          )}

          {showResults && hasResults && !expandedType && (() => {
            globalIdx = 0
            return (
              <div className="divide-y divide-border">
                {/* Codes */}
                {searchResults!.codes && searchResults!.codes.count > 0 && (
                  <ResultSection
                    title="Codes" icon={<Tag className="w-4 h-4" />}
                    count={searchResults!.codes.count} showingCount={searchResults!.codes.items.length}
                    onShowAll={() => handleShowAll('codes')}
                  >
                    {searchResults!.codes.items.map((code) => {
                      const item: FlatResultItem = { type: 'code', data: code }
                      return renderCode(code, item)
                    })}
                  </ResultSection>
                )}

                {/* Segments (display-filtered) */}
                {displaySegments && displaySegments.count > 0 && (
                  <ResultSection
                    title="Segments" icon={<FileText className="w-4 h-4" />}
                    count={displaySegments.count} showingCount={displaySegments.items.length}
                    onShowAll={() => handleShowAll('segments')}
                  >
                    {displaySegments.items.map((segment) => {
                      const item: FlatResultItem = { type: 'segment', data: segment }
                      return renderSegment(segment, item)
                    })}
                  </ResultSection>
                )}

                {/* Documents */}
                {displayDocuments && displayDocuments.count > 0 && (
                  <ResultSection
                    title="Documents" icon={<FileText className="w-4 h-4" />}
                    count={displayDocuments.count} showingCount={displayDocuments.items.length}
                    onShowAll={() => handleShowAll('documents')}
                  >
                    {displayDocuments.items.map((doc) => {
                      const item: FlatResultItem = { type: 'document', data: doc }
                      return renderDocument(doc, item)
                    })}
                  </ResultSection>
                )}

                {/* Text columns */}
                {displayTexts && displayTexts.count > 0 && (
                  <ResultSection
                    title="Text columns" icon={<MessageCircle className="w-4 h-4" />}
                    count={displayTexts.count} showingCount={displayTexts.items.length}
                    onShowAll={() => handleShowAll('text')}
                  >
                    {displayTexts.items.map((comment) => {
                      const item: FlatResultItem = { type: 'text', data: comment }
                      return renderComment(comment, item)
                    })}
                  </ResultSection>
                )}

                {/* Canvases */}
                {displayCanvases && displayCanvases.count > 0 && (
                  <ResultSection
                    title="Canvases" icon={<Layers className="w-4 h-4" />}
                    count={displayCanvases.count} showingCount={displayCanvases.items.length}
                    onShowAll={() => handleShowAll('canvases')}
                  >
                    {displayCanvases.items.map((result) => {
                      const item: FlatResultItem = { type: 'canvas', data: result }
                      return renderCanvas(result, item)
                    })}
                  </ResultSection>
                )}

                {/* Conversations */}
                {displayConversations && displayConversations.count > 0 && (
                  <ResultSection
                    title="Conversations" icon={<Users className="w-4 h-4" />}
                    count={displayConversations.count} showingCount={displayConversations.items.length}
                    onShowAll={() => handleShowAll('conversations')}
                  >
                    {displayConversations.items.map((conversation) => {
                      const item: FlatResultItem = { type: 'conversation', data: conversation }
                      return renderConversation(conversation, item)
                    })}
                  </ResultSection>
                )}

                {/* Notes */}
                {searchResults!.notes && searchResults!.notes.count > 0 && (
                  <ResultSection
                    title="Notes" icon={<StickyNote className="w-4 h-4" />}
                    count={searchResults!.notes.count} showingCount={searchResults!.notes.items.length}
                    onShowAll={() => handleShowAll('notes')}
                  >
                    {searchResults!.notes.items.map((note) => {
                      const item: FlatResultItem = { type: 'note', data: note }
                      return renderNote(note, item)
                    })}
                  </ResultSection>
                )}

                {/* Memos */}
                {searchResults!.memos && searchResults!.memos.count > 0 && (
                  <ResultSection
                    title="Memos" icon={<MessageSquare className="w-4 h-4" />}
                    count={searchResults!.memos.count} showingCount={searchResults!.memos.items.length}
                    onShowAll={() => handleShowAll('memos')}
                  >
                    {searchResults!.memos.items.map((memo) => {
                      const item: FlatResultItem = { type: 'memo', data: memo }
                      return renderMemo(memo, item)
                    })}
                  </ResultSection>
                )}
              </div>
            )
          })()}

          {/* Expanded single-type view */}
          {showResults && hasResults && expandedType && (() => {
            globalIdx = 0
            return (
              <div>
                <div className="sticky top-0 bg-[hsl(var(--mm-green)/0.08)] px-3 py-2 border-b flex items-center gap-2 z-10">
                  <button className="text-sm text-mm-green-text hover:underline" onClick={handleBackFromExpanded}>
                    &larr; Back
                  </button>
                  <span className="text-sm font-medium capitalize">
                    All {expandedType} ({
                      expandedType === 'segments'
                        ? (displaySegments?.count ?? 0)
                        : (searchResults?.[expandedType]?.count ?? 0)
                    })
                  </span>
                </div>
                <div className="divide-y divide-border/50">
                  {expandedType === 'codes' && searchResults?.codes?.items.map(code => {
                    const item: FlatResultItem = { type: 'code', data: code }
                    return renderCode(code, item)
                  })}
                  {expandedType === 'segments' && displaySegments?.items.map(segment => {
                    const item: FlatResultItem = { type: 'segment', data: segment }
                    return renderSegment(segment, item)
                  })}
                  {expandedType === 'documents' && searchResults?.documents?.items.map(doc => {
                    const item: FlatResultItem = { type: 'document', data: doc }
                    return renderDocument(doc, item)
                  })}
                  {expandedType === 'text' && searchResults?.text?.items.map(comment => {
                    const item: FlatResultItem = { type: 'text', data: comment }
                    return renderComment(comment, item)
                  })}
                  {expandedType === 'canvases' && searchResults?.canvases?.items.map(result => {
                    const item: FlatResultItem = { type: 'canvas', data: result }
                    return renderCanvas(result, item)
                  })}
                  {expandedType === 'conversations' && searchResults?.conversations?.items.map(conv => {
                    const item: FlatResultItem = { type: 'conversation', data: conv }
                    return renderConversation(conv, item)
                  })}
                  {expandedType === 'notes' && searchResults?.notes?.items.map(note => {
                    const item: FlatResultItem = { type: 'note', data: note }
                    return renderNote(note, item)
                  })}
                  {expandedType === 'memos' && searchResults?.memos?.items.map(memo => {
                    const item: FlatResultItem = { type: 'memo', data: memo }
                    return renderMemo(memo, item)
                  })}
                </div>
              </div>
            )
          })()}

          {/* Empty initial state */}
          {!showResults && (
            <div className="p-6 text-center text-muted-foreground text-sm">
              <p>Type at least 2 characters to search</p>
              <p className="text-xs mt-1">Try <code className="bg-muted px-1 rounded">code:term</code> or <code className="bg-muted px-1 rounded">term -memos</code></p>
              <p className="text-xs mt-2 text-mm-text-faint">
                <kbd className="inline-flex items-center justify-center min-w-[18px] h-5 px-1 bg-mm-bg border border-mm-border-medium rounded text-[10px] font-mono">&darr;</kbd>
                <kbd className="inline-flex items-center justify-center min-w-[18px] h-5 px-1 bg-mm-bg border border-mm-border-medium rounded text-[10px] font-mono ml-0.5">&uarr;</kbd>
                {' '}navigate
                {' '}<kbd className="inline-flex items-center justify-center min-w-[18px] h-5 px-1 bg-mm-bg border border-mm-border-medium rounded text-[10px] font-mono ml-1">&crarr;</kbd>
                {' '}select
              </p>
            </div>
          )}
        </div>

        {/* Result count footer */}
        {showResults && hasResults && (
          <div className="px-3 py-2 border-t text-xs text-mm-text-faint" role="status">
            {totalResultCount} result{totalResultCount !== 1 ? 's' : ''} across {activeTypeCount} type{activeTypeCount !== 1 ? 's' : ''}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ResultSection({
  title, icon, count, showingCount, onShowAll, children,
}: {
  title: string; icon: React.ReactNode; count: number; showingCount: number; onShowAll: () => void; children: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-center justify-between px-3 py-2 bg-[hsl(var(--mm-green)/0.08)] border-b" role="presentation">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          {icon}
          {title}
          <span className="text-muted-foreground font-normal">({count})</span>
        </div>
        {count > showingCount && (
          <button className="text-xs text-mm-green-text hover:underline flex items-center gap-1" onClick={onShowAll}>
            Show all {count}
            <ChevronDown className="w-3 h-3" />
          </button>
        )}
      </div>
      <div className="divide-y divide-border/50">
        {children}
      </div>
    </div>
  )
}
