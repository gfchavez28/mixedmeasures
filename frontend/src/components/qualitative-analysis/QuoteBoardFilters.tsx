import { useMemo } from 'react'
import type { Code, CodeCategory, ConversationOption, TextColumnInfo } from '@/lib/api'
import { Checkbox } from '@/components/ui/checkbox'
import { getCodeColor } from '@/lib/utils'

interface DocumentOption {
  id: number
  name: string
}

interface QuoteBoardFiltersProps {
  codes: Code[]
  categories: CodeCategory[]
  conversations: ConversationOption[]
  textColumns: TextColumnInfo[]
  documents?: DocumentOption[]
  hiddenCodeIds: Set<number>
  hideUncoded: boolean
  hiddenConversationIds: Set<number>
  hiddenTextColumnIds: Set<number>
  hiddenDocumentIds?: Set<number>
  onHiddenCodeIdsChange: (ids: Set<number>) => void
  onHideUncodedChange: (v: boolean) => void
  onHiddenConversationIdsChange: (ids: Set<number>) => void
  onHiddenTextColumnIdsChange: (ids: Set<number>) => void
  onHiddenDocumentIdsChange?: (ids: Set<number>) => void
  onClearAll: () => void
  hasActiveFilters: boolean
}

interface CodeGroup {
  categoryId: number | null
  categoryName: string
  codes: Code[]
}

function getColLabel(col: TextColumnInfo): string {
  if (col.column_name) return col.column_name
  return col.column_text.length > 40 ? col.column_text.slice(0, 37) + '...' : col.column_text
}

