import React, { useState, useEffect, useRef, useMemo } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Quote, Paperclip, Check } from 'lucide-react'
import { type Segment, type SegmentExcerptInfo, type Code, type Speaker, segmentsApi, speakersApi } from '@/lib/api'
import InlineCodeActions from '@/components/qualitative-analysis/InlineCodeActions'
import { highlightText } from '@/components/qualitative-analysis/highlight-text'
import { getSpeakerInitials, getInitialsBadgeColors } from '@/lib/conversation-import-utils'
import { formatTimestamp, cn, getCodeColor, getContrastColor, hexToRowBg, hexToRowHoverBg } from '@/lib/utils'
import { useTheme } from '@/lib/theme-context'
import { useCodeShortcutLabels } from '@/hooks/useCodeShortcutLabels'
import type { FloatingCoords } from '@/lib/floating-utils'
import { ColorSwatchPicker } from '@/components/ColorSwatchPicker'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from '@/components/ui/context-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// Speaker background colors using mm-* tokens (dark mode aware)
const SPEAKER_BG_TOKENS = [
  'bg-[hsl(var(--mm-speaker-1))]',
  'bg-[hsl(var(--mm-speaker-2))]',
  'bg-[hsl(var(--mm-speaker-3))]',
  'bg-[hsl(var(--mm-speaker-4))]',
  'bg-[hsl(var(--mm-speaker-5))]',
  'bg-[hsl(var(--mm-speaker-6))]',
]
const FACILITATOR_BG_TOKEN = 'bg-[hsl(var(--mm-speaker-facilitator))]'

// Speaker hover colors — intensified version of each speaker's hue
const SPEAKER_HOVER_TOKENS = [
  'hover:bg-[hsl(var(--mm-speaker-1-hover))]',
  'hover:bg-[hsl(var(--mm-speaker-2-hover))]',
  'hover:bg-[hsl(var(--mm-speaker-3-hover))]',
  'hover:bg-[hsl(var(--mm-speaker-4-hover))]',
  'hover:bg-[hsl(var(--mm-speaker-5-hover))]',
  'hover:bg-[hsl(var(--mm-speaker-6-hover))]',
]
const FACILITATOR_HOVER_TOKEN = 'hover:bg-[hsl(var(--mm-speaker-facilitator-hover))]'

// Get speaker background color based on color_index and is_facilitator status
function getSpeakerBgColor(colorIndex: number, isFacilitator: boolean): string {
  if (isFacilitator) return FACILITATOR_BG_TOKEN
  return SPEAKER_BG_TOKENS[colorIndex % SPEAKER_BG_TOKENS.length]
}

// Get speaker hover color — same hue but intensified
function getSpeakerHoverColor(colorIndex: number, isFacilitator: boolean): string {
  if (isFacilitator) return FACILITATOR_HOVER_TOKEN
  return SPEAKER_HOVER_TOKENS[colorIndex % SPEAKER_HOVER_TOKENS.length]
}



interface SegmentRowProps {
  segment: Segment
  isSelected: boolean
  isDragOver?: boolean
  onClick: (e: React.MouseEvent) => void
  conversationId: number
  codes: Code[]
  // Merge support
  canMergeWithPrev?: boolean
  canMergeWithNext?: boolean
  canMergeSelected?: boolean
  selectedCount?: number
  onMergeWithPrev?: () => void
  onMergeWithNext?: () => void
  onMergeSelected?: () => void
  // Unmerge support
  onUnmerge?: () => void
  // Unsplit/rejoin support
  onUnsplit?: () => void
  // Click handler for notes (Item 66)
  onNoteClick?: (noteId: number) => void
  // Inline editing props (Issues 101 & 102)
  isEditing?: boolean
  editField?: 'text' | 'speaker'
  onStartEdit?: (segmentId: number, field: 'text' | 'speaker') => void
  onCancelEdit?: () => void
  onSaveEdit?: (segmentId: number, update: { text?: string; speaker_id?: number }) => void
  speakers?: Speaker[]
  // Excerpt toggle (quote)
  onToggleQuote?: (segmentId: number) => void
  onSaveExcerpt?: (segmentId: number, startOffset: number, endOffset: number) => void
  onDeleteExcerpt?: (excerptId: number) => void
  onAddNoteToExcerpt?: (excerptId: number, segmentId: number) => void
  // Search highlighting (Issue 112)
  searchHighlight?: string
  // Group support (Phase 8)
  groupPosition?: 'first' | 'middle' | 'last' | 'solo' | null
  canGroupSelected?: boolean
  onGroupSelected?: () => void
  isGrouped?: boolean
  onUngroup?: () => void
  groupAriaLabel?: string
  // Context menu actions
  onContextCodeApply?: (segmentId: number, codeId: number) => void
  onContextCreateCode?: (coords: FloatingCoords) => void
  onContextCreateNote?: (segmentId: number, coords: FloatingCoords) => void
  // Right-click selection (select if not already selected, like ByTextTable)
  onRightClickSelect?: () => void
  // Split from context menu
  onSplitAtSelection?: () => void
  // Text selection within this segment (for highlight + copy)
  textSelection?: { start: number; end: number } | null
  // Column visibility toggles
  showTimestamps?: boolean
  showNotes?: boolean
  showCodes?: boolean
  projectId?: number
  allCodes?: Code[]
  codeMap?: Map<number, Code>
  onCodeChange?: () => void
}

