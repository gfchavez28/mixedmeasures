import { useMemo, useState, useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { EyeOff, Filter, ChevronDown, ChevronRight } from 'lucide-react'
import type { CodebookTreeResponse, CodebookCategoryNode, Conversation, TextCodingColumn } from '@/lib/api'
import { getCodeColor } from '@/lib/utils'

interface CodebookHidePanelProps {
  treeData: CodebookTreeResponse
  conversations: Conversation[]
  textColumns: TextCodingColumn[]
  hiddenCodeIds: Set<number>
  hiddenConvIds: Set<number>
  hiddenColIds: Set<number>
  onHiddenCodeIdsChange: (ids: Set<number>) => void
  onHiddenConvIdsChange: (ids: Set<number>) => void
  onHiddenColIdsChange: (ids: Set<number>) => void
  onClearAll: () => void
}

interface CodeEntry {
  id: number
  name: string
  color: string | null
  categoryColor: string | null
}

interface CodeGroup {
  categoryId: number | null
  categoryName: string
  codes: CodeEntry[]
}

function getColLabel(col: TextCodingColumn): string {
  if (col.column_name) return col.column_name
  return col.column_text.length > 40 ? col.column_text.slice(0, 37) + '\u2026' : col.column_text
}

export default function CodebookHidePanel({
  treeData,
  conversations,
  textColumns,
  hiddenCodeIds,
  hiddenConvIds,
  hiddenColIds,
  onHiddenCodeIdsChange,
  onHiddenConvIdsChange,
  onHiddenColIdsChange,
  onClearAll,
}: CodebookHidePanelProps) {
  const [codesExpanded, setCodesExpanded] = useState(true)
  const [sourcesExpanded, setSourcesExpanded] = useState(true)
  const [expandedDatasets, setExpandedDatasets] = useState<Set<number>>(new Set())
  const treeRef = useRef<HTMLDivElement>(null)

  // Build code groups from treeData
  const codeGroups = useMemo((): CodeGroup[] => {
    const groups: CodeGroup[] = []

    function walkCat(nodes: CodebookCategoryNode[]) {
      for (const cat of nodes) {
        if (cat.codes.length > 0) {
          groups.push({
            categoryId: cat.id,
            categoryName: cat.name,
            codes: cat.codes.map(c => ({
              id: c.id,
              name: c.name,
              color: c.color,
              categoryColor: cat.color,
            })),
          })
        }
        walkCat(cat.children)
      }
    }
    walkCat(treeData.tree)

    // Uncategorized codes (non-universal)
    if (treeData.uncategorized_codes.length > 0) {
      groups.push({
        categoryId: null,
        categoryName: 'Uncategorized',
        codes: treeData.uncategorized_codes.map(c => ({
          id: c.id,
          name: c.name,
          color: c.color,
          categoryColor: null,
        })),
      })
    }

    return groups
  }, [treeData])

  // All code IDs for "hide all" / counts
  const allCodeIds = useMemo(() => {
    const ids: number[] = []
    for (const g of codeGroups) {
      for (const c of g.codes) ids.push(c.id)
    }
    // Universal codes are never hideable
    return ids
  }, [codeGroups])

  // Group comment columns by dataset
  const datasetGroups = useMemo(() => {
    const map = new Map<number, { datasetName: string; columns: TextCodingColumn[] }>()
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

  const totalHidden = hiddenCodeIds.size + hiddenConvIds.size + hiddenColIds.size
  const hasAnyCodes = allCodeIds.length > 0
  const hasAnySources = conversations.length > 0 || textColumns.length > 0

  // Toggle helpers
  const toggleCode = useCallback((codeId: number) => {
    const next = new Set(hiddenCodeIds)
    if (next.has(codeId)) next.delete(codeId)
    else next.add(codeId)
    onHiddenCodeIdsChange(next)
  }, [hiddenCodeIds, onHiddenCodeIdsChange])

  const toggleConversation = useCallback((convId: number) => {
    const next = new Set(hiddenConvIds)
    if (next.has(convId)) next.delete(convId)
    else next.add(convId)
    onHiddenConvIdsChange(next)
  }, [hiddenConvIds, onHiddenConvIdsChange])

  const toggleTextCodingColumn = useCallback((colId: number) => {
    const next = new Set(hiddenColIds)
    if (next.has(colId)) next.delete(colId)
    else next.add(colId)
    onHiddenColIdsChange(next)
  }, [hiddenColIds, onHiddenColIdsChange])

  const toggleDataset = useCallback((datasetId: number) => {
    const cols = textColumns.filter(c => c.dataset_id === datasetId)
    const allHidden = cols.every(c => hiddenColIds.has(c.column_id))
    const next = new Set(hiddenColIds)
    if (allHidden) {
      for (const c of cols) next.delete(c.column_id)
    } else {
      for (const c of cols) next.add(c.column_id)
    }
    onHiddenColIdsChange(next)
  }, [textColumns, hiddenColIds, onHiddenColIdsChange])

  const toggleDatasetExpand = useCallback((datasetId: number) => {
    setExpandedDatasets(prev => {
      const next = new Set(prev)
      if (next.has(datasetId)) next.delete(datasetId)
      else next.add(datasetId)
      return next
    })
  }, [])

  // Keyboard nav
  const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = treeRef.current?.querySelectorAll('[role="treeitem"]')
    if (!items || items.length === 0) return
    const focused = document.activeElement as HTMLElement
    const idx = Array.from(items).indexOf(focused)
    if (idx === -1) return

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        ;(items[Math.min(idx + 1, items.length - 1)] as HTMLElement)?.focus()
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        ;(items[Math.max(idx - 1, 0)] as HTMLElement)?.focus()
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

  const renderCheckbox = (checked: boolean) => (
    <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
      checked ? 'bg-orange-500 border-orange-500' : 'border-mm-border-medium'
    }`}>
      {checked && (
        <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 6l3 3 5-5" />
        </svg>
      )}
    </span>
  )

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b border-mm-border-subtle flex items-center gap-2 shrink-0">
        <EyeOff className="w-3.5 h-3.5 text-mm-text-muted" />
        <span className="text-xs font-medium text-mm-text">Hide from Codebook</span>
        {totalHidden > 0 && (
          <span className="ml-auto px-1.5 py-0.5 rounded-full bg-orange-200 dark:bg-orange-800/50 text-orange-800 dark:text-orange-200 text-[10px] font-bold">
            {totalHidden}
          </span>
        )}
      </div>

      {/* Content */}
      <div
        ref={treeRef}
        role="tree"
        aria-label="Hide from codebook"
        className="flex-1 overflow-y-auto px-1 py-1 space-y-0.5"
        onKeyDown={handleKeyDown}
      >
        {/* ── Codes section ────────────────────────────────────── */}
        {hasAnyCodes && (
          <div role="none">
            <div
              role="treeitem"
              tabIndex={0}
              aria-expanded={codesExpanded}
              className="flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:bg-mm-surface-hover rounded"
              onClick={() => setCodesExpanded(!codesExpanded)}
            >
              {codesExpanded
                ? <ChevronDown className="w-3 h-3 text-mm-text-faint shrink-0" />
                : <ChevronRight className="w-3 h-3 text-mm-text-faint shrink-0" />
              }
              <EyeOff className="w-3 h-3 text-mm-text-faint shrink-0" />
              <span className="text-[11px] font-semibold text-mm-text-muted uppercase tracking-wide">Codes</span>
              {hiddenCodeIds.size > 0 && (
                <span className="text-[10px] text-orange-600 dark:text-orange-400 ml-auto tabular-nums">{hiddenCodeIds.size} hidden</span>
              )}
            </div>
            {codesExpanded && (
              <div role="group" className="ml-2 space-y-0.5">
                {codeGroups.map(group => (
                  <div key={group.categoryId ?? 'uncategorized'}>
                    {group.categoryId !== null && (
                      <div className="text-[10px] text-mm-text-faint mt-1.5 mb-0.5 pl-2">{group.categoryName}</div>
                    )}
                    {group.codes.map(code => {
                      const isHidden = hiddenCodeIds.has(code.id)
                      return (
                        <div
                          key={code.id}
                          role="treeitem"
                          tabIndex={-1}
                          aria-checked={isHidden}
                          className="flex items-center gap-1.5 px-2 py-0.5 text-xs rounded cursor-pointer hover:bg-mm-surface-hover"
                          onClick={() => toggleCode(code.id)}
                        >
                          {renderCheckbox(isHidden)}
                          <span
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: getCodeColor({ color: code.color, category_color: code.categoryColor }) }}
                          />
                          <span className={`truncate text-mm-text-secondary ${isHidden ? 'line-through text-mm-text-faint' : ''}`}>
                            {code.name}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Sources section ──────────────────────────────────── */}
        {hasAnySources && (
          <div role="none">
            <div
              role="treeitem"
              tabIndex={-1}
              aria-expanded={sourcesExpanded}
              className="flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:bg-mm-surface-hover rounded mt-1"
              onClick={() => setSourcesExpanded(!sourcesExpanded)}
            >
              {sourcesExpanded
                ? <ChevronDown className="w-3 h-3 text-mm-text-faint shrink-0" />
                : <ChevronRight className="w-3 h-3 text-mm-text-faint shrink-0" />
              }
              <Filter className="w-3 h-3 text-mm-text-faint shrink-0" />
              <span className="text-[11px] font-semibold text-mm-text-muted uppercase tracking-wide">Sources</span>
              {(hiddenConvIds.size > 0 || hiddenColIds.size > 0) && (
                <span className="text-[10px] text-orange-600 dark:text-orange-400 ml-auto tabular-nums">
                  {hiddenConvIds.size + hiddenColIds.size} hidden
                </span>
              )}
            </div>
            {sourcesExpanded && (
              <div role="group" className="ml-2 space-y-0.5">
                {/* Conversations */}
                {conversations.map(conv => {
                  const isHidden = hiddenConvIds.has(conv.id)
                  return (
                    <div
                      key={`conv-${conv.id}`}
                      role="treeitem"
                      tabIndex={-1}
                      aria-checked={isHidden}
                      className="flex items-center gap-1.5 px-2 py-0.5 text-xs rounded cursor-pointer hover:bg-mm-surface-hover"
                      onClick={() => toggleConversation(conv.id)}
                    >
                      {renderCheckbox(isHidden)}
                      <span className={`truncate text-mm-text-secondary ${isHidden ? 'line-through text-mm-text-faint' : ''}`}>
                        {conv.name}
                      </span>
                      <span className="text-[10px] text-mm-text-faint tabular-nums ml-auto">{conv.segment_count}</span>
                    </div>
                  )
                })}

                {/* Comment columns by dataset */}
                {datasetGroups.map(([datasetId, { datasetName, columns }]) => {
                  const expanded = expandedDatasets.has(datasetId)
                  const allHidden = columns.every(c => hiddenColIds.has(c.column_id))

                  return (
                    <div key={`ds-${datasetId}`} role="none">
                      <div
                        role="treeitem"
                        tabIndex={-1}
                        aria-expanded={expanded}
                        className="flex items-center gap-1.5 px-2 py-0.5 cursor-pointer hover:bg-mm-surface-hover rounded"
                      >
                        <span onClick={e => { e.stopPropagation(); toggleDataset(datasetId) }}>
                          {renderCheckbox(allHidden)}
                        </span>
                        <button
                          className="flex items-center gap-1 flex-1 min-w-0 text-left"
                          onClick={() => toggleDatasetExpand(datasetId)}
                          aria-label={expanded ? 'Collapse' : 'Expand'}
                        >
                          {expanded
                            ? <ChevronDown className="w-3 h-3 text-mm-text-faint shrink-0" />
                            : <ChevronRight className="w-3 h-3 text-mm-text-faint shrink-0" />
                          }
                          <span className="text-[10px] text-mm-text-faint truncate">{datasetName}</span>
                          <span className="text-[10px] text-mm-text-faint ml-auto tabular-nums">{columns.length}</span>
                        </button>
                      </div>
                      {expanded && (
                        <div role="group" className="ml-4 space-y-0.5">
                          {columns.map(col => {
                            const isHidden = hiddenColIds.has(col.column_id)
                            return (
                              <div
                                key={col.column_id}
                                role="treeitem"
                                tabIndex={-1}
                                aria-checked={isHidden}
                                className="flex items-center gap-1.5 px-2 py-0.5 text-xs rounded cursor-pointer hover:bg-mm-surface-hover"
                                onClick={() => toggleTextCodingColumn(col.column_id)}
                              >
                                {renderCheckbox(isHidden)}
                                <span
                                  className={`truncate text-mm-text-secondary ${isHidden ? 'line-through text-mm-text-faint' : ''}`}
                                  title={col.column_text}
                                >
                                  {getColLabel(col)}
                                </span>
                                <span className="text-[10px] text-mm-text-faint tabular-nums ml-auto">{col.non_empty_rows}</span>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {!hasAnyCodes && !hasAnySources && (
          <p className="text-xs text-mm-text-faint text-center py-4">No codes or sources available.</p>
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-2 border-t border-mm-border-subtle text-[11px] text-mm-text-faint flex items-center justify-between shrink-0">
        <span>
          {totalHidden === 0
            ? 'Nothing hidden'
            : `${hiddenCodeIds.size > 0 ? `${hiddenCodeIds.size} code${hiddenCodeIds.size !== 1 ? 's' : ''}` : ''}${hiddenCodeIds.size > 0 && (hiddenConvIds.size > 0 || hiddenColIds.size > 0) ? ' \u00b7 ' : ''}${hiddenConvIds.size + hiddenColIds.size > 0 ? `${hiddenConvIds.size + hiddenColIds.size} source${hiddenConvIds.size + hiddenColIds.size !== 1 ? 's' : ''}` : ''}`
          }
        </span>
        {totalHidden > 0 && (
          <button
            onClick={onClearAll}
            className="text-mm-blue-text hover:underline"
          >
            Show all
          </button>
        )}
      </div>
    </div>
  )
}