export default function QuoteBoardFilters({
  codes,
  categories,
  conversations,
  textColumns,
  documents,
  hiddenCodeIds,
  hideUncoded,
  hiddenConversationIds,
  hiddenTextColumnIds,
  hiddenDocumentIds,
  onHiddenCodeIdsChange,
  onHideUncodedChange,
  onHiddenConversationIdsChange,
  onHiddenTextColumnIdsChange,
  onHiddenDocumentIdsChange,
  onClearAll,
  hasActiveFilters,
}: QuoteBoardFiltersProps) {
  // Group codes by category
  const codeGroups = useMemo((): CodeGroup[] => {
    const catMap = new Map<number | null, Code[]>()
    const catOrder: (number | null)[] = []
    for (const code of codes) {
      const cid = code.category_id ?? null
      if (!catMap.has(cid)) {
        catMap.set(cid, [])
        catOrder.push(cid)
      }
      catMap.get(cid)!.push(code)
    }
    const catLookup = new Map(categories.map(c => [c.id, c.name]))
    return catOrder.map(cid => ({
      categoryId: cid,
      categoryName: cid !== null ? (catLookup.get(cid) ?? 'Unknown') : 'Uncategorized',
      codes: catMap.get(cid)!,
    }))
  }, [codes, categories])

  const hasCategories = categories.length > 0

  // Group comment columns by dataset
  const columnsByDataset = useMemo(() => {
    const map = new Map<number, { name: string; columns: TextColumnInfo[] }>()
    for (const col of textColumns) {
      if (!map.has(col.dataset_id)) {
        map.set(col.dataset_id, { name: col.dataset_name, columns: [] })
      }
      map.get(col.dataset_id)!.columns.push(col)
    }
    return map
  }, [textColumns])

  const toggleCode = (codeId: number) => {
    const next = new Set(hiddenCodeIds)
    if (next.has(codeId)) next.delete(codeId)
    else next.add(codeId)
    onHiddenCodeIdsChange(next)
  }

  const toggleConversation = (convId: number) => {
    const next = new Set(hiddenConversationIds)
    if (next.has(convId)) next.delete(convId)
    else next.add(convId)
    onHiddenConversationIdsChange(next)
  }

  const toggleTextColumn = (colId: number) => {
    const next = new Set(hiddenTextColumnIds)
    if (next.has(colId)) next.delete(colId)
    else next.add(colId)
    onHiddenTextColumnIdsChange(next)
  }

  const toggleDocument = (docId: number) => {
    if (!hiddenDocumentIds || !onHiddenDocumentIdsChange) return
    const next = new Set(hiddenDocumentIds)
    if (next.has(docId)) next.delete(docId)
    else next.add(docId)
    onHiddenDocumentIdsChange(next)
  }

  return (
    <div className="space-y-3 text-xs">
      {hasActiveFilters && (
        <button
          className="text-mm-blue-text hover:underline text-xs"
          onClick={onClearAll}
        >
          Clear all filters
        </button>
      )}

      {/* Codes section */}
      {codes.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold text-mm-text-faint uppercase tracking-wider mb-1.5">Codes</div>
          <div className="space-y-0.5">
            <label className="flex items-center gap-1.5 py-0.5 cursor-pointer">
              <Checkbox
                checked={hideUncoded}
                onCheckedChange={v => onHideUncodedChange(v === true)}
              />
              <span className={`text-mm-text-secondary ${hideUncoded ? 'line-through text-mm-text-faint' : ''}`}>
                Uncoded excerpts
              </span>
            </label>
            {hasCategories ? (
              codeGroups.map(group => (
                <div key={group.categoryId ?? 'uncategorized'}>
                  {group.categoryId !== null && (
                    <div className="text-[10px] text-mm-text-faint mt-1.5 mb-0.5 pl-1">{group.categoryName}</div>
                  )}
                  {group.codes.map(code => (
                    <label key={code.id} className="flex items-center gap-1.5 py-0.5 cursor-pointer pl-2">
                      <Checkbox
                        checked={hiddenCodeIds.has(code.id)}
                        onCheckedChange={() => toggleCode(code.id)}
                      />
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: getCodeColor(code) }}
                      />
                      <span className={`text-mm-text-secondary truncate ${hiddenCodeIds.has(code.id) ? 'line-through text-mm-text-faint' : ''}`}>
                        {code.name}
                      </span>
                    </label>
                  ))}
                </div>
              ))
            ) : (
              codes.map(code => (
                <label key={code.id} className="flex items-center gap-1.5 py-0.5 cursor-pointer">
                  <Checkbox
                    checked={hiddenCodeIds.has(code.id)}
                    onCheckedChange={() => toggleCode(code.id)}
                  />
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: getCodeColor(code) }}
                  />
                  <span className={`text-mm-text-secondary truncate ${hiddenCodeIds.has(code.id) ? 'line-through text-mm-text-faint' : ''}`}>
                    {code.name}
                  </span>
                </label>
              ))
            )}
          </div>
        </div>
      )}

      {/* Sources section */}
      {(conversations.length > 0 || textColumns.length > 0 || (documents && documents.length > 0)) && (
        <div>
          <div className="text-[10px] font-semibold text-mm-text-faint uppercase tracking-wider mb-1.5">Sources</div>
          <div className="space-y-0.5">
            {conversations.map(conv => (
              <label key={`conv-${conv.id}`} className="flex items-center gap-1.5 py-0.5 cursor-pointer">
                <Checkbox
                  checked={hiddenConversationIds.has(conv.id)}
                  onCheckedChange={() => toggleConversation(conv.id)}
                />
                <span className={`text-mm-text-secondary truncate ${hiddenConversationIds.has(conv.id) ? 'line-through text-mm-text-faint' : ''}`}>
                  {conv.name}
                </span>
              </label>
            ))}
            {Array.from(columnsByDataset.entries()).map(([datasetId, { name, columns }]) => (
              <div key={`ds-${datasetId}`}>
                <div className="text-[10px] text-mm-text-faint mt-1.5 mb-0.5 pl-1">{name}</div>
                {columns.map(col => (
                  <label key={`ccol-${col.column_id}`} className="flex items-center gap-1.5 py-0.5 cursor-pointer pl-2">
                    <Checkbox
                      checked={hiddenTextColumnIds.has(col.column_id)}
                      onCheckedChange={() => toggleTextColumn(col.column_id)}
                    />
                    <span className={`text-mm-text-secondary truncate ${hiddenTextColumnIds.has(col.column_id) ? 'line-through text-mm-text-faint' : ''}`}>
                      {getColLabel(col)}
                    </span>
                  </label>
                ))}
              </div>
            ))}
            {documents && documents.length > 0 && hiddenDocumentIds && (
              <>
                {(conversations.length > 0 || textColumns.length > 0) && (
                  <div className="text-[10px] text-mm-text-faint mt-1.5 mb-0.5 pl-1">Documents</div>
                )}
                {documents.map(doc => (
                  <label key={`doc-${doc.id}`} className="flex items-center gap-1.5 py-0.5 cursor-pointer pl-2">
                    <Checkbox
                      checked={hiddenDocumentIds.has(doc.id)}
                      onCheckedChange={() => toggleDocument(doc.id)}
                    />
                    <span className={`text-mm-text-secondary truncate ${hiddenDocumentIds.has(doc.id) ? 'line-through text-mm-text-faint' : ''}`}>
                      {doc.name}
                    </span>
                  </label>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
