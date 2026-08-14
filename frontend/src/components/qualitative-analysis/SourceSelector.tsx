import { useState, useMemo, useCallback, useRef } from 'react'
import { Check, ChevronDown, ChevronRight } from 'lucide-react'
import { useTreeKeyboardNav, useTreeAriaPositions } from '@/hooks/useTreeKeyboardNav'
import type { ConversationOption, TextColumnInfo, DocumentListItem, Observation } from '@/lib/api'

interface SourceSelectorProps {
  conversations: ConversationOption[]
  textColumns: TextColumnInfo[]
  documents?: DocumentListItem[]
  observations?: Observation[]
  selectedConversationIds: Set<number>
  selectedTextColumnIds: Set<number>
  selectedDocumentIds?: Set<number>
  selectedObservationIds?: Set<number>
  onConversationChange: (ids: Set<number>) => void
  onTextColumnChange: (ids: Set<number>) => void
  onDocumentChange?: (ids: Set<number>) => void
  onObservationChange?: (ids: Set<number>) => void
  onAllSourcesChange?: (convIds: Set<number>, ccolIds: Set<number>, docIds: Set<number>, obsIds: Set<number>) => void
}

export default function SourceSelector({
  conversations,
  textColumns,
  documents = [],
  observations = [],
  selectedConversationIds,
  selectedTextColumnIds,
  selectedDocumentIds = new Set(),
  selectedObservationIds = new Set(),
  onConversationChange,
  onTextColumnChange,
  onDocumentChange,
  onObservationChange,
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

  // Documents / observations expand state
  const [docsExpanded, setDocsExpanded] = useState(true)
  const [obsExpanded, setObsExpanded] = useState(true)

  // "All sources" state
  const totalSources = conversations.length + textColumns.length + documents.length + observations.length
  const totalSelected = selectedConversationIds.size + selectedTextColumnIds.size + selectedDocumentIds.size + selectedObservationIds.size
  const allEmpty = totalSelected === 0
  const allSelected = totalSelected === totalSources && totalSources > 0

  const toggleAll = useCallback(() => {
    if (allSelected) {
      if (onAllSourcesChange) {
        onAllSourcesChange(new Set(), new Set(), new Set(), new Set())
      } else {
        onConversationChange(new Set())
        onTextColumnChange(new Set())
        onDocumentChange?.(new Set())
        onObservationChange?.(new Set())
      }
    } else {
      const convIds = new Set(conversations.map(c => c.id))
      const ccolIds = new Set(textColumns.map(c => c.column_id))
      const docIds = new Set(documents.map(d => d.id))
      const obsIds = new Set(observations.map(o => o.id))
      if (onAllSourcesChange) {
        onAllSourcesChange(convIds, ccolIds, docIds, obsIds)
      } else {
        onConversationChange(convIds)
        onTextColumnChange(ccolIds)
        onDocumentChange?.(docIds)
        onObservationChange?.(obsIds)
      }
    }
  }, [allSelected, conversations, textColumns, documents, observations, onConversationChange, onTextColumnChange, onDocumentChange, onObservationChange, onAllSourcesChange])

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

  // Observation toggles
  const toggleObservation = useCallback((id: number) => {
    const next = new Set(selectedObservationIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onObservationChange?.(next)
  }, [selectedObservationIds, onObservationChange])

  const allObsSelected = observations.length > 0 && observations.every(o => selectedObservationIds.has(o.id))
  const someObsSelected = !allObsSelected && observations.some(o => selectedObservationIds.has(o.id))

  const toggleAllObs = useCallback(() => {
    if (allObsSelected) {
      onObservationChange?.(new Set())
    } else {
      onObservationChange?.(new Set(observations.map(o => o.id)))
    }
  }, [allObsSelected, observations, onObservationChange])

  /** Toggle, or set explicitly — ArrowRight/ArrowLeft mean expand/collapse, not
   *  "flip", so a second ArrowRight on an open node must not close it. */
  const toggleDatasetExpand = useCallback((datasetId: number, force?: boolean) => {
    setExpandedDatasets(prev => {
      const next = new Set(prev)
      const open = force ?? !next.has(datasetId)
      if (open) next.add(datasetId)
      else next.delete(datasetId)
      return next
    })
  }, [])

  // Keyboard navigation
  // #701(a): the keyboard layer is shared. This file used to carry its own
  // copy — the same querySelectorAll + activeElement + switch as two sibling
  // trees, minus the ArrowRight/ArrowLeft one of them had, minus the Enter key
  // none of them had.
  const handleSetExpanded = useCallback((item: HTMLElement, expand: boolean) => {
    // The section is identified by the group it owns, which is the id already
    // rendered for `aria-owns` — no second identifier to keep in step.
    const owns = item.getAttribute('aria-owns') ?? ''
    if (owns.endsWith('conversations')) setConvsExpanded(expand)
    else if (owns.endsWith('documents')) setDocsExpanded(expand)
    else if (owns.endsWith('observations')) setObsExpanded(expand)
    else if (owns.startsWith('src-tree-group-dataset-')) {
      const datasetId = Number(owns.slice('src-tree-group-dataset-'.length))
      if (Number.isFinite(datasetId)) toggleDatasetExpand(datasetId, expand)
    }
  }, [toggleDatasetExpand])

  const handleKeyDown = useTreeKeyboardNav({ treeRef, onSetExpanded: handleSetExpanded })
  useTreeAriaPositions(treeRef)

  const renderCheckbox = (checked: boolean, indeterminate?: boolean) => (
    <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
      checked ? 'bg-mm-blue border-mm-blue' : indeterminate ? 'bg-mm-blue/50 border-mm-blue/70' : 'border-mm-border-medium'
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
        aria-level={1}
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
            aria-owns="src-tree-group-conversations"
            aria-level={1}
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
            <div role="group" id="src-tree-group-conversations" className="ml-4 space-y-0.5">
              {conversations.map(conv => (
                <div
                  key={conv.id}
                  role="treeitem"
                  tabIndex={-1}
                  aria-level={2}
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
              aria-owns={`src-tree-group-dataset-${datasetId}`}
              aria-level={1}
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
              <div role="group" id={`src-tree-group-dataset-${datasetId}`} className="ml-4 space-y-0.5">
                {columns.map(col => (
                  <div
                    key={col.column_id}
                    role="treeitem"
                    tabIndex={-1}
                    aria-level={2}
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
            aria-owns="src-tree-group-documents"
            aria-level={1}
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
            <div role="group" id="src-tree-group-documents" className="ml-4 space-y-0.5">
              {documents.map(doc => (
                <div
                  key={doc.id}
                  role="treeitem"
                  tabIndex={-1}
                  aria-level={2}
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

      {/* Observations section */}
      {observations.length > 0 && (
        <div role="none">
          <div
            role="treeitem"
            tabIndex={-1}
            aria-expanded={obsExpanded}
            aria-owns="src-tree-group-observations"
            aria-level={1}
            aria-checked={allObsSelected}
            className="flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:bg-mm-surface-hover rounded"
            onClick={toggleAllObs}
          >
            <button
              className="flex-shrink-0 p-0.5 -ml-0.5 rounded hover:bg-mm-border-light"
              onClick={e => { e.stopPropagation(); setObsExpanded(!obsExpanded) }}
              aria-label={obsExpanded ? 'Collapse observations' : 'Expand observations'}
            >
              {obsExpanded
                ? <ChevronDown className="w-3 h-3 text-mm-text-faint" />
                : <ChevronRight className="w-3 h-3 text-mm-text-faint" />
              }
            </button>
            {renderCheckbox(allObsSelected, someObsSelected)}
            <span className="text-xs font-semibold text-mm-text-muted uppercase tracking-wide">Observations</span>
            <span className="text-xs text-mm-text-faint ml-auto tabular-nums">{observations.length}</span>
          </div>
          {obsExpanded && (
            <div role="group" id="src-tree-group-observations" className="ml-4 space-y-0.5">
              {observations.map(obs => (
                <div
                  key={obs.id}
                  role="treeitem"
                  tabIndex={-1}
                  aria-level={2}
                  aria-checked={selectedObservationIds.has(obs.id)}
                  className="flex items-center gap-2 px-2 py-1 text-sm rounded cursor-pointer hover:bg-mm-surface-hover"
                  onClick={() => toggleObservation(obs.id)}
                >
                  {renderCheckbox(selectedObservationIds.has(obs.id))}
                  <span className="truncate">{obs.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {conversations.length === 0 && textColumns.length === 0 && documents.length === 0 && observations.length === 0 && (
        <p className="text-xs text-mm-text-faint text-center py-4">No sources available.</p>
      )}
    </div>
  )
}
