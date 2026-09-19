import { useMemo } from 'react'
import { type Segment } from '@/lib/api'
import { cn } from '@/lib/utils'
import { isSegmentCodedVisible } from '@/lib/coding-progress'
import type { CoderLens } from '@/lib/coder-color'

interface SegmentProgressBarProps {
  segments: Segment[]
  /** the per-coder lens (filter or blind mode) — bar/count reflect only visible coders. */
  hiddenCoderIds?: CoderLens
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

  return (
    <div
      className={cn("h-2 rounded overflow-hidden", className)}
      style={gradientStyle}
      /**
       * 🔴 **DECORATIVE, and that is a correction (#963 Tier 2, 2026-09-18).**
       *
       * #351/#352 gave this bar its own `role="progressbar"` +
       * `aria-label="Coding progress"` + `aria-valuetext`. Track J · J1 3c then
       * wrapped it in a toolbar region carrying **the same role and the same
       * name**, so the workbench shipped TWO nested progressbars both called
       * *"Coding progress"*, both stating the same count — found by a new guard
       * failing with *"Found multiple elements with the role progressbar and
       * name Coding progress"*, never by reading either file.
       *
       * The outer one wins, for a reason beyond being outermost: ARIA gives
       * `progressbar` PRESENTATIONAL CHILDREN, so a conforming reader prunes
       * this one anyway — and the outer `aria-valuetext` is the only one that
       * carries the blind-scope qualifier (*"(colleagues hidden)"*, #503/#517).
       * Where the two could disagree, the one that would survive is the one
       * that says less. A gauge's VISUAL half does not need its own semantics.
       *
       * ⚠️ The `title` went with the role: the sibling text says the count and
       * the region's own `title` carries the facilitator/blind context, so a
       * second tooltip over the same number was two things to read.
       */
      aria-hidden="true"
    />
  )
}
