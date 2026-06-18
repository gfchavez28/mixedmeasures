import { memo, useCallback, useMemo, type JSX, type KeyboardEvent, type Ref } from 'react'
import { useNavigate } from 'react-router-dom'
import { Copy, ExternalLink, Quote, GripVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import CodeChip from '@/components/qualitative-analysis/CodeChip'
import InlineCodeActions from '@/components/qualitative-analysis/InlineCodeActions'
import { type Code, type QuotedExcerptItem } from '@/lib/api'
import type { QuoteDensity } from '@/lib/qual-analysis-types'
import SendToCanvasMenu from '@/components/canvas/SendToCanvasMenu'

interface QuoteCardProps {
  excerpt: QuotedExcerptItem
  projectId: number
  density: QuoteDensity
  showNotes: boolean
  showCodes: boolean
  showSpeaker: boolean
  showSource?: boolean
  onUnquote: (excerptId: number) => void
  onCopy: (excerpt: QuotedExcerptItem) => void
  allCodes?: Code[]
  onCodeChange?: () => void
  onFocusCode?: (codeId: number) => void
  onSendToCanvas?: (canvasId: number, canvasName: string) => void
  onSendToNewCanvas?: (canvasName: string) => void
  // DnD props (from useSortable)
  isDraggable?: boolean
  dragHandleRef?: Ref<HTMLButtonElement>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  dragHandleListeners?: Record<string, Function>
  isDragging?: boolean
}

function formatAttribution(e: QuotedExcerptItem, showSpeaker: boolean, showSource: boolean = true): string {
  if (e.source_type === 'segment') {
    if (e.document_id) {
      // Document segment — no speaker info
      const parts: string[] = []
      if (showSource && e.document_name) parts.push(e.document_name)
      if (e.sequence_order !== null) parts.push(`\u00B6${e.sequence_order + 1}`)
      return parts.join(', ')
    }
    const parts: string[] = []
    if (showSpeaker && e.speaker_name) parts.push(e.speaker_name)
    if (showSource) parts.push(e.source_name)
    if (e.sequence_order !== null) parts.push(`Seg ${e.sequence_order + 1}`)
    return parts.join(', ')
  }
  const parts: string[] = []
  if (showSource && e.source_name) parts.push(e.source_name)
  if (showSpeaker && e.participant_name) parts.push(e.participant_name)
  return parts.join(', ')
}

// eslint-disable-next-line react-refresh/only-export-components
export { formatAttribution }

function renderQuoteText(
  excerpt: QuotedExcerptItem,
  density: QuoteDensity,
): JSX.Element {
  const isFull = density === 'full'

  // Preceding segment context (full density, segment excerpts only)
  const contextBlock = isFull && excerpt.source_type === 'segment' && excerpt.context_before ? (
    <p className="text-xs text-mm-text-muted leading-relaxed mb-2 pb-2 border-b border-mm-border-subtle italic">
      {excerpt.context_before_speaker && (
        <span className="font-medium not-italic">{excerpt.context_before_speaker}: </span>
      )}
      {excerpt.context_before}
    </p>
  ) : null

  if (isFull && excerpt.is_sub_segment && excerpt.full_segment_text && excerpt.start_offset !== null && excerpt.end_offset !== null) {
    const before = excerpt.full_segment_text.slice(0, excerpt.start_offset)
    const highlighted = excerpt.full_segment_text.slice(excerpt.start_offset, excerpt.end_offset)
    const after = excerpt.full_segment_text.slice(excerpt.end_offset)
    return (
      <>
        {contextBlock}
        <p className="text-sm text-mm-text leading-relaxed">
          {'\u201C'}{before}<mark className="bg-yellow-200/40 dark:bg-yellow-500/20 text-inherit rounded-sm">{highlighted}</mark>{after}{'\u201D'}
        </p>
      </>
    )
  }
  return (
    <>
      {contextBlock}
      <p className="text-sm text-mm-text leading-relaxed">
        {'\u201C'}{excerpt.text}{'\u201D'}
      </p>
    </>
  )
}

const QuoteCard = memo(function QuoteCard({
  excerpt,
  projectId,
  density,
  showNotes,
  showCodes,
  showSpeaker,
  showSource = true,
  onUnquote,
  onCopy,
  allCodes,
  onCodeChange,
  onFocusCode,
  onSendToCanvas,
  onSendToNewCanvas,
  isDraggable = false,
  dragHandleRef,
  dragHandleListeners,
  isDragging = false,
}: QuoteCardProps) {
  const navigate = useNavigate()

  const handleNavigate = useCallback(() => {
    if (excerpt.source_type === 'segment' && excerpt.document_id) {
      navigate(`/projects/${projectId}/documents/${excerpt.document_id}?segment=${excerpt.segment_id}`)
    } else if (excerpt.source_type === 'segment' && excerpt.conversation_id) {
      navigate(`/projects/${projectId}/conversations/${excerpt.conversation_id}?segment=${excerpt.segment_id}`)
    } else if (excerpt.source_type === 'text' && excerpt.column_id) {
      navigate(`/projects/${projectId}/datasets/text-coding?columns=${excerpt.column_id}`)
    }
  }, [navigate, projectId, excerpt])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleNavigate()
    }
  }, [handleNavigate])

  // Derive itemType/itemId for InlineCodeActions
  const itemType = excerpt.source_type === 'segment' ? 'segment' as const : 'text' as const
  const itemId = excerpt.source_type === 'segment' ? excerpt.segment_id! : excerpt.dataset_value_id!

  const codeMap = useMemo(() => {
    const m = new Map<number, Code>()
    for (const c of (allCodes ?? [])) m.set(c.id, c)
    return m
  }, [allCodes])

  const attribution = formatAttribution(excerpt, showSpeaker, showSource)

  const cardContent = (
    <div
      className={`group rounded-lg border border-mm-border-subtle bg-mm-surface p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mm-accent${isDragging ? ' opacity-50' : ''}`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      role="article"
      aria-label={`Quoted excerpt: ${excerpt.text.slice(0, 60)}${excerpt.text.length > 60 ? '...' : ''}`}
      aria-roledescription={isDraggable ? 'sortable quote' : undefined}
    >
      {/* Drag handle + Quote text */}
      <div className="flex gap-2">
        {isDraggable && (
          <button
            ref={dragHandleRef}
            {...(dragHandleListeners ?? {})}
            className="flex-shrink-0 mt-0.5 w-5 h-5 flex items-center justify-center rounded text-mm-text-muted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity cursor-grab active:cursor-grabbing hover:text-mm-text"
            tabIndex={-1}
            aria-label="Drag to reorder"
          >
            <GripVertical className="w-3.5 h-3.5" />
          </button>
        )}
        <div className="flex-1 min-w-0">
          {renderQuoteText(excerpt, density)}
        </div>
      </div>

      {/* Attribution */}
      {attribution && (
        <p className="text-xs text-mm-text-muted mt-2">
          — {attribution}
        </p>
      )}

      {/* Excerpt note */}
      {density === 'full' && showNotes && excerpt.excerpt_note && (
        <p className="text-xs text-mm-text-secondary mt-2 italic border-l-2 border-mm-border-subtle pl-2">
          {excerpt.excerpt_note}
        </p>
      )}

      {/* Code chips with inline add/remove — delegates to InlineCodeActions */}
      {showCodes && (
        <div className="mt-2">
          {onCodeChange && allCodes ? (
            <InlineCodeActions
              projectId={projectId}
              itemType={itemType}
              itemId={itemId}
              appliedCodeIds={excerpt.applied_code_ids}
              codeMap={codeMap}
              allCodes={allCodes}
              onCodeChange={onCodeChange}
              onFocusCode={onFocusCode}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-1">
              {excerpt.applied_codes.map(c => (
                <CodeChip key={c.id} code={c} size="xs" onClick={onFocusCode} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-1 mt-3 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity [@media(hover:none)]:opacity-100">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => onCopy(excerpt)}
          title="Copy quote"
        >
          <Copy className="w-3.5 h-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={handleNavigate}
          title="Go to source"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-amber-500 hover:text-amber-600"
          onClick={() => onUnquote(excerpt.excerpt_id)}
          title="Remove quote"
        >
          <Quote className="w-3.5 h-3.5 fill-current" />
        </Button>
      </div>
    </div>
  )

  if (onSendToCanvas) {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {cardContent}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <SendToCanvasMenu
            projectId={projectId}
            onSend={(canvasId, canvasName) => onSendToCanvas(canvasId, canvasName)}
            onSendNew={(name) => onSendToNewCanvas?.(name)}
          />
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onCopy(excerpt)}>
            <Copy className="w-3 h-3 mr-2" /> Copy quote
          </ContextMenuItem>
          <ContextMenuItem onClick={handleNavigate}>
            <ExternalLink className="w-3 h-3 mr-2" /> Go to source
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem className="text-amber-600" onClick={() => onUnquote(excerpt.excerpt_id)}>
            <Quote className="w-3 h-3 mr-2 fill-current" /> Remove quote
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  return cardContent
})

export default QuoteCard
