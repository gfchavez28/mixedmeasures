import { useMemo } from 'react'
import { type Segment } from '@/lib/api'
import { cn } from '@/lib/utils'
import { isSegmentCodedVisible } from '@/lib/coding-progress'

interface SegmentProgressBarProps {
  segments: Segment[]
  /** coder ids hidden by the per-coder filter — bar/count reflect only visible coders. */
  hiddenCoderIds?: Set<number>
  className?: string
}

/**
 * A progress bar that shows WHERE in the transcript segments are coded.
 * Uses a gradient/bitmap approach to show coded (green) vs uncoded (gray) regions.
 */
export default function SegmentProgressBar({
  segments,
  hiddenCoderIds,
  className,
}: SegmentProgressBarProps) {
  // Only count participant segments (non-facilitator) in the progress visualization
  const participantSegments = useMemo(() => {
    return segments.filter(s => !s.is_facilitator)
  }, [segments])

  // Calculate the gradient stops for the progress visualization
  const gradientStyle = useMemo(() => {
    if (participantSegments.length === 0) {
      // Empty bar — quiet neutral track (CSS var resolves per theme).
      return { background: 'hsl(var(--mm-border-subtle))' }
    }

    // Create gradient stops for each segment
    const stops: string[] = []
    const segmentWidth = 100 / participantSegments.length

    participantSegments.forEach((segment, index) => {
      // #400/J-A: a universal-only segment is NOT coded; filter-aware so the bar
      // matches the gauge when a per-coder filter hides a colleague's codes.
      const isCoded = isSegmentCodedVisible(segment.applied_code_details, hiddenCoderIds)
      // coded = mm-green, uncoded = neutral; CSS vars rebalance per theme.
      const color = isCoded ? 'hsl(var(--mm-green))' : 'hsl(var(--mm-border-medium))'
      const startPercent = index * segmentWidth
      const endPercent = (index + 1) * segmentWidth

      // Add color stops (sharp transitions)
      stops.push(`${color} ${startPercent}%`)
      stops.push(`${color} ${endPercent}%`)
    })

    return {
      background: `linear-gradient(to right, ${stops.join(', ')})`,
    }
  }, [participantSegments, hiddenCoderIds])

  // Also calculate overall stats for debugging/verification
  const codedCount = participantSegments.filter(s => isSegmentCodedVisible(s.applied_code_details, hiddenCoderIds)).length
  const totalCount = participantSegments.length

  return (
    <div
      className={cn("h-2 rounded overflow-hidden", className)}
      style={gradientStyle}
      title={`${codedCount} of ${totalCount} participant segments coded (facilitator excluded)`}
      /* #351/#352: explicit progressbar semantics + valuetext so screen
       * readers get the full count + the facilitator-excluded context
       * without depending on the title attribute (which is sighted-only). */
      role="progressbar"
      aria-label="Coding progress"
      aria-valuenow={codedCount}
      aria-valuemin={0}
      aria-valuemax={totalCount}
      aria-valuetext={`${codedCount} of ${totalCount} participant segments coded`}
    />
  )
}
