import { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import { Info } from 'lucide-react'
import { type Segment } from '@/lib/api'
import { formatTimestamp } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'

interface TimelineScrubberProps {
  segments: Segment[]
  currentTime: number | null
  onTimeChange: (time: number) => void
  onPositionChange?: (position: number) => void  // 0-1 for scroll sync
  /** Audio duration — extends max boundary beyond last segment */
  mediaDuration?: number | null
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
        const time = minTime + position * duration
        // Find closest segment
        let closestTime: number | null = null
        let closestDistance = Infinity
        segments.forEach(seg => {
          if (seg.start_time !== null && seg.start_time !== undefined) {
            const distance = Math.abs(seg.start_time - time)
            if (distance < closestDistance) {
              closestDistance = distance
              closestTime = seg.start_time
            }
          }
        })
        if (closestTime !== null) {
          onTimeChange(closestTime)
        }
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
  }, [isDragging, getPositionFromEvent, segments, minTime, duration, onTimeChange, onPositionChange])

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
        aria-valuetext={formatTimestamp(currentTime ?? 0)}
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
            "absolute top-0 bottom-0 w-0.5 bg-[hsl(var(--mm-green))]",
            !isDragging && "transition-all duration-150"
          )}
          style={{ left: `calc(${currentPosition * 100}% - 1px)` }}
        >
          <div className={cn(
            "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 bg-[hsl(var(--mm-green))] rounded-full cursor-grab",
            isDragging && "cursor-grabbing w-4 h-4"
          )} />
        </div>

        {/* Persistent time ticker below indicator - always shows current time */}
        {currentTime !== null && !isDragging && hoveredTime === null && (
          <div
            className="absolute top-5 px-1.5 py-0.5 bg-[hsl(var(--mm-green))] text-white text-[11px] rounded pointer-events-none whitespace-nowrap z-10"
            style={{
              left: `${currentPosition * 100}%`,
              transform: 'translateX(-50%)',
            }}
          >
            {formatTimestamp(currentTime)}
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
          </div>
        )}
      </div>

      {/* End time label */}
      <span className="text-[11px] text-mm-text-muted font-mono whitespace-nowrap select-none">
        {formatTimestamp(maxTime)}
      </span>

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