function SegmentRow({
  segment,
  isSelected,
  isDragOver = false,
  onClick,
  conversationId,
  codes,
  canMergeWithPrev,
  canMergeWithNext,
  canMergeSelected,
  selectedCount = 0,
  onMergeWithPrev,
  onMergeWithNext,
  onMergeSelected,
  onUnmerge,
  onUnsplit,
  onNoteClick,
  isEditing = false,
  editField = 'text',
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onToggleQuote,
  onSaveExcerpt,
  onDeleteExcerpt,
  onAddNoteToExcerpt,
  speakers = [],
  searchHighlight,
  groupPosition = null,
  canGroupSelected,
  onGroupSelected,
  isGrouped,
  onUngroup,
  groupAriaLabel,
  onContextCodeApply,
  onContextCreateCode,
  onContextCreateNote,
  onRightClickSelect,
  onSplitAtSelection,
  textSelection,
  showTimestamps = true,
  showNotes = true,
  showCodes = true,
  projectId,
  allCodes,
  codeMap,
  onCodeChange,
}: SegmentRowProps) {
  const queryClient = useQueryClient()
  const { isDark } = useTheme()
  const [showUnmergeDialog, setShowUnmergeDialog] = useState(false)
  const [showUnsplitDialog, setShowUnsplitDialog] = useState(false)
  const lastCoordsRef = useRef<FloatingCoords>({ x: 0, y: 0 })

  // Inline editing local state (Issues 101 & 102)
  const [editText, setEditText] = useState(segment.text)
  const [editSpeakerId, setEditSpeakerId] = useState(segment.speaker_id)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const editContainerRef = useRef<HTMLDivElement>(null)

  // Derived: does the current text differ from the original?
  const hasTextChanges = isEditing && editField === 'text' && editText !== segment.text

  // Reset local edit state when entering edit mode
  /* eslint-disable react-hooks/set-state-in-effect -- initialize edit fields when edit mode starts */
  useEffect(() => {
    if (isEditing) {
      setEditText(segment.text)
      setEditSpeakerId(segment.speaker_id)
      if (editField === 'text') {
        // Focus textarea after render
        setTimeout(() => textareaRef.current?.focus(), 0)
      }
    }
  }, [isEditing, segment.text, segment.speaker_id, editField])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Click-outside detection for text editing
  useEffect(() => {
    if (!isEditing || editField !== 'text') return

    const handleClickOutside = (e: MouseEvent) => {
      if (editContainerRef.current && !editContainerRef.current.contains(e.target as Node)) {
        if (hasTextChanges) {
          // Absorb the click and keep textarea focused for Enter/Escape
          e.stopPropagation()
          e.preventDefault()
          textareaRef.current?.focus()
        } else {
          onCancelEdit?.()
        }
      }
    }

    // Use capture phase to intercept before other handlers
    // Small delay to avoid catching the initial double-click that opened the edit
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside, true)
    }, 0)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClickOutside, true)
    }
  }, [isEditing, editField, hasTextChanges, onCancelEdit])

  const codeIdToShortcutLabel = useCodeShortcutLabels(codes)
  const updateSpeakerMutation = useMutation({
    mutationFn: (isFacilitator: boolean) =>
      segmentsApi.updateSpeakerRole(conversationId, segment.id, isFacilitator),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['segments', conversationId] })
    },
  })

  const updateSpeakerColorMutation = useMutation({
    mutationFn: (color: string | null) =>
      speakersApi.updateColor(projectId!, segment.speaker_id!, color),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['segments', conversationId] })
      queryClient.invalidateQueries({ queryKey: ['speakers', projectId] })
    },
  })

  // Render text with sub-segment excerpt highlights
  const renderTextWithExcerpts = (text: string, excerpts: SegmentExcerptInfo[]) => {
    const subExcerpts = excerpts
      .filter(e => e.start_offset !== null && e.end_offset !== null)
      .sort((a, b) => a.start_offset! - b.start_offset!)

    if (subExcerpts.length === 0) return text

    const parts: React.ReactNode[] = []
    let lastEnd = 0

    for (const exc of subExcerpts) {
      const start = exc.start_offset!
      const end = Math.min(exc.end_offset!, text.length)
      if (start > lastEnd) {
        parts.push(text.slice(lastEnd, start))
      }
      const markEl = (
        <mark
          key={exc.id}
          className="bg-amber-100 dark:bg-amber-900/30 text-inherit border-b-2 border-amber-400 dark:border-amber-600 rounded-sm px-px cursor-default"
        >
          {text.slice(start, end)}
        </mark>
      )
      if (exc.has_note && exc.note_preview) {
        parts.push(
          <Tooltip key={exc.id}>
            <TooltipTrigger asChild>{markEl}</TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              <p className="text-xs flex items-start gap-1.5">
                <Paperclip className="w-3 h-3 mt-0.5 flex-shrink-0 text-amber-500" />
                <span>{exc.note_preview}</span>
              </p>
            </TooltipContent>
          </Tooltip>
        )
      } else {
        parts.push(markEl)
      }
      lastEnd = end
    }

    if (lastEnd < text.length) {
      parts.push(text.slice(lastEnd))
    }

    return <>{parts}</>
  }

  // Visual treatment based on speaker role and coding status
  const hasCustomColor = !!segment.speaker_color
  const getBackgroundClass = () => {
    if (isSelected) return 'bg-blue-100 dark:bg-blue-900/40'
    if (isDragOver) return 'bg-blue-100 dark:bg-blue-900/40'
    // Custom hex color → use inline style instead of Tailwind token
    if (hasCustomColor) {
      const uncoded = !segment.is_facilitator && segment.applied_codes.length === 0
        ? 'ring-1 ring-inset ring-orange-200 dark:ring-orange-800'
        : ''
      return uncoded
    }
    // Use speaker color based on color_index
    const speakerBg = getSpeakerBgColor(segment.speaker_color_index || 0, segment.is_facilitator)
    // For uncoded participant segments, add a subtle indicator
    if (!segment.is_facilitator && segment.applied_codes.length === 0) {
      return `${speakerBg} ring-1 ring-inset ring-orange-200 dark:ring-orange-800`
    }
    return speakerBg
  }

  // Inline style for custom speaker color row backgrounds
  const customRowStyle = useMemo(() => {
    if (!hasCustomColor || isSelected || isDragOver) return undefined
    return {
      backgroundColor: hexToRowBg(segment.speaker_color!, isDark),
    } as React.CSSProperties
  }, [hasCustomColor, segment.speaker_color, isSelected, isDragOver, isDark])

  const getTextClass = () => {
    if (segment.is_facilitator) return 'text-mm-text-secondary'
    return 'text-mm-text'
  }

  // Get code info for tooltip
  const getCodeInfo = (codeId: number) => {
    const code = codeMap?.get(codeId)
    if (!code) return { name: 'Unknown', description: '', color: '#6b7280' }
    return { name: code.name, description: code.description || '', color: getCodeColor(code) }
  }

  return (
    <TooltipProvider delayDuration={300}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            id={`segment-${segment.id}`}
            className={cn(
              'px-4 py-2 h-full cursor-pointer transition-colors group/row relative',
              isSelected || isDragOver
                ? 'hover:bg-blue-200 dark:hover:bg-blue-800/40'
                : hasCustomColor
                  ? ''
                  : getSpeakerHoverColor(segment.speaker_color_index || 0, segment.is_facilitator),
              getBackgroundClass(),
              groupPosition && 'border-l-[3px] border-teal-400 dark:border-teal-600',
              (isSelected || isDragOver) && 'border-l-[3px] border-blue-500 dark:border-blue-400',
            )}
            style={customRowStyle}
            onMouseEnter={hasCustomColor && !isSelected && !isDragOver ? (e) => {
              (e.currentTarget as HTMLElement).style.backgroundColor = hexToRowHoverBg(segment.speaker_color!, isDark)
            } : undefined}
            onMouseLeave={hasCustomColor && !isSelected && !isDragOver ? (e) => {
              (e.currentTarget as HTMLElement).style.backgroundColor = hexToRowBg(segment.speaker_color!, isDark)
            } : undefined}
            aria-selected={isSelected}
            aria-description={groupAriaLabel}
            onContextMenu={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              lastCoordsRef.current = {
                x: e.clientX,
                y: e.clientY,
                anchorRect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
              }
              if (!isSelected) onRightClickSelect?.()
            }}
            onMouseDown={(e) => {
              // Don't handle row selection while editing
              if (isEditing) return
              // Handle selection on mousedown instead of click
              // This fires before blur events can interfere
              if (e.button === 0) { // Left click only
                onClick(e)
              }
            }}
          >
            {/* Group bracket tooltip trigger (Phase 8) */}
            {groupPosition && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="absolute left-0 top-0 bottom-0 w-2 cursor-default" aria-label="Segment group" role="img" />
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p className="text-xs">Grouped for coding (g to ungroup)</p>
                </TooltipContent>
              </Tooltip>
            )}
            <div className="flex items-start gap-3">
              {/* Quote/Excerpt gutter */}
              <button
                className={cn(
                  'w-5 flex-shrink-0 pt-0.5 focus:outline-none transition-colors',
                  segment.excerpts.length > 0
                    ? 'text-amber-400'
                    : 'text-mm-border-medium hover:text-amber-400 opacity-0 group-hover/row:opacity-100 focus:opacity-100'
                )}
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleQuote?.(segment.id)
                }}
                onMouseDown={(e) => e.stopPropagation()}
                title={segment.excerpts.length > 0 ? 'Has excerpts' : 'No excerpts'}
                aria-label={segment.excerpts.length > 0 ? 'Has excerpts' : 'No excerpts'}
              >
                <Quote className={cn('w-4 h-4', segment.excerpts.length > 0 && 'fill-amber-400')} />
              </button>

              {/* Timestamp */}
              {showTimestamps && (
                <div className="w-16 flex-shrink-0 text-xs text-mm-text-muted font-mono pt-0.5">
                  {formatTimestamp(segment.start_time)}
                </div>
              )}

              {/* Speaker */}
              <div className="w-28 flex-shrink-0 flex items-center gap-1.5">
                {isEditing && editField === 'speaker' ? (
                  <Select
                    value={String(editSpeakerId || '')}
                    onValueChange={(value) => {
                      const newSpeakerId = parseInt(value)
                      setEditSpeakerId(newSpeakerId)
                      onSaveEdit?.(segment.id, { speaker_id: newSpeakerId })
                    }}
                    open={true}
                    onOpenChange={(open) => {
                      if (!open) onCancelEdit?.()
                    }}
                  >
                    <SelectTrigger
                      className="h-7 text-xs w-full"
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Escape') {
                          e.preventDefault()
                          onCancelEdit?.()
                        } else if (e.key === 'Tab' && e.shiftKey) {
                          e.preventDefault()
                          onStartEdit?.(segment.id, 'text')
                        }
                      }}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {speakers.map((speaker) => (
                        <SelectItem key={speaker.id} value={String(speaker.id)}>
                          <span className={cn(
                            speaker.is_facilitator ? 'text-purple-700' : 'text-orange-700'
                          )}>
                            {speaker.name}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <>
                    {/* Initials badge */}
                    <span
                      className={cn(
                        'w-6 h-6 rounded-full text-xs font-semibold flex items-center justify-center ring-1 flex-shrink-0',
                        segment.speaker_color ? 'ring-black/10 dark:ring-white/20' : getInitialsBadgeColors(segment.is_facilitator)
                      )}
                      style={segment.speaker_color ? { backgroundColor: segment.speaker_color, color: getContrastColor(segment.speaker_color) } : undefined}
                      title={segment.speaker_name || 'Unknown'}
                    >
                      {getSpeakerInitials(segment.speaker_name)}
                    </span>
                    {/* Speaker name - click to edit */}
                    <span
                      className={cn(
                        'text-sm font-medium truncate cursor-pointer hover:underline',
                        segment.is_facilitator ? 'text-mm-text-muted' : 'text-mm-text'
                      )}
                      title={`${segment.speaker_name || 'Unknown'} (click to change)`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onStartEdit?.(segment.id, 'speaker')
                      }}
                    >
                      {segment.speaker_name || 'Unknown'}
                    </span>
                  </>
                )}
              </div>

              {/* Text */}
              {isEditing && editField === 'text' ? (
                <div className="flex-1" ref={editContainerRef}>
                  <textarea
                    ref={textareaRef}
                    aria-label="Edit segment text"
                    className="w-full text-sm leading-relaxed border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-emerald-500 resize-none"
                    value={editText}
                    rows={Math.max(2, Math.ceil(editText.length / 80))}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        if (editText.trim() && editText !== segment.text) {
                          onSaveEdit?.(segment.id, { text: editText.trim() })
                        } else {
                          onCancelEdit?.()
                        }
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        onCancelEdit?.()
                      } else if (e.key === 'Tab' && !e.shiftKey) {
                        e.preventDefault()
                        // Save text if changed, then switch to speaker edit
                        if (editText.trim() && editText !== segment.text) {
                          onSaveEdit?.(segment.id, { text: editText.trim() })
                        }
                        onStartEdit?.(segment.id, 'speaker')
                      }
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                  />
                  {hasTextChanges && (
                    <div className="mt-1 text-xs bg-amber-50 border border-amber-200 rounded px-2 py-1 text-amber-700">
                      Save changes? <kbd className="px-1 py-0.5 bg-amber-100 rounded text-[11px] font-mono">Enter</kbd> to save · <kbd className="px-1 py-0.5 bg-amber-100 rounded text-[11px] font-mono">Esc</kbd> to discard
                    </div>
                  )}
                </div>
              ) : (
                <div
                  data-segment-id={segment.id}
                  className={cn('flex-1 text-sm leading-relaxed cursor-text', getTextClass())}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    onStartEdit?.(segment.id, 'text')
                  }}
                >
                  {textSelection && textSelection.start < textSelection.end && searchHighlight
                    ? <>
                        {highlightText(segment.text.slice(0, textSelection.start), searchHighlight)}
                        <mark className="bg-blue-200 dark:bg-blue-700/50 text-foreground rounded-sm px-px">
                          {highlightText(segment.text.slice(textSelection.start, textSelection.end), searchHighlight)}
                        </mark>
                        {highlightText(segment.text.slice(textSelection.end), searchHighlight)}
                      </>
                    : searchHighlight
                      ? highlightText(segment.text, searchHighlight)
                      : textSelection && textSelection.start < textSelection.end
                        ? <>
                            {segment.text.slice(0, textSelection.start)}
                            <mark className="bg-blue-200 dark:bg-blue-700/50 text-foreground rounded-sm px-px">{segment.text.slice(textSelection.start, textSelection.end)}</mark>
                            {segment.text.slice(textSelection.end)}
                          </>
                        : renderTextWithExcerpts(segment.text, segment.excerpts)}
                </div>
              )}

              {/* Notes Column */}
              {showNotes && <div className="w-[40px] flex-shrink-0 flex flex-col items-center justify-center gap-0.5">
                {segment.attached_notes && segment.attached_notes.length > 0 && segment.attached_notes.map(note => (
                  <Tooltip key={note.id}>
                    <TooltipTrigger asChild>
                      <button
                        className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 text-[10px] font-medium hover:bg-amber-200 dark:hover:bg-amber-800/50 transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-1"
                        onClick={(e) => {
                          e.stopPropagation()
                          onNoteClick?.(note.id)
                        }}
                        aria-label={`Note ${note.sequence_number}`}
                      >
                        {note.sequence_number}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs">
                      Note {note.sequence_number} — click to view
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>}

              {/* Codes Column - colored chips with inline add/remove */}
              {showCodes && <div className="w-[160px] flex-shrink-0 flex items-center">
                {onCodeChange && allCodes && codeMap && projectId ? (
                  <InlineCodeActions
                    projectId={projectId}
                    itemType="segment"
                    itemId={segment.id}
                    appliedCodeIds={segment.applied_codes}
                    codeMap={codeMap}
                    allCodes={allCodes}
                    onCodeChange={onCodeChange}
                  />
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {segment.applied_codes.map((codeId) => {
                      const codeInfo = getCodeInfo(codeId)
                      return (
                        <span
                          key={codeId}
                          className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium text-white truncate max-w-[60px]"
                          style={{ backgroundColor: codeInfo.color || '#6b7280' }}
                          title={codeInfo.name}
                        >
                          {codeInfo.name}
                        </span>
                      )
                    })}
                  </div>
                )}
              </div>}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {/* ── Primary coding actions ── */}
          {onContextCodeApply && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>Apply Code</ContextMenuSubTrigger>
              <ContextMenuSubContent className="max-h-64 overflow-y-auto w-52">
                {onContextCreateCode && (
                  <>
                    <ContextMenuItem onClick={() => onContextCreateCode(lastCoordsRef.current)}>
                      New Code...
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                  </>
                )}
                {codes.filter(c => c.is_active).map(code => {
                  const isApplied = segment.applied_codes.includes(code.id)
                  const label = codeIdToShortcutLabel.get(code.id) ?? ''
                  return (
                    <ContextMenuItem
                      key={code.id}
                      onClick={() => onContextCodeApply(segment.id, code.id)}
                    >
                      <span className="flex items-center gap-2 flex-1 min-w-0">
                        {isApplied && <Check className="w-3 h-3 text-green-600 flex-shrink-0" />}
                        <span
                          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: getCodeColor(code) }}
                        />
                        <span className={cn('truncate', isApplied && 'font-bold')}>{code.name}</span>
                      </span>
                      {label && (
                        <span className="text-xs text-mm-text-faint ml-2 font-mono flex-shrink-0">{label}</span>
                      )}
                    </ContextMenuItem>
                  )
                })}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          {onContextCreateNote && (
            <ContextMenuItem onClick={() => onContextCreateNote(segment.id, lastCoordsRef.current)}>
              Add Note
            </ContextMenuItem>
          )}
          {/* Quote/Excerpt actions */}
          {textSelection && textSelection.start < textSelection.end && onSaveExcerpt && (
            <ContextMenuItem onClick={() => onSaveExcerpt(segment.id, textSelection.start, textSelection.end)}>
              Save Excerpt
            </ContextMenuItem>
          )}
          {onToggleQuote && !(textSelection && textSelection.start < textSelection.end) && (
            <ContextMenuItem onClick={() => onToggleQuote(segment.id)}>
              {segment.excerpts.some(e => e.start_offset === null) ? 'Unquote' : 'Quote'}
            </ContextMenuItem>
          )}
          {onDeleteExcerpt && segment.excerpts.filter(e => e.start_offset !== null).length > 0 && (
            <>
              <ContextMenuSeparator />
              {segment.excerpts
                .filter(e => e.start_offset !== null)
                .map(e => {
                  const excerptText = segment.text.slice(e.start_offset!, Math.min(e.end_offset!, segment.text.length))
                  const truncated = excerptText.length > 30 ? excerptText.slice(0, 30) + '...' : excerptText
                  return (
                    <ContextMenuItem key={e.id} onClick={() => onDeleteExcerpt(e.id)}>
                      Remove Excerpt: &ldquo;{truncated}&rdquo;
                    </ContextMenuItem>
                  )
                })}
            </>
          )}
          {onAddNoteToExcerpt && segment.excerpts.filter(e => !e.has_note).length > 0 && (
            <>
              {segment.excerpts
                .filter(e => !e.has_note)
                .map(e => {
                  if (e.start_offset !== null && e.end_offset !== null) {
                    const excerptText = segment.text.slice(e.start_offset, Math.min(e.end_offset, segment.text.length))
                    const truncated = excerptText.length > 30 ? excerptText.slice(0, 30) + '...' : excerptText
                    return (
                      <ContextMenuItem key={`note-${e.id}`} onClick={() => onAddNoteToExcerpt(e.id, segment.id)}>
                        Add Note to Excerpt: &ldquo;{truncated}&rdquo;
                      </ContextMenuItem>
                    )
                  }
                  return (
                    <ContextMenuItem key={`note-${e.id}`} onClick={() => onAddNoteToExcerpt(e.id, segment.id)}>
                      Add Note to Quoted Segment
                    </ContextMenuItem>
                  )
                })}
            </>
          )}
          <ContextMenuSeparator />
          {/* ── Structural operations ── */}
          {onSplitAtSelection && (
            <ContextMenuItem onClick={onSplitAtSelection}>
              Split at Selection
            </ContextMenuItem>
          )}
          {canMergeWithPrev && onMergeWithPrev && (
            <ContextMenuItem onClick={onMergeWithPrev}>
              Merge with Previous
            </ContextMenuItem>
          )}
          {canMergeWithNext && onMergeWithNext && (
            <ContextMenuItem onClick={onMergeWithNext}>
              Merge with Next
            </ContextMenuItem>
          )}
          {canMergeSelected && selectedCount > 1 && onMergeSelected && (
            <ContextMenuItem onClick={onMergeSelected}>
              Merge Selected ({selectedCount} segments)
            </ContextMenuItem>
          )}
          {segment.is_merged && onUnmerge && (
            <ContextMenuItem onClick={() => setShowUnmergeDialog(true)}>
              Unmerge
            </ContextMenuItem>
          )}
          {segment.is_split && onUnsplit && (
            <ContextMenuItem onClick={() => setShowUnsplitDialog(true)}>
              Rejoin
            </ContextMenuItem>
          )}
          {canGroupSelected && selectedCount > 1 && onGroupSelected && (
            <ContextMenuItem onClick={onGroupSelected}>
              Group Selected ({selectedCount} segments)
            </ContextMenuItem>
          )}
          {isGrouped && onUngroup && (
            <ContextMenuItem onClick={onUngroup}>
              Ungroup
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          {/* ── Speaker ── */}
          <ContextMenuItem
            onClick={() => updateSpeakerMutation.mutate(!segment.is_facilitator)}
          >
            Mark as {segment.is_facilitator ? 'Participant' : 'Facilitator'}
          </ContextMenuItem>
          {projectId && segment.speaker_id && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <span className="flex items-center gap-2">
                  <span
                    className="w-3 h-3 rounded-full border border-mm-border-medium"
                    style={{ backgroundColor: segment.speaker_color || undefined }}
                  />
                  Set Speaker Color
                </span>
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="p-2 w-auto">
                <ColorSwatchPicker
                  value={segment.speaker_color || ''}
                  onChange={(color) => updateSpeakerColorMutation.mutate(color)}
                />
                {segment.speaker_color && (
                  <button
                    className="mt-2 text-xs text-mm-text-muted hover:text-mm-text w-full text-center"
                    onClick={() => updateSpeakerColorMutation.mutate(null)}
                  >
                    Reset to default
                  </button>
                )}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          <ContextMenuSeparator />
          {/* ── Clipboard ── */}
          {textSelection && textSelection.start < textSelection.end && (
            <>
              <ContextMenuItem
                onClick={() => {
                  navigator.clipboard.writeText(segment.text.slice(textSelection.start, textSelection.end))
                }}
              >
                Copy Selected Text
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => {
                  const selected = segment.text.slice(textSelection.start, textSelection.end)
                  const quote = `"${selected}" - ${segment.speaker_name || 'Unknown'}`
                  navigator.clipboard.writeText(quote)
                }}
              >
                Copy Selected as Quote
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem
            onClick={() => {
              navigator.clipboard.writeText(segment.text)
            }}
          >
            Copy Text
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              const quote = `"${segment.text}" - ${segment.speaker_name || 'Unknown'}`
              navigator.clipboard.writeText(quote)
            }}
          >
            Copy as Quote
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Unmerge confirmation dialog */}
      <AlertDialog open={showUnmergeDialog} onOpenChange={setShowUnmergeDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unmerge Segment</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>This will restore the original segments from before the merge.</p>
              {segment.applied_codes.length > 0 && (
                <p className="font-medium text-amber-600">
                  Warning: This segment has {segment.applied_codes.length} code(s) applied.
                  Any codes, notes, or memos added to this merged segment will be lost.
                </p>
              )}
              {segment.applied_codes.length === 0 && (
                <p className="text-mm-text-muted">
                  Any notes or memos added to the merged segment will be lost.
                </p>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onUnmerge?.()
                setShowUnmergeDialog(false)
              }}
            >
              Unmerge
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* Rejoin/unsplit confirmation dialog */}
      <AlertDialog open={showUnsplitDialog} onOpenChange={setShowUnsplitDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rejoin Segment</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>This will restore the original segment from before the split, removing all split parts.</p>
              <p className="text-mm-text-muted">
                Any codes or notes added to the split segments will be lost. The original segment&apos;s codes and notes will be restored.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onUnsplit?.()
                setShowUnsplitDialog(false)
              }}
            >
              Rejoin
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  )
}

