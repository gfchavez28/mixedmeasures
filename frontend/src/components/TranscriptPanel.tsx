import { useCallback, useRef, useState, useEffect, useMemo, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso'
import { Search, X, Filter, Merge, Play, Pause, Quote, Users } from 'lucide-react'
import { useDroppable } from '@dnd-kit/core'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { type Segment, type Code, type Speaker, type Conversation, audioApi } from '@/lib/api'
import type { FloatingCoords } from '@/lib/floating-utils'
import { getSpeakerInitials } from '@/lib/conversation-import-utils'
import { useTextSplitSelection } from '@/hooks/useTextSplitSelection'
import { useSegmentSelection } from '@/hooks/useSegmentSelection'
import { usePlayback } from '@/hooks/usePlayback'
import SegmentRow from './SegmentRow'
import SplitToolbar from './SplitToolbar'
import TimelineScrubber from './TimelineScrubber'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'


// KWIC snippet with highlighted match for search results
function renderSearchSnippet(text: string, query: string, contextChars = 50): ReactNode {
  const lower = text.toLowerCase()
  const queryLower = query.toLowerCase()
  const index = lower.indexOf(queryLower)
  if (index === -1) return text.slice(0, contextChars * 2) + (text.length > contextChars * 2 ? '...' : '')

  const matchStart = index
  const matchEnd = index + query.length
  let beforeStart = Math.max(0, matchStart - contextChars)
  const afterEnd = Math.min(text.length, matchEnd + contextChars)

  // Try to start at a word boundary
  if (beforeStart > 0) {
    const spaceIndex = text.indexOf(' ', beforeStart)
    if (spaceIndex !== -1 && spaceIndex < matchStart) {
      beforeStart = spaceIndex + 1
    }
  }

  const prefix = beforeStart > 0 ? '...' : ''
  const suffix = afterEnd < text.length ? '...' : ''

  return (
    <>
      {prefix}{text.slice(beforeStart, matchStart)}
      <mark className="bg-yellow-200 text-yellow-900 rounded-sm px-0.5">{text.slice(matchStart, matchEnd)}</mark>
      {text.slice(matchEnd, afterEnd)}{suffix}
    </>
  )
}

interface TranscriptPanelProps {
  segments: Segment[]
  allSegments: Segment[]
  selectedSegments: number[]
  onSelectionChange: (ids: number[]) => void
  conversationId: number
  codes: Code[]
  // Filter props (Item 14)
  uniqueSpeakers: string[]
  speakerFilter: Set<string>
  onSpeakerFilterChange: (speakers: Set<string>) => void
  textFilter: string
  onTextFilterChange: (text: string) => void
  // Merge props (Item 18)
  onMergeSegments?: (segmentIds: number[]) => void
  // Unmerge prop (Issue 100)
  onUnmergeSegment?: (segmentId: number) => void
  // Click handler for notes in transcript (Item 66)
  onNoteClick?: (noteId: number) => void
  // Inline editing props (Issues 101 & 102)
  editingSegmentId?: number | null
  editField?: 'text' | 'speaker'
  onStartEdit?: (segmentId: number, field: 'text' | 'speaker') => void
  onCancelEdit?: () => void
  onSaveEdit?: (segmentId: number, update: { text?: string; speaker_id?: number }) => void
  speakers?: Speaker[]
  // Excerpt filter
  quotedFilter?: boolean
  onQuotedFilterChange?: (quoted: boolean) => void
  onToggleQuote?: (segmentId: number) => void
  onSaveExcerpt?: (segmentId: number, startOffset: number, endOffset: number) => void
  onDeleteExcerpt?: (excerptId: number) => void
  onAddNoteToExcerpt?: (excerptId: number, segmentId: number) => void
  // Drag-and-drop (Issue 110)
  isDragActive?: boolean
  // Group props (Phase 8)
  onGroupSegments?: (segmentIds: number[]) => void
  onUngroupSegments?: (groupId: number, memberSegmentIds: number[]) => void
  // Context menu actions
  onContextCodeApply?: (segmentId: number, codeId: number) => void
  onContextCreateCode?: (coords: FloatingCoords) => void
  onContextCreateNote?: (segmentId: number, coords: FloatingCoords) => void
  // Split support
  onSplitSegment?: (ranges: { segment_id: number; start_offset: number; end_offset: number }[]) => void
  // Unsplit/rejoin support
  onUnsplitSegment?: (segmentId: number) => void
  // Column visibility toggles
  showTimestamps?: boolean
  showNotes?: boolean
  showCodes?: boolean
  projectId?: number
  allCodes?: Code[]
  codeMap?: Map<number, Code>
  onCodeChange?: () => void
  scrubberPortalRef?: RefObject<HTMLDivElement | null>
  /** Conversation metadata — used for audio playback sync */
  conversation?: Conversation
  /** Ref for parent to access togglePlayback */
  playbackRef?: RefObject<{ togglePlayback: () => void } | null>
}

const HEADER_HEIGHT = 40

export default function TranscriptPanel({
  segments,
  allSegments,
  selectedSegments,
  onSelectionChange,
  conversationId,
  codes,
  uniqueSpeakers,
  speakerFilter,
  onSpeakerFilterChange,
  textFilter,
  onTextFilterChange,
  onMergeSegments,
  onUnmergeSegment,
  onNoteClick,
  editingSegmentId,
  editField,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  speakers,
  quotedFilter = false,
  onQuotedFilterChange,
  onToggleQuote,
  onSaveExcerpt,
  onDeleteExcerpt,
  onAddNoteToExcerpt,
  isDragActive = false,
  onGroupSegments,
  onUngroupSegments,
  onContextCodeApply,
  onContextCreateCode,
  onContextCreateNote,
  onSplitSegment,
  onUnsplitSegment,
  showTimestamps = true,
  showNotes = true,
  showCodes = true,
  projectId,
  allCodes,
  codeMap,
  onCodeChange,
  scrubberPortalRef,
  conversation,
  playbackRef,
}: TranscriptPanelProps) {
  const listRef = useRef<VirtuosoHandle>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerHeight, setContainerHeight] = useState(600)

  // Issue 119: Skip auto-scroll when selection came from a mouse click
  const skipAutoScroll = useRef(false)

  // Ref for segments to avoid auto-scroll re-firing on background refetch (Issue 123)
  const segmentsForScrollRef = useRef(segments)
  useEffect(() => { segmentsForScrollRef.current = segments }, [segments])

  // State mirror of scrubberPortalRef for render (refs cannot be read during render)
  const [portalTarget, setPortalTarget] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    setPortalTarget(scrubberPortalRef?.current ?? null)
  }, [scrubberPortalRef])

  // Issue 120: Search popover state
  const [searchOpen, setSearchOpen] = useState(false)
  const [focusedSearchIndex, setFocusedSearchIndex] = useState(-1)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchResultsRef = useRef<HTMLDivElement>(null)

  // Audio element ref for real audio playback
  const audioRef = useRef<HTMLAudioElement>(null)
  const hasAudio = conversation?.media_type === 'audio' && !!conversation?.media_filename

  // Playback state (Item 62) — extracted to usePlayback hook
  const {
    isPlaying,
    playbackSpeed,
    currentPlaybackTime,
    segmentsWithTime,
    togglePlayback,
    cyclePlaybackSpeed,
    handleTimeSeek,
    isAudioReady,
    isBuffering,
    audioError,
  } = usePlayback({ segments, selectedSegments, onSelectionChange, audioRef, conversation })

  // Show toast on audio error
  useEffect(() => {
    if (audioError) toast.error(audioError)
  }, [audioError])

  // Expose togglePlayback to parent (for Space shortcut)
  useEffect(() => {
    if (playbackRef) {
      // eslint-disable-next-line react-hooks/immutability -- imperative ref handle assignment in effect
      (playbackRef as React.MutableRefObject<{ togglePlayback: () => void } | null>).current = { togglePlayback }
    }
    return () => {
      if (playbackRef) {
        (playbackRef as React.MutableRefObject<{ togglePlayback: () => void } | null>).current = null
      }
    }
  }, [togglePlayback, playbackRef])

  useEffect(() => {
    const updateHeight = () => {
      if (containerRef.current) {
        setContainerHeight(containerRef.current.clientHeight - HEADER_HEIGHT)
      }
    }

    updateHeight()
    window.addEventListener('resize', updateHeight)

    // Also update after a short delay to account for layout shifts
    const timeout = setTimeout(updateHeight, 100)

    return () => {
      window.removeEventListener('resize', updateHeight)
      clearTimeout(timeout)
    }
  }, [])

  // Auto-scroll to selected segment when selection changes (for keyboard navigation)
  // Issue 119: Skip auto-scroll for mouse clicks (segment is already visible)
  // Issue 123: Only fire on selectedSegments change, not segments refetch.
  //   Uses segmentsForScrollRef to avoid re-firing when segments gets a new reference
  //   from a background React Query refetch (which would scroll back to old selection).
  // Issue 210: Removed manual visible-range check — Virtuoso's align:'nearest' handles it natively.
  useEffect(() => {
    if (skipAutoScroll.current) {
      skipAutoScroll.current = false
      return
    }
    if (selectedSegments.length > 0 && listRef.current) {
      const lastSelectedId = selectedSegments[selectedSegments.length - 1]
      const currentSegments = segmentsForScrollRef.current
      const segmentIndex = currentSegments.findIndex(s => s.id === lastSelectedId)
      if (segmentIndex >= 0) {
        listRef.current.scrollToIndex({ index: segmentIndex, behavior: 'auto', align: 'center' })
      }
    }
  }, [selectedSegments])

  // Playback logic now in usePlayback hook (above)

  // Toggle speaker in filter
  const toggleSpeaker = useCallback((speaker: string) => {
    const newFilter = new Set(speakerFilter)
    if (newFilter.has(speaker)) {
      newFilter.delete(speaker)
    } else {
      newFilter.add(speaker)
    }
    onSpeakerFilterChange(newFilter)
  }, [speakerFilter, onSpeakerFilterChange])

  // Clear all filters
  const clearFilters = useCallback(() => {
    onSpeakerFilterChange(new Set())
    onTextFilterChange('')
    onQuotedFilterChange?.(false)
  }, [onSpeakerFilterChange, onTextFilterChange, onQuotedFilterChange])

  // hasActiveFilters checks speaker filter and quoted filter (text search is a popover overlay, not a filter)
  const hasActiveFilters = speakerFilter.size > 0 || quotedFilter

  // Issue 120: Search results for popover (search through ALL segments regardless of speaker filter)
  const searchResults = useMemo(() => {
    if (!textFilter) return []
    const lower = textFilter.toLowerCase()
    return allSegments
      .filter(s => s.text.toLowerCase().includes(lower))
      .slice(0, 20)
  }, [allSegments, textFilter])

  // Speaker lookup for search result badges
  const speakerLookup = useMemo(() => {
    const map = new Map<number, Speaker>()
    speakers?.forEach(s => map.set(s.id, s))
    return map
  }, [speakers])

  // Wrap onSelectionChange to clear speaker filter on regular (non-modifier) clicks
  const handleSelectionWithFilterClear = useCallback((ids: number[]) => {
    onSelectionChange(ids)
  }, [onSelectionChange])

  const { handleItemClick: handleSegmentItemClick } = useSegmentSelection({
    items: segments,
    getId: (s) => s.id,
    selectedIds: selectedSegments,
    onSelectionChange: handleSelectionWithFilterClear,
  })

  const handleSegmentClick = useCallback(
    (segment: Segment, event: React.MouseEvent) => {
      // Issue 119: Mouse clicks should not trigger auto-scroll
      skipAutoScroll.current = true
      handleSegmentItemClick(segment.id, event)
      // Issue 116: Clear speaker filter on regular click
      if (!event.shiftKey && !event.ctrlKey && !event.metaKey && speakerFilter.size > 0) {
        onSpeakerFilterChange(new Set())
      }
    },
    [handleSegmentItemClick, speakerFilter, onSpeakerFilterChange]
  )

  // Check if selected segments are adjacent (for merge validation)
  const areSelectedAdjacent = useCallback(() => {
    if (selectedSegments.length < 2) return false
    // Get segments in order by sequence_order
    const selectedSegs = segments
      .filter(s => selectedSegments.includes(s.id))
      .sort((a, b) => a.sequence_order - b.sequence_order)
    // Check if they're consecutive
    for (let i = 0; i < selectedSegs.length - 1; i++) {
      if (selectedSegs[i + 1].sequence_order !== selectedSegs[i].sequence_order + 1) {
        return false
      }
    }
    return true
  }, [segments, selectedSegments])

  // Phase 8: Precompute group members map from ALL segments (unfiltered)
  // so undo/ARIA use correct full membership even when speaker filter is active
  const groupMembersMap = useMemo(() => {
    const map = new Map<number, number[]>()
    allSegments.forEach(s => {
      if (s.group_id !== null && s.group_id !== undefined) {
        const existing = map.get(s.group_id) || []
        existing.push(s.id)
        map.set(s.group_id, existing)
      }
    })
    return map
  }, [allSegments])

  // Phase 8: Can selected segments be grouped?
  const canGroupSelected = useMemo(() => {
    if (selectedSegments.length < 2) return false
    const selectedSegs = segments
      .filter(s => selectedSegments.includes(s.id))
      .sort((a, b) => a.sequence_order - b.sequence_order)
    for (let i = 0; i < selectedSegs.length - 1; i++) {
      if (selectedSegs[i + 1].sequence_order !== selectedSegs[i].sequence_order + 1) return false
    }
    return selectedSegs.every(s => s.group_id === null && !s.is_merged)
  }, [segments, selectedSegments])

  // Phase 8: Are none of the selected segments grouped? (merge guard)
  const noneSelectedGrouped = useMemo(() => {
    return segments
      .filter(s => selectedSegments.includes(s.id))
      .every(s => s.group_id === null)
  }, [segments, selectedSegments])

  // Text split selection via shared hook
  const {
    splitSelection,
    handleSplit,
    handleCancelSplit,
    getTextSelectionForSegment,
    announcement: splitAnnouncement,
  } = useTextSplitSelection(containerRef, segments, onSplitSegment, onSelectionChange, { allSegments })

  const itemContent = useCallback(
    (index: number) => {
      const segment = segments[index]
      const isSelected = selectedSegments.includes(segment.id)

      // Determine merge capabilities (with group guard)
      const prevSegment = index > 0 ? segments[index - 1] : null
      const nextSegment = index < segments.length - 1 ? segments[index + 1] : null
      const canMergeWithPrev = !!(prevSegment
        && prevSegment.sequence_order === segment.sequence_order - 1
        && !segment.group_id && !prevSegment.group_id)
      const canMergeWithNext = !!(nextSegment
        && nextSegment.sequence_order === segment.sequence_order + 1
        && !segment.group_id && !nextSegment.group_id)
      const canMergeSelected = isSelected && selectedSegments.length > 1
        && areSelectedAdjacent() && noneSelectedGrouped

      // Compute group position (Phase 8)
      let groupPosition: 'first' | 'middle' | 'last' | 'solo' | null = null
      let groupAriaLabel: string | undefined
      if (segment.group_id) {
        const prevInGroup = index > 0 && segments[index - 1].group_id === segment.group_id
        const nextInGroup = index < segments.length - 1 && segments[index + 1].group_id === segment.group_id
        if (prevInGroup && nextInGroup) groupPosition = 'middle'
        else if (prevInGroup) groupPosition = 'last'
        else if (nextInGroup) groupPosition = 'first'
        else groupPosition = 'solo'

        const members = groupMembersMap.get(segment.group_id) || []
        const posInGroup = members.indexOf(segment.id) + 1
        groupAriaLabel = `Grouped segment ${posInGroup} of ${members.length}`
      }

      const segIsGrouped = !!segment.group_id
      const groupMemberIds = segIsGrouped ? (groupMembersMap.get(segment.group_id!) || []) : []

      return (
        <DroppableSegmentWrapper segmentId={segment.id} isDragActive={isDragActive}>
          {(isDragOver) => (
            <div className="border-b border-mm-border-subtle">
              <SegmentRow
                segment={segment}
                isSelected={isSelected}
                isDragOver={isDragOver}
                onClick={(e) => handleSegmentClick(segment, e)}
                conversationId={conversationId}
                codes={codes}
                canMergeWithPrev={canMergeWithPrev}
                canMergeWithNext={canMergeWithNext}
                canMergeSelected={canMergeSelected}
                selectedCount={selectedSegments.length}
                onMergeWithPrev={canMergeWithPrev && onMergeSegments
                  ? () => onMergeSegments([prevSegment!.id, segment.id])
                  : undefined}
                onMergeWithNext={canMergeWithNext && onMergeSegments
                  ? () => onMergeSegments([segment.id, nextSegment!.id])
                  : undefined}
                onMergeSelected={canMergeSelected && onMergeSegments
                  ? () => {
                      const sortedIds = segments
                        .filter(s => selectedSegments.includes(s.id))
                        .sort((a, b) => a.sequence_order - b.sequence_order)
                        .map(s => s.id)
                      onMergeSegments(sortedIds)
                    }
                  : undefined}
                onUnmerge={segment.is_merged && onUnmergeSegment
                  ? () => onUnmergeSegment(segment.id)
                  : undefined}
                onUnsplit={segment.is_split && onUnsplitSegment
                  ? () => onUnsplitSegment(segment.id)
                  : undefined}
                onNoteClick={onNoteClick}

                isEditing={editingSegmentId === segment.id}
                editField={editField}
                onStartEdit={onStartEdit}
                onCancelEdit={onCancelEdit}
                onSaveEdit={onSaveEdit}
                onToggleQuote={onToggleQuote}
                onSaveExcerpt={onSaveExcerpt}
                onDeleteExcerpt={onDeleteExcerpt}
                onAddNoteToExcerpt={onAddNoteToExcerpt}
                speakers={speakers}
                searchHighlight={textFilter}
                groupPosition={groupPosition}
                groupAriaLabel={groupAriaLabel}
                canGroupSelected={isSelected && canGroupSelected}
                onGroupSelected={canGroupSelected && onGroupSegments
                  ? () => {
                      const sortedIds = segments
                        .filter(s => selectedSegments.includes(s.id))
                        .sort((a, b) => a.sequence_order - b.sequence_order)
                        .map(s => s.id)
                      onGroupSegments(sortedIds)
                    }
                  : undefined}
                isGrouped={segIsGrouped}
                onUngroup={segIsGrouped && segment.group_id && onUngroupSegments
                  ? () => onUngroupSegments(segment.group_id!, groupMemberIds)
                  : undefined}
                onContextCodeApply={onContextCodeApply}
                onContextCreateCode={onContextCreateCode}
                onContextCreateNote={onContextCreateNote}
                onRightClickSelect={!isSelected ? () => {
                  skipAutoScroll.current = true
                  onSelectionChange([segment.id])
                } : undefined}
                onSplitAtSelection={splitSelection && onSplitSegment && splitSelection.ranges.some(r => r.segment_id === segment.id)
                  ? handleSplit
                  : undefined}
                textSelection={getTextSelectionForSegment(segment.id)}
                showTimestamps={showTimestamps}
                showNotes={showNotes}
                showCodes={showCodes}
                projectId={projectId}
                allCodes={allCodes}
                codeMap={codeMap}
                onCodeChange={onCodeChange}
              />
            </div>
          )}
        </DroppableSegmentWrapper>
      )
    },
    [segments, selectedSegments, handleSegmentClick, conversationId, codes, areSelectedAdjacent, onMergeSegments, onUnmergeSegment, onUnsplitSegment, onNoteClick, editingSegmentId, editField, onStartEdit, onCancelEdit, onSaveEdit, onToggleQuote, onSaveExcerpt, onDeleteExcerpt, onAddNoteToExcerpt, speakers, textFilter, isDragActive, canGroupSelected, noneSelectedGrouped, onGroupSegments, onUngroupSegments, groupMembersMap, onContextCodeApply, onContextCreateCode, onContextCreateNote, splitSelection, handleSplit, onSplitSegment, showTimestamps, showNotes, showCodes, projectId, allCodes, codeMap, onCodeChange, onSelectionChange, getTextSelectionForSegment]
  )

  // Handle scrubber position change (for live scroll during drag)
  const handleScrubberPositionChange = useCallback((position: number) => {
    if (!listRef.current || segments.length === 0) return
    // Position is 0-1, map to segment index
    const index = Math.floor(position * (segments.length - 1))
    listRef.current.scrollToIndex({ index, behavior: 'auto', align: 'start' })
  }, [segments.length])

  // Show controls when segments have timestamps OR when audio is attached (play/pause only)
  const showPlaybackControls = segmentsWithTime.length > 0 || hasAudio
  // Disabled while audio metadata is still loading AND when audio errored —
  // a file the browser can't decode must not present a clickable-but-dead
  // play button (clicking would just re-error).
  const playButtonDisabled = hasAudio && (!isAudioReady || !!audioError)

  const scrubberControls = showPlaybackControls ? (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0 flex-shrink-0"
        onClick={togglePlayback}
        disabled={playButtonDisabled}
        aria-label={
          isBuffering ? 'Buffering audio' :
          isPlaying ? (hasAudio ? 'Pause audio' : 'Pause transcript') :
          (hasAudio ? 'Play audio (Space)' : 'Play transcript (Space)')
        }
        title={
          audioError ? 'Audio unavailable — this codec can’t play in-browser' :
          playButtonDisabled ? 'Loading audio...' :
          isPlaying ? 'Pause (Space)' : 'Play (Space)'
        }
      >
        {isBuffering ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : isPlaying ? (
          <Pause className="w-4 h-4" />
        ) : (
          <Play className="w-4 h-4" />
        )}
      </Button>
      {segmentsWithTime.length > 0 && (
        <TimelineScrubber
          segments={allSegments}
          currentTime={
            isPlaying && currentPlaybackTime !== null
              ? currentPlaybackTime
              : selectedSegments.length > 0
                ? segments.find(s => s.id === selectedSegments[0])?.start_time ?? null
                : null
          }
          onTimeChange={(time) => {
            const result = handleTimeSeek(time)
            if (result && listRef.current) {
              listRef.current.scrollToIndex({ index: result.segmentIndex, behavior: 'auto', align: 'center' })
            }
          }}
          onPositionChange={handleScrubberPositionChange}
          mediaDuration={conversation?.media_duration_seconds}
          isVbr={conversation?.media_is_vbr === true}
          className="flex-1"
        />
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs flex-shrink-0 font-mono"
        onClick={cyclePlaybackSpeed}
        title="Click to change playback speed"
      >
        {playbackSpeed}x
      </Button>
    </>
  ) : null

  return (
    <div ref={containerRef} className="h-full flex flex-col">
      {/* Hidden audio element for real audio playback */}
      {hasAudio && conversation && projectId && (
        <audio
          ref={audioRef}
          src={audioApi.getStreamUrl(projectId, conversationId)}
          preload="metadata"
        />
      )}

      {/* Portal scrubber controls into toolbar slot if available */}
      {scrubberControls && portalTarget && createPortal(scrubberControls, portalTarget)}

      {/* Column Headers - moved below scrubber (Item 64) */}
      <div
        className="flex-shrink-0 bg-mm-surface border-b px-4 py-2 flex items-center gap-3 font-medium text-sm text-mm-text-secondary"
        style={{ height: HEADER_HEIGHT }}
      >
        {/* Excerpt filter toggle */}
        <button
          className={`w-5 flex-shrink-0 transition-colors ${
            quotedFilter ? 'text-blue-500' : 'text-emerald-400 hover:text-blue-500'
          }`}
          onClick={() => onQuotedFilterChange?.(!quotedFilter)}
          title={quotedFilter ? 'Show all segments' : 'Show excerpted segments only'}
        >
          <Quote className={`w-4 h-4 ${quotedFilter ? 'fill-blue-500' : ''}`} />
        </button>

        {/* Time Column Header */}
        {showTimestamps && <span className="w-16 flex-shrink-0 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 rounded-full px-2.5 py-0.5 text-xs font-medium text-center">Time</span>}

        {/* Speaker Header with Filter */}
        <Popover>
          <PopoverTrigger asChild>
            <button className="w-24 flex-shrink-0 flex items-center gap-1 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 rounded-full px-2.5 py-0.5 text-xs font-medium hover:bg-emerald-100 dark:hover:bg-emerald-900/50">
              Speaker
              {speakerFilter.size > 0 && (
                <span className="text-xs bg-emerald-200 text-emerald-800 dark:bg-emerald-800 dark:text-emerald-200 px-1 rounded-full">
                  {speakerFilter.size}
                </span>
              )}
              <Filter className="w-3 h-3" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-2" align="start">
            <div className="text-xs text-mm-text-muted mb-2">Filter by speaker</div>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {uniqueSpeakers.map(speaker => (
                <div key={speaker} className="flex items-center gap-2">
                  <Checkbox
                    id={`speaker-${speaker}`}
                    checked={speakerFilter.size === 0 || speakerFilter.has(speaker)}
                    onCheckedChange={() => {
                      if (speakerFilter.size === 0) {
                        // First selection: select only this speaker
                        onSpeakerFilterChange(new Set([speaker]))
                      } else {
                        toggleSpeaker(speaker)
                      }
                    }}
                  />
                  <Label htmlFor={`speaker-${speaker}`} className="text-sm cursor-pointer">
                    {speaker}
                  </Label>
                </div>
              ))}
            </div>
            {speakerFilter.size > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full mt-2"
                onClick={() => onSpeakerFilterChange(new Set())}
              >
                Clear filter
              </Button>
            )}
          </PopoverContent>
        </Popover>

        {/* Text Header with Search Popover (Issue 120) */}
        <div className="flex-1 relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-mm-text-faint z-10" />
          <Input
            ref={searchInputRef}
            placeholder="Search segments..."
            role="combobox"
            aria-expanded={searchOpen && !!textFilter}
            aria-controls="segment-search-listbox"
            aria-autocomplete="list"
            value={textFilter}
            onChange={(e) => {
              onTextFilterChange(e.target.value)
              setSearchOpen(true)
              setFocusedSearchIndex(-1)
            }}
            onFocus={() => textFilter && setSearchOpen(true)}
            onBlur={() => setSearchOpen(false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                if (searchOpen) {
                  setSearchOpen(false)
                  setFocusedSearchIndex(-1)
                } else {
                  onTextFilterChange('')
                }
                searchInputRef.current?.blur()
              } else if (e.key === 'ArrowDown' && searchOpen && searchResults.length > 0) {
                e.preventDefault()
                setFocusedSearchIndex(prev => {
                  const next = Math.min(prev + 1, searchResults.length - 1)
                  setTimeout(() => {
                    searchResultsRef.current?.querySelectorAll('[data-search-result]')[next]
                      ?.scrollIntoView({ block: 'nearest' })
                  }, 0)
                  return next
                })
              } else if (e.key === 'ArrowUp' && searchOpen && searchResults.length > 0) {
                e.preventDefault()
                setFocusedSearchIndex(prev => {
                  const next = Math.max(prev - 1, 0)
                  setTimeout(() => {
                    searchResultsRef.current?.querySelectorAll('[data-search-result]')[next]
                      ?.scrollIntoView({ block: 'nearest' })
                  }, 0)
                  return next
                })
              } else if (e.key === 'Enter' && searchOpen && focusedSearchIndex >= 0 && focusedSearchIndex < searchResults.length) {
                e.preventDefault()
                const segment = searchResults[focusedSearchIndex]
                onSelectionChange([segment.id])
                if (speakerFilter.size > 0 && !speakerFilter.has(segment.speaker_name || '')) {
                  onSpeakerFilterChange(new Set())
                }
                setSearchOpen(false)
                setFocusedSearchIndex(-1)
                searchInputRef.current?.blur()
              }
            }}
            className="h-7 pl-7 pr-7 text-sm border-emerald-200 dark:border-emerald-800 focus-visible:ring-emerald-500"
          />
          {textFilter && (
            <button
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-mm-text-faint hover:text-mm-text-secondary z-10"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onTextFilterChange('')
                setSearchOpen(false)
              }}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}

          {/* Search Results Dropdown */}
          {searchOpen && textFilter && (
            <div
              ref={searchResultsRef}
              className="absolute top-full left-0 right-0 mt-1 bg-mm-surface border rounded-md shadow-lg max-h-80 overflow-y-auto z-50"
              id="segment-search-listbox"
              role="listbox"
              onMouseDown={(e) => e.preventDefault()}
            >
              {searchResults.length === 0 ? (
                <div className="p-3 text-sm text-mm-text-muted">No matching segments</div>
              ) : (
                <>
                  <div className="px-3 py-1.5 text-xs text-mm-text-muted border-b bg-mm-bg">
                    {searchResults.length >= 20 ? '20+' : searchResults.length} result{searchResults.length !== 1 ? 's' : ''}
                  </div>
                  {searchResults.map((segment, index) => {
                    const speaker = segment.speaker_id ? speakerLookup.get(segment.speaker_id) : null
                    const isFacilitator = speaker?.is_facilitator ?? false
                    return (
                      <button
                        key={segment.id}
                        data-search-result
                        role="option"
                        aria-selected={focusedSearchIndex === index}
                        className={`w-full text-left px-3 py-2 hover:bg-mm-surface-hover border-b last:border-b-0 flex items-start gap-2 ${focusedSearchIndex === index ? 'bg-mm-surface-hover' : ''}`}
                        onMouseEnter={() => setFocusedSearchIndex(index)}
                        onClick={() => {
                          onSelectionChange([segment.id])
                          // Clear speaker filter if this segment would be hidden
                          if (speakerFilter.size > 0 && !speakerFilter.has(segment.speaker_name || '')) {
                            onSpeakerFilterChange(new Set())
                          }
                          setSearchOpen(false)
                          searchInputRef.current?.blur()
                        }}
                      >
                        <span className={`w-6 h-6 rounded-full text-xs font-semibold flex items-center justify-center ring-1 flex-shrink-0 mt-0.5 ${
                          isFacilitator
                            ? 'bg-purple-200 text-purple-800 ring-purple-300'
                            : 'bg-orange-200 text-orange-800 ring-orange-300'
                        }`}>
                          {getSpeakerInitials(segment.speaker_name || '')}
                        </span>
                        <span className="text-xs text-mm-text-secondary line-clamp-2">
                          {renderSearchSnippet(segment.text, textFilter)}
                        </span>
                      </button>
                    )
                  })}
                </>
              )}
            </div>
          )}
        </div>

        {/* Notes Header (Item 65) */}
        {showNotes && (
          <div className="flex-shrink-0 flex items-center gap-1">
            <span className="bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 rounded-full px-2 py-0.5 text-xs font-medium">Notes</span>
            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1 text-xs"
                onClick={clearFilters}
                title="Clear all filters"
              >
                <X className="w-3 h-3" />
              </Button>
            )}
          </div>
        )}

        {/* Codes Header (Item 65) - left aligned */}
        {showCodes && (
          <div className="w-[160px] flex-shrink-0">
            <span className="bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 rounded-full px-2.5 py-0.5 text-xs font-medium">Codes</span>
          </div>
        )}
      </div>

      {/* Virtualized List */}
      <div className="flex-1 relative">
        {/* Merge/Group Action Bar - overlaid so it doesn't shift the transcript */}
        {selectedSegments.length > 1 && areSelectedAdjacent() && noneSelectedGrouped && (onMergeSegments || onGroupSegments) && (
          <div className="absolute top-0 left-0 right-0 z-10 bg-emerald-50 border-b border-emerald-200 px-4 py-2 flex items-center justify-between shadow-xs">
            <span className="text-sm text-emerald-700">
              {selectedSegments.length} adjacent segments selected
            </span>
            <div className="flex items-center gap-2">
              {canGroupSelected && onGroupSegments && (
                <Button
                  size="sm"
                  variant="default"
                  className="bg-teal-600 hover:bg-teal-700"
                  onClick={() => {
                    const sortedIds = segments
                      .filter(s => selectedSegments.includes(s.id))
                      .sort((a, b) => a.sequence_order - b.sequence_order)
                      .map(s => s.id)
                    onGroupSegments(sortedIds)
                  }}
                >
                  <Users className="w-4 h-4 mr-1" />
                  Group Segments
                </Button>
              )}
              {onMergeSegments && (
                <Button
                  size="sm"
                  variant="default"
                  className="bg-emerald-600 hover:bg-emerald-700"
                  onClick={() => {
                    const sortedIds = segments
                      .filter(s => selectedSegments.includes(s.id))
                      .sort((a, b) => a.sequence_order - b.sequence_order)
                      .map(s => s.id)
                    onMergeSegments(sortedIds)
                  }}
                >
                  <Merge className="w-4 h-4 mr-1" />
                  Merge Segments
                </Button>
              )}
            </div>
          </div>
        )}

        {segments.length === 0 ? (
          <div className="p-8 text-center text-mm-text-muted">
            {hasActiveFilters ? (
              <div>
                <p>No segments match your filters</p>
                <Button variant="link" onClick={clearFilters} className="mt-2">
                  Clear filters
                </Button>
              </div>
            ) : (
              'No segments found'
            )}
          </div>
        ) : (
          <Virtuoso
            ref={listRef}
            style={{ height: containerHeight }}
            totalCount={segments.length}
            itemContent={itemContent}
            overscan={200}
          />
        )}
      </div>

      {/* Split toolbar - floating near text selection */}
      {splitSelection && onSplitSegment && (
        <SplitToolbar
          position={splitSelection.rect}
          onSplit={handleSplit}
          onCancel={handleCancelSplit}
        />
      )}

      {/* Split selection announcements */}
      <div role="status" aria-live="polite" className="sr-only">{splitAnnouncement}</div>
    </div>
  )
}

// Droppable wrapper for segments (Issue 110: drag-and-drop codes/notes onto segments)
function DroppableSegmentWrapper({ segmentId, isDragActive, children }: { segmentId: number; isDragActive: boolean; children: (isDragOver: boolean) => React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `segment-${segmentId}` })

  if (!isDragActive) return <>{children(false)}</>

  return (
    <div ref={setNodeRef}>
      {children(isOver)}
    </div>
  )
}
