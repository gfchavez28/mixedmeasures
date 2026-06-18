import { useState, useMemo, useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Check, ChevronDown, ChevronRight } from 'lucide-react'
import type { ConversationOption, TextColumnInfo, DocumentListItem } from '@/lib/api'

interface SourceSelectorProps {
  conversations: ConversationOption[]
  textColumns: TextColumnInfo[]
  documents?: DocumentListItem[]
  selectedConversationIds: Set<number>
  selectedTextColumnIds: Set<number>
  selectedDocumentIds?: Set<number>
  onConversationChange: (ids: Set<number>) => void
  onTextColumnChange: (ids: Set<number>) => void
  onDocumentChange?: (ids: Set<number>) => void
  onAllSourcesChange?: (convIds: Set<number>, ccolIds: Set<number>, docIds: Set<number>) => void
}

export default function SourceSelector({
  conversations,
  textColumns,
  documents = [],
  selectedConversationIds,
  selectedTextColumnIds,
  selectedDocumentIds = new Set(),
  onConversationChange,
  onTextColumnChange,
  onDocumentChange,
  onAllSourcesChange,
}: SourceSelectorProps) {
  const [convsExpanded, setConvsExpanded] = useState(true)
  const [expandedDatasets, setExpandedDatasets] = useState<Set<number>>(new Set())
  const treeRef = useRef<HTMLDivElement>(null)

  // Group comment columns by dataset
  const datasetGroups = useMemo(() => {
    const map = new Map<number, { datasetName: string; columns: TextColumnInfo[] }>()
    for (const col of textColumns) {
      let entry = map.get(col.dataset_id)
      if (!entry) {
        entry = { datasetName: col.dataset_name, columns: [] }
        map.set(col.dataset_id, entry)
      }
      entry.columns.push(col)
    }
    return Array.from(map.entries())
  }, [textColumns])

  // Documents expand state
  const [docsExpanded, setDocsExpanded] = useState(true)

  // "All sources" state
  const totalSources = conversations.length + textColumns.length + documents.length
  const totalSelected = selectedConversationIds.size + selectedTextColumnIds.size + selectedDocumentIds.size
  const allEmpty = totalSelected === 0
  const allSelected = totalSelected === totalSources && totalSources > 0

  const toggleAll = useCallback(() => {
    if (allSelected) {
      if (onAllSourcesChange) {
        onAllSourcesChange(new Set(), new Set(), new Set())
      } else {
        onConversationChange(new Set())
        onTextColumnChange(new Set())
        onDocumentChange?.(new Set())
      }
    } else {
      const convIds = new Set(conversations.map(c => c.id))
      const ccolIds = new Set(textColumns.map(c => c.column_id))
      const docIds = new Set(documents.map(d => d.id))
      if (onAllSourcesChange) {
        onAllSourcesChange(convIds, ccolIds, docIds)
      } else {
        onConversationChange(convIds)
        onTextColumnChange(ccolIds)
        onDocumentChange?.(docIds)
      }
    }
  }, [allSelected, conversations, textColumns, documents, onConversationChange, onTextColumnChange, onDocumentChange, onAllSourcesChange])

  // Conversation toggles
  const toggleConversation = useCallback((id: number) => {
    const next = new Set(selectedConversationIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onConversationChange(next)
  }, [selectedConversationIds, onConversationChange])

  const allConvsSelected = conversations.length > 0 && conversations.every(c => selectedConversationIds.has(c.id))
  const someConvsSelected = !allConvsSelected && conversations.some(c => selectedConversationIds.has(c.id))

  const toggleAllConvs = useCallback(() => {
    if (allConvsSelected) {
      onConversationChange(new Set())
    } else {
      onConversationChange(new Set(conversations.map(c => c.id)))
    }
  }, [allConvsSelected, conversations, onConversationChange])

  // Comment column toggles
  const toggleTextColumn = useCallback((id: number) => {
    const next = new Set(selectedTextColumnIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onTextColumnChange(next)
  }, [selectedTextColumnIds, onTextColumnChange])

  const toggleDataset = useCallback((datasetId: number) => {
    const cols = textColumns.filter(c => c.dataset_id === datasetId)
    const allSel = cols.every(c => selectedTextColumnIds.has(c.column_id))
    const next = new Set(selectedTextColumnIds)
    if (allSel) {
      for (const c of cols) next.delete(c.column_id)
    } else {
      for (const c of cols) next.add(c.column_id)
    }
    onTextColumnChange(next)
  }, [textColumns, selectedTextColumnIds, onTextColumnChange])

  // Document toggles
  const toggleDocument = useCallback((id: number) => {
    const next = new Set(selectedDocumentIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onDocumentChange?.(next)
  }, [selectedDocumentIds, onDocumentChange])

  const allDocsSelected = documents.length > 0 && documents.every(d => selectedDocumentIds.has(d.id))
  const someDocsSelected = !allDocsSelected && documents.some(d => selectedDocumentIds.has(d.id))

  const toggleAllDocs = useCallback(() => {
    if (allDocsSelected) {
      onDocumentChange?.(new Set())
    } else {
      onDocumentChange?.(new Set(documents.map(d => d.id)))
    }
  }, [allDocsSelected, documents, onDocumentChange])

  const toggleDatasetExpand = useCallback((datasetId: number) => {
    setExpandedDatasets(prev => {
      const next = new Set(prev)
      if (next.has(datasetId)) next.delete(datasetId)
      else next.add(datasetId)
      return next
    })
  }, [])

  // Keyboard navigation
  const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = treeRef.current?.querySelectorAll('[role="treeitem"]')
    if (!items || items.length === 0) return

    const focused = document.activeElement as HTMLElement
    const idx = Array.from(items).indexOf(focused)
    if (idx === -1) return

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        const next = items[Math.min(idx + 1, items.length - 1)] as HTMLElement
        next?.focus()
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        const prev = items[Math.max(idx - 1, 0)] as HTMLElement
        prev?.focus()
        break
      }
      case ' ': {
        e.preventDefault()
        focused.click()
        break
      }
      case 'Home': {
        e.preventDefault()
        ;(items[0] as HTMLElement)?.focus()
        break
      }
      case 'End': {
        e.preventDefault()
        ;(items[items.length - 1] as HTMLElement)?.focus()
        break
      }
    }
  }, [])

  const renderCheckbox = (checked: boolean, indeterminate?: boolean) => (
    <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
      checked ? 'bg-blue-500 border-blue-500' : indeterminate ? 'bg-blue-300 border-blue-400' : 'border-mm-border-medium'
    }`}>
      {checked && <Check className="w-3 h-3 text-white" />}
      {indeterminate && !checked && <span className="w-2 h-0.5 bg-white rounded-full" />}
    </span>
  )

  const getColLabel = (col: TextColumnInfo) =>
    col.column_name || (col.column_text.length > 60 ? col.column_text.slice(0, 57) + '\u2026' : col.column_text)

  return (
    <div
      ref={treeRef}
      role="tree"
      aria-label="Source selection"
      className="overflow-y-auto px-1 space-y-0.5"
      onKeyDown={handleKeyDown}
    >
      {/* Select all / hint */}
      <div
        role="treeitem"
        tabIndex={0}
        aria-checked={allSelected}
        className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-mm-surface-hover cursor-pointer"
        onClick={toggleAll}
      >
        {renderCheckbox(allSelected, !allEmpty && !allSelected)}
        <span className="text-sm font-medium">Select all sources</span>
      </div>

      {allEmpty && (
        <p className="text-xs text-mm-text-faint px-2 py-1">
          Select sources to include in analysis
        </p>
      )}

      {/* Conversations section */}
      {conversations.length > 0 && (
        <div role="none">
          <div
            role="treeitem"
            tabIndex={-1}
            aria-expanded={convsExpanded}
            aria-checked={allConvsSelected}
            className="flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:bg-mm-surface-hover rounded"
            onClick={toggleAllConvs}
          >
            <button
              className="flex-shrink-0 p-0.5 -ml-0.5 rounded hover:bg-mm-border-light"
              onClick={e => { e.stopPropagation(); setConvsExpanded(!convsExpanded) }}
              aria-label={convsExpanded ? 'Collapse conversations' : 'Expand conversations'}
            >
              {convsExpanded
                ? <ChevronDown className="w-3 h-3 text-mm-text-faint" />
                : <ChevronRight className="w-3 h-3 text-mm-text-faint" />
              }
            </button>
            {renderCheckbox(allConvsSelected, someConvsSelected)}
            <span className="text-xs font-semibold text-mm-text-muted uppercase tracking-wide">Conversations</span>
            <span className="text-xs text-mm-text-faint ml-auto tabular-nums">{conversations.length}</span>
          </div>
          {convsExpanded && (
            <div role="group" className="ml-4 space-y-0.5">
              {conversations.map(conv => (
                <div
                  key={conv.id}
                  role="treeitem"
                  tabIndex={-1}
                  aria-checked={selectedConversationIds.has(conv.id)}
                  className="flex items-center gap-2 px-2 py-1 text-sm rounded cursor-pointer hover:bg-mm-surface-hover"
                  onClick={() => toggleConversation(conv.id)}
                >
                  {renderCheckbox(selectedConversationIds.has(conv.id))}
                  <span className="truncate">{conv.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Comment columns section */}
      {datasetGroups.map(([datasetId, { datasetName, columns }]) => {
        const expanded = expandedDatasets.has(datasetId)
        const allColsSel = columns.every(c => selectedTextColumnIds.has(c.column_id))
        const someColsSel = !allColsSel && columns.some(c => selectedTextColumnIds.has(c.column_id))

        return (
          <div key={datasetId} role="none">
            <div
              role="treeitem"
              tabIndex={-1}
              aria-expanded={expanded}
              aria-checked={allColsSel}
              className="flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:bg-mm-surface-hover rounded"
              onClick={() => toggleDataset(datasetId)}
            >
              <button
                className="flex-shrink-0 p-0.5 -ml-0.5 rounded hover:bg-mm-border-light"
                onClick={e => { e.stopPropagation(); toggleDatasetExpand(datasetId) }}
                aria-label={expanded ? 'Collapse' : 'Expand'}
              >
                {expanded
                  ? <ChevronDown className="w-3 h-3 text-mm-text-faint" />
                  : <ChevronRight className="w-3 h-3 text-mm-text-faint" />
                }
              </button>
              {renderCheckbox(allColsSel, someColsSel)}
              <span className="text-xs font-semibold text-mm-text-muted uppercase tracking-wide truncate">{datasetName}</span>
              <span className="text-xs text-mm-text-faint ml-auto tabular-nums">{columns.length}</span>
            </div>
            {expanded && (
              <div role="group" className="ml-4 space-y-0.5">
                {columns.map(col => (
                  <div
                    key={col.column_id}
                    role="treeitem"
                    tabIndex={-1}
                    aria-checked={selectedTextColumnIds.has(col.column_id)}
                    className="flex items-center gap-2 px-2 py-1 text-sm rounded cursor-pointer hover:bg-mm-surface-hover"
                    onClick={() => toggleTextColumn(col.column_id)}
                  >
                    {renderCheckbox(selectedTextColumnIds.has(col.column_id))}
                    <span className="truncate" title={col.column_text}>{getColLabel(col)}</span>
                    <span className="text-xs text-mm-text-faint tabular-nums ml-auto">{col.coded_count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}

      {/* Documents section */}
      {documents.length > 0 && (
        <div role="none">
          <div
            role="treeitem"
            tabIndex={-1}
            aria-expanded={docsExpanded}
            aria-checked={allDocsSelected}
            className="flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:bg-mm-surface-hover rounded"
            onClick={toggleAllDocs}
          >
            <button
              className="flex-shrink-0 p-0.5 -ml-0.5 rounded hover:bg-mm-border-light"
              onClick={e => { e.stopPropagation(); setDocsExpanded(!docsExpanded) }}
              aria-label={docsExpanded ? 'Collapse documents' : 'Expand documents'}
            >
              {docsExpanded
                ? <ChevronDown className="w-3 h-3 text-mm-text-faint" />
                : <ChevronRight className="w-3 h-3 text-mm-text-faint" />
              }
            </button>
            {renderCheckbox(allDocsSelected, someDocsSelected)}
            <span className="text-xs font-semibold text-mm-text-muted uppercase tracking-wide">Documents</span>
            <span className="text-xs text-mm-text-faint ml-auto tabular-nums">{documents.length}</span>
          </div>
          {docsExpanded && (
            <div role="group" className="ml-4 space-y-0.5">
              {documents.map(doc => (
                <div
                  key={doc.id}
                  role="treeitem"
                  tabIndex={-1}
                  aria-checked={selectedDocumentIds.has(doc.id)}
                  className="flex items-center gap-2 px-2 py-1 text-sm rounded cursor-pointer hover:bg-mm-surface-hover"
                  onClick={() => toggleDocument(doc.id)}
                >
                  {renderCheckbox(selectedDocumentIds.has(doc.id))}
                  <span className="truncate">{doc.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {conversations.length === 0 && textColumns.length === 0 && documents.length === 0 && (
        <p className="text-xs text-mm-text-faint text-center py-4">No sources available.</p>
      )}
    </div>
  )
}