export default React.memo(SegmentRow, (prevProps, nextProps) => {
  // Return true if props are equal (skip re-render)
  return (
    prevProps.segment === nextProps.segment &&
    prevProps.isSelected === nextProps.isSelected &&
    prevProps.isDragOver === nextProps.isDragOver &&
    prevProps.onClick === nextProps.onClick &&
    prevProps.conversationId === nextProps.conversationId &&
    prevProps.codes === nextProps.codes &&
    prevProps.canMergeWithPrev === nextProps.canMergeWithPrev &&
    prevProps.canMergeWithNext === nextProps.canMergeWithNext &&
    prevProps.canMergeSelected === nextProps.canMergeSelected &&
    prevProps.selectedCount === nextProps.selectedCount &&
    prevProps.onMergeWithPrev === nextProps.onMergeWithPrev &&
    prevProps.onMergeWithNext === nextProps.onMergeWithNext &&
    prevProps.onMergeSelected === nextProps.onMergeSelected &&
    prevProps.onUnmerge === nextProps.onUnmerge &&
    prevProps.onNoteClick === nextProps.onNoteClick &&
    prevProps.isEditing === nextProps.isEditing &&
    prevProps.editField === nextProps.editField &&
    prevProps.onStartEdit === nextProps.onStartEdit &&
    prevProps.onCancelEdit === nextProps.onCancelEdit &&
    prevProps.onSaveEdit === nextProps.onSaveEdit &&
    prevProps.speakers === nextProps.speakers &&
    prevProps.onToggleQuote === nextProps.onToggleQuote &&
    prevProps.onSaveExcerpt === nextProps.onSaveExcerpt &&
    prevProps.onDeleteExcerpt === nextProps.onDeleteExcerpt &&
    prevProps.onAddNoteToExcerpt === nextProps.onAddNoteToExcerpt &&
    prevProps.searchHighlight === nextProps.searchHighlight &&
    prevProps.groupPosition === nextProps.groupPosition &&
    prevProps.canGroupSelected === nextProps.canGroupSelected &&
    prevProps.isGrouped === nextProps.isGrouped &&
    prevProps.groupAriaLabel === nextProps.groupAriaLabel &&
    !!prevProps.onGroupSelected === !!nextProps.onGroupSelected &&
    !!prevProps.onUngroup === !!nextProps.onUngroup &&
    prevProps.onContextCodeApply === nextProps.onContextCodeApply &&
    prevProps.onContextCreateCode === nextProps.onContextCreateCode &&
    prevProps.onContextCreateNote === nextProps.onContextCreateNote &&
    !!prevProps.onRightClickSelect === !!nextProps.onRightClickSelect &&
    !!prevProps.onSplitAtSelection === !!nextProps.onSplitAtSelection &&
    !!prevProps.onUnsplit === !!nextProps.onUnsplit &&
    prevProps.textSelection?.start === nextProps.textSelection?.start &&
    prevProps.textSelection?.end === nextProps.textSelection?.end &&
    prevProps.showTimestamps === nextProps.showTimestamps &&
    prevProps.showNotes === nextProps.showNotes &&
    prevProps.showCodes === nextProps.showCodes &&
    prevProps.allCodes === nextProps.allCodes &&
    prevProps.codeMap === nextProps.codeMap &&
    prevProps.onCodeChange === nextProps.onCodeChange &&
    prevProps.projectId === nextProps.projectId
  )
})
