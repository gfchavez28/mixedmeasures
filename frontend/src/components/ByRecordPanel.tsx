import { useMemo, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { SELECTED_CARD } from '@/lib/selection'
import { useNavigate } from 'react-router-dom'
import { ExternalLink, MapPin, Quote } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { textCodingApi, type TextCodingResponse, type RecordContext, type Coder } from '@/lib/api'
import TextCodingContextMenu from '@/components/TextCodingContextMenu'
import { useCodeShortcutLabels } from '@/hooks/useCodeShortcutLabels'
import type { FloatingCoords } from '@/lib/floating-utils'
import CodeChip from '@/components/qualitative-analysis/CodeChip'
import { useCoders } from '@/hooks/useCoders'
import { mergeArchivedIntoCoderMap, chipHiddenWithArchived } from '@/lib/coder-color'
import { visibleCodeChipRows } from '@/lib/coding-progress'

interface ByRecordPanelProps {
  projectId: number
  comments: TextCodingResponse[]
  focalColumnIds: number[]
  selectedRecordId: number | null
  codes: Array<{ id: number; name: string; color: string | null; category_color?: string | null; category_name?: string | null; is_active?: boolean; category_id?: number | null; is_universal?: boolean; numeric_id?: number | null }>
  selectedValueIds?: number[]
  onSelectComment?: (dvId: number) => void
  onQuoteToggle?: (dvId: number) => void
  onContextCodeApply?: (dvId: number, codeId: number) => void
  onContextCreateCode?: (coords: FloatingCoords) => void
  onContextCreateNote?: (dvId: number, coords: FloatingCoords) => void
  hiddenCoderIds?: Set<number>  // Track J · J1 visibility filter
  activeCoderId?: number | null  // Track J · J1 active coder (#446 context-menu check)
  extraCoders?: Coder[]  // #451 archived-who-coded — folded into the chip map
  showArchived?: boolean  // #451 "view all coders" — reveal archived chips
}

export default function ByRecordPanel({
  projectId,
  comments,
  focalColumnIds,
  selectedRecordId,
  codes,
  selectedValueIds = [],
  onSelectComment,
  onQuoteToggle,
  onContextCodeApply,
  onContextCreateCode,
  onContextCreateNote,
  hiddenCoderIds,
  activeCoderId,
  extraCoders,
  showArchived,
}: ByRecordPanelProps) {
  const navigate = useNavigate()

  // Get unique records in order
  const records = useMemo(() => {
    const seen = new Map<number, TextCodingResponse>()
    for (const c of comments) {
      if (!seen.has(c.dataset_row_id)) seen.set(c.dataset_row_id, c)
    }
    return Array.from(seen.values())
  }, [comments])

  // Auto-select first if none selected
  const currentRecordId = selectedRecordId ?? records[0]?.dataset_row_id ?? null

  // Get context data for current record
  const { data: context } = useQuery<RecordContext>({
    queryKey: ['record-context', projectId, currentRecordId],
    queryFn: () => textCodingApi.recordContext(projectId, currentRecordId!),
    enabled: currentRecordId !== null,
  })

  // Comments for current record
  const recordComments = useMemo(() => {
    if (!currentRecordId) return []
    return comments.filter(c => c.dataset_row_id === currentRecordId)
  }, [comments, currentRecordId])

  const codeMap = useMemo(() => Object.fromEntries(codes.map(c => [c.id, c])), [codes])
  const { coderMap, multiCoder } = useCoders()  // attribution badges (Track J · J1, multi-coder only)
  // #451: fold archived-who-coded into the chip map + hide them unless "view all".
  const effectiveCoderMap = useMemo(() => mergeArchivedIntoCoderMap(coderMap, extraCoders ?? []), [coderMap, extraCoders])
  const chipHidden = useMemo(
    () => chipHiddenWithArchived(hiddenCoderIds ?? new Set(), new Set((extraCoders ?? []).map(c => c.id)), !!showArchived),
    [hiddenCoderIds, extraCoders, showArchived],
  )
  const activeCodes = useMemo(() => codes.filter(c => c.is_active !== false), [codes])
  const codeIdToShortcutLabel = useCodeShortcutLabels(codes)
  const lastCoordsRef = useRef<FloatingCoords | null>(null)

  // Scroll selected card into view
  const cardRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  useEffect(() => {
    if (selectedValueIds.length === 1) {
      const el = cardRefs.current.get(selectedValueIds[0])
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [selectedValueIds])

  // Card keyboard navigation (arrow keys only — [/] handled by CommentView)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
      if (target.closest('[data-panel="codes"]')) return

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (recordComments.length === 0) return
        const currentDvId = selectedValueIds[selectedValueIds.length - 1]
        const currentIdx = recordComments.findIndex(c => c.dataset_value_id === currentDvId)
        const nextIdx = e.key === 'ArrowDown'
          ? Math.min(currentIdx + 1, recordComments.length - 1)
          : Math.max(currentIdx - 1, 0)
        if (nextIdx < 0 || nextIdx >= recordComments.length) return
        onSelectComment?.(recordComments[nextIdx].dataset_value_id)
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedValueIds, recordComments, onSelectComment])

  if (records.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        No records found.
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Main content: split view */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: record's comments */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4" role="listbox" aria-label="Record text">
          {recordComments.map(comment => {
            const isSelected = selectedValueIds.includes(comment.dataset_value_id)
            return (
              <ContextMenu key={comment.dataset_value_id}>
                <ContextMenuTrigger asChild>
                  <div
                    ref={(el) => { if (el) cardRefs.current.set(comment.dataset_value_id, el); else cardRefs.current.delete(comment.dataset_value_id) }}
                    role="option"
                    aria-selected={isSelected}
                    className={`border rounded-lg p-3 bg-mm-surface cursor-pointer transition-colors group ${
                      isSelected ? SELECTED_CARD : 'hover:bg-mm-surface-hover'
                    }`}
                    onClick={() => onSelectComment?.(comment.dataset_value_id)}
                    onContextMenu={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect()
                      lastCoordsRef.current = {
                        x: e.clientX,
                        y: e.clientY,
                        anchorRect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
                      }
                      if (!selectedValueIds.includes(comment.dataset_value_id)) {
                        onSelectComment?.(comment.dataset_value_id)
                      }
                    }}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs font-medium text-muted-foreground">
                        {comment.column_name || comment.column_text}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        ({comment.dataset_name})
                      </span>
                      <span className="text-[11px] px-1 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded">
                        Col {comment.column_sequence_order}
                      </span>
                      <div className="flex-1" />
                      {onQuoteToggle && (
                        <button
                          className={`shrink-0 ${comment.is_quoted ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'} transition-opacity`}
                          onClick={e => { e.stopPropagation(); onQuoteToggle(comment.dataset_value_id) }}
                          aria-label={comment.is_quoted ? 'Unquote' : 'Quote'}
                        >
                          <Quote className={`w-3.5 h-3.5 ${comment.is_quoted ? 'fill-amber-400 text-amber-400' : 'text-mm-border-medium'}`} />
                        </button>
                      )}
                    </div>

                    <p className="text-sm mb-2">
                      {comment.value_text || <span className="italic text-muted-foreground">Empty response</span>}
                    </p>

                    {comment.applied_code_ids.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-1">
                        {visibleCodeChipRows(comment.applied_code_details ?? [], chipHidden).map(row => {
                          const code = codeMap[row.codeId]
                          if (!code) return null
                          const coder = (multiCoder && row.userId != null) ? effectiveCoderMap.get(row.userId) ?? null : null
                          return <CodeChip key={row.key} code={code} size="xs" coder={coder} />
                        })}
                      </div>
                    )}

                    {comment.note_count > 0 && (
                      <div className="text-[11px] text-muted-foreground">
                        {comment.note_count} note{comment.note_count > 1 ? 's' : ''}
                      </div>
                    )}
                  </div>
                </ContextMenuTrigger>
                {onQuoteToggle && (
                  <TextCodingContextMenu
                    comment={comment}
                    activeCodes={activeCodes}
                    codeIdToShortcutLabel={codeIdToShortcutLabel}
                    onQuoteToggle={onQuoteToggle}
                    onContextCodeApply={onContextCodeApply}
                    onContextCreateCode={onContextCreateCode}
                    onContextCreateNote={onContextCreateNote}
                    lastCoordsRef={lastCoordsRef}
                    activeCoderId={activeCoderId}
                  />
                )}
              </ContextMenu>
            )
          })}

          {recordComments.length === 0 && (
            <div className="text-sm text-muted-foreground text-center py-8">
              No text from this record in the selected columns.
            </div>
          )}
        </div>

        {/* Right: context panel */}
        <div className="w-64 border-l bg-mm-bg overflow-y-auto p-3 space-y-4 shrink-0" role="complementary" aria-label="Record context">
          {context ? (
            <>
              {/* Record header */}
              <div>
                <h4 className="text-xs font-semibold text-mm-text-muted uppercase mb-1">Record</h4>
                <p className="text-sm font-medium">
                  {context.row_identifier || `ID ${currentRecordId}`}
                </p>
                <p className="text-xs text-muted-foreground">{context.dataset_name}</p>
              </div>

              {/* Demographics */}
              {context.demographics.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-mm-text-muted uppercase mb-1">Demographics</h4>
                  {context.demographics.map(d => (
                    <div key={d.column_id} className="text-xs py-0.5">
                      <span className="text-muted-foreground">{d.column_name}:</span>{' '}
                      <span className="font-medium">{d.value || '—'}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Non-text columns */}
              {context.other_columns.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-mm-text-muted uppercase mb-1">Other columns</h4>
                  {context.other_columns.map(nc => (
                    <div key={nc.column_id} className="text-xs py-0.5">
                      <span className="text-muted-foreground">{nc.column_name}:</span>{' '}
                      <span className="font-medium">{nc.value || '—'}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Position map */}
              {context.column_positions.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-mm-text-muted uppercase mb-1">
                    <MapPin className="w-3 h-3 inline mr-1" />
                    Column Position
                  </h4>
                  <div className="space-y-0.5">
                    {context.column_positions.map(cp => {
                      const isFocal = focalColumnIds.includes(cp.column_id)
                      return (
                        <div
                          key={cp.column_id}
                          className={`text-[11px] py-0.5 px-1.5 rounded flex items-center gap-1 ${
                            isFocal ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-400 font-medium' : 'text-muted-foreground'
                          }`}
                        >
                          <span className="font-mono w-5 text-right shrink-0">{cp.sequence_order}</span>
                          <span className="truncate">{cp.column_name}</span>
                          {isFocal && <span className="shrink-0">←</span>}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Linked conversations */}
              {context.linked_conversations.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-mm-text-muted uppercase mb-1">Linked Conversations</h4>
                  {context.linked_conversations.map(conv => (
                    <Button
                      key={conv.id}
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start text-xs h-7 gap-1"
                      onClick={() => navigate(`/projects/${projectId}/conversations/${conv.id}`)}
                    >
                      <ExternalLink className="w-3 h-3 shrink-0" />
                      <span className="truncate">{conv.name}</span>
                    </Button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="text-xs text-muted-foreground text-center py-4">Loading context...</div>
          )}
        </div>
      </div>
    </div>
  )
}
