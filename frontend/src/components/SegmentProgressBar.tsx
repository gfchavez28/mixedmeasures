import { useMemo } from 'react'
import { type Segment } from '@/lib/api'
import { useTheme } from '@/lib/theme-context'
import { cn } from '@/lib/utils'

interface SegmentProgressBarProps {
  segments: Segment[]
  className?: string
}

/**
 * A progress bar that shows WHERE in the transcript segments are coded.
 * Uses a gradient/bitmap approach to show coded (green) vs uncoded (gray) regions.
 */
export default function SegmentProgressBar({
  segments,
  className,
}: SegmentProgressBarProps) {
  const { isDark } = useTheme()

  // Only count participant segments (non-facilitator) in the progress visualization
  const participantSegments = useMemo(() => {
    return segments.filter(s => !s.is_facilitator)
  }, [segments])

  // Calculate the gradient stops for the progress visualization
  const gradientStyle = useMemo(() => {
    if (participantSegments.length === 0) {
      return { background: isDark ? '#374151' : '#e5e7eb' } // gray-700 / gray-200
    }

    // Create gradient stops for each segment
    const stops: string[] = []
    const segmentWidth = 100 / participantSegments.length

    participantSegments.forEach((segment, index) => {
      const isCoded = segment.applied_codes.length > 0
      const color = isCoded ? '#22c55e' : (isDark ? '#4b5563' : '#d1d5db') // green-500 or gray-600/gray-300
      const startPercent = index * segmentWidth
      const endPercent = (index + 1) * segmentWidth

      // Add color stops (sharp transitions)
      stops.push(`${color} ${startPercent}%`)
      stops.push(`${color} ${endPercent}%`)
    })

    return {
      background: `linear-gradient(to right, ${stops.join(', ')})`,
    }
  }, [participantSegments, isDark])

  // Also calculate overall stats for debugging/verification
  const codedCount = participantSegments.filter(s => s.applied_codes.length > 0).length
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
