import { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import { Info } from 'lucide-react'
import { type Segment } from '@/lib/api'
import { formatTimestamp } from '@/lib/utils'
import { isBeyondRecording, recordingEndsAtTimelineTime } from '@/lib/playback-utils'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'

interface TimelineScrubberProps {
  segments: Segment[]
  currentTime: number | null
  onTimeChange: (time: number) => void
  onPositionChange?: (position: number) => void  // 0-1 for scroll sync
  /** Audio duration — extends max boundary beyond last segment */
  mediaDuration?: number | null
  /** Media sync offset (#564): timeline time t maps to media time t + offset, so
   *  the recording covers the timeline only up to `mediaDuration − offset`. */
  mediaOffset?: number
  /** Show VBR info icon */
  isVbr?: boolean
  className?: string
}

export default function TimelineScrubber({
  segments,
  currentTime,
  onTimeChange,
  onPositionChange,
  mediaDuration,
  mediaOffset = 0,
  isVbr = false,
  className,
}: TimelineScrubberProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [hoveredTime, setHoveredTime] = useState<number | null>(null)
  const [hoverPosition, setHoverPosition] = useState<number | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [dragPosition, setDragPosition] = useState<number | null>(null)

  // Calculate timeline boundaries
  const { minTime, maxTime, duration } = useMemo(() => {
    let min = Infinity
    let max = -Infinity

    segments.forEach(seg => {
      if (seg.start_time !== null && seg.start_time !== undefined) {
        min = Math.min(min, seg.start_time)
      }
      if (seg.end_time !== null && seg.end_time !== undefined) {
        max = Math.max(max, seg.end_time)
      }
    })

    if (min === Infinity) min = 0
    if (max === -Infinity) max = 0

    // Extend max to cover audio duration if it exceeds transcript timestamps
    if (mediaDuration != null && mediaDuration > max) {
      max = mediaDuration
    }

    return {
      minTime: min,
      maxTime: max,
      duration: max - min,
    }
  }, [segments, mediaDuration])

  // #563: the transcript can outrun the RECORDING — a partial capture, a trimmed
  // clip, or simply the wrong file attached (the recording slot accepts any file
  // for any transcript). The timeline still spans the whole transcript (you must
  // be able to read and code the untaped part), but the stretch past the end of
  // the recording has nothing to play, and saying so is the difference between a
  // dead zone and a mystery: before this, scrubbing there parked the player on
  // the final frame and the next Play silently restarted at 0:00.
  const recordingEnd = useMemo(
    () => recordingEndsAtTimelineTime(mediaDuration, mediaOffset),
    [mediaDuration, mediaOffset],
  )
  const coverageEnd = useMemo(() => {
    if (recordingEnd === null || duration <= 0) return null
    if (recordingEnd >= maxTime) return null // the recording covers everything
    return Math.max(0, Math.min(1, (recordingEnd - minTime) / duration))
  }, [recordingEnd, minTime, maxTime, duration])

  /** #564: is a given timeline position past the end of the recording? */
  const beyond = useCallback(
    (t: number | null) => t !== null && isBeyondRecording(t, mediaDuration, mediaOffset),
    [mediaDuration, mediaOffset],
  )
  const playheadBeyond = beyond(currentTime)

  // Fixed reference tick marks at 25%, 50%, 75%
  const REFERENCE_TICKS = [
    { position: 25, height: '40%' },
    { position: 50, height: '60%' },
    { position: 75, height: '40%' },
  ]

  // Calculate current position (use drag position when dragging)
  const currentPosition = useMemo(() => {
    if (dragPosition !== null) return dragPosition
    if (currentTime === null || duration <= 0) return 0
    return Math.max(0, Math.min(1, (currentTime - minTime) / duration))
  }, [currentTime, minTime, duration, dragPosition])

  // Get position from mouse/touch event
  const getPositionFromEvent = useCallback((clientX: number) => {
    if (!containerRef.current || duration <= 0) return null
    const rect = containerRef.current.getBoundingClientRect()
    const x = clientX - rect.left
    return Math.max(0, Math.min(1, x / rect.width))
  }, [duration])

  // Handle mouse down - start dragging
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const position = getPositionFromEvent(e.clientX)
    if (position !== null) {
      setIsDragging(true)
      setDragPosition(position)
      onPositionChange?.(position)
    }
  }, [getPositionFromEvent, onPositionChange])

  // Handle touch start
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    const position = getPositionFromEvent(touch.clientX)
    if (position !== null) {
      setIsDragging(true)
      setDragPosition(position)
      onPositionChange?.(position)
    }
  }, [getPositionFromEvent, onPositionChange])

  // Handle mouse/touch move during drag and release
  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const position = getPositionFromEvent(e.clientX)
      if (position !== null) {
        setDragPosition(position)
        onPositionChange?.(position)
      }
    }

    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault() // Prevent scroll only during active drag
      const touch = e.touches[0]
      const position = getPositionFromEvent(touch.clientX)
      if (position !== null) {
        setDragPosition(position)
        onPositionChange?.(position)
      }
    }

    const handleRelease = (clientX: number) => {
      const position = getPositionFromEvent(clientX)
      if (position !== null && duration > 0) {
        // #563b: seek to WHERE THE USER DROPPED THE PLAYHEAD.
        //
        // This used to snap the drop to the nearest segment's `start_time`, which
        // silently destroyed the drag's precision — and with it, most of the
        // timeline. Turns are long: a transcript whose segments start at 0, 8.2,
        // and 133s has exactly THREE reachable positions, so dragging to 1:02
        // slammed the playhead back to 0:08 (nearer to 8.2 than to 133). On a
        // 1:53 recording that left precisely two seekable points in the whole
        // video. The keyboard path never snapped, so drag and arrow-keys also
        // disagreed about where the same timeline position was.
        //
        // The precision is what the consumer is built for: usePlayback's
        // `handleTimeSeek` seeks the media to this exact time AND selects the
        // nearest segment for transcript context (pre-seeding its guard ref so the
        // selection effect can't overwrite the scrubbed position with
        // segment-start − lead-in). Snapping here threw that away before it
        // could be used.
        //
        // Calling unconditionally also fixes a dead scrubber: the old code only
        // fired when a timestamped segment existed, so media attached to a
        // transcript with no timestamps had a draggable-but-inert timeline.
        onTimeChange(minTime + position * duration)
      }
      setIsDragging(false)
      setDragPosition(null)
    }

    const handleMouseUp = (e: MouseEvent) => handleRelease(e.clientX)
    const handleTouchEnd = (e: TouchEvent) => {
      const touch = e.changedTouches[0]
      handleRelease(touch.clientX)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('touchmove', handleTouchMove, { passive: false })
    window.addEventListener('touchend', handleTouchEnd)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('touchmove', handleTouchMove)
      window.removeEventListener('touchend', handleTouchEnd)
    }
    // `segments` is deliberately NOT a dep any more: the release no longer reads
    // it (no snapping), and it churns identity on every refetch — listing it
    // would rebind these window listeners mid-drag.
  }, [isDragging, getPositionFromEvent, minTime, duration, onTimeChange, onPositionChange])

  // Handle hover preview
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging) return
    if (!containerRef.current || duration <= 0) return

    const rect = containerRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const position = Math.max(0, Math.min(1, x / rect.width))
    const time = minTime + position * duration

    setHoveredTime(time)
    setHoverPosition(position)
  }, [minTime, duration, isDragging])

  // Keyboard handler for ARIA slider
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (duration <= 0) return

    let seekDelta: number | null = null
    if (e.key === 'ArrowRight') {
      seekDelta = e.shiftKey ? 30 : 5
    } else if (e.key === 'ArrowLeft') {
      seekDelta = e.shiftKey ? -30 : -5
    } else if (e.key === 'Home') {
      onTimeChange(minTime)
      e.preventDefault()
      return
    } else if (e.key === 'End') {
      onTimeChange(maxTime)
      e.preventDefault()
      return
    }

    if (seekDelta !== null) {
      e.preventDefault()
      e.stopPropagation()
      const current = currentTime ?? minTime
      const newTime = Math.max(minTime, Math.min(maxTime, current + seekDelta))
      onTimeChange(newTime)
    }
  }, [duration, minTime, maxTime, currentTime, onTimeChange])

  if (duration <= 0) {
    return (
      <div className={cn("text-xs text-mm-text-faint px-2", className)}>
        No timestamps
      </div>
    )
  }

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      {/* Start time label */}
      <span className="text-[11px] text-mm-text-muted font-mono whitespace-nowrap select-none">
        {formatTimestamp(minTime)}
      </span>

      {/* Track */}
      <div
        ref={containerRef}
        role="slider"
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(currentTime ?? 0)}
        aria-valuetext={
          formatTimestamp(currentTime ?? 0) + (playheadBeyond ? ', transcript only — past the end of the recording' : '')
        }
        tabIndex={0}
        className={cn(
          "relative h-4 bg-mm-bg rounded cursor-pointer select-none flex-1 outline-none focus-visible:ring-2 focus-visible:ring-mm-green/50",
          isDragging && "cursor-grabbing"
        )}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => {
          if (!isDragging) {
            setHoveredTime(null)
            setHoverPosition(null)
          }
        }}
        onKeyDown={handleKeyDown}
      >
        {/* #563: the region the recording doesn't reach. Dimmed + hatched so it
            reads as "no recording here", with a hard edge at the recording's end. */}
        {coverageEnd !== null && (
          <>
            <div
              className="absolute top-0 bottom-0 right-0 rounded-r bg-[repeating-linear-gradient(135deg,hsl(var(--mm-text-faint)/0.12)_0px,hsl(var(--mm-text-faint)/0.12)_3px,transparent_3px,transparent_6px)] pointer-events-none"
              style={{ left: `${coverageEnd * 100}%` }}
              aria-hidden
            />
            <div
              className="absolute top-0 bottom-0 w-px bg-mm-text-faint/60 pointer-events-none"
              style={{ left: `${coverageEnd * 100}%` }}
              aria-hidden
            />
          </>
        )}

        {/* Reference tick marks at quarter, half, three-quarter */}
        {REFERENCE_TICKS.map((tick) => (
          <div
            key={tick.position}
            className="absolute bottom-0 w-px bg-mm-text-faint/30"
            style={{ left: `${tick.position}%`, height: tick.height }}
          />
        ))}

        {/* Current position marker */}
        <div
          className={cn(
            "absolute top-0 bottom-0 w-0.5",
            // #564: amber past the end of the recording. Amber, not red: this is a
            // MODE (no video here), not an error — red is reserved for failures.
            // Never colour-alone — the ticker and aria-valuetext say it in words.
            playheadBeyond ? "bg-amber-500" : "bg-[hsl(var(--mm-green))]",
            !isDragging && "transition-all duration-150"
          )}
          style={{ left: `calc(${currentPosition * 100}% - 1px)` }}
        >
          <div className={cn(
            "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full cursor-grab",
            playheadBeyond ? "bg-amber-500" : "bg-[hsl(var(--mm-green))]",
            isDragging && "cursor-grabbing w-4 h-4"
          )} />
        </div>

        {/* Persistent time ticker below indicator - always shows current time */}
        {currentTime !== null && !isDragging && hoveredTime === null && (
          <div
            className={cn(
              "absolute top-5 px-1.5 py-0.5 text-white text-[11px] rounded pointer-events-none whitespace-nowrap z-10",
              playheadBeyond ? "bg-amber-500" : "bg-[hsl(var(--mm-green))]",
            )}
            style={{
              left: `${currentPosition * 100}%`,
              transform: 'translateX(-50%)',
            }}
          >
            {formatTimestamp(currentTime)}
            {playheadBeyond && <span className="ml-1 opacity-90">(transcript only)</span>}
          </div>
        )}

        {/* Drag time tooltip - follows indicator during drag */}
        {isDragging && (
          <div
            className="absolute top-5 px-1.5 py-0.5 bg-mm-chrome text-mm-chrome-text text-[11px] rounded pointer-events-none whitespace-nowrap z-10"
            style={{
              left: `${currentPosition * 100}%`,
              transform: 'translateX(-50%)',
            }}
          >
            {formatTimestamp(minTime + currentPosition * duration)}
            {beyond(minTime + currentPosition * duration) && (
              <span className="ml-1 opacity-90">(transcript only)</span>
            )}
          </div>
        )}

        {/* Hover time tooltip - follows cursor position */}
        {hoveredTime !== null && !isDragging && hoverPosition !== null && (
          <div
            className="absolute top-5 px-1.5 py-0.5 bg-mm-chrome text-mm-chrome-text text-[11px] rounded pointer-events-none whitespace-nowrap z-10"
            style={{
              left: `${hoverPosition * 100}%`,
              transform: 'translateX(-50%)',
            }}
          >
            {formatTimestamp(hoveredTime)}
            {beyond(hoveredTime) && <span className="ml-1 opacity-90">(transcript only)</span>}
          </div>
        )}
      </div>

      {/* End time label. #563: when the recording stops before the transcript does,
          the bare transcript end reads as a promise the player can't keep — name
          where the recording actually ends, in text (the hatched region is
          invisible to a screen reader, and this is also how a user discovers they
          attached the WRONG recording). Wrapped in a Tooltip ONLY when there is
          something to explain — like the VBR icon below, so a consumer that renders
          the scrubber outside a TooltipProvider isn't forced to add one. */}
      {coverageEnd !== null && mediaDuration != null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-[11px] text-mm-text-muted font-mono whitespace-nowrap select-none">
              {formatTimestamp(maxTime)}
              <span className="ml-1 text-mm-text-faint">
                (rec. {formatTimestamp(mediaDuration)})
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs text-xs">
            The recording ends at {formatTimestamp(mediaDuration)}, before the transcript
            ends at {formatTimestamp(maxTime)}. You can still read and code the rest —
            there is just nothing to play there.
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className="text-[11px] text-mm-text-muted font-mono whitespace-nowrap select-none">
          {formatTimestamp(maxTime)}
        </span>
      )}

      {/* VBR indicator */}
      {isVbr && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Info className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs text-xs">
            Variable bitrate audio — seeking may be slightly imprecise.
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
